import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import WebSocket from 'ws';
import { routeAccess } from '../src/auth.js';
import { createHub, type Hub } from '../src/server.js';
import { PreviewSupervisor, upstreamHeaders, validatePreview } from '../src/projects/preview.js';

let hub: Hub | undefined;
let root: string | undefined;
let origin: string | undefined;

/**
 * An upstream that is not a dev server but answers like one: it echoes the request it got (so the
 * test can see which headers survived the proxy), and it completes a WebSocket handshake by hand —
 * without echoing the subprotocol, exactly as Vite's HMR server does — then sends one text frame.
 */
const UPSTREAM = `
const http = require('node:http');
const crypto = require('node:crypto');
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ url: req.url, method: req.method, headers: req.headers, body }));
  });
});
server.on('upgrade', (req, socket) => {
  const accept = crypto.createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n' +
    'Sec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
  const payload = Buffer.from(JSON.stringify({
    proto: req.headers['sec-websocket-protocol'] || '', cookie: req.headers.cookie || '',
  }));
  socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
});
console.log('listening');
server.listen(Number(process.env.PORT), '127.0.0.1');
`;

/** A port nothing is listening on, taken and released so the preview can bind it. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function setup(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'agenthub-preview-'));
  hub = createHub({ projectsRoot: root });
  await hub.app.inject({
    method: 'POST', url: '/api/projects',
    payload: { slug: 'demo', title: 'Demo', intent: 'ship the demo' },
  });
  // The preview runs in the project's workspace, so the stand-in dev server lives there.
  await writeFile(join(root, 'demo', 'workspace', 'upstream.js'), UPSTREAM, 'utf8');
}

/** Brings the hub up on a real port, which the proxy tests need for sockets and upgrades. */
async function listen(): Promise<string> {
  await hub!.app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = hub!.app.server.address() as { port: number };
  origin = `http://127.0.0.1:${port}`;
  return origin;
}

const app = (): Hub['app'] => {
  if (!hub) throw new Error('setup() not called');
  return hub.app;
};

async function configure(port: number, cmd: string[] = ['node', 'upstream.js']): Promise<void> {
  const put = await app().inject({ method: 'PUT', url: '/api/projects/demo/preview', payload: { cmd, port } });
  expect(put.statusCode).toBe(200);
}

afterEach(async () => {
  await hub?.stop();
  if (root) await rm(root, { recursive: true, force: true });
  hub = undefined; root = undefined; origin = undefined;
});

describe('validatePreview', () => {
  it('takes a non-empty argv, a port in range and an absolute path', () => {
    expect(validatePreview({ cmd: ['npm', 'run', 'dev'], port: 5173, path: '/app' }))
      .toEqual({ preview: { cmd: ['npm', 'run', 'dev'], port: 5173, path: '/app' } });
    expect(validatePreview({ cmd: ['npm'], port: 1024 })).toEqual({ preview: { cmd: ['npm'], port: 1024 } });
  });

  it('refuses an empty or non-string command', () => {
    expect(validatePreview({ cmd: [], port: 5173 })).toMatchObject({ error: expect.stringContaining('argv') });
    expect(validatePreview({ cmd: 'npm run dev', port: 5173 })).toMatchObject({ error: expect.stringContaining('argv') });
    expect(validatePreview({ cmd: ['npm', 7], port: 5173 })).toMatchObject({ error: expect.stringContaining('strings') });
  });

  it('refuses a privileged, out-of-range or non-integer port', () => {
    for (const port of [80, 0, 70000, 5173.5, '5173']) {
      expect(validatePreview({ cmd: ['npm'], port })).toMatchObject({ error: expect.stringContaining('port') });
    }
  });

  it('refuses a path that is not absolute', () => {
    expect(validatePreview({ cmd: ['npm'], port: 5173, path: 'app' })).toEqual({ error: 'path must start with /' });
  });
});

describe('upstreamHeaders', () => {
  it('drops the hub\'s session cookie and points Host at loopback', () => {
    const out = upstreamHeaders({ cookie: 'hub_session=abc', authorization: 'Bearer x', host: 'hub.local', accept: '*/*' }, 5173);
    expect(out.cookie).toBeUndefined();
    expect(out.authorization).toBeUndefined();
    expect(out.host).toBe('127.0.0.1:5173');
    expect(out.accept).toBe('*/*');
  });
});

describe('preview API', () => {
  it('validates the config, stores it and clears it', async () => {
    await setup();
    const bad = await app().inject({ method: 'PUT', url: '/api/projects/demo/preview', payload: { cmd: [], port: 5173 } });
    expect(bad.statusCode).toBe(400);

    const before = await app().inject({ method: 'GET', url: '/api/projects/demo/preview' });
    expect(before.json()).toMatchObject({ configured: false, running: false, url: '/preview/demo/' });

    await configure(5173, ['npm', 'run', 'dev']);
    const after = await app().inject({ method: 'GET', url: '/api/projects/demo/preview' });
    expect(after.json()).toMatchObject({ configured: true, running: false, port: 5173, url: '/preview/demo/' });

    const cleared = await app().inject({ method: 'DELETE', url: '/api/projects/demo/preview' });
    expect(cleared.json()).toMatchObject({ configured: false });
  });

  it('answers 400 for a malformed slug and 404 for an unknown project', async () => {
    await setup();
    expect((await app().inject({ method: 'GET', url: '/api/projects/NOPE!/preview' })).statusCode).toBe(400);
    expect((await app().inject({ method: 'GET', url: '/api/projects/ghost/preview' })).statusCode).toBe(404);
  });

  it('refuses to start a project with no preview configured', async () => {
    await setup();
    const start = await app().inject({ method: 'POST', url: '/api/projects/demo/preview/start' });
    expect(start.statusCode).toBe(400);
  });
});

describe('preview proxy', () => {
  it('forwards the path unchanged and strips the hub\'s cookie on the way', async () => {
    await setup();
    const port = await freePort();
    await configure(port);
    const base = await listen();

    const started = await app().inject({ method: 'POST', url: '/api/projects/demo/preview/start' });
    expect(started.json()).toMatchObject({ running: true, port });

    const res = await fetch(`${base}/preview/demo/src/main.ts?v=1`, { headers: { cookie: 'hub_session=secret' } });
    expect(res.status).toBe(200);
    const echoed = await res.json() as { url: string; headers: Record<string, string> };
    // The dev server is configured with /preview/demo/ as its base, so that is the path it is sent.
    expect(echoed.url).toBe('/preview/demo/src/main.ts?v=1');
    expect(echoed.headers.cookie).toBeUndefined();
    expect(echoed.headers.host).toBe(`127.0.0.1:${port}`);
  });

  it('forwards a POST body too', async () => {
    await setup();
    const port = await freePort();
    await configure(port);
    const base = await listen();
    await app().inject({ method: 'POST', url: '/api/projects/demo/preview/start' });

    const res = await fetch(`${base}/preview/demo/api/save`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hi: 1 }),
    });
    const echoed = await res.json() as { method: string; body: string };
    expect(echoed.method).toBe('POST');
    expect(echoed.body).toBe('{"hi":1}');
  });

  it('passes a WebSocket upgrade through, subprotocol and all, without the cookie', async () => {
    await setup();
    const port = await freePort();
    await configure(port);
    const base = await listen();
    await app().inject({ method: 'POST', url: '/api/projects/demo/preview/start' });

    // `ws` echoes the first requested subprotocol back to this client, the way the hub's socket
    // server does for a browser; the upstream is the one that never echoes.
    const socket = new WebSocket(`${base.replace('http', 'ws')}/preview/demo/`, ['vite-hmr'], {
      headers: { cookie: 'hub_session=secret' },
    });
    const first = await new Promise<string>((resolve, reject) => {
      socket.once('message', (data) => resolve(String(data)));
      socket.once('error', reject);
      setTimeout(() => reject(new Error('no frame from the preview')), 5000).unref();
    });
    socket.close();
    expect(JSON.parse(first)).toEqual({ proto: 'vite-hmr', cookie: '' });
  });

  it('answers 503 with a readable page while nothing is running', async () => {
    await setup();
    await configure(5173, ['npm', 'run', 'dev']);
    const base = await listen();
    const res = await fetch(`${base}/preview/demo/`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('not running');
  });
});

describe('preview supervisor', () => {
  it('stops the whole process group, so a wrapper\'s child dies with it', async () => {
    await setup();
    const port = await freePort();
    // A shell that backgrounds the server and then waits: killing only the direct child would
    // leave the node process holding the port.
    await configure(port, ['sh', '-c', 'node upstream.js & wait']);
    const started = await app().inject({ method: 'POST', url: '/api/projects/demo/preview/start' });
    expect(started.json()).toMatchObject({ running: true });

    const stopped = await app().inject({ method: 'POST', url: '/api/projects/demo/preview/stop' });
    expect(stopped.json()).toMatchObject({ running: false, crashed: false });
    // The port is free again only if the grandchild went down with the group.
    await expect(freeAgain(port)).resolves.toBe(true);
  });

  it('marks a preview that dies on its own as crashed, with its last lines', async () => {
    await setup();
    const port = await freePort();
    await configure(port, ['node', '-e', 'console.error("boom: missing dependency"); process.exit(1)']);
    const started = await app().inject({ method: 'POST', url: '/api/projects/demo/preview/start' });
    expect(started.json()).toMatchObject({ running: false, crashed: true });
    expect((started.json() as { log: string[] }).log.join('\n')).toContain('boom: missing dependency');
  });

  it('stops a preview nobody has looked at for the idle window, and leaves a watched one alone', async () => {
    await setup();
    const port = await freePort();
    await configure(port);
    let now = 1_000_000;
    const supervisor = new PreviewSupervisor({ projects: hub!.projects, now: () => now, idleMs: 30 * 60_000 });
    await supervisor.start('demo');
    expect(supervisor.portOf('demo')).toBe(port);

    now += 29 * 60_000;
    await supervisor.sweepIdle();
    expect(supervisor.portOf('demo')).toBe(port);

    // A proxied request at minute 29 buys another full window.
    supervisor.touch('demo');
    now += 29 * 60_000;
    await supervisor.sweepIdle();
    expect(supervisor.portOf('demo')).toBe(port);

    now += 31 * 60_000;
    await supervisor.sweepIdle();
    expect(supervisor.portOf('demo')).toBeNull();
    expect((await supervisor.status('demo')).log.join('\n')).toContain('nobody watching');
    await supervisor.stopAll();
  });
});

describe('preview access', () => {
  it('is the owner\'s: the proxy is not open the way the static UI is', () => {
    expect(routeAccess('GET', '/preview/:slug/*')).toBe('owner');
    expect(routeAccess('POST', '/preview/:slug/*')).toBe('owner');
    expect(routeAccess('GET', '/api/projects/:slug/preview')).toBe('owner');
  });

  it('answers 401 without a session', async () => {
    root = await mkdtemp(join(tmpdir(), 'agenthub-preview-'));
    hub = createHub({ projectsRoot: root, auth: { password: 'hunter2', sessionSecret: 'secret' } });
    const base = await listen();
    expect((await fetch(`${base}/preview/demo/`)).status).toBe(401);
    expect((await fetch(`${base}/api/projects/demo/preview`)).status).toBe(401);
  });
});

/** True once nothing answers on `port` any more. */
async function freeAgain(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const listening = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once('error', () => resolve(true));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(false)));
    });
    if (!listening) return true;
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  return false;
}
