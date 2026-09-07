import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job, NodeInfo } from '@agenthub/shared';
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
import { Scheduler, SystemClock, type Clock } from '../src/telegram/scheduler.js';

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

/**
 * Advances the real Node event loop one `setImmediate` turn — letting genuine async work (the
 * fetch to the mock OpenAI HTTP server that `Assistant.reply`/`master.dailyBriefing` make) actually
 * settle. Unlike a wall-clock sleep this is deterministic: it doesn't race against a fixed duration,
 * it just gives the pending I/O another chance to resolve.
 */
async function flush(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

/** Polls `predicate` across a bounded number of event-loop turns — never a timed sleep. */
async function waitFor(predicate: () => boolean, maxIterations = 2000): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    if (predicate()) return;
    await flush();
  }
  throw new Error('timed out waiting for condition');
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
  const tools = assistantTools({ memory, planner, gate, service: hub.projects, master: hub.master, registry: hub.registry, jobs: hub.queue });
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

/**
 * Independent of `epochForTz`: looks up the real UTC offset `Intl` reports for `tz` at a given
 * local wall-clock time and builds the expected UTC epoch from it directly, rather than duplicating
 * the production two-pass guess-and-correct algorithm. Safe near a DST transition as long as the
 * probe time (here, always same-day local `h:mi`) lands on the correct side of it, which every case
 * below does — the transition itself always falls in the small hours, well before `09:00`.
 */
function offsetMinutes(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const probe = new Date(Date.UTC(y, mo, d, h, mi, 0));
  const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
    .formatToParts(probe)
    .find((p) => p.type === 'timeZoneName')!.value; // e.g. "GMT-5" or "GMT-4"
  const m = /GMT([+-]\d+)/.exec(part);
  if (!m) throw new Error(`unexpected timeZoneName part: "${part}"`);
  return Number(m[1]) * 60;
}

function localToUtc(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  return Date.UTC(y, mo, d, h, mi, 0) - offsetMinutes(tz, y, mo, d, h, mi) * 60_000;
}

describe('Scheduler.nextFire — DST transitions (America/New_York)', () => {
  const TZ = 'America/New_York';

  it('spring-forward (2026-03-08): 09:00 local resolves to the post-transition EDT instant', async () => {
    const { hub: h, port, assistant } = await setup();
    const scheduler = new Scheduler({
      clock: new ManualClock(0), port, ownerChatId: OWNER, master: h.master, service: h.projects, assistant,
      briefingTime: '09:00', checkinTimes: ['13:00'], tz: TZ,
    });
    // Clocks spring forward at 2am local on 2026-03-08, well before the 09:00 fire time, so `from`
    // (06:00 local, same day) and the expected fire time are both already on the EDT side.
    const from = localToUtc(TZ, 2026, 2, 8, 6, 0);
    const expected = localToUtc(TZ, 2026, 2, 8, 9, 0);
    expect(scheduler.nextFire('briefing', from)).toBe(expected);
  });

  it('spring-forward gap (2026-03-08): a 02:30 briefing that never happens fires just after the gap', async () => {
    const { hub: h, port, assistant } = await setup();
    const scheduler = new Scheduler({
      clock: new ManualClock(0), port, ownerChatId: OWNER, master: h.master, service: h.projects, assistant,
      briefingTime: '02:30', checkinTimes: ['13:00'], tz: TZ,
    });
    // 02:00–03:00 local does not exist on 2026-03-08: no instant renders as 02:30, so the only
    // question is which side of the gap the scheduler lands on. It must be the far one — firing at
    // 01:30 EST would be an hour *before* the configured time.
    const from = localToUtc(TZ, 2026, 2, 8, 0, 30);
    const fire = scheduler.nextFire('briefing', from);

    expect(fire).toBeGreaterThan(from);
    expect(fire - from).toBeLessThan(24 * 3600_000);
    // The first instant at or after the skipped 02:30 is 03:30 EDT — the same wall clock, shifted
    // by the hour the gap swallowed.
    expect(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .format(new Date(fire))).toBe('03:30');
  });

  it('fall-back (2026-11-01): 09:00 local resolves to the post-transition EST instant', async () => {
    const { hub: h, port, assistant } = await setup();
    const scheduler = new Scheduler({
      clock: new ManualClock(0), port, ownerChatId: OWNER, master: h.master, service: h.projects, assistant,
      briefingTime: '09:00', checkinTimes: ['13:00'], tz: TZ,
    });
    // Clocks fall back at 2am local on 2026-11-01, so 06:00 and 09:00 local that day are both
    // already on the EST side of the transition.
    const from = localToUtc(TZ, 2026, 10, 1, 6, 0);
    const expected = localToUtc(TZ, 2026, 10, 1, 9, 0);
    expect(scheduler.nextFire('briefing', from)).toBe(expected);
  });

  it('with no tz configured, falls back to the host-local interpretation of HH:MM', async () => {
    const { hub: h, port, assistant } = await setup();
    const scheduler = new Scheduler({
      clock: new ManualClock(0), port, ownerChatId: OWNER, master: h.master, service: h.projects, assistant,
      briefingTime: '09:00', checkinTimes: ['13:00'],
    });
    // Built with plain `Date` local-time semantics — the same ones `nextFire` uses without a `tz` —
    // so this holds on any machine regardless of its configured timezone.
    const from = new Date(2026, 5, 15, 6, 0, 0, 0).getTime();
    const expected = new Date(2026, 5, 15, 9, 0, 0, 0).getTime();
    expect(scheduler.nextFire('briefing', from)).toBe(expected);
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

  it('start() is idempotent: a second call never orphans the first call\'s timers', async () => {
    const { hub: h, port, assistant } = await setup();
    vi.useFakeTimers();
    try {
      const scheduler = new Scheduler({
        clock: new SystemClock(), port, ownerChatId: OWNER, master: h.master, service: h.projects, assistant,
        briefingTime: '08:00', checkinTimes: ['13:00'], tz: 'UTC',
      });
      scheduler.start();
      scheduler.start();
      scheduler.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

function fakeEvents(): AlertEvents & { emitNodeOffline(n: NodeInfo, requeued: number): void; emitBriefing(b: Briefing): void; emitJobSettled(j: Job): void } {
  const nodeCbs: ((n: NodeInfo, requeued: number) => void)[] = [];
  const briefingCbs: ((b: Briefing) => void)[] = [];
  const jobCbs: ((j: Job) => void)[] = [];
  return {
    onNodeOffline: (cb) => nodeCbs.push(cb),
    onBriefing: (cb) => briefingCbs.push(cb),
    onJobSettled: (cb) => jobCbs.push(cb),
    emitNodeOffline: (n, requeued) => nodeCbs.forEach((cb) => cb(n, requeued)),
    emitBriefing: (b) => briefingCbs.forEach((cb) => cb(b)),
    emitJobSettled: (j) => jobCbs.forEach((cb) => cb(j)),
  };
}

/** A port whose `send` always fails, for the fire-and-forget paths that must survive one. */
class FailingPort extends FakeTelegramPort {
  override async send(): Promise<void> {
    throw new Error('telegram is down');
  }
}

/**
 * Runs `fn` with an `unhandledRejection` listener installed and returns whatever it caught. The
 * listener also stops Node from tearing the process down mid-suite if the guard being tested is
 * missing — the assertion, not the crash, is what reports the failure.
 */
async function unhandledDuring(fn: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onUnhandled = (err: unknown): void => { seen.push(err); };
  process.on('unhandledRejection', onUnhandled);
  try {
    await fn();
    await flush();
    await flush();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  return seen;
}

describe('Alerts', () => {
  it('logs, rather than rejecting into nowhere, when the alert send fails', async () => {
    const { hub: h } = await setup();
    const port = new FailingPort();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const alerts = new Alerts({ port, ownerChatId: OWNER, registry: h.registry, service: h.projects, clock: new ManualClock(0), videoArtifact: async () => null });
    const events = fakeEvents();
    alerts.attach(events);

    const unhandled = await unhandledDuring(async () => { events.emitNodeOffline(node('mb'), 3); });

    expect(unhandled).toEqual([]);
    expect(errors).toHaveBeenCalledWith('[alerts] send failed', expect.any(Error));
    errors.mockRestore();
  });

  it('sends a node-offline alert with the re-queued job count', async () => {
    const { hub: h, port } = await setup();
    const clock = new ManualClock(0);
    const alerts = new Alerts({ port, ownerChatId: OWNER, registry: h.registry, service: h.projects, clock, videoArtifact: async () => null });
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
    const alerts = new Alerts({ port, ownerChatId: OWNER, registry: h.registry, service: h.projects, clock, videoArtifact: async () => null });
    const events = fakeEvents();
    alerts.attach(events);

    events.emitNodeOffline(node('mb'), 1);
    await waitFor(() => port.sent.length >= 1);

    clock.advanceTo(29 * 60_000);
    events.emitNodeOffline(node('mb'), 1);
    // Negative check: nothing here does real I/O (the fake port just records to an array), so a
    // handful of event-loop turns is enough to be confident a second send isn't merely still in
    // flight — bounded by iteration count, not a wall-clock guess.
    await flush();
    await flush();
    expect(port.sent).toHaveLength(1);

    clock.advanceTo(31 * 60_000);
    events.emitNodeOffline(node('mb'), 1);
    await waitFor(() => port.sent.length >= 2);
    expect(port.sent).toHaveLength(2);
  });

  it('sends a blocked-project alert with its blockers', async () => {
    const { hub: h, port } = await setup();
    const clock = new ManualClock(0);
    const alerts = new Alerts({ port, ownerChatId: OWNER, registry: h.registry, service: h.projects, clock, videoArtifact: async () => null });
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
    const alerts = new Alerts({ port, ownerChatId: OWNER, registry: h.registry, service: h.projects, clock, videoArtifact: async () => null });
    const events = fakeEvents();
    alerts.attach(events);

    const active: Briefing = {
      slug: 'website', title: 'Website refresh', status: 'active', priority: 'project',
      summary: 'moving', progress: { done: 1, total: 4 }, blockers: [], nextSteps: [], updatedAt: 0,
    };
    events.emitBriefing(active);
    // Same negative-check rationale as above: no real I/O involved, so a bounded flush suffices.
    await flush();
    await flush();
    expect(port.sent).toHaveLength(0);
  });
});
