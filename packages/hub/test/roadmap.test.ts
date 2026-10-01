import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { PRD_SECTIONS, type Milestone, type MilestoneVerification } from '@agenthub/shared';
import { createMockOpenAI, type MockOpenAI, type ScriptStep } from '@agenthub/mocks';
import { openDb } from '../src/db.js';
import { NodeRegistry } from '../src/node-registry.js';
import { ModelGateway } from '../src/gateway.js';
import { AgentLoop } from '../src/agents/loop.js';
import { Transcript } from '../src/agents/transcript.js';
import { ProjectBundle } from '../src/projects/bundle.js';
import { PrdDrafter } from '../src/projects/prd.js';
import { currentMilestoneId, moveMilestone, moveMilestoneTo, normalizeMilestones, patchMilestone } from '../src/projects/roadmap.js';
import { createHub, type Hub } from '../src/server.js';

let root: string;
let bundle: ProjectBundle;
let mocks: MockOpenAI[];
let hub: Hub | undefined;

const PRD = [
  `# Demo — PRD`,
  ``,
  ...PRD_SECTIONS.flatMap((s) => [`## ${s.title}`, ``, `${s.title}: `.padEnd(240, 'a real decision, a named technology, a limit. '), ``]),
].join('\n');

const MILESTONES: Milestone[] = [
  { id: 'm1', title: 'Skeleton', summary: 'It boots.', status: 'done' },
  { id: 'm2', title: 'Auth', summary: 'Owners can log in.', status: 'in-progress' },
  { id: 'm3', title: 'Board', summary: 'Cards move.', status: 'planned' },
];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agenthub-roadmap-'));
  bundle = await ProjectBundle.create(root, { slug: 'demo', title: 'Demo', intent: 'ship the demo' });
  mocks = [];
});

afterEach(async () => {
  await hub?.stop();
  for (const m of mocks) await m.close();
  await rm(root, { recursive: true, force: true });
  hub = undefined;
});

async function serve(script: ScriptStep[]): Promise<{ mock: MockOpenAI; url: string }> {
  const mock = createMockOpenAI({ script });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  mocks.push(mock);
  return { mock, url: `http://127.0.0.1:${(mock.server.address() as { port: number }).port}` };
}

async function setup(script: ScriptStep[]): Promise<{ drafter: PrdDrafter; mock: MockOpenAI; transcript: Transcript }> {
  const { mock, url } = await serve(script);
  const db = openDb(':memory:');
  const registry = new NodeRegistry(db);
  registry.register({ name: 'spark', arch: 'arm64', endpoints: [{ tier: 'orchestrator', url, model: 'mock-model', maxStreams: 2 }] });
  const transcript = new Transcript(db);
  const gateway = new ModelGateway(registry);
  const loop = new AgentLoop({ gateway, transcript });
  return { drafter: new PrdDrafter({ loop, gateway, transcript, bundleFor: async () => bundle }), mock, transcript };
}

async function hubHarness(script: ScriptStep[] = []): Promise<{ hub: Hub; port: number }> {
  const { url } = await serve(script);
  hub = createHub({ projectsRoot: root });
  await hub.app.inject({
    method: 'POST', url: '/api/nodes/register',
    payload: { name: 'spark', arch: 'arm64', endpoints: [{ tier: 'orchestrator', url, model: 'mock-model', maxStreams: 2 }] },
  });
  await hub.app.listen({ port: 0, host: '127.0.0.1' });
  return { hub, port: (hub.app.server.address() as { port: number }).port };
}

describe('roadmap ordering', () => {
  it('calls the first not-done milestone the current one', () => {
    expect(currentMilestoneId(MILESTONES)).toBe('m2');
    expect(currentMilestoneId(MILESTONES.map((m) => ({ ...m, status: 'done' as const })))).toBeNull();
    expect(currentMilestoneId([])).toBeNull();
  });

  it('moves a milestone one place, and leaves the order alone at the edges', () => {
    expect(moveMilestone(MILESTONES, 'm3', 'up').map((m) => m.id)).toEqual(['m1', 'm3', 'm2']);
    expect(moveMilestone(MILESTONES, 'm1', 'down').map((m) => m.id)).toEqual(['m2', 'm1', 'm3']);
    expect(moveMilestone(MILESTONES, 'm1', 'up')).toBe(MILESTONES);
    expect(moveMilestone(MILESTONES, 'm3', 'down')).toBe(MILESTONES);
    expect(moveMilestone(MILESTONES, 'nope', 'up')).toBe(MILESTONES);
  });

  it('moves a milestone to an index, clamping it, keeping every field, and no-opping when already there', () => {
    const ids = (ms: Milestone[]) => ms.map((m) => m.id);
    expect(ids(moveMilestoneTo(MILESTONES, 'm3', 0))).toEqual(['m3', 'm1', 'm2']);
    expect(ids(moveMilestoneTo(MILESTONES, 'm1', 2))).toEqual(['m2', 'm3', 'm1']);
    expect(ids(moveMilestoneTo(MILESTONES, 'm1', 99))).toEqual(['m2', 'm3', 'm1']);
    expect(ids(moveMilestoneTo(MILESTONES, 'm3', -5))).toEqual(['m3', 'm1', 'm2']);
    expect(moveMilestoneTo(MILESTONES, 'm2', 1)).toBe(MILESTONES);
    expect(moveMilestoneTo(MILESTONES, 'nope', 0)).toBe(MILESTONES);
    expect(moveMilestoneTo(MILESTONES, 'm3', 0)[0]).toEqual(MILESTONES[2]);
  });

  it('patches one milestone and clears an estimate with an empty string', () => {
    const withEstimate = patchMilestone(MILESTONES, 'm3', { status: 'blocked', estimate: '2 days' });
    expect(withEstimate[2]).toEqual({ id: 'm3', title: 'Board', summary: 'Cards move.', status: 'blocked', estimate: '2 days' });
    expect(withEstimate[0]).toEqual(MILESTONES[0]);
    expect(patchMilestone(withEstimate, 'm3', { estimate: '' })[2]).not.toHaveProperty('estimate');
  });

  it('write_roadmap round-trips startedCommit and verification instead of dropping them', () => {
    // What a model gets back from read_roadmap and could hand straight back to write_roadmap —
    // the evidence complete_milestone already recorded must survive that round trip.
    const verification: MilestoneVerification = { tests: 'pass', review: 'approved', at: 100, notes: 'looks good' };
    const withEvidence: Milestone[] = [
      { id: 'm1', title: 'Skeleton', summary: 'It boots.', status: 'in-progress', startedCommit: 'abc123', verification },
      { id: 'm2', title: 'Auth', summary: 'Owners can log in.', status: 'planned' },
    ];
    expect(normalizeMilestones(withEvidence)).toEqual(withEvidence);
  });
});

describe('PrdDrafter.generateRoadmap', () => {
  it('sequences the PRD into numbered milestones and writes roadmap.yaml', async () => {
    const { drafter, mock, transcript } = await setup([{
      content: '```json\n[{"title":"Skeleton","summary":"It boots.","estimate":"half a day"},'
        + '{"title":"Auth","summary":"Owners can log in.","dependsOn":["m1"]}]\n```',
    }]);
    await bundle.writePrd(PRD);

    const milestones = await drafter.generateRoadmap('demo');

    expect(milestones).toEqual([
      { id: 'm1', title: 'Skeleton', summary: 'It boots.', status: 'planned', estimate: 'half a day' },
      { id: 'm2', title: 'Auth', summary: 'Owners can log in.', status: 'planned', dependsOn: ['m1'] },
    ]);
    expect(await bundle.roadmap()).toEqual(milestones);
    // The PRD is what it sequences, and the work is visible as its own session.
    expect(mock.lastRequest().messages.at(-1).content).toContain('## Functional requirements');
    expect(transcript.sessions({ kind: 'chat', subject: 'demo:roadmap' })).toHaveLength(1);
    expect((await simpleGit(bundle.dir).log()).latest?.message).toBe('agent: generate roadmap');
  });
});

describe('roadmap routes', () => {
  it('serves the milestones with the current one marked', async () => {
    const { hub: target } = await hubHarness();
    await bundle.writeRoadmap(MILESTONES);

    const res = await target.app.inject({ method: 'GET', url: '/api/projects/demo/roadmap' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ milestones: MILESTONES, currentId: 'm2' });
  });

  it('moves a milestone, no-ops at the edge and 400s an unknown id', async () => {
    const { hub: target } = await hubHarness();
    await bundle.writeRoadmap(MILESTONES);

    const up = await target.app.inject({ method: 'POST', url: '/api/projects/demo/roadmap/move', payload: { id: 'm3', direction: 'up' } });
    expect(up.statusCode).toBe(200);
    expect(up.json().milestones.map((m: Milestone) => m.id)).toEqual(['m1', 'm3', 'm2']);
    expect((await bundle.roadmap()).map((m) => m.id)).toEqual(['m1', 'm3', 'm2']);
    expect((await simpleGit(bundle.dir).log()).latest?.message).toBe('owner: move milestone m3 up');

    const edge = await target.app.inject({ method: 'POST', url: '/api/projects/demo/roadmap/move', payload: { id: 'm1', direction: 'up' } });
    expect(edge.statusCode).toBe(200);
    expect(edge.json().milestones.map((m: Milestone) => m.id)).toEqual(['m1', 'm3', 'm2']);

    const unknown = await target.app.inject({ method: 'POST', url: '/api/projects/demo/roadmap/move', payload: { id: 'm9', direction: 'up' } });
    expect(unknown.statusCode).toBe(400);
    const malformed = await target.app.inject({ method: 'POST', url: '/api/projects/demo/roadmap/move', payload: { id: 'm1', direction: 'sideways' } });
    expect(malformed.statusCode).toBe(400);
  });

  it('moves a milestone to an index in one commit, and 400s a non-integer index', async () => {
    const { hub: target } = await hubHarness();
    await bundle.writeRoadmap(MILESTONES);

    const res = await target.app.inject({ method: 'POST', url: '/api/projects/demo/roadmap/move', payload: { id: 'm3', to: 0 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().milestones.map((m: Milestone) => m.id)).toEqual(['m3', 'm1', 'm2']);
    expect((await bundle.roadmap()).map((m) => m.id)).toEqual(['m3', 'm1', 'm2']);
    expect((await simpleGit(bundle.dir).log()).latest?.message).toBe('owner: move milestone m3 to 0');

    for (const to of [1.5, '1', null]) {
      const bad = await target.app.inject({ method: 'POST', url: '/api/projects/demo/roadmap/move', payload: { id: 'm1', to } });
      expect(bad.statusCode).toBe(400);
    }
  });

  it('patches a milestone\'s status and estimate', async () => {
    const { hub: target } = await hubHarness();
    await bundle.writeRoadmap(MILESTONES);

    const res = await target.app.inject({
      method: 'PATCH', url: '/api/projects/demo/roadmap/m3', payload: { status: 'in-progress', estimate: '2 days' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().milestones[2]).toMatchObject({ id: 'm3', status: 'in-progress', estimate: '2 days' });
    expect((await bundle.roadmap())[2]).toMatchObject({ status: 'in-progress', estimate: '2 days' });

    expect((await target.app.inject({ method: 'PATCH', url: '/api/projects/demo/roadmap/m9', payload: { status: 'done' } })).statusCode).toBe(404);
    expect((await target.app.inject({ method: 'PATCH', url: '/api/projects/demo/roadmap/m1', payload: { status: 'nope' } })).statusCode).toBe(400);
  });

  it('ignores fields outside title/summary/estimate/status, so a stray verification cannot ride along', async () => {
    const { hub: target } = await hubHarness();
    await bundle.writeRoadmap(MILESTONES);

    const res = await target.app.inject({
      method: 'PATCH', url: '/api/projects/demo/roadmap/m3',
      payload: { estimate: '2 days', verification: 'x', startedCommit: 'deadbeef' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().milestones[2]).toMatchObject({ id: 'm3', estimate: '2 days' });
    expect(res.json().milestones[2]).not.toHaveProperty('verification');
    expect(res.json().milestones[2]).not.toHaveProperty('startedCommit');
    const m3 = (await bundle.roadmap())[2];
    expect(m3).not.toHaveProperty('verification');
    expect(m3).not.toHaveProperty('startedCommit');
  });

  it('streams a generated roadmap, and 400s while the PRD is still the scaffold', async () => {
    const { hub: target, port } = await hubHarness([{ content: '[{"title":"Skeleton","summary":"It boots."}]' }]);

    const tooEarly = await target.app.inject({ method: 'POST', url: '/api/projects/demo/roadmap/generate' });
    expect(tooEarly.statusCode).toBe(400);

    await target.app.inject({ method: 'PUT', url: '/api/projects/demo/prd', payload: { markdown: PRD } });
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/demo/roadmap/generate`, { method: 'POST' });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const frames = [...(await res.text()).matchAll(/data: (\{.*\})/g)]
      .map((m) => JSON.parse(m[1]) as { token?: string; done?: boolean; milestones?: Milestone[] });

    const done = frames[frames.length - 1];
    expect(done.done).toBe(true);
    expect(done.milestones).toEqual([{ id: 'm1', title: 'Skeleton', summary: 'It boots.', status: 'planned' }]);
    expect((await target.app.inject({ method: 'GET', url: '/api/projects/demo/roadmap' })).json())
      .toEqual({ milestones: done.milestones, currentId: 'm1' });
  });
});
