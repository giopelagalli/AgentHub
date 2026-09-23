import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump, load } from 'js-yaml';
import type { Milestone, TurnEvent } from '@agenthub/shared';
import { createMockOpenAI, type MockOpenAI, type ScriptStep } from '@agenthub/mocks';
import { openDb } from '../src/db.js';
import { NodeRegistry } from '../src/node-registry.js';
import { ModelGateway } from '../src/gateway.js';
import { ProjectBundle } from '../src/projects/bundle.js';
import { AgentLoop } from '../src/agents/loop.js';
import { Transcript } from '../src/agents/transcript.js';
import { SUBAGENT_TOOL_CALLS } from '../src/agents/budgets.js';
import { docTools, type ToolContext } from '../src/agents/tools.js';
import { completeMilestoneTool } from '../src/agents/verify.js';

let root: string;
let bundle: ProjectBundle;
let mocks: MockOpenAI[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agenthub-verify-'));
  bundle = await ProjectBundle.create(root, { slug: 'demo', title: 'Demo', intent: 'ship the demo' });
  await bundle.writeRoadmap([
    { id: 'm1', title: 'Skeleton', summary: 'It boots.', status: 'planned' },
    { id: 'm2', title: 'Auth', summary: 'Owners can log in.', status: 'planned' },
  ]);
  await bundle.commit('test: roadmap');
  mocks = [];
});

afterEach(async () => {
  for (const m of mocks) await m.close();
  await rm(root, { recursive: true, force: true });
});

interface Harness {
  transcript: Transcript;
  worker: MockOpenAI;
  ctx: ToolContext;
  events: TurnEvent[];
  complete: (id: string) => Promise<string>;
  setStatus: (id: string, status: string) => Promise<string>;
}

/** The tool under test with a scripted worker mock standing in for the reviewer. */
async function setup(reviewerScript: ScriptStep[] = []): Promise<Harness> {
  const worker = createMockOpenAI({ script: reviewerScript });
  await worker.listen({ port: 0, host: '127.0.0.1' });
  mocks.push(worker);
  const url = `http://127.0.0.1:${(worker.server.address() as { port: number }).port}`;
  const db = openDb(':memory:');
  const registry = new NodeRegistry(db);
  registry.register({ name: 'spark', arch: 'arm64', endpoints: [{ tier: 'worker', url, model: 'mock-model', maxStreams: 2 }] });
  const transcript = new Transcript(db);
  const loop = new AgentLoop({ gateway: new ModelGateway(registry), transcript });
  const events: TurnEvent[] = [];
  const ctx: ToolContext = { bundle, sessionId: 0, log: () => {}, onEvent: (e) => events.push(e) };
  const tool = completeMilestoneTool({ loop, subject: 'demo' });
  const setMilestoneStatus = docTools().find((t) => t.def.name === 'set_milestone_status')!;
  return {
    transcript, worker, ctx, events,
    complete: (id) => tool.run({ id }, ctx),
    setStatus: (id, status) => setMilestoneStatus.run({ id, status }, ctx),
  };
}

const setVerifyCmd = async (verifyCmd: string): Promise<void> => {
  const path = join(bundle.dir, 'manifest.yaml');
  const manifest = load(await readFile(path, 'utf8')) as Record<string, unknown>;
  await writeFile(path, dump({ ...manifest, verifyCmd }), 'utf8');
};

const milestone = async (id: string): Promise<Milestone> => (await bundle.roadmap()).find((m) => m.id === id)!;

const APPROVE: ScriptStep = { content: 'Read src/app.js and its test.\nVERDICT: APPROVE\n1. Nothing to change.' };
const REQUEST_CHANGES: ScriptStep = { content: 'VERDICT: REQUEST_CHANGES\n1. src/app.js: boot() swallows errors; rethrow them.' };
// One round with more tool calls than the subagent budget allows, and no content: the loop drops the
// overflow calls and ends 'budget-exhausted' before the reviewer ever produces a report.
const BUDGET_EXHAUSTED: ScriptStep = {
  toolCalls: Array.from({ length: SUBAGENT_TOOL_CALLS + 1 }, () => ({ name: 'read_file', arguments: { path: 'src/app.js' } })),
};

describe('complete_milestone', () => {
  it('marks the milestone done when the tests pass and the reviewer approves, and records both', async () => {
    await mkdir(join(bundle.workspace, 'test'), { recursive: true });
    await writeFile(join(bundle.workspace, 'test', 'app.test.js'), `import { test } from 'node:test'; test('boots', () => {});\n`, 'utf8');
    const { complete, events, transcript, worker } = await setup([APPROVE]);

    const result = await complete('m1');

    expect(result).toBe('milestone m1 is now done — tests: pass (node --test, exit 0); review: approved (Vex)');
    const m1 = await milestone('m1');
    expect(m1.status).toBe('done');
    expect(m1.verification).toMatchObject({ tests: 'pass', review: 'approved', at: expect.any(Number) });
    expect(await bundle.decisions()).toContain('Milestone m1 verified and done');
    expect(events).toEqual([
      expect.objectContaining({ kind: 'subagent-start', who: 'reviewer-1', name: 'Vex', role: 'reviewer' }),
      { kind: 'text', who: 'reviewer-1', text: expect.stringContaining('VERDICT: APPROVE') },
      { kind: 'usage', who: 'reviewer-1', usd: 0, tokens: expect.any(Number) },
      expect.objectContaining({ kind: 'subagent-end', who: 'reviewer-1', outcome: 'stop' }),
      { kind: 'verify', milestoneId: 'm1', tests: 'pass', review: 'approved', summary: expect.stringContaining('tests: pass') },
    ]);
    expect(transcript.sessions({ kind: 'subagent' })[0].memberId).toBe('reviewer-1');
    const messages = worker.lastRequest().messages as { role: string; content: string }[];
    expect(messages[0].content).toContain('reviewer');
    expect(messages[1].content).toContain('Skeleton');
    expect(messages[1].content).toContain('VERDICT: APPROVE');
  });

  it('gives the reviewer read-only tools — no write_file, no run_shell', async () => {
    await mkdir(join(bundle.workspace, 'test'), { recursive: true });
    await writeFile(join(bundle.workspace, 'test', 'app.test.js'), `import { test } from 'node:test'; test('boots', () => {});\n`, 'utf8');
    const { complete, worker } = await setup([APPROVE]);

    await complete('m1');

    const tools = (worker.lastRequest().tools ?? []) as { function: { name: string } }[];
    const names = tools.map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(['read_file', 'list_dir']));
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('run_shell');
  });

  it('runs npm test when package.json declares a test script', async () => {
    await writeFile(join(bundle.workspace, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'exit 0' } }), 'utf8');
    const { complete } = await setup([APPROVE]);

    expect(await complete('m1')).toContain('tests: pass (npm test, exit 0)');
  });

  it('leaves a milestone in progress on failing tests, returns the tail, and spawns no reviewer', async () => {
    await setVerifyCmd('echo "1 passing"; echo "Error: boot() threw" >&2; exit 1');
    const { complete, events, transcript } = await setup([APPROVE]);

    const result = await complete('m1');

    expect(result).toContain('milestone m1 stays in-progress');
    expect(result).toContain('tests: fail');
    expect(result).toContain('Error: boot() threw');
    expect(result).toContain('call complete_milestone("m1") again');
    expect(transcript.sessions({ kind: 'subagent' })).toHaveLength(0);
    const m1 = await milestone('m1');
    expect(m1.status).toBe('in-progress');
    expect(m1.verification).toMatchObject({ tests: 'fail', review: 'skipped' });
    expect(events).toEqual([expect.objectContaining({ kind: 'verify', tests: 'fail', review: 'skipped' })]);
    expect(await bundle.decisions()).toContain('Milestone m1 not done: verification failed');
  });

  it('leaves a milestone in progress when the reviewer requests changes, returning the findings', async () => {
    await setVerifyCmd('exit 0');
    const { complete } = await setup([REQUEST_CHANGES]);

    const result = await complete('m1');

    expect(result).toContain('review: changes (Vex)');
    expect(result).toContain('boot() swallows errors');
    expect((await milestone('m1')).status).toBe('in-progress');
    expect((await milestone('m1')).verification).toMatchObject({ tests: 'pass', review: 'changes' });
  });

  it('treats a report without a verdict as a request for changes', async () => {
    await setVerifyCmd('exit 0');
    const { complete } = await setup([{ content: 'Looks fine to me.' }]);

    expect(await complete('m1')).toContain('review: changes');
  });

  it('tells the manager the reviewer was cut short, not that it failed, when its run is aborted', async () => {
    const { complete, ctx } = await setup();
    const controller = new AbortController();
    controller.abort();
    ctx.signal = controller.signal;

    const result = await complete('m1');

    expect(result).toContain('reviewer was cut short (the hub stopped, or the turn hit its time limit) without a report');
  });

  it('tells the manager there are no findings to act on, not to delegate fixes, when the reviewer exhausts its budget', async () => {
    const { complete } = await setup([BUDGET_EXHAUSTED]);

    const result = await complete('m1');

    expect(result).toMatch(/NO findings to act on/);
    expect(result).not.toContain('Fix what is listed');
  });

  it('leaves a milestone in progress with no verification available when both checks are skipped', async () => {
    await bundle.writeTeam((await bundle.team()).filter((m) => m.role !== 'reviewer'));
    const { complete, transcript } = await setup();

    const result = await complete('m1');

    expect(result).toContain('milestone m1 stays in-progress');
    expect(result).toContain('no verification available: no test command and no reviewer on the roster — add one or set manifest.verifyCmd');
    const m1 = await milestone('m1');
    expect(m1.status).toBe('in-progress');
    expect(m1.verification).toMatchObject({ tests: 'skipped', review: 'skipped' });
    expect(transcript.sessions({ kind: 'subagent' })).toHaveLength(0);
  });

  it('marks the milestone done on passing tests alone when nobody on the roster is a reviewer', async () => {
    await writeFile(join(bundle.workspace, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'exit 0' } }), 'utf8');
    await bundle.writeTeam((await bundle.team()).filter((m) => m.role !== 'reviewer'));
    const { complete } = await setup();

    const result = await complete('m1');

    expect(result).toBe('milestone m1 is now done — tests: pass (npm test, exit 0); review: skipped (no reviewer on the roster)');
    expect((await milestone('m1')).status).toBe('done');
  });

  it('marks the milestone done on reviewer approval alone when there is no test command', async () => {
    const { complete } = await setup([APPROVE]);

    const result = await complete('m1');

    expect(result).toBe('milestone m1 is now done — tests: skipped (no test command found); review: approved (Vex)');
    expect((await milestone('m1')).status).toBe('done');
  });

  it('stamps startedCommit when a milestone had none and is left in-progress', async () => {
    await setVerifyCmd('exit 1');
    const { complete } = await setup([APPROVE]);
    expect((await milestone('m1')).startedCommit).toBeUndefined();
    const before = await bundle.head();

    await complete('m1');

    expect((await milestone('m1')).startedCommit).toBe(before);
  });

  it('points the reviewer at the files changed since the milestone went in-progress', async () => {
    await writeFile(join(bundle.workspace, 'old.js'), '// before\n', 'utf8');
    await bundle.commit('test: old file');
    const { complete, setStatus, worker } = await setup([APPROVE]);

    const head = await bundle.head();
    expect(await setStatus('m1', 'in-progress')).toBe('milestone m1 is now in-progress');
    expect((await milestone('m1')).startedCommit).toBe(head);
    await mkdir(join(bundle.workspace, 'src'), { recursive: true });
    await writeFile(join(bundle.workspace, 'src', 'app.js'), '// after\n', 'utf8');
    await complete('m1');

    const task = (worker.lastRequest().messages as { role: string; content: string }[])[1].content;
    expect(task).toContain('- src/app.js');
    expect(task).not.toContain('old.js');
  });

  it('refuses to mark a milestone done through set_milestone_status', async () => {
    const { setStatus } = await setup();

    expect(await setStatus('m1', 'done')).toBe('error: use complete_milestone');
    expect((await milestone('m1')).status).toBe('planned');
  });

  it('rejects an unknown milestone', async () => {
    const { complete } = await setup();
    await expect(complete('m9')).rejects.toThrow('unknown milestone: m9');
  });
});
