import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { createHub, type Hub } from '../../hub/src/server.js';
import { loadConfig, type DaemonConfig } from '../src/config.js';
import { Daemon } from '../src/daemon.js';
import { FakeDriver, FAKE_JPEG, MAX_LINKS, MAX_TEXT, type BrowserDriver } from '../src/browser/driver.js';
import { createBrowserServer } from '../src/browser/server.js';

const MOCK_SERVE = join(process.cwd(), 'packages/mocks/src/serve.ts');

const PAGES = {
  'https://start.test/': {
    title: 'Start',
    text: 'welcome to the start page',
    links: [{ text: 'Docs', href: 'https://start.test/docs' }],
  },
  'https://start.test/docs': { title: 'Docs', text: 'the docs page', links: [] },
};

function getEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

const dirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ah-browser-'));
  dirs.push(dir);
  return dir;
}

/** A daemon config with one mock serving entry, plus whatever browser block the test needs. */
function daemonConfig(over: Partial<DaemonConfig>): DaemonConfig {
  return {
    node: { name: 'browser-node', arch: 'arm64' },
    hub: 'http://127.0.0.1:1',
    serving: [{ tier: 'worker', model: 'mock-model', port: 9999, maxStreams: 4, cmd: ['true'] }],
    ...over,
  };
}

let app: FastifyInstance | undefined;
let hub: Hub | undefined;
let daemon: Daemon | undefined;
afterEach(async () => {
  await app?.close(); app = undefined;
  await daemon?.stop(); daemon = undefined;
  await hub?.stop(); hub = undefined;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe('browser server', () => {
  it('round-trips every route over the fake driver', async () => {
    const driver = new FakeDriver(PAGES);
    app = createBrowserServer(driver);

    const nav = await app.inject({ method: 'POST', url: '/browser/navigate', payload: { url: 'https://start.test/' } });
    expect(nav.statusCode).toBe(200);
    expect(nav.json()).toEqual({ url: 'https://start.test/', title: 'Start' });

    const read = await app.inject({ method: 'POST', url: '/browser/read' });
    expect(read.json()).toEqual({
      state: { url: 'https://start.test/', title: 'Start' },
      text: 'welcome to the start page',
      links: [{ text: 'Docs', href: 'https://start.test/docs' }],
    });

    const state = await app.inject({ method: 'GET', url: '/browser/state' });
    expect(state.json()).toEqual({ url: 'https://start.test/', title: 'Start' });

    const typed = await app.inject({
      method: 'POST', url: '/browser/type', payload: { selector: '#q', text: 'hello', submit: true },
    });
    expect(typed.json()).toEqual({ url: 'https://start.test/', title: 'Start' });

    const click = await app.inject({ method: 'POST', url: '/browser/click', payload: { selector: 'text=Docs' } });
    expect(click.json()).toEqual({ url: 'https://start.test/docs', title: 'Docs' });

    const shot = await app.inject({ method: 'GET', url: '/browser/screenshot' });
    expect(shot.headers['content-type']).toContain('image/jpeg');
    expect(shot.rawPayload.equals(FAKE_JPEG)).toBe(true);

    expect(driver.calls).toEqual([
      { op: 'navigate', args: ['https://start.test/'] },
      { op: 'read', args: [] },
      { op: 'read', args: [] }, // GET /browser/state reads and keeps only the state
      { op: 'type', args: ['#q', 'hello', true] },
      { op: 'click', args: ['text=Docs'] },
      { op: 'screenshot', args: [] },
    ]);
  });

  it('rejects malformed requests with 400 and driver failures with 502', async () => {
    app = createBrowserServer(new FakeDriver(PAGES));
    expect((await app.inject({ method: 'POST', url: '/browser/navigate', payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/browser/click', payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/browser/type', payload: { selector: '#q' } })).statusCode).toBe(400);
    await app.close();

    const broken: BrowserDriver = {
      navigate: async () => { throw new Error('net::ERR_NAME_NOT_RESOLVED'); },
      read: async () => { throw new Error('page closed'); },
      click: async () => { throw new Error('no element'); },
      type: async () => { throw new Error('no element'); },
      screenshot: async () => { throw new Error('screenshot failed'); },
      close: async () => {},
    };
    app = createBrowserServer(broken);
    const failed = await app.inject({ method: 'POST', url: '/browser/navigate', payload: { url: 'https://nope.test/' } });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toEqual({ error: 'net::ERR_NAME_NOT_RESOLVED' });
    expect((await app.inject({ method: 'GET', url: '/browser/screenshot' })).statusCode).toBe(502);
    expect((await app.inject({ method: 'GET', url: '/browser/state' })).statusCode).toBe(502);
  });

  it('caps read text and links so a page can never blow the model context', async () => {
    const driver = new FakeDriver({
      'https://huge.test/': {
        title: 'Huge',
        text: 'x'.repeat(MAX_TEXT + 500),
        links: Array.from({ length: MAX_LINKS + 20 }, (_, i) => ({ text: `l${i}`, href: `https://huge.test/${i}` })),
      },
    });
    app = createBrowserServer(driver);
    await app.inject({ method: 'POST', url: '/browser/navigate', payload: { url: 'https://huge.test/' } });
    const read = (await app.inject({ method: 'POST', url: '/browser/read' })).json() as { text: string; links: unknown[] };
    expect(read.text).toHaveLength(MAX_TEXT);
    expect(read.links).toHaveLength(MAX_LINKS);
  });
});

describe('daemon browser capability', () => {
  it('advertises browser.url only when the capability is enabled', () => {
    expect(new Daemon(daemonConfig({})).registration().browser).toBeUndefined();
    expect(new Daemon(daemonConfig({ browser: { enabled: false } })).registration().browser).toBeUndefined();
    expect(new Daemon(daemonConfig({ browser: { enabled: true, port: 8131 } })).registration().browser)
      .toEqual({ url: 'http://127.0.0.1:8131' });
    expect(new Daemon(daemonConfig({ advertiseHost: 'mini.tailnet', browser: { enabled: true, port: 8131 } })).registration().browser)
      .toEqual({ url: 'http://mini.tailnet:8131' });
  });

  it('rejects a config whose browser block has no boolean enabled', () => {
    const path = join(tmpDir(), 'daemon.yaml');
    writeFileSync(path, [
      'node:', '  name: x', '  arch: arm64', 'hub: http://127.0.0.1:1',
      'serving:', '  - tier: worker', '    model: m', '    port: 1', '    maxStreams: 1', '    cmd: ["true"]',
      'browser:', '  port: 8130',
    ].join('\n'));
    expect(() => loadConfig(path)).toThrow(/browser.enabled/);
  });

  it('serves the browser API and registers its url with the hub, then tears both down on stop', async () => {
    hub = createHub({ staleMs: 60000 });
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const hubPort = (hub.app.server.address() as { port: number }).port;
    const servePort = await getEphemeralPort();

    const cfgPath = join(tmpDir(), 'daemon.yaml');
    writeFileSync(cfgPath, [
      'node:', '  name: mini', '  arch: arm64',
      `hub: http://127.0.0.1:${hubPort}`,
      'heartbeatMs: 500',
      'browser:', '  enabled: true', '  port: 0',
      'serving:',
      '  - tier: worker', '    model: mock-model', `    port: ${servePort}`, '    maxStreams: 4',
      `    cmd: ["npx", "tsx", "${MOCK_SERVE}", "${servePort}"]`,
    ].join('\n'));

    const driver = new FakeDriver(PAGES);
    daemon = new Daemon(loadConfig(cfgPath), { createBrowserDriver: async () => driver });
    await daemon.start();

    const url = hub.registry.byName('mini')?.browser?.url;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const res = await fetch(`${url}/browser/navigate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://start.test/' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://start.test/', title: 'Start' });

    await daemon.stop();
    daemon = undefined;
    expect(driver.closed).toBe(true);
    await expect(fetch(`${url}/browser/state`)).rejects.toThrow();
  }, 30000);
});
