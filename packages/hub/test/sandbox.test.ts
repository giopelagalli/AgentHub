import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DOOR_BRIDGE_SOURCE, HTTPS_ON_LINUX, SANDBOX_EXEC, hiddenPaths, sandboxedCommand, sandboxStatus, serveDoorSocket,
  type ProbeRunner, type SandboxOptions,
} from '../src/agents/harness/sandbox.js';

const opts = (over: Partial<SandboxOptions> = {}): SandboxOptions => ({
  workspace: '/data/projects/demo/workspace', tmpDir: '/tmp/agenthub-pi-x', door: { host: '127.0.0.1', port: 4555 },
  writableWorkspace: true, hidden: [], argv: ['pi', '-p', 'task'], ...over,
});

/** `run` as consecutive items somewhere in `args`. */
const hasRun = (args: string[], ...run: string[]): boolean =>
  args.some((_, i) => run.every((v, j) => args[i + j] === v));
/** Where a consecutive `run` starts in `args`, or -1. */
const runAt = (args: string[], ...run: string[]): number =>
  args.findIndex((_, i) => run.every((v, j) => args[i + j] === v));

/** The Seatbelt profile with each `(param "Pn")` replaced by the path it was given. */
function resolvedProfile(args: string[]): string {
  let profile = args[1];
  for (let i = 2; args[i] === '-D'; i += 2) {
    const [name, ...value] = args[i + 1].split('=');
    profile = profile.replaceAll(`(param "${name}")`, `"${value.join('=')}"`);
  }
  return profile;
}
const allowsWrite = (profile: string, path: string): boolean => profile.includes(`(allow file-write* (subpath "${path}"))`);

describe('sandboxedCommand on macOS', () => {
  it('runs the command under a deny-default Seatbelt profile, writable workspace and temp dir, door only', () => {
    const c = sandboxedCommand('darwin', opts());
    if ('unavailable' in c) throw new Error(c.unavailable);
    expect(c.cmd).toBe(SANDBOX_EXEC);
    expect(c.doorSocket).toBeUndefined();
    const profile = resolvedProfile(c.args);
    expect(profile).toContain('(deny default)');
    expect(profile).not.toContain('(allow default)');
    expect(allowsWrite(profile, '/data/projects/demo/workspace')).toBe(true);
    expect(allowsWrite(profile, '/tmp/agenthub-pi-x')).toBe(true);
    expect(profile).toContain('(allow network-outbound (remote ip "localhost:4555"))');
    expect(profile).not.toContain('network*');
    expect(c.args.slice(-3)).toEqual(['pi', '-p', 'task']);
  });

  it('hides secrets, re-allows the bundle and workspace inside them in that order, and keeps them unwritable', () => {
    const c = sandboxedCommand('darwin', opts({
      hidden: [{ path: '/data', dir: true }, { path: '/home/me/.ssh', dir: true }], readable: '/data/projects/demo',
    }));
    if ('unavailable' in c) throw new Error(c.unavailable);
    const profile = resolvedProfile(c.args);
    const deny = profile.indexOf('(deny file-read-data file-read-xattr (subpath "/data"))');
    const bundle = profile.indexOf('(allow file-read-data file-read-xattr (subpath "/data/projects/demo"))');
    const workspace = profile.indexOf('(allow file-read-data file-read-xattr (subpath "/data/projects/demo/workspace"))');
    const writes = profile.indexOf('(allow file-write* (subpath "/data/projects/demo/workspace"))');
    expect(deny).toBeGreaterThan(-1);
    expect(profile.indexOf('(deny file-write* (subpath "/data"))')).toBeGreaterThan(deny);
    expect(bundle).toBeGreaterThan(deny);
    expect(workspace).toBeGreaterThan(bundle);
    // The last matching rule wins, so the workspace's write comes after the data root's deny.
    expect(writes).toBeGreaterThan(profile.indexOf('(deny file-write* (subpath "/data"))'));
    expect(profile).toContain('(deny file-read-data file-read-xattr (subpath "/home/me/.ssh"))');
    expect(profile).toContain('(deny file-write* (subpath "/home/me/.ssh"))');
    expect(allowsWrite(profile, '/data/projects/demo')).toBe(false);
  });

  it('leaves the workspace out of the write rule for the read-only policy', () => {
    const c = sandboxedCommand('darwin', opts({ writableWorkspace: false }));
    if ('unavailable' in c) throw new Error(c.unavailable);
    const profile = resolvedProfile(c.args);
    expect(allowsWrite(profile, '/data/projects/demo/workspace')).toBe(false);
    expect(allowsWrite(profile, '/tmp/agenthub-pi-x')).toBe(true);
    expect(profile).toContain('(allow file-read-data file-read-xattr (subpath "/data/projects/demo/workspace"))');
  });
});

describe('sandboxedCommand on Linux', () => {
  it('runs bwrap with a read-only root, the workspace and temp dir writable, no network, and the door bridge', () => {
    const c = sandboxedCommand('linux', opts());
    if ('unavailable' in c) throw new Error(c.unavailable);
    expect(c.cmd).toBe('bwrap');
    for (const run of [
      ['--ro-bind', '/', '/'], ['--tmpfs', '/tmp'], ['--tmpfs', '/run'],
      ['--bind', '/data/projects/demo/workspace', '/data/projects/demo/workspace'],
      ['--bind', '/tmp/agenthub-pi-x', '/tmp/agenthub-pi-x'],
      ['--chdir', '/data/projects/demo/workspace'], ['--unshare-all'], ['--die-with-parent'], ['--new-session'],
    ]) expect(hasRun(c.args, ...run), run.join(' ')).toBe(true);
    expect(c.args).not.toContain('--share-net');
    // The binds land on the fresh /tmp, so they must come after it.
    expect(runAt(c.args, '--bind', '/tmp/agenthub-pi-x')).toBeGreaterThan(runAt(c.args, '--tmpfs', '/tmp'));
    expect(c.doorSocket).toBe('/tmp/agenthub-pi-x/door.sock');
    expect(c.args.slice(c.args.indexOf('--') + 1)).toEqual([
      process.execPath, '-e', DOOR_BRIDGE_SOURCE, '/tmp/agenthub-pi-x/door.sock', '127.0.0.1', '4555', 'pi', '-p', 'task',
    ]);
  });

  it('hides a data root with a tmpfs, a key file with /dev/null, then binds the bundle and workspace back', () => {
    const c = sandboxedCommand('linux', opts({
      hidden: [{ path: '/data', dir: true }, { path: '/etc/agenthub/app.pem', dir: false }], readable: '/data/projects/demo',
    }));
    if ('unavailable' in c) throw new Error(c.unavailable);
    const hide = runAt(c.args, '--tmpfs', '/data');
    const bundle = runAt(c.args, '--ro-bind', '/data/projects/demo', '/data/projects/demo');
    const workspace = runAt(c.args, '--bind', '/data/projects/demo/workspace', '/data/projects/demo/workspace');
    expect(hide).toBeGreaterThan(-1);
    expect(bundle).toBeGreaterThan(hide);
    expect(workspace).toBeGreaterThan(bundle);
    expect(hasRun(c.args, '--ro-bind', '/dev/null', '/etc/agenthub/app.pem')).toBe(true);
  });

  it('binds the workspace read-only for the read-only policy', () => {
    const c = sandboxedCommand('linux', opts({ writableWorkspace: false }));
    if ('unavailable' in c) throw new Error(c.unavailable);
    expect(hasRun(c.args, '--ro-bind', '/data/projects/demo/workspace', '/data/projects/demo/workspace')).toBe(true);
    expect(hasRun(c.args, '--bind', '/data/projects/demo/workspace')).toBe(false);
  });
});

describe('the https network (claude-code, decision 0064)', () => {
  const https = (over: Partial<SandboxOptions> = {}): SandboxOptions => ({
    workspace: '/data/projects/demo/workspace', tmpDir: '/tmp/agenthub-claude-x', https: true, keychain: true,
    writableWorkspace: true, hidden: [], argv: ['claude', '-p', '--', 'task'], ...over,
  } as SandboxOptions);

  it('on macOS allows outbound 443, name resolution and the keychain, and no door', () => {
    const c = sandboxedCommand('darwin', https());
    if ('unavailable' in c) throw new Error(c.unavailable);
    const profile = resolvedProfile(c.args);
    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(allow network-outbound (remote tcp "*:443"))');
    expect(profile).toContain('(allow network-outbound (literal "/private/var/run/mDNSResponder"))');
    expect(profile).toContain('(global-name "com.apple.SecurityServer")');
    expect(profile).not.toContain('localhost:');
    expect(profile).not.toContain('network*');
    expect(allowsWrite(profile, '/data/projects/demo/workspace')).toBe(true);
    expect(allowsWrite(profile, '/tmp/agenthub-claude-x')).toBe(true);
    expect(c.args.slice(-4)).toEqual(['claude', '-p', '--', 'task']);
  });

  it('reaches the keychain only when asked, and pi never is', () => {
    for (const o of [https({ keychain: false }), opts()]) {
      const c = sandboxedCommand('darwin', o);
      if ('unavailable' in c) throw new Error(c.unavailable);
      expect(resolvedProfile(c.args)).not.toContain('SecurityServer');
    }
  });

  it('is unavailable on Linux, where bwrap could only share the whole host network, loopback included', async () => {
    expect(sandboxedCommand('linux', https())).toEqual({ unavailable: HTTPS_ON_LINUX });
    const asked: string[][] = [];
    const run: ProbeRunner = async (_cmd, args) => { asked.push(args); return { ok: true }; };
    expect(await sandboxStatus({ https: true, platform: 'linux', run })).toEqual({ available: false, reason: HTTPS_ON_LINUX });
    expect(asked).toEqual([]);
    // pi's door sandbox on Linux is unaffected.
    expect(await sandboxStatus({ platform: 'linux', run })).toEqual({ available: true });
  });

  it('probes the https sandbox on macOS with the network rule it will run with', async () => {
    const asked: string[][] = [];
    const run: ProbeRunner = async (_cmd, args) => { asked.push(args); return { ok: true }; };
    expect(await sandboxStatus({ https: true, platform: 'darwin', run })).toEqual({ available: true });
    expect(resolvedProfile(asked[0])).toContain('(allow network-outbound (remote tcp "*:443"))');
  });
});

describe('sandboxedCommand refusals', () => {
  it('refuses a door that is not on loopback — a hub bound to one address (HUB_HOST)', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(sandboxedCommand(platform, opts({ door: { host: '100.64.0.7', port: 4000 } })))
        .toEqual({ unavailable: expect.stringContaining('HUB_HOST=100.64.0.7') });
    }
    expect('cmd' in sandboxedCommand('linux', opts({ door: { host: '::1', port: 4000 } }))).toBe(true);
  });

  it('has no sandbox for another platform, or for a port that is not one', () => {
    expect(sandboxedCommand('win32', opts())).toEqual({ unavailable: expect.stringContaining('win32') });
    expect(sandboxedCommand('linux', opts({ door: { host: '127.0.0.1', port: 0 } }))).toEqual({ unavailable: expect.stringContaining('port') });
  });
});

describe('hiddenPaths', () => {
  let dir: string;
  beforeEach(async () => { dir = await realpath(await mkdtemp(join(tmpdir(), 'agenthub-hidden-'))); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('hides what exists, and gives the bundle back when the workspace is versioned in it', async () => {
    const data = join(dir, 'data');
    const bundle = join(data, 'projects', 'demo');
    const workspace = join(bundle, 'workspace');
    await mkdir(join(bundle, '.git'), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await mkdir(join(dir, 'home', '.ssh'), { recursive: true });
    await writeFile(join(dir, 'key.pem'), 'k');

    const found = hiddenPaths({ home: join(dir, 'home'), dataRoot: data, githubKeyPath: join(dir, 'key.pem'), configsDir: join(dir, 'nope') }, workspace);
    expect(found.hidden).toEqual([
      { path: data, dir: true }, { path: join(dir, 'key.pem'), dir: false }, { path: join(dir, 'home', '.ssh'), dir: true },
    ]);
    expect(found.readable).toBe(bundle);

    // A workspace with its own repository (an imported project) needs nothing above it.
    await mkdir(join(workspace, '.git'));
    expect(hiddenPaths({ home: join(dir, 'home'), dataRoot: data }, workspace).readable).toBeUndefined();
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
    expect(await sandboxStatus({ platform: 'linux', run })).toEqual({ available: true });
    expect(run.calls[0][0]).toBe('bwrap');
    expect(run.calls[0]).toContain('--unshare-all');
    expect(run.calls[0].at(-1)).toBe('true');
  });

  it('names the package when bwrap is missing', async () => {
    expect(await sandboxStatus({ platform: 'linux', run: runner({ ok: false, code: 'ENOENT', detail: 'spawn bwrap ENOENT' }) }))
      .toEqual({ available: false, reason: expect.stringContaining('sudo apt install bubblewrap') });
  });

  it('says why when bwrap is there but cannot make a sandbox (user namespaces refused)', async () => {
    const status = await sandboxStatus({ platform: 'linux', run: runner({ ok: false, detail: 'bwrap: setting up uid map: Permission denied' }) });
    expect(status).toEqual({ available: false, reason: expect.stringContaining('setting up uid map: Permission denied') });
  });

  it('refuses a door off loopback without probing', async () => {
    const run = runner({ ok: true });
    expect(await sandboxStatus({ doorBase: 'http://100.64.0.7:4000', platform: 'darwin', run }))
      .toEqual({ available: false, reason: expect.stringContaining('not loopback') });
    expect(run.calls).toEqual([]);
    expect(await sandboxStatus({ doorBase: 'http://127.0.0.1:4000', platform: 'darwin', run })).toEqual({ available: true });
  });

  it('probes sandbox-exec on macOS and refuses other platforms without probing', async () => {
    const mac = runner({ ok: true });
    expect(await sandboxStatus({ platform: 'darwin', run: mac })).toEqual({ available: true });
    expect(mac.calls[0][0]).toBe(SANDBOX_EXEC);
    const win = runner({ ok: true });
    expect(await sandboxStatus({ platform: 'win32', run: win })).toEqual({ available: false, reason: expect.stringContaining('win32') });
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

describe('inside a real sandbox', () => {
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
    const bridge = await serveDoorSocket(sock, { host: '127.0.0.1', port: doorPort });
    const probe = createServer();
    const inner = await listen(probe);
    await new Promise((ok) => probe.close(ok));
    try {
      const res = await exec(process.execPath, [
        '-e', DOOR_BRIDGE_SOURCE, sock, '127.0.0.1', String(inner), process.execPath, '-e', fetchScript(`http://127.0.0.1:${inner}/`),
      ]);
      expect(res.code).toBe(0);
      expect(res.stdout.trim()).toBe('door');
    } finally {
      await bridge.close();
    }
  });

  const seatbelt = process.platform === 'darwin' && existsSync(SANDBOX_EXEC);
  describe.skipIf(!seatbelt)('on this Mac', () => {
    let data: string;
    let bundle: string;
    let workspace: string;
    let runTmp: string;
    let home: string;
    const run = (argv: string[], writableWorkspace = true) => {
      const c = sandboxedCommand('darwin', {
        workspace, tmpDir: runTmp, door: { host: '127.0.0.1', port: doorPort }, writableWorkspace,
        ...hiddenPaths({ home, dataRoot: data }, workspace), argv,
      });
      if ('unavailable' in c) throw new Error(c.unavailable);
      return exec(c.cmd, c.args, workspace);
    };

    beforeEach(async () => {
      data = join(dir, 'data');
      bundle = join(data, 'projects', 'demo');
      workspace = join(bundle, 'workspace');
      runTmp = join(dir, 'tmp');
      home = join(dir, 'home');
      for (const d of [workspace, join(data, 'projects', 'other'), runTmp, join(home, '.ssh')]) await mkdir(d, { recursive: true });
      await writeFile(join(workspace, 'mine.txt'), 'mine');
      await writeFile(join(bundle, 'team.yaml'), 'team');
      await writeFile(join(data, 'projects', 'other', 'secret.txt'), 'theirs');
      await writeFile(join(data, 'hub.db'), 'db');
      await writeFile(join(home, '.ssh', 'id'), 'key');
      expect((await exec('git', ['init', '-q', bundle])).code).toBe(0);
    });

    it('writes land inside the workspace only, and only the door answers', async () => {
      const outside = join(dir, 'outside');
      const sh = await run(['sh', '-c', `echo x > ${outside} ; echo y > ./inside`]);
      expect(await readFile(join(workspace, 'inside'), 'utf8')).toBe('y\n');
      expect(existsSync(outside)).toBe(false);
      expect(sh.stderr).toContain('Operation not permitted');

      const reach = async (port: number) => (await run([process.execPath, '-e', fetchScript(`http://127.0.0.1:${port}/`)])).stdout.trim();
      expect(await reach(doorPort)).toBe('door');
      expect(await reach(otherPort)).toBe('FAIL');
    });

    it("another project, the hub's data and ~/.ssh are unreadable; the workspace, its bundle and git are not", async () => {
      const cat = async (path: string) => (await run(['cat', path])).stdout;
      expect(await cat(join(data, 'projects', 'other', 'secret.txt'))).toBe('');
      expect(await cat(join(data, 'hub.db'))).toBe('');
      expect(await cat(join(home, '.ssh', 'id'))).toBe('');
      expect(await cat('mine.txt')).toBe('mine');
      expect(await cat('../team.yaml')).toBe('team');
      const git = await run(['git', 'status', '--porcelain']);
      expect(git.code).toBe(0);
      expect(git.stdout).toContain('workspace/');
    });

    it('the read-only policy cannot write the workspace either', async () => {
      const sh = await run(['sh', '-c', 'echo y > ./inside'], false);
      expect(existsSync(join(workspace, 'inside'))).toBe(false);
      expect(sh.stderr).toContain('Operation not permitted');
      expect((await run(['cat', 'mine.txt'], false)).stdout).toBe('mine');
    });
  });
});
