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
import { workspaceTools } from '../src/agents/tools.js';

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

/** Commit subjects, newest first. */
const commits = async (dir: string): Promise<string[]> =>
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
    // The publish tool commits its own write; the turn adds nothing on top of it.
    expect((await commits(bundle.dir))[0]).toMatch(/^agent:/);
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
    // The synthesized publish is what the turn commits, labelled with the turn and its summary.
    expect((await commits(bundle.dir))[0]).toBe('agent: turn 1 — I reviewed the board and did nothing else.');
  });

  it('keeps the last good briefing when a turn is aborted', async () => {
    const { orchestrator, transcript } = await setup([
      publishStep(),
      { content: 'published' },
      { toolCalls: [{ name: 'run_shell', arguments: { cmd: ['sh', '-c', 'sleep 30'] } }] },
    ]);
    const first = await orchestrator.turn();
    const commitsBefore = await commits(bundle.dir);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);

    const second = await orchestrator.turn({ signal: controller.signal });

    expect(second).toEqual(first);
    expect(await bundle.latestBriefing()).toEqual(first);
    expect(await commits(bundle.dir)).toEqual(commitsBefore);

    const aborted = transcript.sessions({ kind: 'orchestrator' })[1];
    expect(aborted.outcome).toBe('aborted');
    expect(transcript.events(aborted.id).map((e) => e.content).join('\n')).toContain('turn 2 ended aborted');
  });

  it('runs spawn_subagent inline on the worker tier and feeds its text back as the tool result', async () => {
    const { orchestrator, transcript, worker } = await setup(
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
    const offered = (worker.lastRequest().tools as { name: string }[]).map((t) => t.name);
    expect(offered).toEqual(workspaceTools().map((t) => t.def.name));
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
