import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { FakeDriver, FAKE_JPEG } from '../../node-daemon/src/browser/driver.js';
import { createBrowserServer } from '../../node-daemon/src/browser/server.js';
import { createHub, type Hub } from '../src/server.js';

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
  const upstreamUrl = `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}`;

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

    expect(driver.calls.map((c) => c.op)).toEqual(['navigate', 'screenshot', 'read', 'screenshot', 'screenshot']);

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

  it('rejects malformed lease requests and made-up recording ids', async () => {
    expect((await post('/api/browser/lease', { kind: 'ghost', id: 'x' })).status).toBe(400);
    expect((await post('/api/browser/lease', { kind: 'owner' })).status).toBe(400);
    expect((await fetch(`${base}/api/browser/recordings/..%2F..%2Fetc`)).status).toBe(400);
  });

  it('answers 503 while no browser node is online', async () => {
    const bare = createHub({ browser: { recordingsRoot: recordings } });
    await bare.app.listen({ port: 0, host: '127.0.0.1' });
    const bareBase = `http://127.0.0.1:${(bare.app.server.address() as { port: number }).port}`;
    const granted = await (await fetch(`${bareBase}/api/browser/lease`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'owner', id: 'owner' }),
    })).json();
    const res = await fetch(`${bareBase}/api/browser/act`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leaseId: granted.leaseId, op: 'read' }),
    });
    expect(res.status).toBe(503);
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
