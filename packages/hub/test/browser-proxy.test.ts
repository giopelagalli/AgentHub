import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { FakeDriver, FAKE_JPEG } from '../../node-daemon/src/browser/driver.js';
import { createBrowserServer } from '../../node-daemon/src/browser/server.js';
import { createHub, type Hub } from '../src/server.js';
import { openDb } from '../src/db.js';
import { NodeRegistry } from '../src/node-registry.js';
import { LeaseManager } from '../src/browser/lease.js';
import { BrowserProxy, poolSlots } from '../src/browser/proxy.js';
import { Recorder } from '../src/browser/recorder.js';

const PAGES = {
  'https://start.test/': {
    title: 'Start',
    text: 'welcome to the start page',
    links: [{ text: 'Docs', href: 'https://start.test/docs' }],
  },
};

let driver: FakeDriver;
let upstream: FastifyInstance;
let hub: Hub;
let upstreamUrl: string;
let base: string;
let wsUrl: string;
let recordings: string;

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Acquires the lease for `id` and returns it; the tests all start by holding the browser. */
async function lease(kind: 'owner' | 'orchestrator' | 'subagent', id: string): Promise<string> {
  const res = await (await post('/api/browser/lease', { kind, id })).json();
  expect(res.granted).toBe(true);
  return res.leaseId as string;
}

beforeEach(async () => {
  driver = new FakeDriver(PAGES);
  upstream = createBrowserServer(driver);
  await upstream.listen({ port: 0, host: '127.0.0.1' });
  upstreamUrl = `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}`;

  recordings = mkdtempSync(join(tmpdir(), 'ah-rec-'));
  hub = createHub({ browser: { recordingsRoot: recordings } });
  await hub.app.listen({ port: 0, host: '127.0.0.1' });
  const port = (hub.app.server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;

  await post('/api/nodes/register', {
    name: 'macmini', arch: 'arm64', endpoints: [], jobTypes: ['browser-lease'], browser: { url: upstreamUrl },
  });
});

afterEach(async () => {
  await hub.stop();
  await upstream.close();
  rmSync(recordings, { recursive: true, force: true });
});

describe('browser routes', () => {
  it('reports the holder, the queue and the browser node', async () => {
    const leaseId = await lease('subagent', 'sub-1');
    await post('/api/browser/lease', { kind: 'orchestrator', id: 'orch-1' });
    const status = await (await fetch(`${base}/api/browser`)).json();
    expect(status.node).toBe('macmini');
    expect(status.holder.leaseId).toBe(leaseId);
    expect(status.queue).toEqual([{ kind: 'orchestrator', id: 'orch-1' }]);
    const state = await (await fetch(`${base}/api/state`)).json();
    expect(state.browser.holder.requester).toEqual({ kind: 'subagent', id: 'sub-1' });
  });

  it('forwards actions to the browser node and records a frame per action', async () => {
    const leaseId = await lease('subagent', 'sub-1');

    const nav = await (await post('/api/browser/act', { leaseId, op: 'navigate', args: { url: 'https://start.test/' } })).json();
    expect(nav).toEqual({ url: 'https://start.test/', title: 'Start' });

    const read = await (await post('/api/browser/act', { leaseId, op: 'read' })).json();
    expect(read.text).toBe('welcome to the start page');

    const shot = await (await post('/api/browser/act', { leaseId, op: 'screenshot' })).json();
    expect(shot).toEqual({ seq: 3, path: join(recordings, leaseId, '3.jpg') });

    // The hub has never seen this slot used, so the first action starts it over in a fresh session.
    expect(driver.calls.map((c) => c.op)).toEqual(['reset', 'navigate', 'screenshot', 'read', 'screenshot', 'screenshot']);

    const timeline = await (await fetch(`${base}/api/browser/recordings/${leaseId}`)).json();
    expect(timeline.actions.map((a: { op: string; frame: string }) => [a.op, a.frame])).toEqual([
      ['navigate', '1.jpg'], ['read', '2.jpg'], ['screenshot', '3.jpg'],
    ]);
    expect(timeline.actions[0].args).toEqual({ url: 'https://start.test/' });
    for (const seq of [1, 2, 3]) expect(existsSync(join(recordings, leaseId, `${seq}.jpg`))).toBe(true);
  });

  it('relays the node’s own error status for a bad action', async () => {
    const leaseId = await lease('subagent', 'sub-1');
    const res = await post('/api/browser/act', { leaseId, op: 'navigate', args: {} });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('url required');
    const bogus = await post('/api/browser/act', { leaseId, op: 'fly' });
    expect(bogus.status).toBe(400);
  });

  it('refuses to act for anyone but the current holder', async () => {
    const leaseId = await lease('subagent', 'sub-1');
    const queued = await (await post('/api/browser/lease', { kind: 'orchestrator', id: 'orch-1' })).json();
    expect(queued).toEqual({ queued: true, position: 1 });

    const stranger = await post('/api/browser/act', { leaseId: 'someone-elses-lease', op: 'read' });
    expect(stranger.status).toBe(409);
    expect((await stranger.json()).error).toBe('lease lost');

    // The owner takes control; the subagent's very next action fails.
    const ownerLease = await (await post('/api/browser/preempt', { id: 'owner' })).json();
    expect(ownerLease.granted).toBe(true);
    expect((await post('/api/browser/act', { leaseId, op: 'read' })).status).toBe(409);
    expect((await post('/api/browser/act', { leaseId: ownerLease.leaseId, op: 'read' })).status).toBe(200);

    // Releasing hands the browser to the orchestrator that was waiting.
    const released = await fetch(`${base}/api/browser/lease/${ownerLease.leaseId}`, { method: 'DELETE' });
    expect(released.status).toBe(200);
    const status = await (await fetch(`${base}/api/browser`)).json();
    expect(status.holder.requester.id).toBe('orch-1');
    expect((await fetch(`${base}/api/browser/lease/${ownerLease.leaseId}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('drops an expired lease before it can act and hands the browser to the waiter', async () => {
    // Its own hub, so the clock this test winds forward is the only one it affects.
    let now = 1_000_000;
    const timed = createHub({ browser: { recordingsRoot: recordings, ttlMs: 1000, now: () => now } });
    await timed.app.listen({ port: 0, host: '127.0.0.1' });
    const timedBase = `http://127.0.0.1:${(timed.app.server.address() as { port: number }).port}`;
    const to = (path: string, body: unknown) =>
      fetch(`${timedBase}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await to('/api/nodes/register', {
      name: 'macmini', arch: 'arm64', endpoints: [], jobTypes: ['browser-lease'], browser: { url: upstreamUrl },
    });

    const held = await (await to('/api/browser/lease', { kind: 'subagent', id: 'sub-1' })).json();
    expect(held.granted).toBe(true);
    expect(await (await to('/api/browser/lease', { kind: 'orchestrator', id: 'orch-1' })).json())
      .toEqual({ queued: true, position: 1 });

    // Nothing swept in between: the stale holder's own action is what discovers the expiry.
    now += 1001;
    const forwarded = driver.calls.length;
    const res = await to('/api/browser/act', { leaseId: held.leaseId, op: 'read' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('lease lost');
    // The dead lease reached the node with nothing at all — not even the one action it used to get.
    expect(driver.calls.length).toBe(forwarded);

    const status = await (await fetch(`${timedBase}/api/browser`)).json();
    expect(status.holder.requester).toEqual({ kind: 'orchestrator', id: 'orch-1' });
    expect(status.queue).toEqual([]);
    await timed.stop();
  });

  it('rejects malformed lease requests and made-up recording ids', async () => {
    expect((await post('/api/browser/lease', { kind: 'ghost', id: 'x' })).status).toBe(400);
    expect((await post('/api/browser/lease', { kind: 'owner' })).status).toBe(400);
    expect((await fetch(`${base}/api/browser/recordings/..%2F..%2Fetc`)).status).toBe(400);
  });

  it('queues every request while no browser node is online — the pool has no slot to grant', async () => {
    const bare = createHub({ browser: { recordingsRoot: recordings } });
    await bare.app.listen({ port: 0, host: '127.0.0.1' });
    const bareBase = `http://127.0.0.1:${(bare.app.server.address() as { port: number }).port}`;
    const asked = await (await fetch(`${bareBase}/api/browser/lease`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'owner', id: 'owner' }),
    })).json();
    expect(asked).toEqual({ queued: true, position: 1 });
    await bare.stop();
  });
});

describe('browser screencast', () => {
  it('sends frames only to sockets subscribed to the browser topic', async () => {
    const leaseId = await lease('owner', 'owner');
    const watcher = new WebSocket(wsUrl);
    const bystander = new WebSocket(wsUrl);
    const bystanderFrames: unknown[] = [];
    bystander.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.type === 'browser-frame') bystanderFrames.push(msg);
    });

    const frame = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no frame')), 5000);
      watcher.addEventListener('message', (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === 'browser-frame') { clearTimeout(timer); resolve(msg); }
      });
    });

    // Both listeners must be attached before either socket can open, or the second `open` is missed.
    const opened = Promise.all([watcher, bystander].map((ws) => new Promise((r) => ws.addEventListener('open', r))));
    await opened;
    watcher.send(JSON.stringify({ type: 'subscribe', topic: 'browser' }));

    const first = await frame;
    expect(first).toMatchObject({ nodeName: 'macmini', leaseId, jpegBase64: FAKE_JPEG.toString('base64') });
    expect(bystanderFrames).toEqual([]);

    // Unsubscribing stops the polling: the driver takes no further screenshots.
    watcher.send(JSON.stringify({ type: 'unsubscribe', topic: 'browser' }));
    await new Promise((r) => setTimeout(r, 50));
    const taken = driver.calls.length;
    await new Promise((r) => setTimeout(r, 700));
    expect(driver.calls.length).toBe(taken);

    watcher.close();
    bystander.close();
  });
});

describe('browser proxy timeouts', () => {
  let blackhole: HttpServer;
  let blackholeUrl: string;
  let blackholeRecordings: string;

  beforeEach(async () => {
    // Accepts the connection but never answers — the stand-in for a wedged daemon node.
    blackhole = createHttpServer(() => { /* never responds */ });
    await new Promise<void>((resolve) => blackhole.listen(0, '127.0.0.1', resolve));
    blackholeUrl = `http://127.0.0.1:${(blackhole.address() as { port: number }).port}`;
    blackholeRecordings = mkdtempSync(join(tmpdir(), 'ah-proxy-timeout-'));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => blackhole.close(() => resolve()));
    rmSync(blackholeRecordings, { recursive: true, force: true });
  });

  it('times out act() against a black-holed node instead of hanging forever', async () => {
    const db = openDb(':memory:');
    const registry = new NodeRegistry(db);
    registry.register({ name: 'stuck', arch: 'arm64', endpoints: [], jobTypes: [], browser: { url: blackholeUrl } });
    const leases = new LeaseManager({ slots: () => poolSlots(registry) });
    const proxy = new BrowserProxy({ registry, leases, recorder: new Recorder({ root: blackholeRecordings }), actionTimeoutMs: 100 });

    const granted = leases.acquire({ kind: 'owner', id: 'owner' });
    if (!('granted' in granted)) throw new Error('expected the owner to be granted');

    await expect(proxy.act(granted.leaseId, { op: 'read' })).rejects.toMatchObject({ status: 504, message: 'browser node timeout' });
  });

  it('bounds a screencast poll frame separately, so a stuck node cannot pin the inFlight flag', async () => {
    const db = openDb(':memory:');
    const registry = new NodeRegistry(db);
    registry.register({ name: 'stuck', arch: 'arm64', endpoints: [], jobTypes: [], browser: { url: blackholeUrl } });
    const leases = new LeaseManager({ slots: () => poolSlots(registry) });

    // A fetch that never settles on its own — proves `inFlight` is released by the per-call timeout
    // (AbortSignal.timeout), not by the upstream ever answering. Asserting frames===0 alone wouldn't
    // catch a regression that never clears `inFlight`: the black hole errors either way, so only
    // counting how many times fetch was actually invoked distinguishes "polling kept going" from
    // "wedged after the first tick".
    let calls = 0;
    const hangingFetch = ((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    }) as typeof fetch;

    const proxy = new BrowserProxy({
      registry, leases, recorder: new Recorder({ root: blackholeRecordings }),
      fetch: hangingFetch, screencastTimeoutMs: 100,
    });

    leases.acquire({ kind: 'owner', id: 'owner' }); // only a held slot is polled
    const cast = proxy.screencast(500);
    let frames = 0;
    cast.onFrame(() => { frames += 1; });
    cast.start();
    // Two-plus poll intervals' worth of wall time; each poll's fetch is capped at 100ms, so multiple
    // ticks must fire well inside this window if (and only if) the timeout releases `inFlight`
    // between them — otherwise the first call alone would still be in flight and `calls` would stay 1.
    await new Promise((r) => setTimeout(r, 1200));
    cast.stop();
    expect(frames).toBe(0);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('maps a stalled response body to 504, not a raw abort error', async () => {
    const stallBody = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // headers sent, body never written or ended
    });
    await new Promise<void>((resolve) => stallBody.listen(0, '127.0.0.1', resolve));
    const stallUrl = `http://127.0.0.1:${(stallBody.address() as { port: number }).port}`;
    try {
      const db = openDb(':memory:');
      const registry = new NodeRegistry(db);
      registry.register({ name: 'stalling', arch: 'arm64', endpoints: [], jobTypes: [], browser: { url: stallUrl } });
      const leases = new LeaseManager({ slots: () => poolSlots(registry) });
      const proxy = new BrowserProxy({ registry, leases, recorder: new Recorder({ root: blackholeRecordings }), actionTimeoutMs: 100 });

      const granted = leases.acquire({ kind: 'owner', id: 'owner' });
      if (!('granted' in granted)) throw new Error('expected the owner to be granted');

      await expect(proxy.act(granted.leaseId, { op: 'read' })).rejects.toMatchObject({ status: 504, message: 'browser node timeout' });
    } finally {
      await new Promise<void>((resolve) => stallBody.close(() => resolve()));
    }
  });
});
