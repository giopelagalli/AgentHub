import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TurnRecord } from '@agenthub/shared';
import { createMockOpenAI, type MockOpenAI, type ScriptStep } from '@agenthub/mocks';
import { createHub, type Hub } from '../src/server.js';

let hub: Hub | undefined;
let mock: MockOpenAI | undefined;
let dir: string | undefined;

/** A hub over an on-disk db and projects root, so a second one can be opened over the same files. */
async function openHub(script: ScriptStep[] = []): Promise<Hub> {
  dir ??= await mkdtemp(join(tmpdir(), 'agenthub-turns-'));
  await mock?.close();
  mock = createMockOpenAI({ script });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`;
  hub = createHub({ projectsRoot: join(dir, 'projects'), dbPath: join(dir, 'hub.db') });
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
  return hub;
}

afterEach(async () => {
  await hub?.stop();
  await mock?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
  hub = undefined; mock = undefined; dir = undefined;
});

const publishStep: ScriptStep = {
  toolCalls: [{
    name: 'publish_briefing',
    arguments: {
      title: 'Demo', status: 'active', priority: 'project',
      summary: 'wired the frobnicator', progress: { done: 1, total: 3 },
      blockers: [], nextSteps: ['ship it'],
    },
  }],
};

const turns = async (h: Hub): Promise<{ running: { sessionId: number; startedAt: number } | null; turns: TurnRecord[] }> =>
  (await h.app.inject({ method: 'GET', url: '/api/projects/demo/turns' })).json();

describe('GET /api/projects/:slug/turns', () => {
  it('replays a finished turn\'s events from storage, even from a hub started afterwards', async () => {
    const first = await openHub([
      { toolCalls: [{ name: 'spawn_subagent', arguments: { task: 'look around', role: 'researcher' } }], content: 'delegating' },
      { content: 'nothing to see' },
      publishStep,
      { content: 'done' },
    ]);
    await first.app.inject({ method: 'POST', url: '/api/projects', payload: { slug: 'demo', title: 'Demo', intent: 'ship the demo' } });
    await first.app.inject({ method: 'POST', url: '/api/projects/demo/turn', payload: {} });

    const live = await turns(first);
    expect(live.running).toBeNull();
    expect(live.turns).toHaveLength(1);
    expect(live.turns[0]).toMatchObject({
      sessionId: expect.any(Number), startedAt: expect.any(Number), endedAt: expect.any(Number),
      outcome: 'stop', summary: 'wired the frobnicator', toolCalls: 2,
    });
    expect(live.turns[0].events.map((e) => e.kind)).toEqual([
      'turn-start', 'text', 'tool-call', 'subagent-start', 'text', 'subagent-end', 'tool-result',
      'tool-call', 'tool-result', 'text', 'turn-end',
    ]);
    expect(live.turns[0].events.every((e) => typeof e.at === 'number')).toBe(true);

    // Restart: a fresh hub over the same database and bundles sees the same turn.
    await first.stop();
    const second = await openHub();
    const replayed = await turns(second);
    expect(replayed).toEqual(live);
  });

  it('shows a turn in progress as running and without an end', async () => {
    const h = await openHub([
      { toolCalls: [{ name: 'run_shell', arguments: { cmd: ['sleep', '2'] } }] },
      publishStep,
      { content: 'done' },
    ]);
    await h.app.inject({ method: 'POST', url: '/api/projects', payload: { slug: 'demo', title: 'Demo', intent: 'ship the demo' } });
    const turn = h.projects.runTurn('demo');
    const deadline = Date.now() + 5000;
    let mid = await turns(h);
    while (!mid.running && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      mid = await turns(h);
    }

    expect(mid.running).toEqual({ sessionId: mid.turns[0].sessionId, startedAt: expect.any(Number) });
    expect(mid.turns[0]).toMatchObject({ endedAt: null, outcome: null });
    expect(mid.turns[0].events[0].kind).toBe('turn-start');

    await turn;
    const after = await turns(h);
    expect(after.running).toBeNull();
    expect(after.turns[0].endedAt).toEqual(expect.any(Number));
  });

  it('closes a turn a crashed hub left open, so a restart never reports it as running forever', async () => {
    const h1 = await openHub();
    await h1.app.inject({ method: 'POST', url: '/api/projects', payload: { slug: 'demo', title: 'Demo', intent: 'ship the demo' } });
    // A hub that dies mid-turn never calls endSession — simulate that by starting a turn's session
    // and never ending it, then opening a fresh hub over the same database in place of a restart.
    const danglingId = h1.transcript.startSession('orchestrator', 'demo', 'orchestrator');
    h1.transcript.appendTurnEvent(danglingId, { kind: 'turn-start', who: 'manager' });

    const h2 = await openHub();
    const after = await turns(h2);

    expect(after.running).toBeNull();
    expect(after.turns).toHaveLength(1);
    expect(after.turns[0]).toMatchObject({ sessionId: danglingId, outcome: 'aborted', endedAt: expect.any(Number) });
  });

  it('lists the newest twenty turns first', async () => {
    const script: ScriptStep[] = [];
    for (let i = 0; i < 22; i++) script.push({ content: `turn ${i + 1}` });
    const h = await openHub(script);
    await h.app.inject({ method: 'POST', url: '/api/projects', payload: { slug: 'demo', title: 'Demo', intent: 'ship the demo' } });
    for (let i = 0; i < 22; i++) await h.projects.runTurn('demo');

    const { turns: listed } = await turns(h);
    expect(listed).toHaveLength(20);
    expect(listed[0].summary).toBe('turn 22');
    expect(listed[19].summary).toBe('turn 3');
  });
});
