import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb } from '../src/db.js';
import { NodeRegistry } from '../src/node-registry.js';
import { ModelGateway } from '../src/gateway.js';
import type { AnthropicLike } from '../src/providers/anthropic.js';
import { createHub, CLOUD_FIREWORKS_NODE_NAME, type Hub } from '../src/server.js';

const KEY_ENV = 'FIREWORKS_API_KEY';
const FLASH = 'accounts/fireworks/models/glm-5p3-flash';
const DEEPSEEK = 'accounts/fireworks/models/deepseek-v4p1-flash';
const GLM = 'accounts/fireworks/models/glm-5p3';
const KIMI = 'accounts/fireworks/models/kimi-k3';

/**
 * A fake Fireworks: the OpenAI-compatible chat completion it streams, and the `authorization`
 * header each request arrived with. Nothing leaves the machine.
 */
interface FakeFireworks {
  app: FastifyInstance;
  url: string;
  chatAuth: (string | undefined)[];
  chatBodies: { model: string }[];
  status: number;
}

async function fakeFireworks(): Promise<FakeFireworks> {
  const app = Fastify();
  const state: FakeFireworks = {
    app, url: '', chatAuth: [], chatBodies: [], status: 200,
  };

  app.addHook('onRequest', async (req) => {
    state.chatAuth.push(req.headers.authorization);
  });

  app.post('/v1/chat/completions', async (req, reply) => {
    state.chatBodies.push(req.body as { model: string });
    if (state.status !== 200) return reply.code(state.status).send({ error: 'nope' });
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
    reply.raw.write(chunk({ content: 'from ' }, null));
    reply.raw.write(chunk({ content: 'fireworks' }, null));
    reply.raw.write(chunk({}, 'stop'));
    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
    return reply;
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  state.url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  return state;
}

let hub: Hub | undefined;
let fake: FakeFireworks | undefined;
const savedKey = process.env[KEY_ENV];

afterEach(async () => {
  await hub?.stop();
  await fake?.app.close();
  hub = undefined; fake = undefined;
  if (savedKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = savedKey;
  vi.restoreAllMocks();
});

function gatewayFor(url: string) {
  const registry = new NodeRegistry(openDb(':memory:'));
  registry.register({
    name: CLOUD_FIREWORKS_NODE_NAME, arch: 'cloud',
    endpoints: [
      { tier: 'worker', provider: 'fireworks', url, apiKeyEnv: KEY_ENV, model: 'accounts/fireworks/models/glm-5p3-flash', maxStreams: 4 },
    ],
  });
  return { registry, gateway: new ModelGateway(registry) };
}

describe('the fireworks endpoint', () => {
  it('sends the bearer token from apiKeyEnv and streams the OpenAI-shaped reply', async () => {
    fake = await fakeFireworks();
    process.env[KEY_ENV] = 'fw-secret';
    const { gateway } = gatewayFor(fake.url);

    const tokens: string[] = [];
    const res = await gateway.chat('worker', [{ role: 'user', content: 'hi' }], { onToken: (t) => tokens.push(t) });
    expect(res.content).toBe('from fireworks');
    expect(res.finish).toBe('stop');
    expect(tokens.join('')).toBe('from fireworks');
    expect(fake.chatAuth).toEqual(['Bearer fw-secret']);
    expect(fake.chatBodies[0].model).toBe('accounts/fireworks/models/glm-5p3-flash');
  });

  it('is unavailable, with one log line, when the env var is not set', async () => {
    fake = await fakeFireworks();
    delete process.env[KEY_ENV];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { gateway } = gatewayFor(fake.url);

    expect(gateway.pick('worker')).toBeNull();
    await expect(gateway.chat('worker', [{ role: 'user', content: 'hi' }], {})).rejects.toThrow('no capacity');
    // Several picks, one line — and no request ever went out unauthenticated.
    expect(warn.mock.calls.filter((c) => String(c[0]).includes(KEY_ENV))).toHaveLength(1);
    expect(fake.chatAuth).toEqual([]);
  });

  it('treats a 429 as retryable and a 400 as not', async () => {
    fake = await fakeFireworks();
    process.env[KEY_ENV] = 'fw-secret';
    const { registry, gateway } = gatewayFor(fake.url);
    // A second endpoint for the tier, so a retryable failure has somewhere to fail over to.
    registry.register({
      name: 'spark', arch: 'arm64',
      endpoints: [{ tier: 'worker', url: fake.url, model: 'local-model', maxStreams: 4 }],
    });

    fake.status = 429;
    await expect(gateway.chat('worker', [{ role: 'user', content: 'hi' }], {})).rejects.toThrow('429');
    // Retried on the other endpoint before giving up: two requests for one chat.
    expect(fake.chatBodies).toHaveLength(2);

    fake.chatBodies.length = 0;
    fake.status = 400;
    await expect(gateway.chat('worker', [{ role: 'user', content: 'hi' }], {})).rejects.toThrow('400');
    expect(fake.chatBodies).toHaveLength(1);
  });
});

describe('the synthetic fireworks node', () => {
  it('registers, is never swept, and refuses a daemon under its name', async () => {
    fake = await fakeFireworks();
    process.env[KEY_ENV] = 'fw-secret';
    hub = createHub({ cloud: { fireworks: { baseUrl: fake.url } }, staleMs: 25, sweepIntervalMs: 5 });

    const node = hub.registry.byName(CLOUD_FIREWORKS_NODE_NAME)!;
    expect(node.arch).toBe('cloud');
    expect(node.endpoints.map((e) => [e.tier, e.model, e.provider, e.apiKeyEnv])).toEqual([
      ['orchestrator', FLASH, 'fireworks', KEY_ENV],
      ['worker', FLASH, 'fireworks', KEY_ENV],
    ]);
    expect(node.jobTypes).toEqual([]);
    expect(node.browser).toBeUndefined();

    await new Promise((r) => setTimeout(r, 80));
    expect(hub.registry.online().map((n) => n.name)).toEqual([CLOUD_FIREWORKS_NODE_NAME]);

    const refused = await hub.app.inject({
      method: 'POST', url: '/api/nodes/register',
      payload: { name: CLOUD_FIREWORKS_NODE_NAME, arch: 'arm64', endpoints: [] },
    });
    expect(refused.statusCode).toBe(409);
  });

  it('answers a tier end to end through the hub gateway', async () => {
    fake = await fakeFireworks();
    process.env[KEY_ENV] = 'fw-secret';
    hub = createHub({ cloud: { fireworks: { baseUrl: fake.url, workerModel: 'accounts/me/models/custom' } } });
    const res = await hub.gateway.chat('worker', [{ role: 'user', content: 'hi' }], {});
    expect(res.content).toBe('from fireworks');
    expect(fake.chatBodies[0].model).toBe('accounts/me/models/custom');
  });
});

describe('GET /api/models', () => {
  it('lists local endpoints and the curated fireworks models, cheap enabled and hard disabled', async () => {
    fake = await fakeFireworks();
    process.env[KEY_ENV] = 'fw-secret';
    hub = createHub({ cloud: { fireworks: { baseUrl: fake.url } } });
    await hub.app.inject({
      method: 'POST', url: '/api/nodes/register',
      payload: {
        name: 'spark', arch: 'arm64',
        endpoints: [{ tier: 'worker', url: 'http://127.0.0.1:1', model: 'qwen-local', maxStreams: 2 }],
      },
    });

    const res = await hub.app.inject({ method: 'GET', url: '/api/models' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      local: [{ node: 'spark', tier: 'worker', model: 'qwen-local' }],
      cloud: [{
        provider: 'fireworks',
        models: [FLASH, DEEPSEEK],
        disabled: [GLM, KIMI],
        configured: { orchestrator: FLASH, worker: FLASH },
      }],
    });
  });

  it('lists every curated model, none disabled, when the hard tier is switched on', async () => {
    fake = await fakeFireworks();
    process.env[KEY_ENV] = 'fw-secret';
    hub = createHub({ cloud: { fireworks: { baseUrl: fake.url, hardModels: true } } });

    const res = await hub.app.inject({ method: 'GET', url: '/api/models' });
    const row = res.json().cloud.find((c: { provider: string }) => c.provider === 'fireworks');
    expect(row.models).toEqual([FLASH, DEEPSEEK, GLM, KIMI]);
    expect(row.disabled).toEqual([]);
  });

  it('reports the configured anthropic ids and no cloud row at all without a cloud tier', async () => {
    const unusedClient = { messages: { stream: () => { throw new Error('unused'); } } } as unknown as AnthropicLike;
    hub = createHub({ cloud: { anthropic: { client: unusedClient } } });
    expect((await hub.app.inject({ method: 'GET', url: '/api/models' })).json().cloud).toEqual([
      { provider: 'anthropic', models: ['claude-opus-4-8', 'claude-sonnet-5'], configured: { orchestrator: 'claude-opus-4-8', worker: 'claude-sonnet-5' } },
    ]);
    await hub.stop();

    hub = createHub();
    expect((await hub.app.inject({ method: 'GET', url: '/api/models' })).json()).toEqual({ local: [], cloud: [] });
  });
});
