import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import WebSocket from 'ws';
import { routeAccess } from '../src/auth.js';
import { createHub, type Hub } from '../src/server.js';
import {
  parsePreviewPath, previewUrl, PreviewSupervisor, downstreamHeaders, upstreamHeaders, validatePreview,
} from '../src/projects/preview.js';
import type { PreviewStatus } from '@agenthub/shared';

let hub: Hub | undefined;
let root: string | undefined;

/**
 * An upstream that is not a dev server but answers like one: it echoes the request it got (so the
 * test can see which headers survived the proxy), it can be asked for a response that is cut off
 * mid-body, and it completes a WebSocket handshake by hand — then sends one text frame.
 */
const UPSTREAM = `
const http = require('node:http');
const crypto = require('node:crypto');
const server = http.createServer((req, res) => {
  if (req.url.includes('/cut')) {
    // Promises 1000 bytes, sends 3, then drops the socket: a dev server dying mid-response.
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '1000' });
    res.write('abc');
    setTimeout(() => res.socket.destroy(), 20);
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': 'sneaky=1',
      'x-kept': 'yes',
    });
    res.end(JSON.stringify({ url: req.url, method: req.method, headers: req.headers, body }));
  });
});
server.on('upgrade', (req, socket) => {
  const accept = crypto.createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n' +
    'Sec-WebSocket-Accept: ' + accept + '\\r\\n' +
    (req.headers['sec-websocket-protocol'] ? 'Sec-WebSocket-Protocol: ' + req.headers['sec-websocket-protocol'] + '\\r\\n' : '') +
    '\\r\\n');
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
  hub = createHub({ projectsRoot: root, preview: { host: '127.0.0.1' } });
  await hub.app.inject({
    method: 'POST', url: '/api/projects',
    payload: { slug: 'demo', title: 'Demo', intent: 'ship the demo' },
  });
  // The preview runs in the project's workspace, so the stand-in dev server lives there.
  await writeFile(join(root, 'demo', 'workspace', 'upstream.js'), UPSTREAM, 'utf8');
}

const app = (): Hub['app'] => {
  if (!hub) throw new Error('setup() not called');
  return hub.app;
};

/** Saves a preview and hands back its absolute address, which carries the capability. */
async function configure(port: number, cmd: string[] = ['node', 'upstream.js']): Promise<string> {
  const put = await app().inject({ method: 'PUT', url: '/api/projects/demo/preview', payload: { cmd, port } });
  expect(put.statusCode).toBe(200);
  const status = put.json() as PreviewStatus;
  expect(status.url).toMatch(/^http:\/\/[^/]+\/p\/demo\/[0-9a-f]{32}\/$/);
  return status.url!;
}

/** The preview listener answers on loopback, whatever host the status url happens to name. */
function local(url: string): string {
  const parsed = new URL(url);
  parsed.hostname = '127.0.0.1';
  return parsed.toString();
}

async function start(): Promise<PreviewStatus> {
  const started = await app().inject({ method: 'POST', url: '/api/projects/demo/preview/start' });
  return started.json() as PreviewStatus;
}

afterEach(async () => {
  await hub?.stop();
  if (root) await rm(root, { recursive: true, force: true });
  hub = undefined; root = undefined;
});

describe('validatePreview', () => {
  it('takes a non-empty argv, a port in range and an absolute path', () => {
    expect(validatePreview({ cmd: ['npm', 'run', 'dev'], port: 5173, path: '/app' }))
      .toEqual({ preview: { cmd: ['npm', 'run', 'dev'], port: 5173, path: '/app' } });
    expect(validatePreview({ cmd: ['npm'], port: 1024 })).toEqual({ preview: { cmd: ['npm'], port: 1024 } });
  });

  it('never takes a capability from the caller', () => {
    const validated = validatePreview({ cmd: ['npm'], port: 5173, cap: 'f'.repeat(32) });
    expect(validated).toEqual({ preview: { cmd: ['npm'], port: 5173 } });
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

describe('preview paths and addresses', () => {
  const cap = 'b'.repeat(32);

  it('only reads a path that names a slug and a 32-hex capability', () => {
    expect(parsePreviewPath(`/p/demo/${cap}/src/main.ts?v=1`)).toEqual({ slug: 'demo', cap, trailing: true });
    expect(parsePreviewPath(`/p/demo/${cap}`)).toEqual({ slug: 'demo', cap, trailing: false });
    expect(parsePreviewPath('/api/state')).toBeNull();
    expect(parsePreviewPath(`/p/demo/${'b'.repeat(31)}/`)).toBeNull();
    expect(parsePreviewPath(`/p/NOPE!/${cap}/`)).toBeNull();
    expect(parsePreviewPath(undefined)).toBeNull();
  });

  it('addresses the preview on its own port, or at the public base behind a proxy', () => {
    expect(previewUrl({ port: 4010 }, 'hub.local:4000', false, 'demo', cap))
      .toBe(`http://hub.local:4010/p/demo/${cap}/`);
    expect(previewUrl({ port: 4010 }, '[::1]:4000', false, 'demo', cap))
      .toBe(`http://[::1]:4010/p/demo/${cap}/`);
    expect(previewUrl({ port: 4010, publicBase: 'https://preview.example.com/' }, 'hub.example.com', true, 'demo', cap))
      .toBe(`https://preview.example.com/p/demo/${cap}/`);
  });
});

describe('proxy headers', () => {
  it('drops the hub\'s session cookie and points Host at loopback', () => {
    const out = upstreamHeaders({ cookie: 'hub_session=abc', authorization: 'Bearer x', host: 'hub.local', accept: '*/*' }, 5173);
    expect(out.cookie).toBeUndefined();
    expect(out.authorization).toBeUndefined();
    expect(out.host).toBe('127.0.0.1:5173');
    expect(out.accept).toBe('*/*');
  });

  it('drops the upstream\'s cookies and the hop-by-hop headers on the way back', () => {
    const out = downstreamHeaders({
      'set-cookie': ['a=1'], connection: 'keep-alive', 'transfer-encoding': 'chunked',
      'content-type': 'text/html',
    });
    expect(out['set-cookie']).toBeUndefined();
    expect(out.connection).toBeUndefined();
    expect(out['transfer-encoding']).toBeUndefined();
    expect(out['content-type']).toBe('text/html');
  });
});

describe('preview API', () => {
  it('validates the config, mints one capability and keeps it across saves', async () => {
    await setup();
    const bad = await app().inject({ method: 'PUT', url: '/api/projects/demo/preview', payload: { cmd: [], port: 5173 } });
    expect(bad.statusCode).toBe(400);

    const before = await app().inject({ method: 'GET', url: '/api/projects/demo/preview' });
    expect(before.json()).toMatchObject({ configured: false, running: false, url: null, base: null });

    const first = await configure(5173, ['npm', 'run', 'dev']);
    // The same address: re-saving the command must not break the link the owner already has.
    expect(await configure(5174, ['npm', 'run', 'serve'])).toBe(first);

    const cleared = await app().inject({ method: 'DELETE', url: '/api/projects/demo/preview' });
    expect(cleared.json()).toMatchObject({ configured: false, url: null });
  });

  it('mints a new capability on reset, and the old address stops working', async () => {
    await setup();
    const port = await freePort();
    const before = await configure(port);
    await start();
    expect((await fetch(local(before))).status).toBe(200);

    const rotated = await app().inject({ method: 'POST', url: '/api/projects/demo/preview/rotate' });
    const after = (rotated.json() as PreviewStatus).url!;
    expect(after).not.toBe(before);
    // Resetting the link stops the preview: the base path it was started with has just changed.
    expect((rotated.json() as PreviewStatus).running).toBe(false);
    expect((await fetch(local(before))).status).toBe(404);
  });

  it('refuses the hub\'s own ports, and answers 400/404 for a bad slug', async () => {
    await setup();
    await app().listen({ port: 0, host: '127.0.0.1' });
    const hubPort = (app().server.address() as { port: number }).port;
    const status = await configure(await freePort());
    const previewPort = Number(new URL(status).port);
    for (const port of [hubPort, previewPort]) {
      const clash = await app().inject({ method: 'PUT', url: '/api/projects/demo/preview', payload: { cmd: ['npm'], port } });
      expect(clash.statusCode).toBe(400);
    }
    expect((await app().inject({ method: 'GET', url: '/api/projects/NOPE!/preview' })).statusCode).toBe(400);
    expect((await app().inject({ method: 'GET', url: '/api/projects/ghost/preview' })).statusCode).toBe(404);
  });

  it('refuses to start a project with no preview configured, or a port already in use', async () => {
    await setup();
    expect((await app().inject({ method: 'POST', url: '/api/projects/demo/preview/start' })).statusCode).toBe(400);

    const squatter = createServer();
    await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
    const taken = (squatter.address() as { port: number }).port;
    await configure(taken);
    const started = await app().inject({ method: 'POST', url: '/api/projects/demo/preview/start' });
    expect(started.statusCode).toBe(409);
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
  });
});

describe('preview listener', () => {
  it('forwards the path unchanged, with no cookie either way', async () => {
    await setup();
    const port = await freePort();
    const url = await configure(port);
    expect(await start()).toMatchObject({ running: true, port });

    const res = await fetch(`${local(url)}src/main.ts?v=1`, { headers: { cookie: 'hub_session=secret' } });
    expect(res.status).toBe(200);
    // The dev server is built with this base path, so that is the path it is sent.
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-kept')).toBe('yes');
    const echoed = await res.json() as { url: string; headers: Record<string, string> };
    expect(echoed.url).toBe(`${new URL(url).pathname}src/main.ts?v=1`);
    expect(echoed.headers.cookie).toBeUndefined();
    expect(echoed.headers.host).toBe(`127.0.0.1:${port}`);
  });

  it('forwards a POST body too', async () => {
    await setup();
    const port = await freePort();
    const url = await configure(port);
    await start();
    const res = await fetch(`${local(url)}api/save`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hi: 1 }),
    });
    const echoed = await res.json() as { method: string; body: string };
    expect(echoed.method).toBe('POST');
    expect(echoed.body).toBe('{"hi":1}');
  });

  it('serves nothing but previews: no API, no UI, and no unknown capability', async () => {
    await setup();
    const port = await freePort();
    const url = await configure(port);
    await start();
    const origin = new URL(url).origin;
    for (const path of ['/api/state', '/', '/index.html', `/p/demo/${'0'.repeat(32)}/`, '/p/ghost/' + 'a'.repeat(32) + '/']) {
      expect((await fetch(`${origin}${path}`)).status).toBe(404);
    }
  });

  it('survives a response the dev server cuts off mid-body', async () => {
    await setup();
    const port = await freePort();
    const url = await configure(port);
    await start();
    await expect(fetch(`${local(url)}cut`).then((r) => r.text())).rejects.toThrow();
    // The hub is still here, and still answering for this preview.
    expect((await fetch(local(url))).status).toBe(200);
    expect((await app().inject({ method: 'GET', url: '/api/projects/demo/preview' })).statusCode).toBe(200);
  });

  it('passes a WebSocket upgrade through, subprotocol and all, without the cookie', async () => {
    await setup();
    const port = await freePort();
    const url = await configure(port);
    await start();

    const socket = new WebSocket(`${local(url).replace('http', 'ws')}`, ['vite-hmr'], {
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

  it('drops an upgrade that carries no capability, or the wrong one', async () => {
    await setup();
    const port = await freePort();
    const url = await configure(port);
    await start();
    const origin = new URL(url).origin.replace('http', 'ws');
    for (const path of [`/p/demo/${'0'.repeat(32)}/`, '/', '/ws']) {
      const socket = new WebSocket(`${origin}${path}`);
      await expect(new Promise((resolve, reject) => {
        socket.once('open', () => resolve('opened'));
        socket.once('error', reject);
        socket.once('close', () => reject(new Error('closed')));
      })).rejects.toThrow();
    }
  });

  it('answers 503 inside the iframe while nothing is running', async () => {
    await setup();
    const url = await configure(5173, ['npm', 'run', 'dev']);
    const res = await fetch(local(url));
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
    expect(await start()).toMatchObject({ running: true });

    const stopped = await app().inject({ method: 'POST', url: '/api/projects/demo/preview/stop' });
    expect(stopped.json()).toMatchObject({ running: false, crashed: false });
    // The port is free again only if the grandchild went down with the group.
    await expect(freeAgain(port)).resolves.toBe(true);
  });

  it('marks a preview that dies on its own as crashed, with its last lines', async () => {
    await setup();
    const port = await freePort();
    await configure(port, ['node', '-e', 'console.error("boom: missing dependency"); process.exit(1)']);
    const started = await start();
    expect(started).toMatchObject({ running: false, crashed: true });
    expect(started.log.join('\n')).toContain('boom: missing dependency');
  });

  it('joins two concurrent starts rather than spawning a second child', async () => {
    await setup();
    const port = await freePort();
    await configure(port);
    const supervisor = new PreviewSupervisor({ projects: hub!.projects });
    const [a, b] = await Promise.all([supervisor.start('demo'), supervisor.start('demo')]);
    expect(a).toMatchObject({ running: true });
    expect(b).toMatchObject({ running: true });
    await supervisor.stop('demo');
    // A second, orphaned child would still be holding the port.
    await expect(freeAgain(port)).resolves.toBe(true);
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

  it('stops a running preview whose config changed underneath it', async () => {
    await setup();
    const port = await freePort();
    await configure(port);
    expect(await start()).toMatchObject({ running: true });
    // What `set_preview` does: the manifest changes with no route involved.
    const bundle = await hub!.projects.get('demo');
    const manifest = await bundle.manifest();
    await bundle.setPreview({ ...manifest.preview!, cmd: ['node', '-e', 'setTimeout(()=>{},1e6)'] });
    const status = await app().inject({ method: 'GET', url: '/api/projects/demo/preview' });
    expect(status.json()).toMatchObject({ running: false });
  });
});

describe('preview access', () => {
  it('is not on the hub\'s origin at all', () => {
    expect(routeAccess('GET', '/preview/:slug/*')).toBe('none');
    expect(routeAccess('GET', '/api/projects/:slug/preview')).toBe('owner');
    expect(routeAccess('POST', '/api/projects/:slug/preview/rotate')).toBe('owner');
  });

  it('keeps the owner\'s routes behind the session', async () => {
    root = await mkdtemp(join(tmpdir(), 'agenthub-preview-'));
    hub = createHub({ projectsRoot: root, preview: { host: '127.0.0.1' }, auth: { password: 'hunter2', sessionSecret: 'secret' } });
    expect((await hub.app.inject({ method: 'GET', url: '/api/projects/demo/preview' })).statusCode).toBe(401);
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
