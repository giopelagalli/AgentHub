import { execFile } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The OS sandbox an external harness runs in (decision 0055): Seatbelt (`sandbox-exec`) on macOS,
 * bubblewrap (`bwrap`) on Linux. Either way the process may read the disk except the hub's own
 * secrets and other projects, write only the workspace and its own temp dir, and reach the network
 * only at the hub's door — or, for `claude`, which talks to Anthropic itself, at any host on port
 * 443 (decision 0064).
 */
export type SandboxOptions = SandboxBase & SandboxNetwork;

/**
 * What the process may reach. `door`: the hub's door and nothing else (pi). `https`: outbound TCP
 * to port 443 anywhere, plus name resolution (claude-code, decision 0064).
 */
export type SandboxNetwork = { door: Door } | { https: true };

export interface SandboxBase {
  /** Absolute and already resolved (`realpath`): Seatbelt matches real paths, not symlinks. */
  workspace: string;
  /** The run's own scratch dir, writable; resolved like `workspace`. */
  tmpDir: string;
  /** False for the read-only tool policy (the reviewer): then the workspace is read-only too. */
  writableWorkspace: boolean;
  /** Existing, resolved paths whose contents are hidden; see `hiddenPaths`. */
  hidden: HiddenPath[];
  /** A directory inside a hidden one that is readable again: the bundle holding the workspace's `.git`. */
  readable?: string;
  /** The command to run inside, `argv[0]` resolved through PATH as usual. */
  argv: string[];
  /**
   * macOS only: lets the process reach the login keychain through securityd, which is where the
   * `claude` CLI keeps its subscription login (decision 0064). Linux keeps it in a file instead.
   */
  keychain?: boolean;
}

export interface Door { host: string; port: number }
export interface HiddenPath { path: string; dir: boolean }

export type SandboxedCommand =
  /** `doorSocket`, when set, is the unix socket the caller must serve with `serveDoorSocket`. */
  | { cmd: string; args: string[]; doorSocket?: string }
  | { unavailable: string };

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export const BWRAP = 'bwrap';

/** The door named by a base URL (`http://127.0.0.1:4000`), brackets off an IPv6 host. */
export function doorOf(base: string): Door {
  const url = new URL(base);
  return { host: url.hostname.replace(/^\[(.*)\]$/, '$1'), port: Number(url.port || 80) };
}

const isLoopback = (host: string): boolean => host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);

/** Why this door cannot be reached from inside a sandbox, or null when it can. */
function doorProblem(door: Door): string | null {
  if (!Number.isInteger(door.port) || door.port < 1 || door.port > 65535) return `not a door port: ${door.port}`;
  // Both sandboxes reach loopback only — Seatbelt can only name `localhost:<port>`, and on Linux the
  // bridge listens on the namespace's own loopback. A hub bound to one address is not on it.
  if (!isLoopback(door.host)) {
    return `the hub's door is on ${door.host}, not loopback (HUB_HOST=${door.host}); a sandboxed pi can only reach loopback`;
  }
  return null;
}

/** Path components, so an ancestor always sorts before what is inside it. */
const depth = (path: string): number => path.split(sep).filter(Boolean).length;
const within = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * What a sandbox hides, readable again, and writable, in mount order: an ancestor before what is
 * inside it, so a hidden data root comes before the workspace inside it, and a hidden directory
 * inside the workspace would come after it. Seatbelt reads its rules in the same order (the last
 * matching rule wins); bubblewrap mounts them in it.
 */
type Layer = { path: string; as: 'hide-dir' | 'hide-file' | 'read' | 'write' };
function layers(o: SandboxOptions): Layer[] {
  const all: Layer[] = [
    ...o.hidden.map((h): Layer => ({ path: h.path, as: h.dir ? 'hide-dir' : 'hide-file' })),
    ...(o.readable ? [{ path: o.readable, as: 'read' as const }] : []),
    { path: o.workspace, as: o.writableWorkspace ? 'write' : 'read' },
    { path: o.tmpDir, as: 'write' },
  ];
  return all.map((l, i) => ({ l, i })).sort((a, b) => depth(a.l.path) - depth(b.l.path) || a.i - b.i).map(({ l }) => l);
}

/**
 * The Seatbelt profile and its `-D` parameters. Deny by default: an `allow default` profile leaves
 * mach services open, and some of those start processes outside the sandbox. Paths come in as
 * parameters so a quote in one cannot change the profile.
 *
 * Hiding denies `file-read-data` (and xattrs), not metadata: `realpath` and `getcwd` lstat every
 * ancestor of the workspace, and a data root above it would otherwise break both. A more specific
 * operation beats `file-read*` whatever the order, so the re-allows name the same two operations.
 */
export function seatbeltProfile(o: SandboxOptions): { profile: string; params: string[] } {
  const params: string[] = [];
  const param = (value: string): string => {
    params.push('-D', `P${params.length / 2}=${value}`);
    return `(param "P${params.length / 2 - 1}")`;
  };
  const READ = 'file-read-data file-read-xattr';
  // In layer order, so a deeper rule overrides the one above it: a hidden data root, then the
  // workspace readable and writable again inside it. A hidden path is unwritable as well.
  const rules = layers(o).flatMap((l) => {
    const p = param(l.path);
    if (l.as === 'hide-dir' || l.as === 'hide-file') return [`(deny ${READ} (subpath ${p}))`, `(deny file-write* (subpath ${p}))`];
    return [`(allow ${READ} (subpath ${p}))`, ...(l.as === 'write' ? [`(allow file-write* (subpath ${p}))`] : [])];
  });
  const profile = [
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
    ...rules,
    // `echo … > /dev/stderr` opens these for writing.
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero")',
    '  (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/fd/[0-9]+$"))',
    '(allow file-ioctl (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))',
    ...('door' in o
      // Verified per port (decision 0055): another loopback port, an IP and DNS all fail.
      ? [`(allow network-outbound (remote ip "localhost:${o.door.port}"))`]
      // Verified with claude 2.1 (decision 0064): any host on 443, and DNS through mDNSResponder.
      : [
        '(allow network-outbound (remote tcp "*:443"))',
        '(allow network-outbound (literal "/private/var/run/mDNSResponder"))',
        '(allow mach-lookup (global-name "com.apple.dnssd.service"))',
      ]),
    ...(o.keychain ? ['(allow mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc"))'] : []),
  ].join('\n');
  return { profile, params };
}

/**
 * Runs inside the Linux sandbox's own network namespace, where the host's loopback — and so the
 * door — is out of reach: listens on the namespace's `<host>:<port>`, pipes every connection to the
 * unix socket the hub serves, and only then starts the command, exiting with its status.
 * `node -e` with argv `[socket, host, port, cmd, ...args]`.
 */
export const DOOR_BRIDGE_SOURCE = `
const net = require('node:net');
const { spawn } = require('node:child_process');
const { constants } = require('node:os');
const [sock, host, port, cmd, ...args] = process.argv.slice(1);
const server = net.createServer((inside) => {
  const door = net.connect(sock);
  inside.pipe(door).pipe(inside);
  inside.on('error', () => door.destroy());
  door.on('error', () => inside.destroy());
});
server.on('error', (e) => { console.error('door bridge: ' + e.message); process.exit(126); });
server.listen(Number(port), host, () => {
  const child = spawn(cmd, args, { stdio: 'inherit' });
  child.on('error', (e) => { console.error('door bridge: ' + e.message); process.exit(127); });
  child.on('exit', (code, sig) => process.exit(code ?? 128 + (constants.signals[sig] ?? 0)));
});
`;

const RESOLVED_DIR = '/run/systemd/resolve';

/** The bubblewrap line, without the command. */
function bwrapArgs(o: SandboxOptions): string[] {
  const mounts = layers(o).flatMap((l) => {
    if (l.as === 'hide-dir') return ['--tmpfs', l.path];
    if (l.as === 'hide-file') return ['--ro-bind', '/dev/null', l.path];
    return [l.as === 'write' ? '--bind' : '--ro-bind', l.path, l.path];
  });
  return [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    // A read-only bind still lets a process connect() to a socket on it: docker.sock, D-Bus and
    // ssh-agent live here, so it is replaced rather than bound read-only.
    '--tmpfs', '/run',
    // systemd-resolved's stub, which /etc/resolv.conf points into on Ubuntu, is the one part of /run
    // a process with the network shared needs back (unverified on the Spark, decision 0064).
    ...('https' in o && existsSync(RESOLVED_DIR) ? ['--ro-bind', RESOLVED_DIR, RESOLVED_DIR] : []),
    ...mounts,
    '--chdir', o.workspace,
    '--unshare-all',
    ...('https' in o ? ['--share-net'] : []),
    '--die-with-parent',
    '--new-session',
  ];
}

/**
 * `argv` wrapped in this platform's sandbox. Pure: the probe and the tests both go through it, so
 * what is detected is exactly what runs.
 */
export function sandboxedCommand(platform: NodeJS.Platform, o: SandboxOptions): SandboxedCommand {
  const problem = 'door' in o ? doorProblem(o.door) : null;
  if (problem) return { unavailable: problem };
  if (platform === 'darwin') {
    const { profile, params } = seatbeltProfile(o);
    return { cmd: SANDBOX_EXEC, args: ['-p', profile, ...params, ...o.argv] };
  }
  if (platform === 'linux') {
    // With the network shared there is no namespace loopback to bridge, and no door to reach.
    if ('https' in o) return { cmd: BWRAP, args: [...bwrapArgs(o), '--', ...o.argv] };
    const doorSocket = join(o.tmpDir, 'door.sock');
    return {
      cmd: BWRAP,
      args: [
        ...bwrapArgs(o), '--',
        process.execPath, '-e', DOOR_BRIDGE_SOURCE, doorSocket, o.door.host, String(o.door.port), ...o.argv,
      ],
      doorSocket,
    };
  }
  return { unavailable: `an external harness is only sandboxed on macOS and Linux, not ${platform}` };
}

/**
 * The hub's end of the Linux door bridge: a unix socket at `path` whose every connection is piped
 * to the door. Close it when the run is over.
 */
export async function serveDoorSocket(path: string, door: Door): Promise<{ close: () => Promise<void> }> {
  const open = new Set<Socket>();
  const server = createServer((inside) => {
    const out = createConnection(door.port, door.host);
    for (const s of [inside, out]) { open.add(s); s.on('close', () => open.delete(s)); }
    inside.pipe(out).pipe(inside);
    inside.on('error', () => out.destroy());
    out.on('error', () => inside.destroy());
  });
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(path, ok); });
  return {
    close: () => new Promise<void>((ok) => {
      for (const s of open) s.destroy();
      server.close(() => ok());
    }),
  };
}

/** Where the hub keeps what a harness must not read; see `hostSecrets`. */
export interface SecretPaths {
  home: string;
  /** The hub's data directory: its database, memory, and every project's bundle. */
  dataRoot?: string;
  /** Roots the hub was pointed at outside `dataRoot` (`HUB_DB`, `PROJECTS_ROOT`, `MEMORY_ROOT`). */
  extra?: string[];
  /** The repo's `configs/` — node configs and their tokens. */
  configsDir?: string;
  /** `GITHUB_APP_PRIVATE_KEY`. */
  githubKeyPath?: string;
}

/** Credential directories in the hub user's home. */
const HOME_SECRETS = ['.ssh', '.aws', '.config/gh', '.gnupg', '.docker'];
/** `configs/` at the repo root, from this file's place in `packages/hub/src/agents/harness/`. */
const CONFIGS_DIR = fileURLToPath(new URL('../../../../../configs', import.meta.url));

/** This hub's secret paths, read from the same environment `options.ts` builds the hub from. */
export function hostSecrets(env: NodeJS.ProcessEnv = process.env): SecretPaths {
  return {
    home: homedir(),
    // Unset, the hub keeps `data/…` relative to where it was started (options.ts).
    dataRoot: resolve(env.DATA_ROOT || 'data'),
    extra: [env.HUB_DB, env.PROJECTS_ROOT, env.MEMORY_ROOT].filter((p): p is string => !!p).map((p) => resolve(p)),
    configsDir: CONFIGS_DIR,
    ...(env.GITHUB_APP_PRIVATE_KEY ? { githubKeyPath: resolve(env.GITHUB_APP_PRIVATE_KEY) } : {}),
  };
}

/**
 * The secrets that exist on this host, resolved, as `SandboxOptions.hidden` — and the workspace's
 * bundle as `readable` when the workspace has no `.git` of its own (a project the hub created
 * versions its workspace in the bundle above it) and that bundle sits inside something hidden.
 */
export function hiddenPaths(s: SecretPaths, workspace: string): Pick<SandboxOptions, 'hidden' | 'readable'> {
  const candidates = [s.dataRoot, ...(s.extra ?? []), s.configsDir, s.githubKeyPath, ...HOME_SECRETS.map((d) => join(s.home, d))];
  const hidden: HiddenPath[] = [];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const path = realpathSync(c);
      // A root that *contains* the workspace is hidden and the workspace re-allowed inside it, but
      // one that *is* the workspace (PROJECTS_ROOT pointed at a single project) would hide it all.
      if (path === workspace) continue;
      if (!hidden.some((h) => h.path === path)) hidden.push({ path, dir: statSync(path).isDirectory() });
    } catch { /* absent: nothing to hide */ }
  }
  const bundle = dirname(workspace);
  const needsBundle = !existsSync(join(workspace, '.git')) && existsSync(join(bundle, '.git'))
    && hidden.some((h) => h.dir && within(h.path, bundle));
  return { hidden, ...(needsBundle ? { readable: bundle } : {}) };
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

/** A host probe that succeeded once holds for the process; a failure is probed again next time. */
const probedOk = new Set<string>();

/**
 * Whether this host can sandbox a harness that calls the door at `doorBase`, found out by running
 * one: the binary being on PATH is not enough on Linux, where user namespaces may be disabled or
 * refused by AppArmor (decision 0055). The probe is the real wrapped command around `true`, the
 * host's hidden paths and the door bridge included. Without a `doorBase` only the host is judged.
 * `https` probes the claude-code sandbox instead: the network shared, the keychain reachable.
 */
export async function sandboxStatus(
  { doorBase, https = false, platform = process.platform, run = hostRunner }:
  { doorBase?: string; https?: boolean; platform?: NodeJS.Platform; run?: ProbeRunner } = {},
): Promise<SandboxStatus> {
  if (platform !== 'darwin' && platform !== 'linux') {
    return { available: false, reason: `an external harness is only sandboxed on macOS and Linux, not ${platform}` };
  }
  const problem = doorBase ? doorProblem(doorOf(doorBase)) : null;
  if (problem) return { available: false, reason: problem };
  const cached = run === hostRunner;
  const key = `${platform}:${https ? 'https' : 'door'}`;
  if (cached && probedOk.has(key)) return { available: true };
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'agenthub-sandbox-probe-')));
  try {
    // Any port does: nothing connects, and on Linux the bridge listens in an empty namespace.
    const wrapped = sandboxedCommand(platform, {
      workspace: dir, tmpDir: dir, writableWorkspace: true,
      ...(https ? { https: true, keychain: true } : { door: { host: '127.0.0.1', port: 65535 } }),
      ...hiddenPaths(hostSecrets(), dir), argv: ['true'],
    });
    if ('unavailable' in wrapped) return { available: false, reason: wrapped.unavailable };
    const res = await run(wrapped.cmd, wrapped.args);
    if (res.ok) {
      if (cached) probedOk.add(key);
      return { available: true };
    }
    if (res.code === 'ENOENT') {
      return {
        available: false,
        reason: platform === 'darwin' ? 'sandbox-exec is missing from /usr/bin' : 'bubblewrap is not installed (sudo apt install bubblewrap)',
      };
    }
    const tool = platform === 'darwin' ? 'sandbox-exec' : 'bubblewrap';
    return { available: false, reason: `${tool} could not start a sandbox here: ${res.detail}` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
