import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The OS sandbox an external harness runs in (decision 0055): Seatbelt (`sandbox-exec`) on macOS,
 * bubblewrap (`bwrap`) on Linux. Either way the process may read the whole disk, write only the
 * workspace and its own temp dir, and reach the network only at the hub's door.
 */
export interface SandboxOptions {
  /** Absolute and already resolved (`realpath`): Seatbelt matches real paths, not symlinks. */
  workspace: string;
  /** The run's own scratch dir, writable; resolved like `workspace`. */
  tmpDir: string;
  /** The port the hub's door listens on at 127.0.0.1 — the only address reachable inside. */
  doorPort: number;
  /** Lift the network restriction entirely. Nothing sets it yet (decision 0055). */
  allowNetwork: boolean;
  /** The command to run inside, `argv[0]` resolved through PATH as usual. */
  argv: string[];
}

export type SandboxedCommand =
  /** `doorSocket`, when set, is the unix socket the caller must serve with `serveDoorSocket`. */
  | { cmd: string; args: string[]; doorSocket?: string }
  | { unavailable: string };

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export const BWRAP = 'bwrap';

/**
 * The Seatbelt profile. Deny by default: an `allow default` profile leaves mach services open,
 * and some of those start processes outside the sandbox. Paths come in as `-D` parameters so a
 * quote in one cannot change the profile.
 */
export function seatbeltProfile(doorPort: number, allowNetwork: boolean): string {
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))',
    '(allow file-read*)',
    '(allow sysctl-read)',
    // confstr() asks it for the per-user temp dir; without it every /usr/bin/git (an xcrun shim) warns.
    '(allow mach-lookup (global-name "com.apple.bsd.dirhelper"))',
    '(allow file-write*',
    '  (subpath (param "WORKSPACE"))',
    '  (subpath (param "TMPDIR"))',
    '  (literal "/dev/null") (literal "/dev/zero")',
    // `echo … > /dev/stderr` opens these for writing.
    '  (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/fd/[0-9]+$"))',
    '(allow file-ioctl (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))',
    ...(allowNetwork
      ? ['(allow network*)', '(allow mach-lookup (global-name "com.apple.dnssd.service"))']
      // Verified per port (decision 0055): another loopback port, an IP and DNS all fail.
      : [`(allow network-outbound (remote ip "localhost:${doorPort}"))`]),
  ].join('\n');
}

/**
 * Runs inside the Linux sandbox's own network namespace, where the host's loopback — and so the
 * door — is out of reach: listens on the namespace's 127.0.0.1:<port>, pipes every connection to
 * the unix socket the hub serves, and only then starts the command, exiting with its status.
 * `node -e` with argv `[socket, port, cmd, ...args]`.
 */
export const DOOR_BRIDGE_SOURCE = `
const net = require('node:net');
const { spawn } = require('node:child_process');
const { constants } = require('node:os');
const [sock, port, cmd, ...args] = process.argv.slice(1);
const server = net.createServer((inside) => {
  const door = net.connect(sock);
  inside.pipe(door).pipe(inside);
  inside.on('error', () => door.destroy());
  door.on('error', () => inside.destroy());
});
server.on('error', (e) => { console.error('door bridge: ' + e.message); process.exit(126); });
server.listen(Number(port), '127.0.0.1', () => {
  const child = spawn(cmd, args, { stdio: 'inherit' });
  child.on('error', (e) => { console.error('door bridge: ' + e.message); process.exit(127); });
  child.on('exit', (code, sig) => process.exit(code ?? 128 + (constants.signals[sig] ?? 0)));
});
`;

/** The bubblewrap line, without the command. */
function bwrapArgs(o: SandboxOptions): string[] {
  return [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    // A read-only bind still lets a process connect() to a socket on it: docker.sock, D-Bus and
    // ssh-agent live here, so it is replaced rather than bound read-only.
    '--tmpfs', '/run',
    ...(o.allowNetwork ? ['--ro-bind-try', '/run/systemd/resolve', '/run/systemd/resolve'] : []),
    '--bind', o.workspace, o.workspace,
    '--bind', o.tmpDir, o.tmpDir,
    '--chdir', o.workspace,
    '--unshare-all',
    ...(o.allowNetwork ? ['--share-net'] : []),
    '--die-with-parent',
    '--new-session',
  ];
}

/**
 * `argv` wrapped in this platform's sandbox. Pure: the probe and the tests both go through it, so
 * what is detected is exactly what runs.
 */
export function sandboxedCommand(platform: NodeJS.Platform, o: SandboxOptions): SandboxedCommand {
  if (!Number.isInteger(o.doorPort) || o.doorPort < 1 || o.doorPort > 65535) {
    return { unavailable: `not a door port: ${o.doorPort}` };
  }
  if (platform === 'darwin') {
    return {
      cmd: SANDBOX_EXEC,
      args: [
        '-p', seatbeltProfile(o.doorPort, o.allowNetwork),
        '-D', `WORKSPACE=${o.workspace}`,
        '-D', `TMPDIR=${o.tmpDir}`,
        ...o.argv,
      ],
    };
  }
  if (platform === 'linux') {
    if (o.allowNetwork) return { cmd: BWRAP, args: [...bwrapArgs(o), '--', ...o.argv] };
    const doorSocket = join(o.tmpDir, 'door.sock');
    return {
      cmd: BWRAP,
      args: [...bwrapArgs(o), '--', process.execPath, '-e', DOOR_BRIDGE_SOURCE, doorSocket, String(o.doorPort), ...o.argv],
      doorSocket,
    };
  }
  return { unavailable: `pi is only sandboxed on macOS and Linux, not ${platform}` };
}

/**
 * The hub's end of the Linux door bridge: a unix socket at `path` whose every connection is piped
 * to the door on 127.0.0.1:`doorPort`. Close it when the run is over.
 */
export async function serveDoorSocket(path: string, doorPort: number): Promise<{ close: () => Promise<void> }> {
  const open = new Set<Socket>();
  const server = createServer((inside) => {
    const door = createConnection(doorPort, '127.0.0.1');
    for (const s of [inside, door]) { open.add(s); s.on('close', () => open.delete(s)); }
    inside.pipe(door).pipe(inside);
    inside.on('error', () => door.destroy());
    door.on('error', () => inside.destroy());
  });
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(path, ok); });
  return {
    close: () => new Promise<void>((ok) => {
      for (const s of open) s.destroy();
      server.close(() => ok());
    }),
  };
}

export type SandboxStatus = { available: true } | { available: false; reason: string };

/** How a probe runs a command: exit 0 is `ok`, anything else (including ENOENT) carries why. */
export type ProbeRunner = (cmd: string, args: string[]) => Promise<{ ok: true } | { ok: false; code?: string; detail: string }>;

const PROBE_TIMEOUT_MS = 10_000;

const hostRunner: ProbeRunner = (cmd, args) => new Promise((settle) => {
  execFile(cmd, args, { timeout: PROBE_TIMEOUT_MS }, (err, _stdout, stderr) => {
    if (!err) return settle({ ok: true });
    const code = typeof (err as NodeJS.ErrnoException).code === 'string' ? (err as NodeJS.ErrnoException).code : undefined;
    const detail = stderr.trim().split('\n')[0]?.trim() || err.message;
    settle({ ok: false, ...(code ? { code } : {}), detail });
  });
});

/**
 * Whether this host can sandbox a harness, found out by running one: the binary being on PATH is
 * not enough on Linux, where user namespaces may be disabled or refused by AppArmor (decision 0055).
 * The probe is the real wrapped command around `true`, door bridge included.
 */
export async function sandboxStatus(platform: NodeJS.Platform = process.platform, run: ProbeRunner = hostRunner): Promise<SandboxStatus> {
  if (platform !== 'darwin' && platform !== 'linux') {
    return { available: false, reason: `pi is only sandboxed on macOS and Linux, not ${platform}` };
  }
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'agenthub-sandbox-probe-')));
  try {
    // Any port does: nothing connects, and on Linux the bridge listens in an empty namespace.
    const wrapped = sandboxedCommand(platform, { workspace: dir, tmpDir: dir, doorPort: 65535, allowNetwork: false, argv: ['true'] });
    if ('unavailable' in wrapped) return { available: false, reason: wrapped.unavailable };
    const res = await run(wrapped.cmd, wrapped.args);
    if (res.ok) return { available: true };
    const tool = platform === 'darwin' ? 'sandbox-exec' : 'bubblewrap';
    if (res.code === 'ENOENT') {
      return {
        available: false,
        reason: platform === 'darwin' ? 'sandbox-exec is missing from /usr/bin' : 'bubblewrap is not installed (sudo apt install bubblewrap)',
      };
    }
    return { available: false, reason: `${tool} could not start a sandbox here: ${res.detail}` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
