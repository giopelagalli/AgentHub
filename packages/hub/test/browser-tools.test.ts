import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createMockOpenAI, type MockOpenAI, type ScriptStep } from '@agenthub/mocks';
import { FakeDriver } from '../../node-daemon/src/browser/driver.js';
import { createBrowserServer } from '../../node-daemon/src/browser/server.js';
import { openDb } from '../src/db.js';
import { NodeRegistry } from '../src/node-registry.js';
import { ModelGateway } from '../src/gateway.js';
import { AgentLoop } from '../src/agents/loop.js';
import { Transcript } from '../src/agents/transcript.js';
import { runToolCall, type Tool, type ToolContext } from '../src/agents/tools.js';
import { LeaseManager } from '../src/browser/lease.js';
import { BrowserProxy } from '../src/browser/proxy.js';
import { Recorder } from '../src/browser/recorder.js';
import { ProjectBundle } from '../src/projects/bundle.js';
import { browserTools, browserOperatorTools, type BrowserToolDeps } from '../src/agents/browser-tools.js';

const PAGES = {
  'https://start.test/': {
    title: 'Start',
    text: 'welcome to the start page',
    links: [{ text: 'Docs', href: 'https://start.test/docs' }],
  },
};

let driver: FakeDriver;
let upstream: FastifyInstance;
let recordings: string;
let leases: LeaseManager;
let proxy: BrowserProxy;
let deps: BrowserToolDeps;

beforeEach(async () => {
  driver = new FakeDriver(PAGES);
  upstream = createBrowserServer(driver);
  await upstream.listen({ port: 0, host: '127.0.0.1' });
  const upstreamUrl = `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}`;

  const db = openDb(':memory:');
  const registry = new NodeRegistry(db);
  registry.register({ name: 'macmini', arch: 'arm64', endpoints: [], jobTypes: [], browser: { url: upstreamUrl } });

  recordings = mkdtempSync(join(tmpdir(), 'ah-browser-tools-'));
  leases = new LeaseManager();
  proxy = new BrowserProxy({ registry, leases, recorder: new Recorder({ root: recordings }) });
  deps = { leases, proxy };
});

afterEach(async () => {
  await upstream.close();
  rmSync(recordings, { recursive: true, force: true });
});

const ctxFor = (sessionId: number): ToolContext => ({ sessionId, log: () => {} });

describe('browserTools — direct tool calls', () => {
  it('rejects every browser_* tool until acquire_browser has run', async () => {
    const tools = browserTools(deps, 'orchestrator');
    const ctx = ctxFor(1);
    expect(await runToolCall(tools, { id: '1', name: 'browser_navigate', arguments: '{"url":"https://start.test/"}' }, ctx))
      .toBe('error: no browser lease — call acquire_browser first');
    expect(await runToolCall(tools, { id: '2', name: 'release_browser', arguments: '{}' }, ctx))
      .toBe('error: no browser lease — call acquire_browser first');
  });

  it('acquires, navigates, reads, clicks, types, screenshots and releases, formatting title+url', async () => {
    const tools = browserTools(deps, 'orchestrator');
    const ctx = ctxFor(7);

    expect(await runToolCall(tools, { id: '1', name: 'acquire_browser', arguments: '{}' }, ctx)).toBe('browser lease granted');

    const nav = await runToolCall(tools, { id: '2', name: 'browser_navigate', arguments: '{"url":"https://start.test/"}' }, ctx);
    expect(nav).toBe('page: Start (https://start.test/)');

    const read = await runToolCall(tools, { id: '3', name: 'browser_read', arguments: '{}' }, ctx);
    expect(read).toContain('page: Start (https://start.test/)');
    expect(read).toContain('welcome to the start page');
    expect(read).toContain('- Docs: https://start.test/docs');

    const shot = await runToolCall(tools, { id: '4', name: 'browser_screenshot', arguments: '{}' }, ctx);
    expect(shot).toMatch(/^saved .*\.jpg$/);

    expect(await runToolCall(tools, { id: '5', name: 'release_browser', arguments: '{}' }, ctx)).toBe('browser lease released');
    expect(leases.holder()).toBeNull();
  });

  it('returns the model-facing error once the lease is lost mid-session, and a fresh acquire works again', async () => {
    const tools = browserTools(deps, 'subagent');
    const ctx = ctxFor(3);
    expect(await runToolCall(tools, { id: '1', name: 'acquire_browser', arguments: '{}' }, ctx)).toBe('browser lease granted');

    // The owner preempts the holder directly through the LeaseManager, as a real preempt would.
    leases.acquire({ kind: 'owner', id: 'owner' });

    expect(await runToolCall(tools, { id: '2', name: 'browser_navigate', arguments: '{"url":"https://start.test/"}' }, ctx))
      .toBe('error: lease lost — owner took control');
    // The session never held a lease again, so later calls report the "no lease" error, not another loss.
    expect(await runToolCall(tools, { id: '3', name: 'browser_read', arguments: '{}' }, ctx))
      .toBe('error: no browser lease — call acquire_browser first');
  });

  it('release_browser reports "lease already lost" instead of claiming success once the lease is gone', async () => {
    const tools = browserTools(deps, 'orchestrator');
    const ctx = ctxFor(31);
    expect(await runToolCall(tools, { id: '1', name: 'acquire_browser', arguments: '{}' }, ctx)).toBe('browser lease granted');

    // The owner preempts the holder directly through the LeaseManager, as a real preempt would.
    leases.acquire({ kind: 'owner', id: 'owner' });

    expect(await runToolCall(tools, { id: '2', name: 'release_browser', arguments: '{}' }, ctx))
      .toBe('error: lease already lost');
  });

  it('subagent priority: acquire_browser reports the queue position immediately, no polling', async () => {
    leases.acquire({ kind: 'orchestrator', id: 'orch-1' });
    const tools = browserOperatorTools(deps);
    const result = await runToolCall(tools, { id: '1', name: 'acquire_browser', arguments: '{}' }, ctxFor(9));
    expect(result).toBe('queued: position 1');
  });

  it('orchestrator priority: acquire_browser polls (fake clock) until the lease frees up', async () => {
    leases.acquire({ kind: 'subagent', id: 'busy' });
    let elapsed = 0;
    const now = () => elapsed;
    const sleep = async (ms: number) => {
      elapsed += ms;
      if (elapsed >= 3000) leases.release(leases.holder()!.leaseId);
    };
    const tools = browserTools({ ...deps, now, sleep }, 'orchestrator');
    const result = await runToolCall(tools, { id: '1', name: 'acquire_browser', arguments: '{}' }, ctxFor(11));
    expect(result).toBe('browser lease granted');
    expect(elapsed).toBeLessThan(60_000);
  });

  it('orchestrator priority: acquire_browser gives up after 60s (fake clock), withdraws, and reports busy', async () => {
    leases.acquire({ kind: 'owner', id: 'owner' }); // never releases
    let elapsed = 0;
    const now = () => elapsed;
    const sleep = async (ms: number) => { elapsed += ms; };
    const tools = browserTools({ ...deps, now, sleep }, 'orchestrator');
    const result = await runToolCall(tools, { id: '1', name: 'acquire_browser', arguments: '{}' }, ctxFor(13));
    expect(result).toBe('error: browser busy — try again later');
    expect(elapsed).toBeGreaterThanOrEqual(60_000);
    expect(leases.queue()).toEqual([]);

    // A later release must not grant the lease to the request that already gave up.
    leases.release(leases.holder()!.leaseId);
    expect(leases.holder()).toBeNull();
  });
});

describe('browserTools — requester identity across turns', () => {
  let root: string;
  let bundle: ProjectBundle;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'ah-browser-tools-bundle-'));
    bundle = await ProjectBundle.create(root, { slug: 'demo', title: 'Demo', intent: 'ship it' });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('a returning orchestrator (fresh sessionId, same project) re-acquires its still-valid lease instead of queueing', async () => {
    // Turn 1: a fresh tool list (AgentLoop builds one per turn) and the sessionId AgentLoop mints for it.
    const turn1 = browserTools(deps, 'orchestrator');
    const ctx1: ToolContext = { sessionId: 101, log: () => {}, bundle };
    expect(await runToolCall(turn1, { id: '1', name: 'acquire_browser', arguments: '{}' }, ctx1)).toBe('browser lease granted');
    const leaseId = leases.holder()!.leaseId;

    // Turn 2: another fresh tool list and a different sessionId — but the same project bundle. The
    // turn-1 lease is still well within its TTL, so this must renew it in place, not queue behind it.
    const turn2 = browserTools(deps, 'orchestrator');
    const ctx2: ToolContext = { sessionId: 202, log: () => {}, bundle };
    expect(await runToolCall(turn2, { id: '1', name: 'acquire_browser', arguments: '{}' }, ctx2)).toBe('browser lease granted');
    expect(leases.holder()!.leaseId).toBe(leaseId);
    expect(leases.queue()).toEqual([]);
  });

  it('release_browser falls back to the current holder when a fresh turn (new sessionId, same project) never learned the leaseId itself', async () => {
    const turn1 = browserTools(deps, 'orchestrator');
    const ctx1: ToolContext = { sessionId: 301, log: () => {}, bundle };
    expect(await runToolCall(turn1, { id: '1', name: 'acquire_browser', arguments: '{}' }, ctx1)).toBe('browser lease granted');

    // A brand-new browserTools() instance (fresh `held` map) for a later turn of the same project —
    // it never called acquire_browser itself, so it has no local memory of the leaseId.
    const turn2 = browserTools(deps, 'orchestrator');
    const ctx2: ToolContext = { sessionId: 402, log: () => {}, bundle };
    expect(await runToolCall(turn2, { id: '1', name: 'release_browser', arguments: '{}' }, ctx2)).toBe('browser lease released');
    expect(leases.holder()).toBeNull();
  });
});

describe('browserTools — acquire_browser abort handling', () => {
  it('aborts within one poll interval when the signal fires, and withdraws from the queue', async () => {
    leases.acquire({ kind: 'owner', id: 'owner' }); // holds forever; the orchestrator below queues behind it
    const controller = new AbortController();
    let polls = 0;
    // A sleep that never resolves on its own — if the abort race didn't win, this test would hang
    // (or time out), which is exactly the "delays shutdown by up to a full poll interval" bug.
    const sleep = async (): Promise<void> => {
      polls += 1;
      if (polls === 1) controller.abort();
      await new Promise<void>(() => {});
    };
    const tools = browserTools({ ...deps, sleep }, 'orchestrator');
    const ctx: ToolContext = { sessionId: 21, log: () => {}, signal: controller.signal };

    const result = await runToolCall(tools, { id: '1', name: 'acquire_browser', arguments: '{}' }, ctx);

    expect(result).toBe('error: aborted');
    expect(polls).toBe(1);
    expect(leases.queue()).toEqual([]);
  });

  it('releases a lease granted during the abort race instead of leaking it to the aborted requester', async () => {
    leases.acquire({ kind: 'subagent', id: 'busy' }); // holds; the orchestrator below queues behind it
    const controller = new AbortController();
    let polls = 0;
    const sleep = async (): Promise<void> => {
      polls += 1;
      if (polls === 1) {
        // The owner releases mid-sleep, promoting the queued orchestrator to holder — before the
        // abort below is even observed by the acquire loop.
        leases.release(leases.holder()!.leaseId);
        controller.abort();
      }
      await new Promise<void>(() => {});
    };
    const tools = browserTools({ ...deps, sleep }, 'orchestrator');
    const ctx: ToolContext = { sessionId: 23, log: () => {}, signal: controller.signal };

    const result = await runToolCall(tools, { id: '1', name: 'acquire_browser', arguments: '{}' }, ctx);

    expect(result).toBe('error: aborted');
    expect(leases.holder()).toBeNull();
    expect(leases.queue()).toEqual([]);

    // The aborted requester must not be able to act with a lease it was never told it holds.
    expect(await runToolCall(tools, { id: '2', name: 'browser_navigate', arguments: '{"url":"https://start.test/"}' }, ctx))
      .toBe('error: no browser lease — call acquire_browser first');
  });
});

describe('browserTools — through the AgentLoop', () => {
  let mocks: MockOpenAI[];

  beforeEach(() => { mocks = []; });
  afterEach(async () => { for (const m of mocks) await m.close(); });

  it('script acquires, navigates, reads, releases: 2 frames recorded and the read text reaches the model', async () => {
    const script: ScriptStep[] = [
      { toolCalls: [{ name: 'acquire_browser', arguments: {} }] },
      { toolCalls: [{ name: 'browser_navigate', arguments: { url: 'https://start.test/' } }] },
      { toolCalls: [{ name: 'browser_read', arguments: {} }] },
      { toolCalls: [{ name: 'release_browser', arguments: {} }] },
    ];
    const mock = createMockOpenAI({ script });
    await mock.listen({ port: 0, host: '127.0.0.1' });
    mocks.push(mock);
    const url = `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`;

    const db = openDb(':memory:');
    const registry = new NodeRegistry(db);
    registry.register({ name: 'brain', arch: 'arm64', endpoints: [{ tier: 'orchestrator', url, model: 'mock-model', maxStreams: 2 }] });
    const transcript = new Transcript(db);
    const loop = new AgentLoop({ gateway: new ModelGateway(registry), transcript });

    let leaseId: string | null = null;
    leases.onChange((status) => { if (status.holder?.requester.kind === 'orchestrator') leaseId = status.holder.leaseId; });

    const tools: Tool[] = browserTools(deps, 'orchestrator');
    const res = await loop.run({
      kind: 'orchestrator',
      subject: 'demo',
      tier: 'orchestrator',
      system: 'you drive the shared browser',
      user: 'go look at the start page',
      tools,
      ctx: {},
      maxToolCalls: 10,
    });

    expect(res.outcome).toBe('stop');
    expect(leases.holder()).toBeNull();
    expect(leaseId).not.toBeNull();

    // The read tool's result — the page text — must have reached the model.
    const sawReadResult = mock.requests.some((r) =>
      (r.messages as { role: string; content: string | null }[]).some(
        (m) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('welcome to the start page'),
      ),
    );
    expect(sawReadResult).toBe(true);

    const timeline = await new Recorder({ root: recordings }).list(leaseId!);
    expect(timeline.map((a) => [a.op, a.frame])).toEqual([['navigate', '1.jpg'], ['read', '2.jpg']]);
    expect(driver.calls.map((c) => c.op)).toEqual(['navigate', 'screenshot', 'read', 'screenshot']);
  });
});
