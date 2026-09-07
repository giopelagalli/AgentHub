import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockOpenAI, type MockOpenAI, type ScriptStep } from '@agenthub/mocks';
import { AgentLoop } from '../src/agents/loop.js';
import { Assistant } from '../src/assistant/assistant.js';
import { ConfirmationGate } from '../src/assistant/confirm.js';
import { MemoryStore } from '../src/assistant/memory.js';
import { Planner } from '../src/assistant/planner.js';
import { assistantTools } from '../src/assistant/tools.js';
import { createHub, type Hub } from '../src/server.js';
import { CommandRouter } from '../src/telegram/router.js';
import { FakeTelegramPort, type OutgoingMessage } from '../src/telegram/port.js';

const OWNER = 'owner-chat';
const STRANGER = 'stranger-chat';

interface Harness {
  router: CommandRouter;
  port: FakeTelegramPort;
  hub: Hub;
  planner: Planner;
  gate: ConfirmationGate;
  mock: MockOpenAI;
}

let hub: Hub | undefined;
let mock: MockOpenAI | undefined;
let projectsRoot: string | undefined;
let memoryRoot: string | undefined;

/**
 * Fails only the `/new` follow-up send, so a test can exercise the background chain's terminal
 * failure without also breaking the ack the same handler sends first.
 */
class FollowUpFailsPort extends FakeTelegramPort {
  override async send(chatId: string, msg: OutgoingMessage): Promise<void> {
    if (msg.text.startsWith('First turn')) throw new Error('telegram is down');
    return super.send(chatId, msg);
  }
}

async function setup(script: ScriptStep[] = [], port: FakeTelegramPort = new FakeTelegramPort()): Promise<Harness> {
  projectsRoot = await mkdtemp(join(tmpdir(), 'agenthub-router-projects-'));
  memoryRoot = await mkdtemp(join(tmpdir(), 'agenthub-router-memory-'));
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

  const router = new CommandRouter({
    port, ownerChatId: OWNER, assistant, service: hub.projects, master: hub.master,
    planner, registry: hub.registry, gate,
  });
  router.start();

  return { router, port, hub, planner, gate, mock };
}

afterEach(async () => {
  await hub?.stop();
  await mock?.close();
  for (const dir of [projectsRoot, memoryRoot]) if (dir) await rm(dir, { recursive: true, force: true });
  hub = undefined; mock = undefined; projectsRoot = undefined; memoryRoot = undefined;
});

/** Polls `port.sent` until it holds at least `count` messages, for asserting on a fire-and-forget reply. */
async function waitForMessage(
  port: FakeTelegramPort, count: number, timeoutMs = 2000,
): Promise<{ chatId: string; msg: OutgoingMessage }> {
  const deadline = Date.now() + timeoutMs;
  while (port.sent.length < count) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for message #${count}; got ${port.sent.length}`);
    await new Promise((r) => setTimeout(r, 10));
  }
  return port.sent[count - 1]!;
}

/**
 * Runs `fn`, then polls until `settled` holds, with an `unhandledRejection` listener installed;
 * returns whatever that listener caught.
 */
async function unhandledDuring(fn: () => Promise<void>, settled: () => boolean): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onUnhandled = (err: unknown): void => { seen.push(err); };
  process.on('unhandledRejection', onUnhandled);
  try {
    await fn();
    const deadline = Date.now() + 2000;
    while (!settled() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setImmediate(r));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  return seen;
}

/** Creates a project and publishes one briefing for it, without going through the model. */
async function seed(h: Hub, slug: string, title: string): Promise<void> {
  await h.projects.create({ slug, title, intent: 'x' });
  const bundle = await h.projects.get(slug);
  await bundle.publishBriefing({
    slug, title, status: 'active', priority: 'project',
    summary: `${title} is moving`, progress: { done: 1, total: 2 },
    blockers: [], nextSteps: [], updatedAt: Date.now(),
  });
}

describe('CommandRouter', () => {
  it('ignores messages from a chat that is not the owner', async () => {
    const { port } = await setup();
    await port.simulateMessage(STRANGER, '/help');
    expect(port.sent).toEqual([]);
  });

  it('ignores callbacks from a chat that is not the owner', async () => {
    const { port, hub } = await setup();
    await seed(hub, 'demo', 'Demo');
    await port.simulateCallback(STRANGER, 'proj:pause:demo');
    expect(port.sent).toEqual([]);
    expect((await (await hub.projects.get('demo')).manifest()).status).toBe('active');
  });

  it('/help lists the commands', async () => {
    const { port } = await setup();
    await port.simulateMessage(OWNER, '/help');
    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]!.msg.text).toContain('/brief');
    expect(port.sent[0]!.msg.text).toContain('/new');
  });

  it('an unknown command falls back to help', async () => {
    const { port } = await setup();
    await port.simulateMessage(OWNER, '/nope');
    expect(port.sent[0]!.msg.text).toContain('/brief');
  });

  it('/brief asks the master orchestrator and reports every project', async () => {
    const { port, hub } = await setup([{ content: 'Demo is moving along nicely.' }]);
    await seed(hub, 'demo', 'Demo');

    await port.simulateMessage(OWNER, '/brief');

    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]!.msg.text).toContain('Demo is moving along nicely.');
    expect(port.sent[0]!.msg.text).toContain('Demo: active');
  });

  it('/projects lists projects with pause/turn buttons', async () => {
    const { port, hub } = await setup();
    await seed(hub, 'demo', 'Demo');

    await port.simulateMessage(OWNER, '/projects');

    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]!.msg.text).toContain('Demo (demo)');
    expect(port.sent[0]!.msg.buttons).toEqual([[
      { text: 'Pause', data: 'proj:pause:demo' },
      { text: 'Run turn', data: 'proj:turn:demo' },
    ]]);
  });

  it('/todo add appends an item and lists it back', async () => {
    const { port, planner } = await setup();

    await port.simulateMessage(OWNER, '/todo add buy oat milk');

    expect(port.sent[0]!.msg.text).toBe('Todo:\n1. [ ] buy oat milk');
    expect(await planner.list('todo')).toEqual([{ n: 1, text: 'buy oat milk', done: false }]);
  });

  it('/todo done completes an item', async () => {
    const { port, planner } = await setup();
    await planner.add('todo', 'buy oat milk');

    await port.simulateMessage(OWNER, '/todo done 1');

    expect(port.sent[0]!.msg.text).toBe('Todo:\n1. [x] buy oat milk');
  });

  it('/nodes reports the registered node', async () => {
    const { port } = await setup();
    await port.simulateMessage(OWNER, '/nodes');
    expect(port.sent[0]!.msg.text).toContain('spark (arm64)');
  });

  it('/video and /controlnode reply that they are coming in Phase 6', async () => {
    const { port } = await setup();
    await port.simulateMessage(OWNER, '/video a sunset over the ocean');
    expect(port.sent[0]!.msg.text).toBe('coming in Phase 6');
  });

  it('/new creates a project and replies twice, the second once the first turn completes', async () => {
    const { port, hub } = await setup([{ content: 'Set up the initial plan.' }]);

    await port.simulateMessage(OWNER, '/new My New Project: build something great');

    // The ack comes back before the first turn has even started — handle() returns without
    // awaiting it, so only one message has landed by the time simulateMessage resolves.
    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]!.msg.text).toContain('my-new-project');
    const manifest = await (await hub.projects.get('my-new-project')).manifest();
    expect(manifest.title).toBe('My New Project');

    const briefing = await waitForMessage(port, 2);
    expect(briefing.msg.text).toContain('First turn for my-new-project done');
  });

  it('/new reports the failure if the first turn throws, without blocking the ack', async () => {
    const { port, hub } = await setup();
    // A real delay (not just a rejected-microtask race) so the ack is unambiguously observed
    // before the failure, proving handle() didn't wait on this promise to settle.
    hub.projects.runTurn = (async () => {
      await new Promise((r) => setTimeout(r, 20));
      throw new Error('gateway is down');
    }) as typeof hub.projects.runTurn;

    await port.simulateMessage(OWNER, '/new Another Project: get it done');

    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]!.msg.text).toContain('another-project');

    const failure = await waitForMessage(port, 2);
    expect(failure.msg.text).toBe('First turn failed: gateway is down');
  });

  it('/new logs, rather than rejecting into nowhere, when the follow-up send itself fails', async () => {
    const { port } = await setup([{ content: 'Set up the initial plan.' }], new FollowUpFailsPort());
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const unhandled = await unhandledDuring(
      () => port.simulateMessage(OWNER, '/new Doomed Project: it will not report back'),
      () => errors.mock.calls.some(([first]) => first === '[telegram] /new follow-up send failed'),
    );

    expect(unhandled).toEqual([]);
    expect(errors).toHaveBeenCalledWith('[telegram] /new follow-up send failed', expect.any(Error));
    errors.mockRestore();
  });

  it('a throwing service does not take the bot down: the owner gets an error reply and the next command still works', async () => {
    const { port, hub } = await setup();
    hub.registry.all = () => { throw new Error('registry exploded'); };

    await port.simulateMessage(OWNER, '/nodes');

    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]!.msg.text).toBe('Something went wrong handling that — see hub logs.');

    await port.simulateMessage(OWNER, '/help');

    expect(port.sent).toHaveLength(2);
    expect(port.sent[1]!.msg.text).toContain('/brief');
  });

  it('a throwing service in a callback replies with the error text and later callbacks still work', async () => {
    const { port, hub } = await setup();
    await seed(hub, 'demo', 'Demo');
    hub.projects.pause = async () => { throw new Error('db exploded'); };

    await port.simulateCallback(OWNER, 'proj:pause:demo');

    // Answered before the work was attempted, so the owner's button stops spinning either way.
    expect(port.answered).toHaveLength(1);
    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]!.msg.text).toBe('Something went wrong handling that — see hub logs.');

    // A different callback, hitting an untouched code path, still goes through fine.
    await port.simulateCallback(OWNER, 'proj:resume:demo');

    expect(port.sent).toHaveLength(2);
    expect(port.sent[1]!.msg.text).toContain('Demo (demo)');
  });

  it('a proj:pause callback pauses the project and reports back the updated list', async () => {
    const { port, hub } = await setup();
    await seed(hub, 'demo', 'Demo');

    await port.simulateCallback(OWNER, 'proj:pause:demo');

    expect((await (await hub.projects.get('demo')).manifest()).status).toBe('paused');
    expect(port.answered).toHaveLength(1);
    expect(port.sent[0]!.msg.text).toContain('Demo (demo)');
  });

  it('free text goes to the assistant, and an outward action attaches Confirm/Cancel buttons that the gate honors', async () => {
    const { port, gate } = await setup([
      { toolCalls: [{ name: 'demo_outward_action', arguments: { text: 'hello world' } }] },
      { content: 'Ready to send — confirm?' },
    ]);

    await port.simulateMessage(OWNER, 'send hello world to my friend');

    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]!.msg.text).toBe('Ready to send — confirm?');
    const buttons = port.sent[0]!.msg.buttons;
    expect(buttons).toHaveLength(1);
    const [confirmButton, cancelButton] = buttons![0]!;
    expect(confirmButton!.text).toBe('Confirm');
    expect(cancelButton!.text).toBe('Cancel');
    expect(gate.pending()).toHaveLength(1);

    await port.simulateCallback(OWNER, confirmButton!.data);

    expect(gate.pending()).toEqual([]);
    expect(port.sent[1]!.msg.text).toBe('sent: hello world');
  });
});
