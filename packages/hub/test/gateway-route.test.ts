import { describe, it, expect, afterEach } from 'vitest';
import { createMockOpenAI, type MockOpenAI } from '@agenthub/mocks';
import type { NodeRegistration, Tier } from '@agenthub/shared';
import { openDb } from '../src/db.js';
import { NodeRegistry } from '../src/node-registry.js';
import { ModelGateway, routeFor, type Route } from '../src/gateway.js';

const KEY_ENV = 'FIREWORKS_API_KEY';
const TIERS: Tier[] = ['orchestrator', 'worker'];

const localNode = (name: string, url = 'http://local', maxStreams = 2): NodeRegistration => ({
  name, arch: 'arm64',
  endpoints: TIERS.map((tier) => ({ tier, url, model: `local-${tier}`, maxStreams })),
});

const cloudNode = (provider: 'anthropic' | 'fireworks', url: string): NodeRegistration => ({
  name: `cloud-${provider}`, arch: 'cloud',
  endpoints: TIERS.map((tier) => ({
    tier, provider, url, model: `${provider}-${tier}`, maxStreams: 4,
    ...(provider === 'fireworks' ? { apiKeyEnv: KEY_ENV } : {}),
  })),
});

const savedKey = process.env[KEY_ENV];
const mocks: MockOpenAI[] = [];

afterEach(async () => {
  for (const m of mocks.splice(0)) await m.close();
  if (savedKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = savedKey;
});

async function mockServer(): Promise<{ mock: MockOpenAI; url: string }> {
  const mock = createMockOpenAI();
  mocks.push(mock);
  await mock.listen({ port: 0, host: '127.0.0.1' });
  return { mock, url: `http://127.0.0.1:${(mock.server.address() as { port: number }).port}` };
}

/** A registry with one local node and both cloud nodes, all serving both tiers. */
function setup(nodes: NodeRegistration[]) {
  process.env[KEY_ENV] = 'fw-secret';
  const registry = new NodeRegistry(openDb(':memory:'));
  for (const node of nodes) registry.register(node);
  return { registry, gateway: new ModelGateway(registry) };
}

const picked = (gateway: ModelGateway, tier: Tier, route?: Route): string | null =>
  gateway.pick(tier, route)?.node.name ?? null;

describe('routeFor', () => {
  it('resolves a policy per tier, and is undefined without one', () => {
    expect(routeFor(undefined, 'orchestrator')).toBeUndefined();
    expect(routeFor({ prefer: 'local' }, 'worker')).toEqual({ prefer: 'local' });
    const policy = { prefer: 'cloud', provider: 'fireworks', orchestratorModel: 'big', workerModel: 'small' } as const;
    expect(routeFor(policy, 'orchestrator')).toEqual({ prefer: 'cloud', provider: 'fireworks', model: 'big' });
    expect(routeFor(policy, 'worker')).toEqual({ prefer: 'cloud', provider: 'fireworks', model: 'small' });
  });
});

describe('ModelGateway.pick with a route', () => {
  it('auto keeps the old ordering: local first, cloud as overflow', async () => {
    const { url } = await mockServer();
    const { gateway } = setup([localNode('spark', url, 1), cloudNode('fireworks', url)]);
    expect(picked(gateway, 'worker')).toBe('spark');
    expect(picked(gateway, 'worker', { prefer: 'auto' })).toBe('spark');

    // Saturate the one local stream: auto spills to the cloud.
    const inflight = gateway.chat('worker', [{ role: 'user', content: 'a b c' }], {});
    expect(picked(gateway, 'worker', { prefer: 'auto' })).toBe('cloud-fireworks');
    await inflight;
  });

  it('local stays local while any local endpoint serves the tier, even a saturated one', async () => {
    const { url } = await mockServer();
    const { gateway } = setup([localNode('spark', url, 1), cloudNode('fireworks', url)]);
    const inflight = gateway.chat('worker', [{ role: 'user', content: 'a b c' }], {});
    expect(picked(gateway, 'worker', { prefer: 'local' })).toBeNull();
    await inflight;
    expect(picked(gateway, 'worker', { prefer: 'local' })).toBe('spark');
  });

  it('local falls back to the cloud for a tier no local node serves at all', async () => {
    const { url } = await mockServer();
    const registry = new NodeRegistry(openDb(':memory:'));
    process.env[KEY_ENV] = 'fw-secret';
    registry.register({ name: 'spark', arch: 'arm64', endpoints: [{ tier: 'worker', url, model: 'local-worker', maxStreams: 2 }] });
    registry.register(cloudNode('fireworks', url));
    const gateway = new ModelGateway(registry);
    expect(picked(gateway, 'worker', { prefer: 'local' })).toBe('spark');
    expect(picked(gateway, 'orchestrator', { prefer: 'local' })).toBe('cloud-fireworks');
  });

  it('cloud goes out first, honours the named provider, and falls back to local', async () => {
    const { url } = await mockServer();
    const { gateway } = setup([localNode('spark', url), cloudNode('anthropic', 'anthropic://'), cloudNode('fireworks', url)]);
    // No provider named: a cloud endpoint, whichever is least busy — never the local one.
    expect(picked(gateway, 'worker', { prefer: 'cloud' })).toMatch(/^cloud-/);
    expect(picked(gateway, 'worker', { prefer: 'cloud', provider: 'fireworks' })).toBe('cloud-fireworks');
    expect(picked(gateway, 'worker', { prefer: 'cloud', provider: 'anthropic' })).toBe('cloud-anthropic');

    // Asking for a provider this hub doesn't have falls back to local before the other cloud.
    const onlyLocal = setup([localNode('spark', url), cloudNode('anthropic', 'anthropic://')]);
    expect(picked(onlyLocal.gateway, 'worker', { prefer: 'cloud', provider: 'fireworks' })).toBe('spark');
  });

  it('skips a cloud endpoint whose key is missing, even when the route asks for it', async () => {
    const { url } = await mockServer();
    const { gateway } = setup([localNode('spark', url), cloudNode('fireworks', url)]);
    delete process.env[KEY_ENV];
    expect(picked(gateway, 'worker', { prefer: 'cloud', provider: 'fireworks' })).toBe('spark');
  });
});

describe('the route model override', () => {
  it('replaces the model on a cloud endpoint of the named provider only', async () => {
    const local = await mockServer();
    const cloud = await mockServer();
    const { gateway } = setup([localNode('spark', local.url), cloudNode('fireworks', cloud.url)]);

    await gateway.chat('worker', [{ role: 'user', content: 'hi' }], {
      route: { prefer: 'cloud', provider: 'fireworks', model: 'accounts/me/models/chosen' },
    });
    expect(cloud.mock.lastRequest().model).toBe('accounts/me/models/chosen');

    // Same override, but the route sends the work local: the endpoint's own model is used.
    await gateway.chat('worker', [{ role: 'user', content: 'hi' }], {
      route: { prefer: 'local', provider: 'fireworks', model: 'accounts/me/models/chosen' },
    });
    expect(local.mock.lastRequest().model).toBe('local-worker');

    // And a cloud endpoint of a different provider keeps its own model too.
    await gateway.chat('worker', [{ role: 'user', content: 'hi' }], {
      route: { prefer: 'cloud', provider: 'anthropic', model: 'claude-opus-4-8' },
    });
    expect(local.mock.lastRequest().model).toBe('local-worker');
    expect(cloud.mock.requests).toHaveLength(1);
  });
});
