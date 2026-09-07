import { describe, it, expect, afterAll } from 'vitest';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { createMockOpenAI, type MockOpenAI, type ScriptStep } from '@agenthub/mocks';
import { createHub, type Hub } from '../src/server.js';

/**
 * Phase 3 acceptance test (spec §14): create a project, run a turn that plans, delegates and
 * publishes a briefing, pause it, restart the hub over the same db + projects root, and confirm the
 * project rehydrates from its bundle — not from anything held in memory — into a coherent briefing.
 */

const tmpDirs: string[] = [];
const openMocks: MockOpenAI[] = [];
let hub: Hub | undefined;

afterAll(async () => {
  await hub?.stop();
  for (const m of openMocks) await m.close();
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

async function serve(script: ScriptStep[]): Promise<{ mock: MockOpenAI; url: string }> {
  const mock = createMockOpenAI({ script });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  openMocks.push(mock);
  return { mock, url: `http://127.0.0.1:${(mock.server.address() as { port: number }).port}` };
}

async function registerNode(h: Hub, orchestratorUrl: string, workerUrl: string): Promise<void> {
  const res = await h.app.inject({
    method: 'POST', url: '/api/nodes/register',
    payload: {
      name: 'spark', arch: 'arm64',
      endpoints: [
        { tier: 'orchestrator', url: orchestratorUrl, model: 'mock-model', maxStreams: 2 },
        { tier: 'worker', url: workerUrl, model: 'mock-model', maxStreams: 2 },
      ],
    },
  });
  expect(res.statusCode).toBe(200);
}

/** Commit subjects, newest first. */
const commitSubjects = async (dir: string): Promise<string[]> =>
  (await simpleGit(dir).log()).all.map((c) => c.message);

describe('phase 3 acceptance: pause, restart, rehydrate', () => {
  it(
    'plans, delegates, publishes, survives a restart and rehydrates from the bundle',
    async () => {
      const dbPath = join(await tempDir('agenthub-e2e-db-'), 'hub.db');
      const projectsRoot = await tempDir('agenthub-e2e-projects-');

      // --- hub A: turn 1 -------------------------------------------------------
      const { url: brainAUrl } = await serve([
        {
          toolCalls: [
            {
              name: 'update_tasks',
              arguments: {
                tasks: [
                  { id: 't1', title: 'wire the frobnicator', status: 'backlog' },
                  { id: 't2', title: 'write the docs', status: 'backlog' },
                ],
              },
            },
            { name: 'spawn_subagent', arguments: { task: 'summarize the repo', role: 'researcher' } },
          ],
        },
        {
          toolCalls: [
            { name: 'add_decision', arguments: { title: 'use SQLite WAL', rationale: 'concurrent readers during turns' } },
            {
              name: 'publish_briefing',
              arguments: {
                title: 'Demo', status: 'active', priority: 'project',
                summary: 'turn one wired the plan', progress: { done: 0, total: 2 },
                blockers: [], nextSteps: ['wire the frobnicator', 'write the docs'],
              },
            },
          ],
        },
        { content: 'turn one done' },
      ]);
      // Worker mock is unscripted: it just echoes the subagent's task back.
      const { url: workerAUrl } = await serve([]);

      hub = createHub({ dbPath, projectsRoot });
      await registerNode(hub, brainAUrl, workerAUrl);

      const created = await hub.app.inject({
        method: 'POST', url: '/api/projects',
        payload: { slug: 'demo', title: 'Demo', intent: 'ship the demo' },
      });
      expect(created.statusCode).toBe(201);

      const turn1 = await hub.app.inject({ method: 'POST', url: '/api/projects/demo/turn', payload: {} });
      expect(turn1.statusCode).toBe(200);
      expect(turn1.json()).toMatchObject({
        slug: 'demo', title: 'Demo', status: 'active',
        summary: 'turn one wired the plan', progress: { done: 0, total: 2 },
      });

      // Bundle files reflect turn 1's work on disk.
      const bundleDir = join(projectsRoot, 'demo');
      const tasksYaml = await readFile(join(bundleDir, 'tasks.yaml'), 'utf8');
      expect(tasksYaml).toContain('wire the frobnicator');
      expect(tasksYaml).toContain('write the docs');
      const decisionsLog = await readFile(join(bundleDir, 'decisions.log.md'), 'utf8');
      expect(decisionsLog).toContain('use SQLite WAL');
      expect(decisionsLog).toContain('concurrent readers during turns');
      // Scaffolding aside, every commit turn 1 made is an `agent:` commit.
      const subjects = await commitSubjects(bundleDir);
      const agentCommits = subjects.filter((s) => s !== 'chore: scaffold project bundle');
      expect(agentCommits.length).toBeGreaterThan(0);
      expect(agentCommits.every((s) => s.startsWith('agent:'))).toBe(true);

      // Pause, then stop the hub — simulating a hub restart.
      const paused = await hub.app.inject({ method: 'POST', url: '/api/projects/demo/pause' });
      expect(paused.statusCode).toBe(200);
      expect(paused.json().status).toBe('paused');

      await hub.stop();

      // --- hub B: same db + projects root, fresh process -----------------------
      const { mock: brainB, url: brainBUrl } = await serve([
        {
          toolCalls: [{
            name: 'publish_briefing',
            arguments: {
              title: 'Demo', status: 'active', priority: 'project',
              summary: 'turn two moved wire the frobnicator forward', progress: { done: 1, total: 2 },
              blockers: [], nextSteps: ['write the docs'],
            },
          }],
        },
        { content: 'turn two done' },
      ]);
      const { url: workerBUrl } = await serve([]);

      hub = createHub({ dbPath, projectsRoot });
      await registerNode(hub, brainBUrl, workerBUrl);

      // The restarted hub sees the project paused with turn 1's briefing intact, from the bundle.
      const reopened = await hub.app.inject({ method: 'GET', url: '/api/projects/demo' });
      expect(reopened.statusCode).toBe(200);
      expect(reopened.json().manifest).toMatchObject({ slug: 'demo', status: 'paused' });
      expect(reopened.json().briefing).toMatchObject({ summary: 'turn one wired the plan', progress: { done: 0, total: 2 } });
      expect(reopened.json().tasks).toEqual([
        { id: 't1', title: 'wire the frobnicator', status: 'backlog' },
        { id: 't2', title: 'write the docs', status: 'backlog' },
      ]);

      const resumed = await hub.app.inject({ method: 'POST', url: '/api/projects/demo/resume' });
      expect(resumed.statusCode).toBe(200);
      expect(resumed.json().status).toBe('active');

      const turn2 = await hub.app.inject({ method: 'POST', url: '/api/projects/demo/turn', payload: {} });
      expect(turn2.statusCode).toBe(200);
      expect(turn2.json()).toMatchObject({
        slug: 'demo', summary: 'turn two moved wire the frobnicator forward', progress: { done: 1, total: 2 },
      });

      // The rehydrated orchestrator's own bundle context — not memory — carried turn 1's task and
      // decision forward into turn 2's prompt.
      const req = brainB.lastRequest() as { messages: { role: string; content: string }[] };
      const system = req.messages[0];
      expect(system.role).toBe('system');
      expect(system.content).toContain('wire the frobnicator');
      expect(system.content).toContain('use SQLite WAL');
      expect(system.content).toContain('concurrent readers during turns');

      // /api/briefings lists the project.
      const briefings = await hub.app.inject({ method: 'GET', url: '/api/briefings' });
      expect(briefings.statusCode).toBe(200);
      expect(briefings.json().map((b: { slug: string }) => b.slug)).toContain('demo');

      // /api/master/brief reads only the briefings and mentions the project by title (either the
      // model's own words or the templated fallback, both of which name every project).
      const brief = await hub.app.inject({ method: 'POST', url: '/api/master/brief' });
      expect(brief.statusCode).toBe(200);
      expect(brief.json().text).toContain('Demo');
    },
    60_000,
  );
});
