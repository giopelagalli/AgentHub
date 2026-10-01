import { connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { createHub, type Hub } from '../src/server.js';

/**
 * node-pty is a native module: it needs a compiler (Xcode command line tools, build-essential) at
 * install time. Where it could not build, the whole terminal is absent rather than broken, and
 * these tests say so instead of failing.
 */
let terminal: typeof import('../src/projects/terminal.js') | null = null;
let ptyError = '';
try {
  terminal = await import('../src/projects/terminal.js');
} catch (err) {
  ptyError = (err as Error).message;
}
const describeWithPty = terminal ? describe : describe.skip;
if (!terminal) {
  console.warn(`[terminal.test] skipped: node-pty did not load (${ptyError}). Install build tools and reinstall.`);
}

const PASSWORD = 'let-me-in';
const DAEMON_TOKEN = 'daemon-token-abc';

let hub: Hub | undefined;
let app: FastifyInstance | undefined;
let root: string | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await hub?.stop();
  await app?.close();
  if (root) await rm(root, { recursive: true, force: true });
  hub = undefined; app = undefined; root = undefined;
});

/** A raw upgrade request, so the status line the hub answers with is visible. */
function handshake(port: number, path: string, headers: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write([
        `GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: Upgrade', 'Upgrade: websocket',
        'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...headers, '', '',
      ].join('\r\n'));
    });
    let buf = '';
    socket.on('data', (chunk) => {
      buf += String(chunk);
      const end = buf.indexOf('\r\n');
      if (end < 0) return;
      socket.destroy();
      resolve(buf.slice(0, end));
    });
    socket.on('error', reject);
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('handshake timed out')); });
  });
}

/** The plugin on its own server, with a stub project store, a predictable shell and a fake clock. */
async function serve(opts: { now?: () => number; sweepMs?: number } = {}): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'agenthub-term-'));
  app = Fastify();
  await app.register(websocket);
  await app.register(terminal!.terminalRoutes, {
    projects: { get: async (slug: string) => { if (slug !== 'demo') throw new Error('unknown'); return { workspace: root! }; } },
    shell: '/bin/sh',
    ...opts,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return `ws://127.0.0.1:${(app.server.address() as { port: number }).port}`;
}

function open(base: string, slug = 'demo'): Promise<WebSocket> {
  const socket = new WebSocket(`${base}/api/projects/${slug}/terminal`);
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

/** Collects output until `match` shows up, so a test never depends on chunk boundaries. */
function waitFor(socket: WebSocket, match: RegExp, ms = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(() => reject(new Error(`never saw ${match}; got: ${JSON.stringify(seen)}`)), ms);
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      seen += data.toString('utf8');
      if (match.test(seen)) { clearTimeout(timer); resolve(seen); }
    });
  });
}

const closed = (socket: WebSocket): Promise<{ code: number; reason: string }> =>
  new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason: String(reason) })));

/** Polls until the pid is gone; false if it outlived the wait. */
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i += 1) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** Runs `echo PID=$$` and returns the shell's own pid, which is its process group's id too. */
async function shellPid(socket: WebSocket): Promise<number> {
  const output = waitFor(socket, /PID=\d+/);
  type(socket, 'echo PID=$$\n');
  const pid = Number(/PID=(\d+)/.exec(await output)![1]);
  expect(pid).toBeGreaterThan(0);
  return pid;
}

const type = (socket: WebSocket, line: string): void => { socket.send(Buffer.from(line, 'utf8'), { binary: true }); };

const PATH = '/api/projects/demo/terminal';

/** A hub with a password, listening, plus its port and a logged-in cookie. */
async function guardedHub(): Promise<{ port: number; cookie: string }> {
  hub = createHub({ auth: { password: PASSWORD, daemonToken: DAEMON_TOKEN, sessionSecret: 'test-secret' } });
  await hub.app.listen({ port: 0, host: '127.0.0.1' });
  const login = await hub.app.inject({ method: 'POST', url: '/api/login', payload: { password: PASSWORD } });
  return {
    port: (hub.app.server.address() as { port: number }).port,
    cookie: String(login.headers['set-cookie']).split(';')[0]!,
  };
}

describeWithPty('terminal route auth', () => {
  it('refuses the upgrade without an owner session, and with the daemon bearer', async () => {
    const { port, cookie } = await guardedHub();
    expect(await handshake(port, PATH)).toContain('401 Unauthorized');
    expect(await handshake(port, PATH, [`Authorization: Bearer ${DAEMON_TOKEN}`])).toContain('401 Unauthorized');
    expect(await handshake(port, PATH, [`Cookie: ${cookie}`])).toContain('101 Switching Protocols');
  });

  it('refuses a node\'s own token, which is a credential for jobs and not for shells', async () => {
    const { port, cookie } = await guardedHub();
    const minted = await hub!.app.inject({
      method: 'POST', url: '/api/nodes/enrollment-tokens', headers: { cookie }, payload: { name: 'strix' },
    });
    const enrolled = await hub!.app.inject({
      method: 'POST', url: '/api/nodes/enroll',
      payload: { token: (minted.json() as { token: string }).token, name: 'strix', arch: 'x86_64' },
    });
    const nodeToken = (enrolled.json() as { nodeToken: string }).nodeToken;
    // The token is real: it drives the node's own routes.
    const heartbeat = await hub!.app.inject({
      method: 'POST', url: '/api/nodes/strix/heartbeat', headers: { authorization: `Bearer ${nodeToken}` },
    });
    expect(heartbeat.statusCode).toBe(200);
    expect(await handshake(port, PATH, [`Authorization: Bearer ${nodeToken}`])).toContain('401 Unauthorized');
  });

  it('refuses an upgrade a cross-origin page asked for, even with the session cookie', async () => {
    const { port, cookie } = await guardedHub();
    const cookieHeader = `Cookie: ${cookie}`;
    expect(await handshake(port, PATH, [cookieHeader, 'Origin: https://evil.example'])).toContain('403 Forbidden');
    // Same host, wrong port is still another origin, and a shell is too much to lose to it.
    expect(await handshake(port, PATH, [cookieHeader, `Origin: http://127.0.0.1:${port + 1}`])).toContain('403 Forbidden');
    expect(await handshake(port, PATH, [cookieHeader, `Origin: http://127.0.0.1:${port}`])).toContain('101 Switching Protocols');
  });

  it('is not there at all on a hub with no password', async () => {
    hub = createHub({});
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (hub.app.server.address() as { port: number }).port;
    // No route, so no shell: `owner` means nothing where there is no credential to hold.
    expect(await handshake(port, PATH)).toContain('404');
  });

  it('classifies the route as the owner\'s, and checks the origin itself', async () => {
    const { routeAccess } = await import('../src/auth.js');
    expect(routeAccess('GET', terminal!.TERMINAL_ROUTE)).toBe('owner');

    const { originAllowed } = terminal!;
    expect(originAllowed(undefined, 'spark:4000')).toBe(true);
    expect(originAllowed('http://spark:4000', 'spark:4000')).toBe(true);
    expect(originAllowed('http://spark:4001', 'spark:4000')).toBe(false);
    expect(originAllowed('https://evil.example', 'spark:4000')).toBe(false);
    expect(originAllowed('null', 'spark:4000')).toBe(false);
    expect(originAllowed('http://spark:4000', undefined)).toBe(false);
  });
});

describeWithPty('terminal session', () => {
  it('runs a shell in the workspace and echoes what it is told', async () => {
    const base = await serve();
    const socket = await open(base);
    const output = waitFor(socket, /hello-from-the-pty/);
    type(socket, 'echo hello-from-the-pty\n');
    expect(await output).toContain('hello-from-the-pty');
  });

  it('takes resize frames, and ignores a control frame it does not know', async () => {
    const base = await serve();
    const socket = await open(base);
    socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    socket.send(JSON.stringify({ type: 'resize', cols: -1, rows: 0 }));
    socket.send('not json at all');
    socket.send(JSON.stringify({ type: 'nonsense' }));
    const output = waitFor(socket, /still-alive/);
    type(socket, 'echo still-alive\n');
    expect(await output).toContain('still-alive');
  });

  it('refuses an unknown project before anything is spawned', async () => {
    const base = await serve();
    const socket = await open(base, 'nope');
    expect((await closed(socket)).reason).toBe('unknown project');
  });

  it(`carries ${4} terminals at a time and refuses the fifth`, async () => {
    const base = await serve();
    for (let i = 0; i < terminal!.MAX_TERMINALS; i += 1) await open(base);
    const extra = await open(base);
    const end = await closed(extra);
    expect(end.code).toBe(1013);
    expect(end.reason).toContain('4 terminals');
  });

  it('closes a session that has been idle past the timeout', async () => {
    let clock = Date.now();
    const base = await serve({ now: () => clock, sweepMs: 10 });
    const socket = await open(base);
    // The prompt: the session exists and has stamped its last activity with the clock as it stands.
    await waitFor(socket, /\S/);
    clock += terminal!.TERMINAL_IDLE_MS + 1000;
    expect((await closed(socket)).reason).toBe('idle');
  });

  it('leaves no process behind when the socket closes', async () => {
    const base = await serve();
    const socket = await open(base);
    const pid = await shellPid(socket);
    socket.close();
    expect(await gone(pid)).toBe(true);
  });

  it('kills the shell outright when the hub itself goes down', async () => {
    const base = await serve();
    const socket = await open(base);
    const pid = await shellPid(socket);
    // Nothing may outlive the hub, so shutdown does not leave an escalation timer behind — it is
    // not going to be here to run one.
    await app!.close();
    expect(await gone(pid)).toBe(true);
  });
});

describeWithPty('control frames', () => {
  it('parses a resize and refuses anything else', () => {
    const { parseControl } = terminal!;
    expect(parseControl(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }))).toEqual({ type: 'resize', cols: 80, rows: 24 });
    expect(parseControl('{')).toBeNull();
    expect(parseControl(JSON.stringify({ type: 'resize', cols: 0, rows: 24 }))).toBeNull();
    expect(parseControl(JSON.stringify({ type: 'resize', cols: 80.5, rows: 24 }))).toBeNull();
    expect(parseControl(JSON.stringify({ type: 'resize', cols: 80, rows: 100000 }))).toBeNull();
    expect(parseControl(JSON.stringify({ type: 'write', data: 'rm -rf /' }))).toBeNull();
  });
});
