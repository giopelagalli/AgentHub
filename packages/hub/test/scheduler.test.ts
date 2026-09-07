import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeInfo } from '@agenthub/shared';
import { createMockOpenAI, type MockOpenAI, type ScriptStep } from '@agenthub/mocks';
import { AgentLoop } from '../src/agents/loop.js';
import { Assistant } from '../src/assistant/assistant.js';
import { ConfirmationGate } from '../src/assistant/confirm.js';
import { MemoryStore } from '../src/assistant/memory.js';
import { Planner } from '../src/assistant/planner.js';
import { assistantTools } from '../src/assistant/tools.js';
import type { Briefing } from '../src/projects/schema.js';
import { createHub, type Hub } from '../src/server.js';
import { Alerts, type AlertEvents } from '../src/telegram/alerts.js';
import { FakeTelegramPort } from '../src/telegram/port.js';
import { Scheduler, type Clock } from '../src/telegram/scheduler.js';

const OWNER = 'owner-chat';

/** A `Clock` a test drives by hand: `advanceTo` fires every timer due by `target`, in order, before settling `now()` there. */
class ManualClock implements Clock {
  private t: number;
  private timers: { id: number; at: number; fn: () => void }[] = [];
  private nextId = 1;

  constructor(start: number) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): { clear(): void } {
    const id = this.nextId++;
    this.timers.push({ id, at: this.t + Math.max(0, ms), fn });
    return { clear: () => { this.timers = this.timers.filter((x) => x.id !== id); } };
  }

  advanceTo(target: number): void {
    for (;;) {
      const due = this.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x.id !== due.id);
      this.t = due.at;
      due.fn();
    }
    this.t = target;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Harness {
  hub: Hub;
  port: FakeTelegramPort;
  assistant: Assistant;
}

let hub: Hub | undefined;
let mock: MockOpenAI | undefined;
let projectsRoot: string | undefined;
let memoryRoot: string | undefined;

async function setup(script: ScriptStep[] = []): Promise<Harness> {
  projectsRoot = await mkdtemp(join(tmpdir(), 'agenthub-scheduler-projects-'));
  memoryRoot = await mkdtemp(join(tmpdir(), 'agenthub-scheduler-memory-'));
  mock = createMockOpenAI({ script });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`;

  hub = createHub({ projectsRoot });
  await hub.projects.stop();
  await hub.app.inject({
    method: 'POST', url: '/api/nodes/register',
    payload: {
      name: 'spark', arch: 'arm64',
      endpoints: [{ tier: 'orchestrator', url, model: 'mock-model', maxStreams: 4 }],
    },
  });

  const memory = await MemoryStore.open(memoryRoot);
  const planner = new Planner(join(memoryRoot, 'planner'), (msg) => memory.commit(msg));
  const gate = new ConfirmationGate();
  const loop = new AgentLoop({ gateway: hub.gateway, transcript: hub.transcript });
  const tools = assistantTools({ memory, planner, gate, service: hub.projects, master: hub.master, registry: hub.registry });
  const assistant = new Assistant({ loop, tools, memory, planner, gate, transcript: hub.transcript });

  const port = new FakeTelegramPort();
  return { hub, port, assistant };
}

afterEach(async () => {
  await hub?.stop();
  await mock?.close();
  for (const dir of [projectsRoot, memoryRoot]) if (dir) await rm(dir, { recursive: true, force: true });
  hub = undefined; mock = undefined; projectsRoot = undefined; memoryRoot = undefined;
});

/** Creates a project and publishes one briefing for it, without going through the model. */
async function seed(h: Hub, slug: string, title: string, status: Briefing['status'] = 'active'): Promise<void> {
  await h.projects.create({ slug, title, intent: 'x' });
  const bundle = await h.projects.get(slug);
  await bundle.publishBriefing({
    slug, title, status, priority: 'project',
    summary: `${title} is moving`, progress: { done: 1, total: 2 },
    blockers: status === 'blocked' ? ['waiting on design review'] : [], nextSteps: [], updatedAt: Date.now(),
  });
}

const node = (name: string): NodeInfo => ({
  id: 1, name, arch: 'arm64', status: 'offline', lastHeartbeat: 0,
  endpoints: [{ tier: 'worker', url: 'http://x', model: 'm', maxStreams: 1 }], jobTypes: [],
});

describe('Scheduler.nextFire', () => {
  it('returns today when the time is still ahead, in the configured tz', async () => {
    const { hub: h, port, assistant } = await setup();
    const scheduler = new Scheduler({
      clock: new ManualClock(0), port, ownerChatId: OWNER, master: h.master, service: h.projects, assistant,
      briefingTime: '08:00', checkinTimes: ['13:00'], tz: 'UTC',
    });
    const from = Date.UTC(2026, 0, 1, 5, 0, 0);
    expect(scheduler.nextFire('briefing', from)).toBe(Date.UTC(2026, 0, 1, 8, 0, 0));
  });

  it('rolls to tomorrow when the time already passed today', async () => {
    const { hub: h, port, assistant } = await setup();
    const scheduler = new Scheduler({
      clock: new ManualClock(0), port, ownerChatId: OWNER, master: h.master, service: h.projects, assistant,
      briefingTime: '08:00', checkinTimes: ['13:00'], tz: 'UTC',
    });
    const from = Date.UTC(2026, 0, 1, 9, 0, 0);
    expect(scheduler.nextFire('briefing', from)).toBe(Date.UTC(2026, 0, 2, 8, 0, 0));
  });

  it('rolls to tomorrow when from lands exactly on the fire time (never re-fires in place)', async () => {
    const { hub: h, port, assistant } = await setup();
    const scheduler = new Scheduler({
      clock: new ManualClock(0), port, ownerChatId: OWNER, master: h.master, service: h.projects, assistant,
      briefingTime: '08:00', checkinTimes: ['13:00'], tz: 'UTC',
    });
    const from = Date.UTC(2026, 0, 1, 8, 0, 0);
    expect(scheduler.nextFire('briefing', from)).toBe(Date.UTC(2026, 0, 2, 8, 0, 0));
  });

  it('picks the earliest check-in across a midnight boundary', async () => {
    const { hub: h, port, assistant } = await setup();
    const scheduler = new Scheduler({
      clock: new ManualClock(0), port, ownerChatId: OWNER, master: h.master, service: h.projects, assistant,
      briefingTime: '08:00', checkinTimes: ['23:50', '00:10'], tz: 'UTC',
    });
    // Both times have already passed today; the next occurrence of 00:10 (tomorrow) comes before
    // the next occurrence of 23:50 (also tomorrow).
    const from = Date.UTC(2026, 0, 1, 23, 55, 0);
    expect(scheduler.nextFire('checkin', from)).toBe(Date.UTC(2026, 0, 2, 0, 10, 0));
  });
});

describe('Scheduler firing', () => {
  it('fires the daily briefing exactly once per day boundary and sends it to the owner', async () => {
    const { hub: h, port, assistant } = await setup();
    await seed(h, 'website', 'Website refresh');

    const start = Date.UTC(2026, 0, 1, 7, 0, 0);
    const clock = new ManualClock(start);
    const scheduler = new Scheduler({
      clock, port, ownerChatId: OWNER, master: h.master, service: h.projects, assistant,
      briefingTime: '08:00', checkinTimes: ['13:00'], tz: 'UTC',
    });
    scheduler.start();

    // `checkinTimes: ['13:00']` also fires once in this window (a Scheduler always runs both
    // timers), so assertions filter to briefing sends specifically rather than raw send count.
    const briefingSent = () => port.sent.filter((s) => s.msg.text.includes('Website refresh'));

    clock.advanceTo(Date.UTC(2026, 0, 1, 8, 0, 0));
    await waitFor(() => briefingSent().length >= 1);
    expect(briefingSent()).toHaveLength(1);
    expect(briefingSent()[0]!.chatId).toBe(OWNER);
    expect(briefingSent()[0]!.msg.text).toContain('Website refresh');

    // Advancing short of the next day must not fire it again.
    clock.advanceTo(Date.UTC(2026, 0, 1, 20, 0, 0));
    expect(briefingSent()).toHaveLength(1);

    clock.advanceTo(Date.UTC(2026, 0, 2, 8, 0, 0));
    await waitFor(() => briefingSent().length >= 2);
    expect(briefingSent()).toHaveLength(2);

    scheduler.stop();
  });

  it('fires a check-in and sends the assistant reply to the owner', async () => {
    const { hub: h, port, assistant } = await setup();
    const start = Date.UTC(2026, 0, 1, 12, 0, 0);
    const clock = new ManualClock(start);
    const scheduler = new Scheduler({
      clock, port, ownerChatId: OWNER, master: h.master, service: h.projects, assistant,
      briefingTime: '08:00', checkinTimes: ['13:00'], tz: 'UTC',
    });
    scheduler.start();

    clock.advanceTo(Date.UTC(2026, 0, 1, 13, 0, 0));
    await waitFor(() => port.sent.length >= 1);
    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]!.chatId).toBe(OWNER);
    expect(typeof port.sent[0]!.msg.text).toBe('string');

    scheduler.stop();
  });

  it('stop() cancels pending timers', async () => {
    const { hub: h, port, assistant } = await setup();
    const clock = new ManualClock(Date.UTC(2026, 0, 1, 7, 0, 0));
    const scheduler = new Scheduler({
      clock, port, ownerChatId: OWNER, master: h.master, service: h.projects, assistant,
      briefingTime: '08:00', checkinTimes: ['13:00'], tz: 'UTC',
    });
    scheduler.start();
    scheduler.stop();

    clock.advanceTo(Date.UTC(2026, 0, 3, 0, 0, 0));
    expect(port.sent).toHaveLength(0);
  });
});

function fakeEvents(): AlertEvents & { emitNodeOffline(n: NodeInfo, requeued: number): void; emitBriefing(b: Briefing): void } {
  const nodeCbs: ((n: NodeInfo, requeued: number) => void)[] = [];
  const briefingCbs: ((b: Briefing) => void)[] = [];
  return {
    onNodeOffline: (cb) => nodeCbs.push(cb),
    onBriefing: (cb) => briefingCbs.push(cb),
    emitNodeOffline: (n, requeued) => nodeCbs.forEach((cb) => cb(n, requeued)),
    emitBriefing: (b) => briefingCbs.forEach((cb) => cb(b)),
  };
}

describe('Alerts', () => {
  it('sends a node-offline alert with the re-queued job count', async () => {
    const { hub: h, port } = await setup();
    const clock = new ManualClock(0);
    const alerts = new Alerts({ port, ownerChatId: OWNER, registry: h.registry, service: h.projects, clock });
    const events = fakeEvents();
    alerts.attach(events);

    events.emitNodeOffline(node('mb'), 3);
    await waitFor(() => port.sent.length >= 1);
    expect(port.sent[0]!.chatId).toBe(OWNER);
    expect(port.sent[0]!.msg.text).toBe('⚠️ node mb went offline; 3 jobs re-queued');
  });

  it('dedupes the same alert key within 30 minutes, and re-sends after', async () => {
    const { hub: h, port } = await setup();
    const clock = new ManualClock(0);
    const alerts = new Alerts({ port, ownerChatId: OWNER, registry: h.registry, service: h.projects, clock });
    const events = fakeEvents();
    alerts.attach(events);

    events.emitNodeOffline(node('mb'), 1);
    await waitFor(() => port.sent.length >= 1);

    clock.advanceTo(29 * 60_000);
    events.emitNodeOffline(node('mb'), 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(port.sent).toHaveLength(1);

    clock.advanceTo(31 * 60_000);
    events.emitNodeOffline(node('mb'), 1);
    await waitFor(() => port.sent.length >= 2);
    expect(port.sent).toHaveLength(2);
  });

  it('sends a blocked-project alert with its blockers', async () => {
    const { hub: h, port } = await setup();
    const clock = new ManualClock(0);
    const alerts = new Alerts({ port, ownerChatId: OWNER, registry: h.registry, service: h.projects, clock });
    const events = fakeEvents();
    alerts.attach(events);

    const blocked: Briefing = {
      slug: 'website', title: 'Website refresh', status: 'blocked', priority: 'project',
      summary: 'stuck', progress: { done: 1, total: 4 }, blockers: ['waiting on design review'],
      nextSteps: [], updatedAt: 0,
    };
    events.emitBriefing(blocked);
    await waitFor(() => port.sent.length >= 1);
    expect(port.sent[0]!.msg.text).toBe('⛔ Website refresh is blocked: waiting on design review');
  });

  it('ignores briefings that are not blocked', async () => {
    const { hub: h, port } = await setup();
    const clock = new ManualClock(0);
    const alerts = new Alerts({ port, ownerChatId: OWNER, registry: h.registry, service: h.projects, clock });
    const events = fakeEvents();
    alerts.attach(events);

    const active: Briefing = {
      slug: 'website', title: 'Website refresh', status: 'active', priority: 'project',
      summary: 'moving', progress: { done: 1, total: 4 }, blockers: [], nextSteps: [], updatedAt: 0,
    };
    events.emitBriefing(active);
    await new Promise((r) => setTimeout(r, 20));
    expect(port.sent).toHaveLength(0);
  });
});
