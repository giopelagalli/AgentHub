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
        `GET ${path} HTTP/1.1`, 'Host: 127.0.0.1', 'Connection: Upgrade', 'Upgrade: websocket',
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

const type = (socket: WebSocket, line: string): void => { socket.send(Buffer.from(line, 'utf8'), { binary: true }); };

describeWithPty('terminal route auth', () => {
  it('refuses the upgrade without an owner session, and with the daemon bearer', async () => {
    hub = createHub({ auth: { password: PASSWORD, daemonToken: DAEMON_TOKEN, sessionSecret: 'test-secret' } });
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (hub.app.server.address() as { port: number }).port;
    const path = '/api/projects/demo/terminal';

    expect(await handshake(port, path)).toContain('401 Unauthorized');
    expect(await handshake(port, path, [`Authorization: Bearer ${DAEMON_TOKEN}`])).toContain('401 Unauthorized');

    const login = await hub.app.inject({ method: 'POST', url: '/api/login', payload: { password: PASSWORD } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    expect(await handshake(port, path, [`Cookie: ${cookie}`])).toContain('101 Switching Protocols');
  });

  it('classifies the route as the owner\'s', async () => {
    const { routeAccess } = await import('../src/auth.js');
    expect(routeAccess('GET', terminal!.TERMINAL_ROUTE)).toBe('owner');
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
    const output = waitFor(socket, /PID=\d+/);
    type(socket, 'echo PID=$$\n');
    const pid = Number(/PID=(\d+)/.exec(await output)![1]);
    expect(pid).toBeGreaterThan(0);

    socket.close();
    const gone = async (): Promise<boolean> => {
      for (let i = 0; i < 100; i += 1) {
        try { process.kill(pid, 0); } catch { return true; }
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    };
    expect(await gone()).toBe(true);
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
