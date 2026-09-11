import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockOpenAI, type MockOpenAI, type ScriptStep } from '@agenthub/mocks';
import { createHub, type Hub } from '../src/server.js';

let hub: Hub | undefined;
let mock: MockOpenAI | undefined;
let root: string | undefined;

/** A hub with a temp projects root and one scripted mock registered as the orchestrator/worker node. */
async function setup(script: ScriptStep[] = []): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'agenthub-projects-'));
  mock = createMockOpenAI({ script });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`;
  hub = createHub({ projectsRoot: root });
  await hub.app.inject({
    method: 'POST', url: '/api/nodes/register',
    payload: {
      name: 'spark', arch: 'arm64',
      endpoints: [
        { tier: 'orchestrator', url, model: 'mock-model', maxStreams: 2 },
        { tier: 'worker', url, model: 'mock-model', maxStreams: 2 },
      ],
    },
  });
}

afterEach(async () => {
  await hub?.stop();
  await mock?.close();
  if (root) await rm(root, { recursive: true, force: true });
  hub = undefined; mock = undefined; root = undefined;
});

const app = (): Hub['app'] => {
  if (!hub) throw new Error('setup() not called');
  return hub.app;
};

const publishStep = (over: Record<string, unknown> = {}): ScriptStep => ({
  toolCalls: [{
    name: 'publish_briefing',
    arguments: {
      title: 'Demo', status: 'active', priority: 'project',
      summary: 'wired the frobnicator', progress: { done: 1, total: 3 },
      blockers: [], nextSteps: ['ship it'],
      ...over,
    },
  }],
});

describe('projects API', () => {
  it('round-trips create → turn → pause → read', async () => {
    await setup([publishStep(), { content: 'briefing published' }]);

    const created = await app().inject({
      method: 'POST', url: '/api/projects',
      payload: { slug: 'demo', title: 'Demo', intent: 'ship the demo' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ slug: 'demo', title: 'Demo', status: 'active', priority: 'project' });

    const list = await app().inject({ method: 'GET', url: '/api/projects' });
    expect(list.json()).toHaveLength(1);

    const turn = await app().inject({ method: 'POST', url: '/api/projects/demo/turn', payload: {} });
    expect(turn.statusCode).toBe(200);
    expect(turn.json()).toMatchObject({
      slug: 'demo', title: 'Demo', summary: 'wired the frobnicator', progress: { done: 1, total: 3 },
    });

    const briefings = await app().inject({ method: 'GET', url: '/api/briefings' });
    expect(briefings.json()).toHaveLength(1);
    expect(briefings.json()[0].slug).toBe('demo');

    const paused = await app().inject({ method: 'POST', url: '/api/projects/demo/pause' });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().status).toBe('paused');

    const got = await app().inject({ method: 'GET', url: '/api/projects/demo' });
    expect(got.statusCode).toBe(200);
    expect(got.json().manifest).toMatchObject({ slug: 'demo', status: 'paused' });
    expect(got.json().briefing).toMatchObject({ summary: 'wired the frobnicator' });
    expect(got.json().tasks).toEqual([]);

    const transcript = await app().inject({ method: 'GET', url: '/api/projects/demo/transcript' });
    expect(transcript.statusCode).toBe(200);
    const sessions = transcript.json();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ kind: 'orchestrator', subject: 'demo', tier: 'orchestrator' });
    expect(sessions[0].messages[0].role).toBe('system');
    expect(sessions[0].messages.length).toBeGreaterThan(2);
  });

  it('exposes projects on /api/state', async () => {
    await setup();
    await app().inject({ method: 'POST', url: '/api/projects', payload: { slug: 'demo', title: 'Demo', intent: 'x' } });

    const state = await app().inject({ method: 'GET', url: '/api/state' });
    expect(state.json().projects).toHaveLength(1);
    expect(state.json().projects[0]).toMatchObject({ slug: 'demo', status: 'active' });
  });

  it('rejects an invalid slug with 400 and a duplicate with 409', async () => {
    await setup();

    const bad = await app().inject({
      method: 'POST', url: '/api/projects',
      payload: { slug: 'Not A Slug', title: 'Demo', intent: 'x' },
    });
    expect(bad.statusCode).toBe(400);

    const missingTitle = await app().inject({ method: 'POST', url: '/api/projects', payload: { slug: 'demo', intent: 'x' } });
    expect(missingTitle.statusCode).toBe(400);

    expect((await app().inject({
      method: 'POST', url: '/api/projects', payload: { slug: 'demo', title: 'Demo', intent: 'x' },
    })).statusCode).toBe(201);

    const dup = await app().inject({
      method: 'POST', url: '/api/projects', payload: { slug: 'demo', title: 'Demo Again', intent: 'y' },
    });
    expect(dup.statusCode).toBe(409);
  });

  it('changes priority, resumes and archives', async () => {
    await setup();
    await app().inject({ method: 'POST', url: '/api/projects', payload: { slug: 'demo', title: 'Demo', intent: 'x' } });

    const badPriority = await app().inject({ method: 'POST', url: '/api/projects/demo/priority', payload: { priority: 'nope' } });
    expect(badPriority.statusCode).toBe(400);

    const priority = await app().inject({ method: 'POST', url: '/api/projects/demo/priority', payload: { priority: 'interactive' } });
    expect(priority.json().priority).toBe('interactive');

    await app().inject({ method: 'POST', url: '/api/projects/demo/pause' });
    const resumed = await app().inject({ method: 'POST', url: '/api/projects/demo/resume' });
    expect(resumed.json().status).toBe('active');

    const archived = await app().inject({ method: 'POST', url: '/api/projects/demo/archive' });
    expect(archived.json().status).toBe('done');
  });

  it('404s on an unknown project', async () => {
    await setup();
    expect((await app().inject({ method: 'GET', url: '/api/projects/ghost' })).statusCode).toBe(404);
    expect((await app().inject({ method: 'POST', url: '/api/projects/ghost/pause' })).statusCode).toBe(404);
    expect((await app().inject({ method: 'POST', url: '/api/projects/ghost/turn', payload: {} })).statusCode).toBe(404);
  });

  it('400s a traversing slug without touching anything outside the projects root', async () => {
    await setup();
    // A decoy bundle a sibling of the projects root, reachable as `..%2Foutside%2Fdecoy`.
    const outside = join(root!, '..', `outside-${Date.now()}`);
    const decoyDir = join(outside, 'decoy');
    await mkdir(decoyDir, { recursive: true });
    const decoy = join(decoyDir, 'manifest.yaml');
    const original = [
      'schema: 1', 'slug: decoy', 'title: Decoy', 'status: active', 'priority: project',
      'intent: do not touch', 'links: []', 'createdAt: 1', 'updatedAt: 1', 'index: []', '',
    ].join('\n');
    await writeFile(decoy, original, 'utf8');

    try {
      const traversal = `..%2F${outside.split('/').pop()}%2Fdecoy`;
      for (const url of [
        `/api/projects/${traversal}`,
        `/api/projects/${traversal}/transcript`,
      ]) {
        expect((await app().inject({ method: 'GET', url })).statusCode).toBe(400);
      }
      for (const url of [
        `/api/projects/${traversal}/pause`,
        `/api/projects/${traversal}/resume`,
        `/api/projects/${traversal}/archive`,
        `/api/projects/${traversal}/turn`,
      ]) {
        expect((await app().inject({ method: 'POST', url, payload: {} })).statusCode).toBe(400);
      }
      expect((await app().inject({
        method: 'POST', url: `/api/projects/${traversal}/priority`, payload: { priority: 'batch' },
      })).statusCode).toBe(400);

      expect(await readFile(decoy, 'utf8')).toBe(original);
      expect((await app().inject({ method: 'GET', url: '/api/projects' })).json()).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('project team API', () => {
  /** A project with the default roster, plus the transcript the seeded sessions go into. */
  const seeded = async (): Promise<Hub['transcript']> => {
    await setup();
    await app().inject({ method: 'POST', url: '/api/projects', payload: { slug: 'demo', title: 'Demo', intent: 'x' } });
    return hub!.transcript;
  };

  it('lists the roster with statuses derived from each member\'s latest session', async () => {
    const transcript = await seeded();
    const working = transcript.startSession('subagent', 'demo', 'worker', { memberId: 'coder-1' });
    transcript.append(working, { role: 'assistant', content: 'editing the parser' });
    // Unfinished but older than the working window: a hub killed mid-turn must not pin an employee busy.
    transcript.startSession('subagent', 'demo', 'worker', { memberId: 'researcher-1', now: Date.now() - 60 * 60_000 });

    const res = await app().inject({ method: 'GET', url: '/api/projects/demo/team' });
    expect(res.statusCode).toBe(200);
    const { members, manager } = res.json();

    expect(members.map((m: { id: string }) => m.id)).toEqual(['coder-1', 'researcher-1', 'reviewer-1']);
    expect(members[0]).toMatchObject({ name: 'Ada', role: 'coder', avatar: 'robot-cyan', status: 'working', sessionsCount: 1 });
    expect(members[0].currentSession).toMatchObject({ id: working, outcome: null, lastMessage: 'editing the parser' });
    expect(members[1]).toMatchObject({ status: 'idle', sessionsCount: 1 });
    expect(members[2]).toMatchObject({ status: 'idle', sessionsCount: 0 });
    expect(members[2].currentSession).toBeUndefined();
    expect(manager).toEqual({ status: 'idle' });
  });

  it('adds a member, validates the payload and removes them again', async () => {
    await seeded();

    const created = await app().inject({
      method: 'POST', url: '/api/projects/demo/team',
      payload: { name: 'Byte', role: 'coder', avatar: 'robot-violet', instructions: 'small diffs only' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: 'coder-2', name: 'Byte', role: 'coder', avatar: 'robot-violet', instructions: 'small diffs only' });

    for (const payload of [
      { name: 'Nix', role: 'wizard', avatar: 'robot-violet' },
      { name: 'Nix', role: 'coder', avatar: 'robot-gold' },
      { name: 'N'.repeat(41), role: 'coder', avatar: 'robot-cyan' },
      { name: '', role: 'coder', avatar: 'robot-cyan' },
      { name: 'Nix', role: 'coder', avatar: 'robot-cyan', instructions: 'x'.repeat(2001) },
    ]) {
      expect((await app().inject({ method: 'POST', url: '/api/projects/demo/team', payload })).statusCode).toBe(400);
    }

    const duplicate = await app().inject({
      method: 'POST', url: '/api/projects/demo/team', payload: { name: 'ada', role: 'reviewer', avatar: 'robot-green' },
    });
    expect(duplicate.statusCode).toBe(409);

    expect((await app().inject({ method: 'GET', url: '/api/projects/demo/team' })).json().members).toHaveLength(4);

    const removed = await app().inject({ method: 'DELETE', url: '/api/projects/demo/team/coder-2' });
    expect(removed.statusCode).toBe(204);
    expect((await app().inject({ method: 'DELETE', url: '/api/projects/demo/team/coder-2' })).statusCode).toBe(404);

    const after = await app().inject({ method: 'GET', url: '/api/projects/demo/team' });
    expect(after.json().members.map((m: { id: string }) => m.id)).toEqual(['coder-1', 'researcher-1', 'reviewer-1']);
  });

  it('returns a member\'s latest session as their activity', async () => {
    const transcript = await seeded();
    const older = transcript.startSession('subagent', 'demo', 'worker', { memberId: 'coder-1' });
    transcript.append(older, { role: 'assistant', content: 'the old one' });
    transcript.endSession(older, 'stop');
    const latest = transcript.startSession('subagent', 'demo', 'worker', { memberId: 'coder-1' });
    transcript.append(latest, { role: 'user', content: 'fix the parser' });
    transcript.append(latest, { role: 'assistant', content: 'parser fixed' });
    transcript.appendEvent(latest, 'gateway error: boom');

    const res = await app().inject({ method: 'GET', url: '/api/projects/demo/team/coder-1/activity' });
    expect(res.statusCode).toBe(200);
    expect(res.json().session).toMatchObject({ id: latest, memberId: 'coder-1' });
    expect(res.json().messages.map((m: { content: string }) => m.content)).toEqual(['fix the parser', 'parser fixed']);
    expect(res.json().events[0].content).toBe('gateway error: boom');

    const idle = await app().inject({ method: 'GET', url: '/api/projects/demo/team/reviewer-1/activity' });
    expect(idle.json()).toEqual({ session: null, messages: [], events: [] });

    expect((await app().inject({ method: 'GET', url: '/api/projects/demo/team/ghost-9/activity' })).statusCode).toBe(404);
  });

  it('404s the roster of an unknown project and 400s a traversing slug', async () => {
    await setup();
    expect((await app().inject({ method: 'GET', url: '/api/projects/ghost/team' })).statusCode).toBe(404);
    expect((await app().inject({ method: 'GET', url: '/api/projects/..%2Foutside/team' })).statusCode).toBe(400);
  });
});
