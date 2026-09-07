import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockOpenAI, type MockOpenAI, type ScriptStep } from '@agenthub/mocks';
import { FakeTelegramPort } from '../src/telegram/port.js';
import type { Clock } from '../src/telegram/scheduler.js';
import { createHub, type Hub } from '../src/server.js';

const OWNER = 'owner-chat';

/** Never fires: the scheduler is wired in these tests, but nothing here should depend on its timers. */
class FakeClock implements Clock {
  t = 1_700_000_000_000;

  now(): number {
    return this.t;
  }

  setTimeout(): { clear(): void } {
    return { clear: () => {} };
  }
}

let hub: Hub | undefined;
let mock: MockOpenAI | undefined;
let projectsRoot: string | undefined;
let memoryRoot: string | undefined;

interface Harness {
  hub: Hub;
  port: FakeTelegramPort;
  clock: FakeClock;
}

async function setup(opts: { script?: ScriptStep[]; staleMs?: number } = {}): Promise<Harness> {
  projectsRoot = await mkdtemp(join(tmpdir(), 'agenthub-api-projects-'));
  memoryRoot = await mkdtemp(join(tmpdir(), 'agenthub-api-memory-'));
  mock = createMockOpenAI({ script: opts.script ?? [] });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`;

  const port = new FakeTelegramPort();
  const clock = new FakeClock();
  hub = createHub({
    projectsRoot,
    ...(opts.staleMs ? { staleMs: opts.staleMs } : {}),
    assistant: { memoryRoot, telegram: { port, ownerChatId: OWNER }, clock },
  });
  await hub.projects.stop();
  await hub.app.inject({
    method: 'POST', url: '/api/nodes/register',
    payload: {
      name: 'spark', arch: 'arm64',
      endpoints: [{ tier: 'orchestrator', url, model: 'mock-model', maxStreams: 4 }],
    },
  });
  await hub.assistant();
  return { hub, port, clock };
}

afterEach(async () => {
  await hub?.stop();
  await mock?.close();
  for (const dir of [projectsRoot, memoryRoot]) if (dir) await rm(dir, { recursive: true, force: true });
  hub = undefined; mock = undefined; projectsRoot = undefined; memoryRoot = undefined;
});

/** Posts to the assistant SSE route over a real socket and decodes every frame. */
async function streamAssistant(target: Hub, text: string): Promise<{ token?: string; done?: boolean; full?: string; pending?: { id: string; description: string }[] }[]> {
  await target.app.listen({ port: 0, host: '127.0.0.1' });
  const port = (target.app.server.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}/api/assistant/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
  });
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const body = await res.text();
  return [...body.matchAll(/data: (\{.*\})/g)].map((m) => JSON.parse(m[1]));
}

describe('assistant HTTP API', () => {
  it('streams a reply and reports the actions it proposed', async () => {
    const { hub: h } = await setup({
      script: [
        { toolCalls: [{ name: 'demo_outward_action', arguments: { text: 'ship it' } }] },
        { content: 'Ready when you are.' },
      ],
    });

    const events = await streamAssistant(h, 'post that for me');

    expect(events.filter((e) => e.token).map((e) => e.token).join('')).toBe('Ready when you are.');
    const done = events.find((e) => e.done);
    expect(done?.full).toBe('Ready when you are.');
    expect(done?.pending).toHaveLength(1);
    expect(done?.pending?.[0].description).toContain('ship it');

    const listed = (await h.app.inject({ method: 'GET', url: '/api/assistant/pending' })).json();
    expect(listed).toHaveLength(1);

    const confirmed = await h.app.inject({ method: 'POST', url: `/api/assistant/pending/${done!.pending![0].id}/confirm` });
    expect(confirmed.json()).toEqual({ result: 'sent: ship it' });
    expect((await h.app.inject({ method: 'GET', url: '/api/assistant/pending' })).json()).toEqual([]);
  });

  it('cancels a pending action instead of running it', async () => {
    const { hub: h } = await setup({
      script: [
        { toolCalls: [{ name: 'demo_outward_action', arguments: { text: 'nope' } }] },
        { content: 'Say the word.' },
      ],
    });

    const events = await streamAssistant(h, 'post that for me');
    const id = events.find((e) => e.done)!.pending![0].id;

    expect((await h.app.inject({ method: 'POST', url: `/api/assistant/pending/${id}/cancel` })).json()).toEqual({ ok: true });
    expect((await h.app.inject({ method: 'POST', url: `/api/assistant/pending/${id}/cancel` })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'POST', url: `/api/assistant/pending/${id}/confirm` })).statusCode).toBe(404);
  });

  it('rejects a message with no text', async () => {
    const { hub: h } = await setup();
    expect((await h.app.inject({ method: 'POST', url: '/api/assistant/messages', payload: {} })).statusCode).toBe(400);
  });

  it('reads and edits the planner lists', async () => {
    const { hub: h } = await setup();

    const added = await h.app.inject({ method: 'POST', url: '/api/planner/todo', payload: { text: 'call the bank' } });
    expect(added.statusCode).toBe(201);
    expect(added.json().n).toBe(1);

    const lists = (await h.app.inject({ method: 'GET', url: '/api/planner' })).json();
    expect(lists.todo).toEqual([{ n: 1, text: 'call the bank', done: false }]);
    expect(lists.goals).toEqual([]);
    expect(lists.backlog).toEqual([]);

    const done = await h.app.inject({ method: 'POST', url: '/api/planner/todo/1/done' });
    expect(done.json().items[0].done).toBe(true);

    expect((await h.app.inject({ method: 'POST', url: '/api/planner/nope', payload: { text: 'x' } })).statusCode).toBe(400);
    expect((await h.app.inject({ method: 'POST', url: '/api/planner/todo', payload: { text: '  ' } })).statusCode).toBe(400);
    expect((await h.app.inject({ method: 'POST', url: '/api/planner/todo/9/done' })).statusCode).toBe(404);
  });

  it('serves the memory index', async () => {
    const { hub: h } = await setup();
    const { memory } = await h.assistant();
    await memory.remember({ name: 'Coffee', description: 'oat milk, no sugar', type: 'preference', body: 'Oat milk.' });

    const index = (await h.app.inject({ method: 'GET', url: '/api/memory/index' })).json();
    expect(index.text).toContain('Coffee');
    expect(index.entries).toEqual([{ name: 'Coffee', description: 'oat milk, no sugar', file: 'notes/coffee.md' }]);
  });

  it('answers 503 when the hub was built without an assistant', async () => {
    const bare = createHub();
    try {
      expect((await bare.app.inject({ method: 'GET', url: '/api/planner' })).statusCode).toBe(503);
      await expect(bare.assistant()).rejects.toThrow('not configured');
    } finally {
      await bare.stop();
    }
  });
});

describe('telegram wiring failures leave the assistant usable', () => {
  /** A port whose polling never comes up — the shape of a bad token or an unreachable Telegram. */
  class UnstartablePort extends FakeTelegramPort {
    stopped = false;

    override async start(): Promise<void> {
      throw new Error('401 unauthorized');
    }

    override async stop(): Promise<void> {
      this.stopped = true;
    }
  }

  /** Builds a hub whose telegram wiring is expected to fail, and tears it down with the suite. */
  async function setupBroken(cfg: { port: FakeTelegramPort; briefingTime?: string }): Promise<Hub> {
    projectsRoot = await mkdtemp(join(tmpdir(), 'agenthub-broken-projects-'));
    memoryRoot = await mkdtemp(join(tmpdir(), 'agenthub-broken-memory-'));
    hub = createHub({
      projectsRoot,
      assistant: {
        memoryRoot, telegram: { port: cfg.port, ownerChatId: OWNER }, clock: new FakeClock(),
        ...(cfg.briefingTime ? { schedule: { briefingTime: cfg.briefingTime } } : {}),
      },
    });
    await hub.projects.stop();
    return hub;
  }

  it('keeps the HTTP assistant serving when the telegram port refuses to start', async () => {
    const port = new UnstartablePort();
    const h = await setupBroken({ port });

    const handle = await h.assistant();
    expect(handle.port).toBeNull();
    expect(handle.scheduler).toBeNull();
    expect(port.stopped).toBe(true);
    expect((await h.app.inject({ method: 'GET', url: '/api/planner' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/api/memory/index' })).statusCode).toBe(200);
  });

  it('answers 503, not 500, when the wiring itself failed', async () => {
    projectsRoot = await mkdtemp(join(tmpdir(), 'agenthub-broken-projects-'));
    // A memory root that cannot exist: its parent is a regular file, so MemoryStore.open rejects
    // and `assistantReady` is a rejected promise every route has to cope with.
    memoryRoot = await mkdtemp(join(tmpdir(), 'agenthub-broken-memory-'));
    const blocker = join(memoryRoot, 'not-a-dir');
    await writeFile(blocker, 'x', 'utf8');
    hub = createHub({ projectsRoot, assistant: { memoryRoot: join(blocker, 'memory') } });
    await hub.projects.stop();

    expect((await hub.app.inject({ method: 'GET', url: '/api/planner' })).statusCode).toBe(503);
    expect((await hub.app.inject({ method: 'POST', url: '/api/assistant/messages', payload: { text: 'hi' } })).statusCode).toBe(503);
    await expect(hub.stop()).resolves.toBeUndefined();
    hub = undefined;
  });

  it('keeps serving — and stops cleanly — when the configured briefing time is malformed', async () => {
    const port = new FakeTelegramPort();
    const h = await setupBroken({ port, briefingTime: '25:99' });

    const handle = await h.assistant();
    expect(handle.scheduler).toBeNull();
    expect((await h.app.inject({ method: 'GET', url: '/api/planner' })).statusCode).toBe(200);
    await expect(h.stop()).resolves.toBeUndefined();
    hub = undefined; // already stopped; afterEach must not stop it twice
  });
});

describe('telegram wiring', () => {
  it('serves the owner and ignores everyone else', async () => {
    const { port } = await setup();

    await port.simulateMessage(OWNER, '/help');
    expect(port.sent).toHaveLength(1);
    expect(port.sent[0].msg.text).toContain('/brief');

    await port.simulateMessage('someone-else', '/help');
    expect(port.sent).toHaveLength(1);
  });

  it('alerts the owner when a node goes offline', async () => {
    const { hub: h, port } = await setup({ staleMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 40));

    await h.app.inject({ method: 'GET', url: '/api/nodes' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(port.sent.map((s) => s.msg.text)).toContain('⚠️ node spark went offline; 0 jobs re-queued');
    expect(port.sent.every((s) => s.chatId === OWNER)).toBe(true);
  });
});
