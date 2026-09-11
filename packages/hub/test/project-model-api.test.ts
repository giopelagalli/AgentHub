import { describe, it, expect, afterEach } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { createMockOpenAI, type MockOpenAI } from '@agenthub/mocks';
import { createHub, type Hub } from '../src/server.js';

const KEY_ENV = 'FIREWORKS_API_KEY';
const GLM = 'accounts/fireworks/models/glm-5p3';
const FLASH = 'accounts/fireworks/models/glm-5p3-flash';

let hub: Hub | undefined;
let local: MockOpenAI | undefined;
let fireworks: MockOpenAI | undefined;
let root: string | undefined;
const savedKey = process.env[KEY_ENV];

/**
 * A hub with a temp projects root, one local node, and a Fireworks cloud tier pointed at a second
 * mock — whose `/v1/models` lists `mock-model`, so the catalog has something beyond the defaults.
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

describe('POST /api/projects/:slug/model', () => {
  it('stores the policy on the manifest and commits it', async () => {
    await setup();
    const res = await setPolicy({ prefer: 'cloud', provider: 'fireworks', orchestratorModel: GLM, workerModel: FLASH });
    expect(res.statusCode).toBe(200);
    expect(res.json().modelPolicy).toEqual({
      prefer: 'cloud', provider: 'fireworks', orchestratorModel: GLM, workerModel: FLASH,
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

  it('rejects a bad preference, an unknown provider, and a model the catalog does not list', async () => {
    await setup();
    expect((await setPolicy({ prefer: 'whatever' })).statusCode).toBe(400);
    expect((await setPolicy({})).statusCode).toBe(400);
    expect((await setPolicy({ prefer: 'cloud', provider: 'openai' })).statusCode).toBe(400);
    expect((await setPolicy({ prefer: 'cloud', provider: 'anthropic' })).statusCode).toBe(400); // not configured here

    const unknown = await setPolicy({ prefer: 'cloud', provider: 'fireworks', orchestratorModel: 'accounts/me/models/nope' });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toContain('unknown model');

    // A model override without a provider has nothing to validate against.
    expect((await setPolicy({ prefer: 'cloud', orchestratorModel: GLM })).statusCode).toBe(400);

    // The manifest is untouched by every refusal.
    const read = await app().inject({ method: 'GET', url: '/api/projects/demo' });
    expect(read.json().manifest.modelPolicy).toBeUndefined();
  });

  it('accepts a model the live catalog lists as well as the configured defaults', async () => {
    await setup();
    // The mock's /v1/models lists `mock-model`; the configured defaults are the GLM pair.
    expect((await setPolicy({ prefer: 'cloud', provider: 'fireworks', workerModel: 'mock-model' })).statusCode).toBe(200);
    expect((await setPolicy({ prefer: 'cloud', provider: 'fireworks', orchestratorModel: GLM })).statusCode).toBe(200);
  });

  it('404s for a project that does not exist', async () => {
    await setup();
    const res = await app().inject({ method: 'POST', url: '/api/projects/ghost/model', payload: { prefer: 'local' } });
    expect(res.statusCode).toBe(404);
  });

  it('404s a bad slug before checking the catalog, even with a provider named', async () => {
    await setup();
    let catalogHits = 0;
    // The mock is already listening by the time this test runs, so a Fastify hook is refused —
    // count directly on the underlying HTTP server instead.
    fireworks!.server.on('request', (req) => { if (req.url?.startsWith('/v1/models')) catalogHits++; });

    const missing = await app().inject({
      method: 'POST', url: '/api/projects/ghost/model',
      payload: { prefer: 'cloud', provider: 'fireworks', orchestratorModel: GLM },
    });
    expect(missing.statusCode).toBe(404);
    expect(catalogHits).toBe(0); // resolveProject ran first, so the catalog was never fetched

    // A real project with the same payload does fetch the catalog, confirming the hook works.
    expect((await setPolicy({ prefer: 'cloud', provider: 'fireworks', orchestratorModel: GLM })).statusCode).toBe(200);
    expect(catalogHits).toBe(1);
  });
});

describe('a project turn under a model policy', () => {
  it('sends the orchestrator turn to the policy\'s cloud model', async () => {
    await setup();
    await setPolicy({ prefer: 'cloud', provider: 'fireworks', orchestratorModel: GLM, workerModel: FLASH });

    const turn = await app().inject({ method: 'POST', url: '/api/projects/demo/turn', payload: {} });
    expect(turn.statusCode).toBe(200);
    // The turn ran against the Fireworks endpoint, under the orchestrator model the owner chose.
    expect(fireworks!.requests.length).toBeGreaterThan(0);
    expect(fireworks!.lastRequest().model).toBe(GLM);
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
