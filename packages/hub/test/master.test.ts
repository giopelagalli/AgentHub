import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Priority } from '@agenthub/shared';
import { createMockOpenAI, type MockOpenAI, type ScriptStep } from '@agenthub/mocks';
import { createHub, type Hub } from '../src/server.js';

let hub: Hub | undefined;
let mock: MockOpenAI | undefined;
let root: string | undefined;

/**
 * A hub whose scheduler is stopped on arrival: every test seeds its projects first and starts the
 * scheduler explicitly, so a tick can never race project creation.
 */
async function setup(script: ScriptStep[] = [], tickIntervalMs?: number): Promise<Hub> {
  root = await mkdtemp(join(tmpdir(), 'agenthub-master-'));
  mock = createMockOpenAI({ script });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`;
  hub = createHub({ projectsRoot: root, ...(tickIntervalMs ? { tickIntervalMs } : {}) });
  await hub.projects.stop();
  await hub.app.inject({
    method: 'POST', url: '/api/nodes/register',
    payload: {
      name: 'spark', arch: 'arm64',
      endpoints: [
        { tier: 'orchestrator', url, model: 'mock-model', maxStreams: 4 },
        { tier: 'worker', url, model: 'mock-model', maxStreams: 4 },
      ],
    },
  });
  return hub;
}

afterEach(async () => {
  await hub?.stop();
  await mock?.close();
  if (root) await rm(root, { recursive: true, force: true });
  hub = undefined; mock = undefined; root = undefined;
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Creates a project and publishes one briefing for it, without going through the model. */
async function seed(h: Hub, slug: string, title: string, priority: Priority = 'project'): Promise<void> {
  await h.projects.create({ slug, title, intent: 'secret-owner-intent', priority });
  const bundle = await h.projects.get(slug);
  await bundle.publishBriefing({
    slug, title, status: 'active', priority,
    summary: `${title} is moving`, progress: { done: 1, total: 2 },
    blockers: [], nextSteps: [], updatedAt: Date.now(),
  });
}

describe('project scheduler', () => {
  it('runs turns for active projects only, highest priority first', async () => {
    const h = await setup([], 50);
    await h.projects.create({ slug: 'urgent', title: 'Urgent', intent: 'x', priority: 'interactive' });
    await h.projects.create({ slug: 'demo', title: 'Demo', intent: 'x', priority: 'project' });
    await h.projects.create({ slug: 'sleepy', title: 'Sleepy', intent: 'x', priority: 'project' });
    await h.projects.pause('sleepy');

    const seen: string[] = [];
    h.projects.onBriefing((b) => seen.push(b.slug));
    h.projects.start();
    await waitFor(() => seen.length >= 2);
    await h.projects.stop();

    expect(seen[0]).toBe('urgent');
    expect(seen[1]).toBe('demo');
    expect(seen).not.toContain('sleepy');
    expect(await (await h.projects.get('sleepy')).latestBriefing()).toBeNull();
  });

  it('serializes concurrent turns for one project', async () => {
    const h = await setup([
      { toolCalls: [{ name: 'publish_briefing', arguments: {
        title: 'Demo', status: 'active', priority: 'project', summary: 'first',
        progress: { done: 0, total: 1 }, blockers: [], nextSteps: [],
      } }] },
      { content: 'turn one' },
      { toolCalls: [{ name: 'publish_briefing', arguments: {
        title: 'Demo', status: 'active', priority: 'project', summary: 'second',
        progress: { done: 1, total: 1 }, blockers: [], nextSteps: [],
      } }] },
      { content: 'turn two' },
    ]);
    await h.projects.create({ slug: 'demo', title: 'Demo', intent: 'x' });

    const seen: string[] = [];
    h.projects.onBriefing((b) => seen.push(b.summary));
    await Promise.all([h.projects.runTurn('demo'), h.projects.runTurn('demo')]);

    expect(seen).toEqual(['first', 'second']);
    expect(await (await h.projects.get('demo')).latestBriefing()).toMatchObject({ summary: 'second' });
  });
});

describe('MasterOrchestrator', () => {
  it('summarizes every project from briefings alone', async () => {
    const h = await setup([{ content: 'Alpha Project is on track. Beta Project is blocked on the API key.' }]);
    await seed(h, 'alpha', 'Alpha Project');
    await seed(h, 'beta', 'Beta Project');

    const res = await h.app.inject({ method: 'POST', url: '/api/master/brief' });
    expect(res.statusCode).toBe(200);
    const { text, briefings } = res.json() as { text: string; briefings: unknown[] };
    expect(briefings).toHaveLength(2);
    expect(text).toContain('Alpha Project');
    expect(text).toContain('Beta Project');
    expect(text.length).toBeLessThanOrEqual(1500);

    // The master's inputs are briefings only — never the bundle context pack (which carries intent).
    const sent = mock!.lastRequest().messages as { role: string; content: string }[];
    expect(sent[1].role).toBe('user');
    expect(sent[1].content).toContain('Alpha Project');
    expect(sent[1].content).not.toContain('secret-owner-intent');
  });

  it('falls back to a templated summary when the model returns nothing', async () => {
    const h = await setup([{ content: '' }]);
    await seed(h, 'alpha', 'Alpha Project');
    await seed(h, 'beta', 'Beta Project');

    const { text } = await h.master.dailyBriefing();

    expect(text).toContain('Alpha Project');
    expect(text).toContain('Beta Project');
    expect(text).toContain('1/2');
  });

  it('acts on an owner command through its project tools', async () => {
    const h = await setup([
      { toolCalls: [{ name: 'pause_project', arguments: { slug: 'demo' } }] },
      { content: 'Paused demo.' },
    ]);
    await h.projects.create({ slug: 'demo', title: 'Demo', intent: 'secret-owner-intent' });

    const res = await h.app.inject({ method: 'POST', url: '/api/master/command', payload: { text: 'pause demo' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().actions).toContain('pause_project');
    expect(res.json().text).toBe('Paused demo.');
    expect((await (await h.projects.get('demo')).manifest()).status).toBe('paused');

    // The command prompt carries a roster (slug, title, status, priority) — never the owner's intent.
    const sent = mock!.lastRequest().messages as { role: string; content: string }[];
    expect(sent[0].role).toBe('system');
    expect(sent[0].content).toContain('demo');
    expect(sent[0].content).not.toContain('secret-owner-intent');
  });

  it('reports no action when the tool the model called failed', async () => {
    const h = await setup([
      { toolCalls: [{ name: 'pause_project', arguments: { slug: 'ghost' } }] },
      { content: 'I could not find a project called ghost.' },
    ]);
    await h.projects.create({ slug: 'demo', title: 'Demo', intent: 'x' });

    const res = await h.app.inject({ method: 'POST', url: '/api/master/command', payload: { text: 'pause ghost' } });

    expect(res.json().actions).toEqual([]);
    const sent = mock!.lastRequest().messages as { role: string; content: string }[];
    expect(sent.find((m) => m.role === 'tool')?.content).toMatch(/^error:/);
    expect((await (await h.projects.get('demo')).manifest()).status).toBe('active');
  });

  it('rejects a command without text', async () => {
    const h = await setup();
    expect((await h.app.inject({ method: 'POST', url: '/api/master/command', payload: {} })).statusCode).toBe(400);
  });
});
