import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createMockOpenAI, type MockOpenAI, type ScriptStep } from '@agenthub/mocks';
import { FakeDriver, FAKE_JPEG } from '../../node-daemon/src/browser/driver.js';
import { createBrowserServer } from '../../node-daemon/src/browser/server.js';
import { AgentLoop } from '../src/agents/loop.js';
import { browserOperatorTools } from '../src/agents/browser-tools.js';
import { runToolCall } from '../src/agents/tools.js';
import { createHub, type Hub } from '../src/server.js';

// The whole "web" this acceptance run browses: one page, served by the FakeDriver behind a real
// browser server, so the hub talks HTTP to a node exactly as it would to the Mac mini's Chromium.
const PAGES = {
  'https://start.test/': {
    title: 'Start',
    text: 'welcome to the start page',
    links: [{ text: 'Docs', href: 'https://start.test/docs' }],
  },
};

const TTL_MS = 120_000;

let hub: Hub | undefined;
let upstream: FastifyInstance | undefined;
let mock: MockOpenAI | undefined;
let recordings: string | undefined;

afterAll(async () => {
  await hub?.stop();
  await upstream?.close();
  await mock?.close();
  if (recordings) rmSync(recordings, { recursive: true, force: true });
});

describe('phase 5b acceptance: shared browser with owner preempt', () => {
  it(
    'a subagent drives the browser, the owner takes it, the queue moves on and a lapsed TTL hands over',
    async () => {
      // --- the cluster ---------------------------------------------------------
      // `macmini`: the browser node. Its driver is fake; everything between it and the agent — the
      // browser server, the hub proxy, the lease, the recorder — is the real thing.
      const driver = new FakeDriver(PAGES);
      upstream = createBrowserServer(driver);
      await upstream.listen({ port: 0, host: '127.0.0.1' });
      const browserUrl = `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}`;

      // `brain`: the model the browser-operator subagent thinks with, scripted call by call.
      const script: ScriptStep[] = [
        { toolCalls: [{ name: 'acquire_browser', arguments: {} }] },
        { toolCalls: [{ name: 'browser_navigate', arguments: { url: 'https://start.test/' } }] },
        { toolCalls: [{ name: 'browser_read', arguments: {} }] },
        { content: 'the start page welcomes visitors' },
      ];
      mock = createMockOpenAI({ script });
      await mock.listen({ port: 0, host: '127.0.0.1' });
      const brainUrl = `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`;

      recordings = mkdtempSync(join(tmpdir(), 'ah-e2e-browser-'));
      // The lease clock is injected, so the TTL step below is a variable assignment rather than a
      // two-minute wait — nothing else in this test depends on wall-clock time.
      let now = 1_700_000_000_000;
      hub = createHub({ browser: { recordingsRoot: recordings, ttlMs: TTL_MS, now: () => now } });
      await hub.app.listen({ port: 0, host: '127.0.0.1' });
      const port = (hub.app.server.address() as { port: number }).port;
      const base = `http://127.0.0.1:${port}`;
      const wsUrl = `ws://127.0.0.1:${port}/ws`;

      const post = (path: string, body: unknown) =>
        fetch(`${base}${path}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
      const postJson = async (path: string, body: unknown) => (await post(path, body)).json();
      const getJson = async (path: string) => (await fetch(`${base}${path}`)).json();

      await post('/api/nodes/register', {
        name: 'macmini', arch: 'arm64', endpoints: [], jobTypes: ['browser-lease'], browser: { url: browserUrl },
      });
      await post('/api/nodes/register', {
        name: 'brain', arch: 'arm64', jobTypes: [],
        endpoints: [{ tier: 'worker', url: brainUrl, model: 'mock-model', maxStreams: 2 }],
      });

      // --- 1. a browser-operator subagent acquires the lease and reads a page --
      // The leaseId is only ever known to the tools, so the test watches the manager for it.
      let subLeaseId: string | null = null;
      hub.leases.onChange((status) => {
        if (!subLeaseId && status.holder?.requester.kind === 'subagent') subLeaseId = status.holder.leaseId;
      });

      const tools = browserOperatorTools({ leases: hub.leases, proxy: hub.browser });
      const loop = new AgentLoop({ gateway: hub.gateway, transcript: hub.transcript });
      const run = await loop.run({
        kind: 'subagent',
        subject: 'look at the start page',
        tier: 'worker',
        system: 'you drive the shared browser',
        user: 'open the start page and tell me what it says',
        tools,
        ctx: {},
        maxToolCalls: 10,
      });
      expect(run.outcome).toBe('stop');
      expect(subLeaseId).not.toBeNull();

      // What the browser read has to reach the model, or the toolset is decorative.
      const sawPageText = mock.requests.some((r) =>
        (r.messages as { role: string; content: string | null }[]).some(
          (m) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('welcome to the start page'),
        ),
      );
      expect(sawPageText).toBe(true);

      // The script never released, so the subagent is still holding the browser.
      const holding = await getJson('/api/browser');
      expect(holding.node).toBe('macmini');
      expect(holding.holder.leaseId).toBe(subLeaseId);

      // --- 2. the session is on disk, frame by frame ---------------------------
      const timeline = await getJson(`/api/browser/recordings/${subLeaseId}`);
      expect(timeline.actions.map((a: { op: string; frame: string }) => [a.op, a.frame]))
        .toEqual([['navigate', '1.jpg'], ['read', '2.jpg']]);
      for (const frame of ['1.jpg', '2.jpg', 'actions.jsonl']) {
        expect(existsSync(join(recordings, subLeaseId!, frame))).toBe(true);
      }

      // --- 3. the screening room sees the live screen --------------------------
      const watcher = new WebSocket(wsUrl);
      const frame = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no browser frame within 5s')), 5000);
        watcher.addEventListener('message', (ev) => {
          const msg = JSON.parse(String(ev.data));
          if (msg.type === 'browser-frame') { clearTimeout(timer); resolve(msg); }
        });
      });
      await new Promise((r) => watcher.addEventListener('open', r));
      watcher.send(JSON.stringify({ type: 'subscribe', topic: 'browser' }));
      expect(await frame).toMatchObject({
        nodeName: 'macmini', leaseId: subLeaseId, jpegBase64: FAKE_JPEG.toString('base64'),
      });
      // Closing the last subscriber stops the cast; the rest of the run leaves the node alone.
      watcher.close();

      // --- 4. an orchestrator asks for the browser and waits its turn ----------
      expect(await postJson('/api/browser/lease', { kind: 'orchestrator', id: 'project:demo' }))
        .toEqual({ queued: true, position: 1 });

      // --- 5. the owner takes control -----------------------------------------
      const ownerLease = await postJson('/api/browser/preempt', { id: 'owner' });
      expect(ownerLease.granted).toBe(true);

      // The subagent's very next action is refused — at the route, and as the error its model sees.
      const refused = await post('/api/browser/act', { leaseId: subLeaseId, op: 'read' });
      expect(refused.status).toBe(409);
      expect((await refused.json()).error).toBe('lease lost');
      const asTheAgentSeesIt = await runToolCall(
        tools, { id: 'lost', name: 'browser_read', arguments: '{}' }, { sessionId: run.sessionId, log: () => {} },
      );
      expect(asTheAgentSeesIt).toBe('error: lease lost — call acquire_browser again');

      // The owner's own actions work while the preempted lease is dead.
      expect((await post('/api/browser/act', { leaseId: ownerLease.leaseId, op: 'read' })).status).toBe(200);

      // --- 6. releasing hands the browser to the queue, not back to the loser --
      expect((await fetch(`${base}/api/browser/lease/${ownerLease.leaseId}`, { method: 'DELETE' })).status).toBe(200);
      const afterRelease = await getJson('/api/browser');
      expect(afterRelease.holder.requester).toEqual({ kind: 'orchestrator', id: 'project:demo' });
      expect(afterRelease.queue).toEqual([]);

      // --- 7. a lapsed TTL hands over without anyone having to sweep -----------
      expect(await postJson('/api/browser/lease', { kind: 'subagent', id: 'subagent:demo:2' }))
        .toEqual({ queued: true, position: 1 });
      now += TTL_MS + 1;
      const stale = await post('/api/browser/act', { leaseId: afterRelease.holder.leaseId, op: 'read' });
      expect(stale.status).toBe(409);
      expect((await stale.json()).error).toBe('lease lost');
      const afterExpiry = await getJson('/api/browser');
      expect(afterExpiry.holder.requester).toEqual({ kind: 'subagent', id: 'subagent:demo:2' });
      expect(afterExpiry.queue).toEqual([]);
    },
    30_000,
  );
});
