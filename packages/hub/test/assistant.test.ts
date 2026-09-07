import { describe, it, expect, afterEach } from 'vitest';
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

interface Harness {
  assistant: Assistant;
  memory: MemoryStore;
  planner: Planner;
  gate: ConfirmationGate;
  mock: MockOpenAI;
}

let hub: Hub | undefined;
let mock: MockOpenAI | undefined;
let projectsRoot: string | undefined;
let memoryRoot: string | undefined;

async function setup(script: ScriptStep[] = []): Promise<Harness> {
  projectsRoot = await mkdtemp(join(tmpdir(), 'agenthub-assistant-projects-'));
  memoryRoot = await mkdtemp(join(tmpdir(), 'agenthub-assistant-memory-'));
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
  const tools = assistantTools({
    memory, planner, gate,
    service: hub.projects, master: hub.master, registry: hub.registry,
  });
  const assistant = new Assistant({ loop, tools, memory, planner, gate, transcript: hub.transcript });
  return { assistant, memory, planner, gate, mock };
}

afterEach(async () => {
  await hub?.stop();
  await mock?.close();
  for (const dir of [projectsRoot, memoryRoot]) if (dir) await rm(dir, { recursive: true, force: true });
  hub = undefined; mock = undefined; projectsRoot = undefined; memoryRoot = undefined;
});

const messagesOf = (m: MockOpenAI): { role: string; content: string | null }[] =>
  m.lastRequest().messages as { role: string; content: string | null }[];

describe('Assistant.reply', () => {
  it('runs a planner tool and returns the model reply', async () => {
    const { assistant, planner } = await setup([
      { toolCalls: [{ name: 'planner_add', arguments: { list: 'todo', text: 'buy oat milk' } }] },
      { content: 'Added it to your todo list.' },
    ]);

    const res = await assistant.reply('remind me to buy oat milk');

    expect(res.text).toBe('Added it to your todo list.');
    expect(res.pending).toEqual([]);
    expect(await planner.list('todo')).toEqual([{ n: 1, text: 'buy oat milk', done: false }]);
  });

  it('writes a note when the model calls remember', async () => {
    const { assistant, memory } = await setup([
      { toolCalls: [{ name: 'remember', arguments: {
        name: 'Coffee', description: 'Owner drinks oat flat whites', type: 'preference',
        body: 'Oat flat white, no sugar.',
      } }] },
      { content: 'Noted.' },
    ]);

    await assistant.reply('I always drink oat flat whites');

    const note = await memory.read('Coffee');
    expect(note?.meta.type).toBe('preference');
    expect(note?.body).toContain('Oat flat white');
    expect(await memory.index()).toContainEqual({
      name: 'Coffee', description: 'Owner drinks oat flat whites', file: 'notes/coffee.md',
    });
  });

  it('holds an outward action for confirmation instead of running it', async () => {
    const { assistant, gate, mock } = await setup([
      { toolCalls: [{ name: 'demo_outward_action', arguments: { text: 'hello world' } }] },
      { content: 'Ready to send — confirm?' },
    ]);

    const res = await assistant.reply('send hello world');

    expect(res.pending).toHaveLength(1);
    expect(res.pending[0].description).toContain('hello world');
    expect(gate.pending()).toHaveLength(1);
    // The model is told the action is pending, not that it happened.
    const toolResult = messagesOf(mock).find((m) => m.role === 'tool')?.content ?? '';
    expect(toolResult).toBe(`pending confirmation ${res.pending[0].id}`);

    expect(await gate.confirm(res.pending[0].id)).toBe('sent: hello world');
    expect(gate.pending()).toEqual([]);
  });

  it('drops an outward action the owner cancels', async () => {
    const { assistant, gate } = await setup([
      { toolCalls: [{ name: 'demo_outward_action', arguments: { text: 'hello world' } }] },
      { content: 'Ready to send — confirm?' },
    ]);

    const res = await assistant.reply('send hello world');

    expect(gate.cancel(res.pending[0].id)).toBe(true);
    expect(gate.pending()).toEqual([]);
  });

  it('inlines the memory index and the planner snapshot in the system prompt', async () => {
    const { assistant, memory, planner, mock } = await setup([{ content: 'Hi.' }]);
    await memory.remember({
      name: 'Sister Ada', description: 'Owner’s sister, lives in Lisbon', type: 'person',
      body: 'Ada moved to Lisbon in 2024.',
    });
    await planner.add('goals', 'ship AgentHub phase 4');
    await planner.add('todo', 'call the dentist');
    await planner.complete('todo', 1);

    await assistant.reply('hey');

    const system = messagesOf(mock)[0];
    expect(system.role).toBe('system');
    expect(system.content).toContain('Sister Ada');
    expect(system.content).toContain('Owner’s sister, lives in Lisbon');
    expect(system.content).toContain('ship AgentHub phase 4');
    // The snapshot carries open items only.
    expect(system.content).not.toContain('call the dentist');
  });

  it('replays the previous turns as conversation history', async () => {
    const { assistant, mock } = await setup([
      { content: 'Your sister is Ada.' },
      { content: 'She lives in Lisbon.' },
    ]);

    await assistant.reply('who is my sister?');
    await assistant.reply('where does she live?');

    const sent = messagesOf(mock);
    expect(sent.map((m) => `${m.role}: ${m.content}`)).toEqual([
      expect.stringContaining('system:'),
      'user: who is my sister?',
      'assistant: Your sister is Ada.',
      'user: where does she live?',
    ]);
  });
});
