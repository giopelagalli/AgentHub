import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { createMockOpenAI, type MockOpenAI, type ScriptStep } from '@agenthub/mocks';
import { openDb } from '../src/db.js';
import { JobQueue } from '../src/queue.js';
import { NodeRegistry } from '../src/node-registry.js';
import { ModelGateway } from '../src/gateway.js';
import { ProjectBundle } from '../src/projects/bundle.js';
import { ProjectOrchestrator } from '../src/projects/orchestrator.js';
import { AgentLoop } from '../src/agents/loop.js';
import { Transcript } from '../src/agents/transcript.js';

let root: string;
let bundle: ProjectBundle;
let mocks: MockOpenAI[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agenthub-orch-'));
  bundle = await ProjectBundle.create(root, { slug: 'demo', title: 'Demo', intent: 'ship the demo' });
  mocks = [];
});

afterEach(async () => {
  for (const m of mocks) await m.close();
  await rm(root, { recursive: true, force: true });
});

async function serve(script: ScriptStep[]): Promise<{ mock: MockOpenAI; url: string }> {
  const mock = createMockOpenAI({ script });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  mocks.push(mock);
  return { mock, url: `http://127.0.0.1:${(mock.server.address() as { port: number }).port}` };
}

interface Harness {
  orchestrator: ProjectOrchestrator;
  transcript: Transcript;
  brain: MockOpenAI;
  worker: MockOpenAI;
  registry: NodeRegistry;
  loop: AgentLoop;
  queue: JobQueue;
}

/** Two mocks — one per tier — so orchestrator and subagent scripts stay independent. */
async function setup(brainScript: ScriptStep[], workerScript: ScriptStep[] = [], target = bundle): Promise<Harness> {
  const { mock: brain, url: brainUrl } = await serve(brainScript);
  const { mock: worker, url: workerUrl } = await serve(workerScript);

  const db = openDb(':memory:');
  const registry = new NodeRegistry(db);
  registry.register({
    name: 'spark', arch: 'arm64',
    endpoints: [
      { tier: 'orchestrator', url: brainUrl, model: 'mock-model', maxStreams: 2 },
      { tier: 'worker', url: workerUrl, model: 'mock-model', maxStreams: 2 },
    ],
  });
  const transcript = new Transcript(db);
  const gateway = new ModelGateway(registry);
  const loop = new AgentLoop({ gateway, transcript });
  const queue = new JobQueue(db);
  const orchestrator = new ProjectOrchestrator({ bundle: target, loop, gateway, queue, registry, transcript });
  return { orchestrator, transcript, brain, worker, registry, loop, queue };
}

const publishStep = (over: Record<string, unknown> = {}): ScriptStep => ({
  toolCalls: [{
    name: 'publish_briefing',
    arguments: {
      title: 'Demo', status: 'active', priority: 'project',
      summary: 'model-written summary', progress: { done: 2, total: 4 },
      blockers: ['waiting on the API key'], nextSteps: ['wire the frobnicator'],
      ...over,
    },
  }],
});

const subjects = async (dir: string): Promise<string[]> =>
  (await simpleGit(dir).log()).all.map((c) => c.message);

describe('ProjectOrchestrator', () => {
  it('returns the briefing the model published and commits the turn', async () => {
    const { orchestrator } = await setup([publishStep(), { content: 'published' }]);

    const briefing = await orchestrator.turn();

    expect(briefing).toMatchObject({
      slug: 'demo', title: 'Demo', status: 'active', priority: 'project',
      summary: 'model-written summary', progress: { done: 2, total: 4 },
      blockers: ['waiting on the API key'], nextSteps: ['wire the frobnicator'],
    });
    expect(existsSync(join(bundle.dir, 'briefings', 'latest.json'))).toBe(true);
    expect(await bundle.latestBriefing()).toMatchObject({ summary: 'model-written summary' });
    expect(await subjects(bundle.dir)).toContain('agent: turn 1');
  });

  it('synthesizes a briefing from tasks.yaml when the model never publishes one', async () => {
    await bundle.writeTasks({
      tasks: [
        { id: 't1', title: 'scaffold the bundle', status: 'done' },
        { id: 't2', title: 'wire the loop', status: 'in-progress' },
        { id: 't3', title: 'write the docs', status: 'backlog' },
      ],
    });
    const { orchestrator } = await setup([{ content: 'I reviewed the board and did nothing else.' }]);

    const briefing = await orchestrator.turn();

    expect(briefing).toMatchObject({
      slug: 'demo', title: 'Demo', status: 'active',
      progress: { done: 1, total: 3 },
    });
    expect(briefing.summary).toContain('I reviewed the board');
    expect(briefing.summary.length).toBeLessThanOrEqual(600);
    expect(briefing.nextSteps).toEqual(['wire the loop', 'write the docs']);
    expect(await bundle.latestBriefing()).toMatchObject({ progress: { done: 1, total: 3 } });
  });

  it('runs spawn_subagent inline on the worker tier and feeds its text back as the tool result', async () => {
    const { orchestrator, transcript } = await setup(
      [
        { toolCalls: [{ name: 'spawn_subagent', arguments: { task: 'summarize the repo', role: 'researcher' } }] },
        publishStep(),
        { content: 'delegated' },
      ],
      [{ content: 'the repo holds one package' }],
    );

    await orchestrator.turn();

    const subagentSessions = transcript.sessions({ kind: 'subagent' });
    expect(subagentSessions).toHaveLength(1);
    expect(subagentSessions[0]).toMatchObject({ subject: 'demo', tier: 'worker', outcome: 'stop' });

    const orchestratorSession = transcript.sessions({ kind: 'orchestrator' })[0];
    const results = transcript.messages(orchestratorSession.id).filter((m) => m.role === 'tool');
    expect(results[0].content).toBe('the repo holds one package');

    // The subagent got the task as its user message and only workspace tools.
    const workerMessages = transcript.messages(subagentSessions[0].id);
    expect(workerMessages[1]).toMatchObject({ role: 'user', content: 'summarize the repo' });
    expect(workerMessages[0].content).toContain('researcher');
  });

  it('rehydrates a restarted orchestrator from the bundle, not the transcript', async () => {
    const first = await setup([
      {
        toolCalls: [
          { name: 'update_tasks', arguments: { tasks: [{ id: 't1', title: 'wire the frobnicator', status: 'backlog' }] } },
          { name: 'add_decision', arguments: { title: 'use SQLite WAL', rationale: 'concurrent readers during turns' } },
        ],
      },
      publishStep(),
      { content: 'turn one done' },
    ]);
    await first.orchestrator.turn();
    for (const m of mocks) await m.close();
    mocks = [];

    // Simulated restart: fresh bundle handle, fresh orchestrator, fresh transcript.
    const reopened = await ProjectBundle.open(root, 'demo');
    const second = await setup([{ content: 'turn two done' }], [], reopened);

    await second.orchestrator.turn();

    const system = (second.brain.lastRequest().messages as { role: string; content: string }[])[0];
    expect(system.role).toBe('system');
    expect(system.content).toContain('wire the frobnicator');
    expect(system.content).toContain('use SQLite WAL');
    expect(system.content).toContain('concurrent readers during turns');
  });
});
