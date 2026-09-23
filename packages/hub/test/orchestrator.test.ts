import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { PRD_SECTIONS, type TurnEvent } from '@agenthub/shared';
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
import { ORCHESTRATOR_TOOL_CALLS, SUBAGENT_TOOL_CALLS } from '../src/agents/budgets.js';

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
  /** Every live event the orchestrator reported, stamped with the turn's session. */
  events: (TurnEvent & { sessionId: number })[];
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
  const events: (TurnEvent & { sessionId: number })[] = [];
  const orchestrator = new ProjectOrchestrator({
    bundle: target, loop, gateway, queue, registry, transcript,
    onEvent: (sessionId, e) => events.push({ ...e, sessionId }),
  });
  return { orchestrator, transcript, brain, worker, registry, loop, queue, events };
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
    const { orchestrator, transcript, events } = await setup([
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
    // The hub stopped the turn — the model never failed to report, so the note says so.
    expect(events.filter((e) => e.kind === 'turn-end').at(-1)).toMatchObject({ summary: expect.stringMatching(/cut short/) });
  });

  it('synthesizes a "cut short" briefing when the first turn ever is aborted', async () => {
    const { orchestrator } = await setup([
      { toolCalls: [{ name: 'run_shell', arguments: { cmd: ['sh', '-c', 'sleep 30'] } }] },
    ]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);

    const briefing = await orchestrator.turn({ signal: controller.signal });

    // No prior briefing to fall back to, so this is the model's report — and it must not read as
    // the model's own failure to report.
    expect(briefing.summary).toMatch(/cut short/);
    expect(briefing.summary).toContain('1 tool calls were made, last action: run_shell');
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
    expect(results[0].content).toBe('the repo holds one package\n\nFiles written: (none)');

    // The subagent got the task as its user message and only workspace tools.
    const workerMessages = transcript.messages(subagentSessions[0].id);
    expect(workerMessages[1]).toMatchObject({ role: 'user', content: 'summarize the repo' });
    expect(workerMessages[0].content).toContain('researcher');
    const offered = (worker.lastRequest().tools as { function: { name: string } }[]).map((t) => t.function.name);
    expect(offered).toEqual(workspaceTools().map((t) => t.def.name));
  });

  it('tells the manager a subagent\'s report was cut short when its own run is aborted', async () => {
    const { orchestrator, transcript } = await setup(
      [{ toolCalls: [{ name: 'spawn_subagent', arguments: { task: 'summarize the repo', role: 'researcher' } }] }],
      [{ toolCalls: [{ name: 'run_shell', arguments: { cmd: ['sh', '-c', 'sleep 30'] } }] }],
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);

    await orchestrator.turn({ signal: controller.signal });

    const subagentSessions = transcript.sessions({ kind: 'subagent' });
    expect(subagentSessions[0].outcome).toBe('aborted');

    // The hub stopped the subagent's run — the manager must not read this as the subagent failing
    // to report.
    const orchestratorSession = transcript.sessions({ kind: 'orchestrator' })[0];
    const results = transcript.messages(orchestratorSession.id).filter((m) => m.role === 'tool');
    expect(results[0].content).toMatch(/cut short/);
  });

  it('gives a roster-less subagent\'s own events the same who as its start/end bracket', async () => {
    // Nobody on the roster has the researcher role, so the subagent runs with no memberId.
    await bundle.writeTeam((await bundle.team()).filter((m) => m.role !== 'researcher'));
    const { orchestrator, events } = await setup(
      [
        { toolCalls: [{ name: 'spawn_subagent', arguments: { task: 'summarize the repo', role: 'researcher' } }] },
        publishStep(),
        { content: 'delegated' },
      ],
      [{ content: 'the repo holds one package' }],
    );

    await orchestrator.turn();

    // Its text and tool events must still read 'researcher', matching subagent-start/-end — not
    // 'subagent', which is what the loop's own kind-based fallback would otherwise give them.
    const inner = events.filter((e) => e.kind === 'text' && 'who' in e && e.who !== 'manager');
    expect(inner).toEqual([expect.objectContaining({ kind: 'text', who: 'researcher' })]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'subagent-start', who: 'researcher' }),
      expect.objectContaining({ kind: 'subagent-end', who: 'researcher' }),
    ]));
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

describe('turn events', () => {
  it('brackets the turn, forwards a subagent\'s events with its id, and reports the files it wrote', async () => {
    const { orchestrator, transcript, events } = await setup(
      [
        { toolCalls: [{ name: 'spawn_subagent', arguments: { task: 'add the lexer', member: 'coder-1' } }], content: 'delegating' },
        publishStep(),
        { content: 'delegated' },
      ],
      [
        { toolCalls: [{ name: 'write_file', arguments: { path: 'src/lexer.js', content: 'export const lex = () => [];\n' } }] },
        { toolCalls: [{ name: 'run_shell', arguments: { cmd: ['cp', 'src/lexer.js', 'src/copy.js'] } }] },
        { toolCalls: [{ name: 'run_shell', arguments: { cmd: ['cat', 'src/lexer.js'] } }] },
        { content: 'lexer added' },
      ],
    );

    await orchestrator.turn();

    const session = transcript.sessions({ kind: 'orchestrator' })[0];
    expect(events.every((e) => e.sessionId === session.id)).toBe(true);
    expect(events.map((e) => `${e.kind}:${'who' in e ? e.who : '-'}`)).toEqual([
      'turn-start:manager',
      'text:manager',
      'tool-call:manager',
      'subagent-start:coder-1',
      'tool-call:coder-1', 'tool-result:coder-1',
      'tool-call:coder-1', 'tool-result:coder-1',
      'tool-call:coder-1', 'tool-result:coder-1',
      'text:coder-1',
      'subagent-end:coder-1',
      'tool-result:manager',
      'tool-call:manager', 'tool-result:manager',
      'text:manager',
      'turn-end:-',
    ]);
    expect(events[3]).toMatchObject({ kind: 'subagent-start', who: 'coder-1', name: 'Ada', role: 'coder', task: 'add the lexer' });
    expect(events[11]).toMatchObject({ kind: 'subagent-end', who: 'coder-1', outcome: 'stop', ms: expect.any(Number) });
    expect(events[events.length - 1]).toMatchObject({ kind: 'turn-end', outcome: 'stop', summary: 'model-written summary', ms: expect.any(Number) });

    // The manager learns what changed from the report, not by inspecting the workspace.
    const results = transcript.messages(session.id).filter((m) => m.role === 'tool');
    expect(results[0].content).toBe('lexer added\n\nFiles written: src/lexer.js, src/copy.js');

    // The whole turn replays from the orchestrator session; the member's session holds its own part.
    expect(transcript.turnEvents(session.id).map((e) => e.kind)).toEqual(events.map((e) => e.kind));
    const member = transcript.sessions({ kind: 'subagent' })[0];
    expect(transcript.turnEvents(member.id).map((e) => e.kind)).toEqual(['tool-call', 'tool-result', 'tool-call', 'tool-result', 'tool-call', 'tool-result', 'text']);
  });
});

describe('project team', () => {
  it('delegates to a named member, tags the session and appends their instructions', async () => {
    await bundle.writeTeam([
      { id: 'coder-1', name: 'Ada', role: 'coder', avatar: 'robot-cyan', instructions: 'Always run npm test before reporting.', createdAt: 1 },
    ]);
    const { orchestrator, transcript, brain, worker } = await setup(
      [
        { toolCalls: [{ name: 'spawn_subagent', arguments: { task: 'fix the parser', member: 'coder-1' } }] },
        publishStep(),
        { content: 'delegated' },
      ],
      [{ content: 'parser fixed' }],
    );

    await orchestrator.turn();

    const [session] = transcript.sessions({ kind: 'subagent' });
    expect(session.memberId).toBe('coder-1');

    const workerSystem = (worker.lastRequest().messages as { role: string; content: string }[])[0];
    expect(workerSystem.content).toContain('Always run npm test before reporting.');

    // The orchestrator is told who is on the roster, so it can delegate by name.
    const orchestratorSystem = (brain.requests[0].messages as { role: string; content: string }[])[0];
    expect(orchestratorSystem.content).toContain('# Your team');
    expect(orchestratorSystem.content).toContain('coder-1');
    expect(orchestratorSystem.content).toContain('Ada (coder)');
  });

  it('attributes a role-only delegation to the first roster member with that role', async () => {
    const { orchestrator, transcript } = await setup(
      [
        { toolCalls: [{ name: 'spawn_subagent', arguments: { task: 'read the docs', role: 'researcher' } }] },
        publishStep(),
        { content: 'delegated' },
      ],
      [{ content: 'docs read' }],
    );

    await orchestrator.turn();

    expect(transcript.sessions({ kind: 'subagent' })[0].memberId).toBe('researcher-1');
  });

  it('refuses an unknown member instead of guessing', async () => {
    const { orchestrator, transcript } = await setup(
      [
        { toolCalls: [{ name: 'spawn_subagent', arguments: { task: 'do a thing', member: 'ghost-9' } }] },
        publishStep(),
        { content: 'delegated' },
      ],
    );

    await orchestrator.turn();

    expect(transcript.sessions({ kind: 'subagent' })).toHaveLength(0);
    const orchestratorSession = transcript.sessions({ kind: 'orchestrator' })[0];
    const results = transcript.messages(orchestratorSession.id).filter((m) => m.role === 'tool');
    expect(results[0].content).toBe('error: unknown team member: ghost-9');
  });
});

describe('the product plan in a turn', () => {
  const PRD = [
    '# Demo — PRD',
    '',
    ...PRD_SECTIONS.flatMap((s) => [`## ${s.title}`, '', `${s.title}: `.padEnd(240, 'a real decision, a named technology, a limit. '), '']),
  ].join('\n');

  it('carries the PRD and marks the current milestone', async () => {
    await bundle.writePrd(PRD);
    await bundle.writeRoadmap([
      { id: 'm1', title: 'Skeleton', summary: 'It boots.', status: 'done' },
      { id: 'm2', title: 'Auth', summary: 'Owners can log in.', status: 'planned' },
      { id: 'm3', title: 'Board', summary: 'Cards move.', status: 'planned' },
    ]);
    const { orchestrator, brain } = await setup([publishStep(), { content: 'published' }]);

    await orchestrator.turn();

    const system = (brain.requests[0].messages as { role: string; content: string }[])[0].content;
    expect(system).toContain('# Product plan');
    expect(system).toContain('## Functional requirements');
    expect(system).toContain('m2 [planned] Auth **← current milestone**');
    expect(system).not.toContain('m3 [planned] Board **←');
    expect(system).toContain('Work the current milestone only.');
    expect(system).toContain('set_milestone_status');
  });

  it('reports an undrafted PRD and does no work at all', async () => {
    const { orchestrator, brain } = await setup([
      publishStep({ summary: 'prd.md is still the empty scaffold — the PRD needs drafting before work can start.' }),
      { content: 'reported' },
    ]);

    const briefing = await orchestrator.turn();

    const system = (brain.requests[0].messages as { role: string; content: string }[])[0].content;
    expect(system).toContain('prd.md is still the empty scaffold');
    expect(system).toContain('Do not invent requirements');
    // The plan section replaces the PRD and roadmap listings entirely: there is nothing to show.
    expect(system).not.toContain('## Roadmap');
    expect(briefing.summary).toContain('still the empty scaffold');
    expect((await bundle.tasks()).tasks).toEqual([]);
  });

  it('moves a milestone along and writes a docs page from a turn', async () => {
    await bundle.writePrd(PRD);
    await bundle.writeRoadmap([{ id: 'm1', title: 'Skeleton', summary: 'It boots.', status: 'planned' }]);
    const { orchestrator } = await setup([
      {
        toolCalls: [
          { name: 'set_milestone_status', arguments: { id: 'm1', status: 'in-progress' } },
          { name: 'write_doc', arguments: { page: 'skeleton', markdown: '# Skeleton\n\nWhy: a boot path first.\n' } },
        ],
      },
      publishStep(),
      { content: 'published' },
    ]);

    await orchestrator.turn();

    expect((await bundle.roadmap())[0].status).toBe('in-progress');
    expect(await bundle.doc('skeleton')).toContain('Why: a boot path first.');
    expect((await bundle.docs()).index).toContain('(skeleton.md)');
    expect(await commits(bundle.dir)).toContain('agent: write doc skeleton');
    expect(await commits(bundle.dir)).toContain('agent: milestone m1 in-progress');
  });
});

describe('tool-call budgets', () => {
  it('are one place, with the orchestrator wide enough to read its bundle and still delegate', () => {
    expect(ORCHESTRATOR_TOOL_CALLS).toBe(40);
    expect(SUBAGENT_TOOL_CALLS).toBe(25);
  });
});

describe('the whole PRD in the prompt', () => {
  const MARKER = 'MARKER_LAST_SECTION_9f3c1a';

  const bigPrd = PRD_SECTIONS.map((s, i) => {
    const body = i === PRD_SECTIONS.length - 1
      ? `${MARKER} `.padEnd(1300, 'a real decision, a named technology, a limit. ')
      : `${s.title}: `.padEnd(1300, 'a real decision, a named technology, a limit. ');
    return [`## ${s.title}`, '', body, ''].join('\n');
  });
  const PRD = ['# Demo — PRD', '', ...bigPrd].join('\n');

  it('carries a normal-sized PRD whole, not just its heading summary', async () => {
    expect(PRD.length).toBeGreaterThan(10000);
    await bundle.writePrd(PRD);
    const { orchestrator, brain } = await setup([publishStep(), { content: 'published' }]);

    await orchestrator.turn();

    const system = (brain.requests[0].messages as { role: string; content: string }[])[0].content;
    expect(system).toContain(MARKER);
    expect(system).toContain('(This is the complete PRD.)');
  });
});

describe('a turn that never reported', () => {
  it('publishes what the budget spent instead of the model\'s mid-thought text', async () => {
    const toolCalls = Array.from({ length: ORCHESTRATOR_TOOL_CALLS + 1 }, () => ({ name: 'list_dir', arguments: {} }));
    const { orchestrator } = await setup([
      { toolCalls, content: 'The output is tail-truncated. Let me request smaller ranges to capture FR 1-8 exactly.' },
    ]);

    const briefing = await orchestrator.turn();

    expect(briefing.summary).toContain(`tool-call budget (${ORCHESTRATOR_TOOL_CALLS})`);
    expect(briefing.summary).toContain('last action: list_dir');
    expect(briefing.summary).not.toContain('tail-truncated');
    expect(briefing.blockers.some((b) => b.includes('last action: list_dir'))).toBe(true);
  });
});
