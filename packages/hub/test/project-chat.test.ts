import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockOpenAI, type MockOpenAI, type ScriptStep } from '@agenthub/mocks';
import { openDb } from '../src/db.js';
import { NodeRegistry } from '../src/node-registry.js';
import { ModelGateway } from '../src/gateway.js';
import { AgentLoop } from '../src/agents/loop.js';
import { Transcript } from '../src/agents/transcript.js';
import { ProjectBundle } from '../src/projects/bundle.js';
import { ProjectChat } from '../src/projects/chat.js';
import { createHub, type Hub } from '../src/server.js';

const CHARTER = '# Demo\n\n## Goal\n\nThe frobnicator ships on Friday.\n';

let root: string;
let bundle: ProjectBundle;
let mocks: MockOpenAI[];
let hub: Hub | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agenthub-chat-'));
  bundle = await ProjectBundle.create(root, { slug: 'demo', title: 'Demo', intent: 'ship the demo' });
  await bundle.writeProject(CHARTER);
  mocks = [];
});

afterEach(async () => {
  await hub?.stop();
  for (const m of mocks) await m.close();
  await rm(root, { recursive: true, force: true });
  hub = undefined;
});

async function serve(script: ScriptStep[] = []): Promise<{ mock: MockOpenAI; url: string }> {
  const mock = createMockOpenAI({ script });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  mocks.push(mock);
  return { mock, url: `http://127.0.0.1:${(mock.server.address() as { port: number }).port}` };
}

interface Harness {
  chat: ProjectChat;
  mock: MockOpenAI;
  transcript: Transcript;
}

async function setup(script: ScriptStep[] = []): Promise<Harness> {
  const { mock, url } = await serve(script);
  const db = openDb(':memory:');
  const registry = new NodeRegistry(db);
  registry.register({
    name: 'spark', arch: 'arm64',
    endpoints: [{ tier: 'orchestrator', url, model: 'mock-model', maxStreams: 2 }],
  });
  const transcript = new Transcript(db);
  const loop = new AgentLoop({ gateway: new ModelGateway(registry), transcript });
  return { chat: new ProjectChat({ loop, transcript, bundleFor: async () => bundle }), mock, transcript };
}

/** The system prompt of the model's most recent request. */
const lastSystem = (mock: MockOpenAI): string => mock.lastRequest().messages[0].content as string;

/** Every message of the model's most recent request as `role:content` pairs. */
const lastMessages = (mock: MockOpenAI): { role: string; content: string | null }[] => mock.lastRequest().messages;

describe('ProjectChat', () => {
  it('answers as the manager over the project context pack', async () => {
    const { chat, mock } = await setup([{ content: 'We are on track for Friday.' }]);

    const reply = await chat.reply('demo', 'manager', 'Where are we?');

    expect(reply).toMatchObject({ text: 'We are on track for Friday.', outcome: 'stop' });
    const system = lastSystem(mock);
    expect(system).toContain('The frobnicator ships on Friday.');
    expect(system).toContain('chatting with the owner');
    // The chat persona is the orchestrator's, minus the licence to act.
    expect(system).toContain('You are the project orchestrator');
    expect(system).toContain('do not spawn subagents');
  });

  it("builds an employee's prompt from their role and standing instructions", async () => {
    await bundle.writeTeam([
      { id: 'coder-1', name: 'Ada', role: 'coder', avatar: 'robot-cyan', instructions: 'prefers small diffs', createdAt: 1 },
    ]);
    const { chat, mock } = await setup([{ content: 'Small diffs only.' }]);

    const reply = await chat.reply('demo', 'coder-1', 'How do you work?');

    expect(reply.text).toBe('Small diffs only.');
    const system = lastSystem(mock);
    expect(system).toContain('You are a coder subagent');
    expect(system).toContain('prefers small diffs');
    expect(system).toContain('The frobnicator ships on Friday.');
    expect(system).toContain('chatting with the owner');
  });

  it('replays the conversation so far on the next message', async () => {
    const { chat, mock } = await setup([{ content: 'Friday.' }, { content: 'Still Friday.' }]);

    await chat.reply('demo', 'manager', 'When does it ship?');
    await chat.reply('demo', 'manager', 'And now?');

    const messages = lastMessages(mock);
    expect(messages.map((m) => m.content)).toEqual([
      expect.stringContaining('chatting with the owner'),
      'When does it ship?',
      'Friday.',
      'And now?',
    ]);
    expect(messages.filter((m) => m.content === 'Friday.')).toHaveLength(1);
  });

  it('keeps each agent on its own conversation', async () => {
    const { chat, mock } = await setup([{ content: 'manager says hi' }, { content: 'coder says hi' }]);

    await chat.reply('demo', 'manager', 'hello manager');
    await chat.reply('demo', 'coder-1', 'hello coder');

    expect(lastMessages(mock).map((m) => m.content).slice(1)).toEqual(['hello coder']);
    expect(chat.messages('demo', 'manager')).toEqual([
      { role: 'user', content: 'hello manager' },
      { role: 'assistant', content: 'manager says hi' },
    ]);
  });

  it('rejects a member who is not on the roster', async () => {
    const { chat } = await setup();
    await expect(chat.reply('demo', 'ghost-9', 'hello?')).rejects.toThrow(/unknown team member/);
  });
});

/** Boots a hub whose projects root already holds the demo bundle, with the mock as its only node. */
async function hubHarness(script: ScriptStep[] = []): Promise<{ hub: Hub; port: number }> {
  const { url } = await serve(script);
  hub = createHub({ projectsRoot: root });
  await hub.projects.stop();
  await hub.app.inject({
    method: 'POST', url: '/api/nodes/register',
    payload: { name: 'spark', arch: 'arm64', endpoints: [{ tier: 'orchestrator', url, model: 'mock-model', maxStreams: 2 }] },
  });
  await hub.app.listen({ port: 0, host: '127.0.0.1' });
  return { hub, port: (hub.app.server.address() as { port: number }).port };
}

/** Posts to a chat's SSE route over a real socket and decodes every frame. */
async function stream(port: number, who: string, text: string): Promise<{ token?: string; done?: boolean; full?: string }[]> {
  const res = await fetch(`http://127.0.0.1:${port}/api/projects/demo/chat/${who}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
  });
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const body = await res.text();
  return [...body.matchAll(/data: (\{.*\})/g)].map((m) => JSON.parse(m[1]) as { token?: string; done?: boolean; full?: string });
}

describe('project chat routes', () => {
  it('streams tokens and a done frame, then serves the history back', async () => {
    const { hub: target, port } = await hubHarness([{ content: 'We are on track.' }, { content: 'Still on track.' }]);

    const frames = await stream(port, 'manager', 'Where are we?');
    expect(frames.filter((f) => f.token).map((f) => f.token).join('')).toBe('We are on track.');
    expect(frames[frames.length - 1]).toEqual({ done: true, full: 'We are on track.' });

    await stream(port, 'manager', 'And now?');
    const res = await target.app.inject({ method: 'GET', url: '/api/projects/demo/chat/manager' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      messages: [
        { role: 'user', content: 'Where are we?' },
        { role: 'assistant', content: 'We are on track.' },
        { role: 'user', content: 'And now?' },
        { role: 'assistant', content: 'Still on track.' },
      ],
    });
  });

  it('404s an unknown member and an unknown project', async () => {
    const { hub: target } = await hubHarness();

    expect((await target.app.inject({ method: 'GET', url: '/api/projects/demo/chat/ghost-9' })).statusCode).toBe(404);
    expect((await target.app.inject({
      method: 'POST', url: '/api/projects/demo/chat/ghost-9/messages', payload: { text: 'hi' },
    })).statusCode).toBe(404);
    expect((await target.app.inject({ method: 'GET', url: '/api/projects/nope/chat/manager' })).statusCode).toBe(404);
    // An employee on the roster is a chat; the default bundle ships with one.
    expect((await target.app.inject({ method: 'GET', url: '/api/projects/demo/chat/coder-1' })).statusCode).toBe(200);
  });
});
