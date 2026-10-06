import { describe, it, expect, afterEach } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { createMockOpenAI, type MockOpenAI, type ScriptStep } from '@agenthub/mocks';
import { createHub, type Hub } from '../src/server.js';
import { routeAccess } from '../src/auth.js';

const KEY_ENV = 'FIREWORKS_API_KEY';
const GLM = 'accounts/fireworks/models/glm-5p3';
const FLASH = 'accounts/fireworks/models/glm-5p3-flash';
const DEEPSEEK = 'accounts/fireworks/models/deepseek-v4p1-flash';

let hub: Hub | undefined;
let local: MockOpenAI | undefined;
let fireworks: MockOpenAI | undefined;
let root: string | undefined;
const savedKey = process.env[KEY_ENV];

/**
 * A hub with a temp projects root, one local node, and a Fireworks cloud tier pointed at a second
 * mock. The cloud model list is the curated one, not fetched from the mock.
 */
async function setup(): Promise<void> {
  process.env[KEY_ENV] = 'fw-secret';
  root = await mkdtemp(join(tmpdir(), 'agenthub-model-policy-'));
  local = createMockOpenAI();
  fireworks = createMockOpenAI();
  await local.listen({ port: 0, host: '127.0.0.1' });
  await fireworks.listen({ port: 0, host: '127.0.0.1' });
  const localUrl = `http://127.0.0.1:${(local.server.address() as { port: number }).port}`;
  const fireworksUrl = `http://127.0.0.1:${(fireworks.server.address() as { port: number }).port}`;
  hub = createHub({ projectsRoot: root, cloud: { fireworks: { baseUrl: fireworksUrl } } });
  await hub.app.inject({
    method: 'POST', url: '/api/nodes/register',
    payload: {
      name: 'spark', arch: 'arm64',
      endpoints: [
        { tier: 'orchestrator', url: localUrl, model: 'mock-model', maxStreams: 2 },
        { tier: 'worker', url: localUrl, model: 'mock-model', maxStreams: 2 },
      ],
    },
  });
  await hub.app.inject({
    method: 'POST', url: '/api/projects',
    payload: { slug: 'demo', title: 'Demo', intent: 'ship the demo' },
  });
}

afterEach(async () => {
  await hub?.stop();
  await local?.close();
  await fireworks?.close();
  if (root) await rm(root, { recursive: true, force: true });
  hub = undefined; local = undefined; fireworks = undefined; root = undefined;
  if (savedKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = savedKey;
});

const app = (): Hub['app'] => {
  if (!hub) throw new Error('setup() not called');
  return hub.app;
};

function setPolicy(payload: Record<string, unknown>): Promise<LightMyRequestResponse> {
  return app().inject({ method: 'POST', url: '/api/projects/demo/model', payload });
}

function patchMember(id: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> {
  return app().inject({ method: 'PATCH', url: `/api/projects/demo/team/${id}`, payload });
}

describe('POST /api/projects/:slug/model', () => {
  it('stores the policy on the manifest and commits it', async () => {
    await setup();
    const res = await setPolicy({ prefer: 'cloud', provider: 'fireworks', orchestratorModel: FLASH, workerModel: DEEPSEEK });
    expect(res.statusCode).toBe(200);
    expect(res.json().modelPolicy).toEqual({
      prefer: 'cloud', provider: 'fireworks', orchestratorModel: FLASH, workerModel: DEEPSEEK,
    });

    const read = await app().inject({ method: 'GET', url: '/api/projects/demo' });
    expect(read.json().manifest.modelPolicy.prefer).toBe('cloud');

    const log = await simpleGit(join(root!, 'demo')).log();
    expect(log.latest?.message).toBe('owner: set model policy');
  });

  it('accepts the simple modes with no provider', async () => {
    await setup();
    expect((await setPolicy({ prefer: 'local' })).json().modelPolicy).toEqual({ prefer: 'local' });
    expect((await setPolicy({ prefer: 'auto' })).json().modelPolicy).toEqual({ prefer: 'auto' });
  });

  it('rejects a bad preference, an unknown provider, a switched-off hard model, and a model the catalog does not list', async () => {
    await setup();
    expect((await setPolicy({ prefer: 'whatever' })).statusCode).toBe(400);
    expect((await setPolicy({})).statusCode).toBe(400);
    expect((await setPolicy({ prefer: 'cloud', provider: 'openai' })).statusCode).toBe(400);
    expect((await setPolicy({ prefer: 'cloud', provider: 'anthropic' })).statusCode).toBe(400); // not configured here

    const off = await setPolicy({ prefer: 'cloud', provider: 'fireworks', orchestratorModel: GLM });
    expect(off.statusCode).toBe(400);
    expect(off.json().error).toMatch(/switched off/);

    const unknown = await setPolicy({ prefer: 'cloud', provider: 'fireworks', orchestratorModel: 'accounts/me/models/nope' });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toContain('unknown model');

    // A model override without a provider has nothing to validate against.
    expect((await setPolicy({ prefer: 'cloud', orchestratorModel: FLASH })).statusCode).toBe(400);

    // The manifest is untouched by every refusal.
    const read = await app().inject({ method: 'GET', url: '/api/projects/demo' });
    expect(read.json().manifest.modelPolicy).toBeUndefined();
  });

  it('accepts the curated models and the configured defaults', async () => {
    await setup();
    expect((await setPolicy({ prefer: 'cloud', provider: 'fireworks', workerModel: FLASH })).statusCode).toBe(200);
    expect((await setPolicy({ prefer: 'cloud', provider: 'fireworks', orchestratorModel: DEEPSEEK })).statusCode).toBe(200);
  });

  it('accepts a hard model once FIREWORKS_HARD_MODELS is on', async () => {
    process.env[KEY_ENV] = 'fw-secret';
    root = await mkdtemp(join(tmpdir(), 'agenthub-model-policy-'));
    fireworks = createMockOpenAI();
    await fireworks.listen({ port: 0, host: '127.0.0.1' });
    const fireworksUrl = `http://127.0.0.1:${(fireworks.server.address() as { port: number }).port}`;
    hub = createHub({ projectsRoot: root, cloud: { fireworks: { baseUrl: fireworksUrl, hardModels: true } } });
    await hub.app.inject({
      method: 'POST', url: '/api/projects',
      payload: { slug: 'demo', title: 'Demo', intent: 'ship the demo' },
    });

    expect((await setPolicy({ prefer: 'cloud', provider: 'fireworks', orchestratorModel: GLM })).statusCode).toBe(200);
  });

  it('404s for a project that does not exist', async () => {
    await setup();
    const res = await app().inject({ method: 'POST', url: '/api/projects/ghost/model', payload: { prefer: 'local' } });
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /api/projects/:slug/team/:id', () => {
  it('stores the override on the member and the roster shows it; null clears it', async () => {
    await setup();
    const res = await patchMember('coder-1', { model: { prefer: 'cloud', provider: 'fireworks', workerModel: FLASH } });
    expect(res.statusCode).toBe(200);
    expect(res.json().model).toEqual({ prefer: 'cloud', provider: 'fireworks', workerModel: FLASH });

    const roster = await app().inject({ method: 'GET', url: '/api/projects/demo/team' });
    const ada = roster.json().members.find((m: { id: string }) => m.id === 'coder-1');
    expect(ada.model).toEqual({ prefer: 'cloud', provider: 'fireworks', workerModel: FLASH });

    const log = await simpleGit(join(root!, 'demo')).log();
    expect(log.latest?.message).toMatch(/^owner:/);

    const cleared = await patchMember('coder-1', { model: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().model).toBeUndefined();
    const rosterAfter = await app().inject({ method: 'GET', url: '/api/projects/demo/team' });
    expect(rosterAfter.json().members.find((m: { id: string }) => m.id === 'coder-1').model).toBeUndefined();
  });

  it('refuses a disabled or unknown model with the project route\'s own messages', async () => {
    await setup();
    const badPrefer = await patchMember('coder-1', { model: { prefer: 'whatever' } });
    expect(badPrefer.statusCode).toBe(400);

    const off = await patchMember('coder-1', { model: { prefer: 'cloud', provider: 'fireworks', orchestratorModel: GLM } });
    expect(off.statusCode).toBe(400);
    expect(off.json().error).toMatch(/switched off/);

    const unknown = await patchMember('coder-1', { model: { prefer: 'cloud', provider: 'fireworks', orchestratorModel: 'accounts/me/models/nope' } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toContain('unknown model');

    // The roster is untouched by every refusal.
    const roster = await app().inject({ method: 'GET', url: '/api/projects/demo/team' });
    expect(roster.json().members.find((m: { id: string }) => m.id === 'coder-1').model).toBeUndefined();
  });

  it('404s for an unknown project or an unknown member', async () => {
    await setup();
    const badProject = await app().inject({ method: 'PATCH', url: '/api/projects/ghost/team/coder-1', payload: { model: null } });
    expect(badProject.statusCode).toBe(404);

    const badMember = await patchMember('ghost-9', { model: null });
    expect(badMember.statusCode).toBe(404);
  });
});

describe('an employee\'s media abilities (decision 0073)', () => {
  const memberOf = async (id: string) =>
    (await app().inject({ method: 'GET', url: '/api/projects/demo/team' })).json().members.find((m: { id: string }) => m.id === id);

  it('stores a deduplicated subset in a fixed order, keeps [] as set, and null clears it', async () => {
    await setup();
    const res = await patchMember('researcher-1', { abilities: ['video', 'image', 'video'] });
    expect(res.statusCode).toBe(200);
    expect(res.json().abilities).toEqual(['image', 'video']);
    expect((await memberOf('researcher-1')).abilities).toEqual(['image', 'video']);
    const log = await simpleGit(join(root!, 'demo')).log();
    expect(log.latest?.message).toMatch(/^owner: set Sol's abilities/);

    expect((await patchMember('researcher-1', { abilities: [] })).json().abilities).toEqual([]);
    expect((await memberOf('researcher-1')).abilities).toEqual([]);

    expect((await patchMember('researcher-1', { abilities: null })).json().abilities).toBeUndefined();
    expect((await memberOf('researcher-1')).abilities).toBeUndefined();
  });

  it('refuses anything but a list of image/video, leaving the roster untouched', async () => {
    await setup();
    for (const abilities of ['image', ['audio'], [1], { image: true }]) {
      const res = await patchMember('coder-1', { abilities });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid abilities');
    }
    expect((await memberOf('coder-1')).abilities).toBeUndefined();
    const empty = await patchMember('coder-1', {});
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toBe('nothing to change');
  });

  it('is accepted with no machine able to render, and the roster says nothing can render yet', async () => {
    await setup();
    expect((await patchMember('coder-1', { abilities: ['image'] })).statusCode).toBe(200);
    const roster = (await app().inject({ method: 'GET', url: '/api/projects/demo/team' })).json();
    expect(roster.renderers).toEqual({ image: false, video: false });
  });

  it('can be set when hiring, and is owner-only like the rest of the roster', async () => {
    await setup();
    const hired = await app().inject({
      method: 'POST', url: '/api/projects/demo/team',
      payload: { name: 'Iris', role: 'coder', avatar: 'robot-green', abilities: ['video'] },
    });
    expect(hired.statusCode).toBe(201);
    expect(hired.json().abilities).toEqual(['video']);
    const bad = await app().inject({
      method: 'POST', url: '/api/projects/demo/team',
      payload: { name: 'Otto', role: 'coder', avatar: 'robot-green', abilities: ['audio'] },
    });
    expect(bad.statusCode).toBe(400);
    const unset = await app().inject({
      method: 'POST', url: '/api/projects/demo/team',
      payload: { name: 'Pia', role: 'designer', avatar: 'robot-green', abilities: null },
    });
    expect(unset.statusCode).toBe(201);
    expect(unset.json().abilities).toBeUndefined();
    expect(routeAccess('PATCH', '/api/projects/:slug/team/:id')).toBe('owner');
  });
});

describe('a project turn under a model policy', () => {
  it('sends the orchestrator turn to the policy\'s cloud model', async () => {
    await setup();
    await setPolicy({ prefer: 'cloud', provider: 'fireworks', orchestratorModel: FLASH, workerModel: DEEPSEEK });

    const turn = await app().inject({ method: 'POST', url: '/api/projects/demo/turn', payload: {} });
    expect(turn.statusCode).toBe(200);
    // The turn ran against the Fireworks endpoint, under the orchestrator model the owner chose.
    expect(fireworks!.requests.length).toBeGreaterThan(0);
    expect(fireworks!.lastRequest().model).toBe(FLASH);
    expect(local!.requests).toHaveLength(0);
  });

  it('leaves an unset policy on the local node', async () => {
    await setup();
    const turn = await app().inject({ method: 'POST', url: '/api/projects/demo/turn', payload: {} });
    expect(turn.statusCode).toBe(200);
    expect(local!.requests.length).toBeGreaterThan(0);
    expect(fireworks!.requests).toHaveLength(0);
  });
});

describe('a turn where one employee has a model override', () => {
  it("routes that member's subagent run to their own model, leaving the manager on the project's", async () => {
    // No shared setup() here: the manager needs a scripted spawn_subagent, and the mock it and the
    // subagent's tier share is set up once, at construction.
    process.env[KEY_ENV] = 'fw-secret';
    root = await mkdtemp(join(tmpdir(), 'agenthub-model-policy-'));
    const managerScript: ScriptStep[] = [
      { toolCalls: [{ name: 'spawn_subagent', arguments: { task: 'add the lexer', member: 'coder-1' } }] },
      {
        toolCalls: [{
          name: 'publish_briefing',
          arguments: {
            title: 'Demo', status: 'active', priority: 'project', summary: 'delegated to Ada',
            progress: { done: 1, total: 2 }, blockers: [], nextSteps: [],
          },
        }],
      },
      { content: 'delegated' },
    ];
    local = createMockOpenAI({ script: managerScript });
    fireworks = createMockOpenAI({ script: [{ content: 'lexer added' }] });
    await local.listen({ port: 0, host: '127.0.0.1' });
    await fireworks.listen({ port: 0, host: '127.0.0.1' });
    const localUrl = `http://127.0.0.1:${(local.server.address() as { port: number }).port}`;
    const fireworksUrl = `http://127.0.0.1:${(fireworks.server.address() as { port: number }).port}`;
    hub = createHub({ projectsRoot: root, cloud: { fireworks: { baseUrl: fireworksUrl } } });
    await hub.app.inject({
      method: 'POST', url: '/api/nodes/register',
      payload: {
        name: 'spark', arch: 'arm64',
        endpoints: [
          { tier: 'orchestrator', url: localUrl, model: 'mock-model', maxStreams: 2 },
          { tier: 'worker', url: localUrl, model: 'mock-model', maxStreams: 2 },
        ],
      },
    });
    await hub.app.inject({
      method: 'POST', url: '/api/projects',
      payload: { slug: 'demo', title: 'Demo', intent: 'ship the demo' },
    });
    // The project itself stays on the (unset, so local-first) default — only Ada gets a cloud model.
    await patchMember('coder-1', { model: { prefer: 'cloud', provider: 'fireworks', workerModel: FLASH } });

    const turn = await app().inject({ method: 'POST', url: '/api/projects/demo/turn', payload: {} });
    expect(turn.statusCode).toBe(200);

    // Ada's subagent run went to Fireworks, under her own worker model.
    expect(fireworks!.requests).toHaveLength(1);
    expect(fireworks!.lastRequest().model).toBe(FLASH);
    // The manager's own three calls (spawn, publish, final text) never left the local mock.
    expect(local!.requests).toHaveLength(3);
  });
});
