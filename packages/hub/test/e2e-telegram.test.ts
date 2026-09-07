import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockOpenAI, type MockOpenAI, type ScriptStep } from '@agenthub/mocks';
import { createHub, type Hub } from '../src/server.js';
import { FakeTelegramPort } from '../src/telegram/port.js';
import type { Clock } from '../src/telegram/scheduler.js';

/**
 * Phase 4 acceptance test (spec §14): the hub driven entirely through a `FakeTelegramPort` and a
 * fake clock, with the model scripted — no real Telegram, no real network beyond the loopback mock.
 * `/new` creates a project from "the phone"; a scheduled briefing later arrives with real project
 * state; free text teaches the assistant something durable; an outward action waits for an explicit
 * Confirm; and a stale node reaches the owner as an alert — all through the one wiring `createHub`
 * builds from an `assistant` option.
 */

const OWNER = 'owner-chat';
const STRANGER = 'stranger-chat';

/** A `Clock` the test drives by hand: `advanceTo` fires every timer due by `target`, in order. */
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

/** A single `setImmediate` turn — enough to settle handlers that are already resolved. */
async function flush(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

/**
 * Polls `predicate`, for the two spots in this test that observe the result of a genuinely
 * fire-and-forget async chain (the `/new` background turn, the scheduler's fire-and-forget send) —
 * both make a real fetch to the loopback mock server, whose cold-start latency a bounded
 * `setImmediate` spin can undershoot. Matches the same real-time-bounded pattern router.test.ts's
 * `waitForMessage` and assistant-api.test.ts's node-offline check already use for the same reason.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

let hub: Hub | undefined;
let mock: MockOpenAI | undefined;
let projectsRoot: string | undefined;
let memoryRoot: string | undefined;

interface Harness {
  hub: Hub;
  port: FakeTelegramPort;
  clock: ManualClock;
}

/**
 * Delivers a message and waits for the router's detached per-chat chain to drain — the transport
 * hands an update off and returns, so `simulateMessage` resolving does not mean the reply is out.
 */
async function deliver(port: FakeTelegramPort, chatId: string, text: string): Promise<void> {
  await port.simulateMessage(chatId, text);
  await (await hub!.assistant()).router!.idle();
}

/** `deliver`, for a button press. */
async function press(port: FakeTelegramPort, chatId: string, data: string): Promise<void> {
  await port.simulateCallback(chatId, data);
  await (await hub!.assistant()).router!.idle();
}

async function setup(script: ScriptStep[] = [], opts: { staleMs?: number } = {}): Promise<Harness> {
  projectsRoot = await mkdtemp(join(tmpdir(), 'agenthub-e2e-telegram-projects-'));
  memoryRoot = await mkdtemp(join(tmpdir(), 'agenthub-e2e-telegram-memory-'));
  mock = createMockOpenAI({ script });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`;

  const port = new FakeTelegramPort();
  // Started at 07:00 UTC; briefingTime fires at 08:00 the same day once the clock is advanced to
  // it. checkinTimes is set far past that window so it never fires and never consumes a script step.
  const clock = new ManualClock(Date.UTC(2026, 0, 1, 7, 0, 0));

  hub = createHub({
    projectsRoot,
    ...(opts.staleMs ? { staleMs: opts.staleMs } : {}),
    assistant: {
      memoryRoot,
      telegram: { port, ownerChatId: OWNER },
      schedule: { briefingTime: '08:00', checkinTimes: ['23:59'], tz: 'UTC' },
      clock,
    },
  });
  // The project fleet's own 15-minute auto-tick scheduler would otherwise burn scripted model
  // steps this test needs for its own, explicitly-triggered turns.
  await hub.projects.stop();
  await hub.app.inject({
    method: 'POST', url: '/api/nodes/register',
    payload: {
      name: 'spark', arch: 'arm64',
      endpoints: [{ tier: 'orchestrator', url, model: 'mock-model', maxStreams: 4 }],
    },
  });
  await hub.assistant(); // waits for memory/planner/gate/router/scheduler/alerts wiring to finish
  return { hub, port, clock };
}

afterEach(async () => {
  await hub?.stop();
  await mock?.close();
  for (const dir of [projectsRoot, memoryRoot]) if (dir) await rm(dir, { recursive: true, force: true });
  hub = undefined; mock = undefined; projectsRoot = undefined; memoryRoot = undefined;
});

describe('phase 4 acceptance: telegram control and scheduled briefing', () => {
  it('drives project creation, planner, memory, confirmation and the scheduled briefing entirely through Telegram', async () => {
    const { hub: h, port, clock } = await setup([
      // 1: /new's background first turn — no tool calls, so the orchestrator synthesizes a
      // briefing from the manifest's own title ("Website refresh") and this text as the summary.
      { content: 'Getting started on the landing page.' },
      // 2-3: free text that teaches the assistant something durable.
      {
        toolCalls: [{
          name: 'remember',
          arguments: {
            name: 'Morning meetings', description: 'Owner prefers morning meetings.',
            type: 'preference', body: 'The owner prefers to have meetings in the morning.',
          },
        }],
      },
      { content: 'Got it — noted that you prefer morning meetings.' },
      // 4-5: free text that triggers an outward (confirm-gated) action.
      { toolCalls: [{ name: 'demo_outward_action', arguments: { text: 'ship the landing page update' } }] },
      { content: 'Ready when you confirm.' },
      // 6: the scheduled daily briefing (master.dailyBriefing has no tools, one call).
      { content: "Here's today's update." },
    ]);

    // --- /new creates a project and, once the background first turn finishes, reports it -------
    await deliver(port, OWNER, '/new Website refresh: rebuild the landing page');
    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]!.msg.text).toContain('website-refresh');

    await waitFor(() => port.sent.length >= 2);
    expect(port.sent).toHaveLength(2);
    expect(port.sent[1]!.msg.text).toContain('First turn for website-refresh done');
    const manifest = await (await h.projects.get('website-refresh')).manifest();
    expect(manifest.title).toBe('Website refresh');

    // --- a non-owner chat is invisible to the bot ------------------------------------------------
    await deliver(port, STRANGER, '/brief');
    expect(port.sent).toHaveLength(2);

    // --- free text that teaches the assistant something durable calls remember() ------------------
    await deliver(port, OWNER, 'remember that I prefer morning meetings');
    expect(port.sent).toHaveLength(3);
    const handle = await h.assistant();
    const index = await handle.memory.index();
    expect(index.some((e) => e.name === 'Morning meetings')).toBe(true);
    expect(await handle.memory.indexText()).toContain('Morning meetings');

    // --- an outward action is proposed, not run, until the owner presses Confirm ------------------
    await deliver(port, OWNER, 'post that update for me');
    expect(port.sent).toHaveLength(4);
    const proposal = port.sent[3]!;
    const confirmButton = proposal.msg.buttons?.flat().find((b) => b.data.startsWith('confirm:'));
    expect(confirmButton).toBeTruthy();
    const pendingId = confirmButton!.data.slice('confirm:'.length);
    expect(handle.gate.pending().map((p) => p.id)).toContain(pendingId);

    await press(port, OWNER, confirmButton!.data);
    expect(handle.gate.pending().map((p) => p.id)).not.toContain(pendingId);
    expect(port.sent[port.sent.length - 1]!.msg.text).toBe('sent: ship the landing page update');

    // --- /todo add + /todo list --------------------------------------------------------------------
    await deliver(port, OWNER, '/todo add call the bank');
    expect(port.sent[port.sent.length - 1]!.msg.text).toBe('Todo:\n1. [ ] call the bank');
    await deliver(port, OWNER, '/todo');
    expect(port.sent[port.sent.length - 1]!.msg.text).toBe('Todo:\n1. [ ] call the bank');

    // --- advancing the fake clock to BRIEFING_TIME fires exactly one scheduled briefing -----------
    const beforeBriefing = port.sent.length;
    clock.advanceTo(Date.UTC(2026, 0, 1, 8, 0, 0));
    await waitFor(() => port.sent.length > beforeBriefing);
    const briefings = port.sent.slice(beforeBriefing);
    expect(briefings).toHaveLength(1);
    expect(briefings[0]!.chatId).toBe(OWNER);
    expect(briefings[0]!.msg.text).toContain('Website refresh');
  });

  it('alerts the owner when a registered node goes offline', async () => {
    const { port, hub: h } = await setup([], { staleMs: 20 });
    // Node staleness is genuinely wall-clock based (NodeRegistry.sweep defaults to real Date.now,
    // independent of the scheduler's injected Clock), so this waits on real time rather than the
    // fake clock — matching the same pattern assistant-api.test.ts uses for the same reason.
    await new Promise((resolve) => setTimeout(resolve, 40));
    await h.app.inject({ method: 'GET', url: '/api/nodes' });
    await flush();

    expect(port.sent.map((s) => s.msg.text)).toContain('⚠️ node spark went offline; 0 jobs re-queued');
    expect(port.sent.every((s) => s.chatId === OWNER)).toBe(true);
  });
});
