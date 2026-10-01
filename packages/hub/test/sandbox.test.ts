import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DOOR_BRIDGE_SOURCE, SANDBOX_EXEC, sandboxedCommand, sandboxStatus, serveDoorSocket, type ProbeRunner, type SandboxOptions,
} from '../src/agents/harness/sandbox.js';

const opts = (over: Partial<SandboxOptions> = {}): SandboxOptions => ({
  workspace: '/work/demo', tmpDir: '/tmp/agenthub-pi-x', doorPort: 4555, allowNetwork: false, argv: ['pi', '-p', 'task'], ...over,
});

/** `flag` followed by `values`, somewhere in `args`. */
const hasRun = (args: string[], ...run: string[]): boolean =>
  args.some((_, i) => run.every((v, j) => args[i + j] === v));

describe('sandboxedCommand on macOS', () => {
  it('runs the command under a deny-default Seatbelt profile with the paths as parameters', () => {
    const c = sandboxedCommand('darwin', opts());
    if ('unavailable' in c) throw new Error(c.unavailable);
    expect(c.cmd).toBe(SANDBOX_EXEC);
    expect(c.doorSocket).toBeUndefined();
    expect(c.args[0]).toBe('-p');
    const profile = c.args[1];
    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(subpath (param "WORKSPACE"))');
    expect(profile).toContain('(subpath (param "TMPDIR"))');
    expect(profile).toContain('(allow network-outbound (remote ip "localhost:4555"))');
    expect(profile).not.toContain('network*');
    expect(profile).not.toContain('(allow default)');
    expect(hasRun(c.args, '-D', 'WORKSPACE=/work/demo')).toBe(true);
    expect(hasRun(c.args, '-D', 'TMPDIR=/tmp/agenthub-pi-x')).toBe(true);
    expect(c.args.slice(-3)).toEqual(['pi', '-p', 'task']);
  });

  it('opens the network only when asked', () => {
    const c = sandboxedCommand('darwin', opts({ allowNetwork: true }));
    if ('unavailable' in c) throw new Error(c.unavailable);
    expect(c.args[1]).toContain('(allow network*)');
  });
});

describe('sandboxedCommand on Linux', () => {
  it('runs bwrap with a read-only root, the workspace and temp dir writable, no network, and the door bridge', () => {
    const c = sandboxedCommand('linux', opts());
    if ('unavailable' in c) throw new Error(c.unavailable);
    expect(c.cmd).toBe('bwrap');
    for (const run of [
      ['--ro-bind', '/', '/'], ['--tmpfs', '/tmp'], ['--tmpfs', '/run'],
      ['--bind', '/work/demo', '/work/demo'], ['--bind', '/tmp/agenthub-pi-x', '/tmp/agenthub-pi-x'],
      ['--chdir', '/work/demo'], ['--unshare-all'], ['--die-with-parent'], ['--new-session'],
    ]) expect(hasRun(c.args, ...run), run.join(' ')).toBe(true);
    expect(c.args).not.toContain('--share-net');
    // The binds land on the fresh /tmp, so they must come after it.
    expect(c.args.indexOf('--bind')).toBeGreaterThan(c.args.indexOf('/tmp'));
    expect(c.doorSocket).toBe('/tmp/agenthub-pi-x/door.sock');
    const inner = c.args.slice(c.args.indexOf('--') + 1);
    expect(inner).toEqual([process.execPath, '-e', DOOR_BRIDGE_SOURCE, '/tmp/agenthub-pi-x/door.sock', '4555', 'pi', '-p', 'task']);
  });

  it('shares the host network, without a bridge, only when asked', () => {
    const c = sandboxedCommand('linux', opts({ allowNetwork: true }));
    if ('unavailable' in c) throw new Error(c.unavailable);
    expect(c.args).toContain('--share-net');
    expect(c.doorSocket).toBeUndefined();
    expect(c.args.slice(c.args.indexOf('--') + 1)).toEqual(['pi', '-p', 'task']);
  });
});

describe('sandboxedCommand elsewhere', () => {
  it('has no sandbox for another platform, or for a port that is not one', () => {
    expect(sandboxedCommand('win32', opts())).toEqual({ unavailable: expect.stringContaining('win32') });
    expect(sandboxedCommand('linux', opts({ doorPort: 0 }))).toEqual({ unavailable: expect.stringContaining('port') });
  });
});

describe('sandboxStatus', () => {
  const runner = (res: Awaited<ReturnType<ProbeRunner>>): ProbeRunner & { calls: string[][] } => {
    const calls: string[][] = [];
    const run = (async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return res; }) as ProbeRunner & { calls: string[][] };
    run.calls = calls;
    return run;
  };

  it('is available when the probe — the real wrapped command around `true` — succeeds', async () => {
    const run = runner({ ok: true });
    expect(await sandboxStatus('linux', run)).toEqual({ available: true });
    expect(run.calls[0][0]).toBe('bwrap');
    expect(run.calls[0]).toContain('--unshare-all');
    expect(run.calls[0].at(-1)).toBe('true');
  });

  it('names the package when bwrap is missing', async () => {
    expect(await sandboxStatus('linux', runner({ ok: false, code: 'ENOENT', detail: 'spawn bwrap ENOENT' })))
      .toEqual({ available: false, reason: expect.stringContaining('sudo apt install bubblewrap') });
  });

  it('says why when bwrap is there but cannot make a sandbox (user namespaces refused)', async () => {
    const status = await sandboxStatus('linux', runner({ ok: false, detail: 'bwrap: setting up uid map: Permission denied' }));
    expect(status).toEqual({ available: false, reason: expect.stringContaining('setting up uid map: Permission denied') });
  });

  it('probes sandbox-exec on macOS and refuses other platforms without probing', async () => {
    const mac = runner({ ok: true });
    expect(await sandboxStatus('darwin', mac)).toEqual({ available: true });
    expect(mac.calls[0][0]).toBe(SANDBOX_EXEC);
    const win = runner({ ok: true });
    expect(await sandboxStatus('win32', win)).toEqual({ available: false, reason: expect.stringContaining('win32') });
    expect(win.calls).toEqual([]);
  });
});

/** Runs a command and resolves with its exit code and output, never rejecting. */
const exec = (cmd: string, args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((ok) => execFile(cmd, args, { cwd, timeout: 15_000 }, (err, stdout, stderr) =>
    ok({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr })));

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return (server.address() as { port: number }).port;
};

/** A node one-liner that GETs `url` and prints the body or `FAIL`. */
const fetchScript = (url: string): string =>
  `fetch(${JSON.stringify(url)}).then((r) => r.text()).then((t) => console.log(t), () => console.log('FAIL'))`;

describe('the door, reached from inside', () => {
  let dir: string;
  let door: Server;
  let other: Server;
  let doorPort: number;
  let otherPort: number;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'agenthub-sandbox-')));
    door = createServer((_q, r) => r.end('door'));
    other = createServer((_q, r) => r.end('other'));
    doorPort = await listen(door);
    otherPort = await listen(other);
  });

  afterEach(async () => {
    await new Promise((ok) => door.close(ok));
    await new Promise((ok) => other.close(ok));
    await rm(dir, { recursive: true, force: true });
  });

  it("pipes the Linux bridge's loopback port through the hub's unix socket to the door", async () => {
    // The bridge's two halves without bwrap: outside a network namespace its listen port has to
    // differ from the door's, which inside one it does not.
    const sock = join(dir, 'door.sock');
    const bridge = await serveDoorSocket(sock, doorPort);
    const probe = createServer();
    const inner = await listen(probe);
    await new Promise((ok) => probe.close(ok));
    try {
      const res = await exec(process.execPath, [
        '-e', DOOR_BRIDGE_SOURCE, sock, String(inner), process.execPath, '-e', fetchScript(`http://127.0.0.1:${inner}/`),
      ]);
      expect(res.code).toBe(0);
      expect(res.stdout.trim()).toBe('door');
    } finally {
      await bridge.close();
    }
  });

  const seatbelt = process.platform === 'darwin' && existsSync(SANDBOX_EXEC);
  it.skipIf(!seatbelt)('on this Mac: writes land inside the workspace only, and only the door answers', async () => {
    const workspace = join(dir, 'ws');
    const runTmp = join(dir, 'tmp');
    const outside = join(dir, 'outside');
    await exec('mkdir', ['-p', workspace, runTmp]);
    const run = (argv: string[]) => {
      const c = sandboxedCommand('darwin', { workspace, tmpDir: runTmp, doorPort, allowNetwork: false, argv });
      if ('unavailable' in c) throw new Error(c.unavailable);
      return exec(c.cmd, c.args, workspace);
    };

    const sh = await run(['sh', '-c', `echo x > ${outside} ; echo y > ./inside`]);
    expect(await readFile(join(workspace, 'inside'), 'utf8')).toBe('y\n');
    expect(existsSync(outside)).toBe(false);
    expect(sh.stderr).toContain('Operation not permitted');

    const reach = async (port: number) => (await run([process.execPath, '-e', fetchScript(`http://127.0.0.1:${port}/`)])).stdout.trim();
    expect(await reach(doorPort)).toBe('door');
    expect(await reach(otherPort)).toBe('FAIL');
  });
});
