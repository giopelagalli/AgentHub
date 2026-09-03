import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMockOpenAI } from '@agenthub/mocks';
import Fastify, { type FastifyInstance } from 'fastify';
import { createServer } from 'node:net';
import { openDb } from '../src/db.js';
import { NodeRegistry } from '../src/node-registry.js';
import { ModelGateway } from '../src/gateway.js';

// Binds an ephemeral port and closes it immediately, yielding a URL that reliably
// rejects with ECONNREFUSED — used to simulate an unreachable endpoint.
async function closedPortUrl(): Promise<string> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

let mock: FastifyInstance; let url: string;
beforeAll(async () => {
  mock = createMockOpenAI({ tokenDelayMs: 5 });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`;
});
afterAll(async () => { await mock.close(); });

function setup(maxStreams = 2) {
  const registry = new NodeRegistry(openDb(':memory:'));
  registry.register({ name: 'spark', arch: 'arm64', endpoints: [{ tier: 'worker', url, model: 'mock-model', maxStreams }] });
  return { registry, gateway: new ModelGateway(registry) };
}

describe('ModelGateway', () => {
  it('picks null for unserved tier and errors on chat', async () => {
    const { gateway } = setup();
    expect(gateway.pick('video-gen')).toBeNull();
    await expect(gateway.chat('video-gen', [{ role: 'user', content: 'x' }])).rejects.toThrow('no capacity');
  });

  it('streams tokens and resolves the full text', async () => {
    const { gateway } = setup();
    const tokens: string[] = [];
    const full = await gateway.chat('worker', [{ role: 'user', content: 'hello world' }], (t) => tokens.push(t));
    expect(full).toBe('echo: hello world');
    expect(tokens.length).toBeGreaterThan(1);
    expect(tokens.join('')).toBe(full);
    expect(gateway.activeStreams()).toBe(0);
  });

  it('runs two sessions concurrently and enforces maxStreams', async () => {
    const { gateway } = setup(2);
    let maxActive = 0;
    const run = () => gateway.chat('worker', [{ role: 'user', content: 'a b c d e' }], () => {
      maxActive = Math.max(maxActive, gateway.activeStreams('worker'));
    });
    const [r1, r2] = await Promise.all([run(), run()]);
    expect(r1).toBe('echo: a b c d e'); expect(r2).toBe('echo: a b c d e');
    expect(maxActive).toBe(2);
    // saturate: occupy both slots, third pick returns null
    const p = Promise.all([run(), run()]);
    expect(gateway.pick('worker')).toBeNull();
    await p;
  });

  it('releases the stream slot when the caller aborts mid-stream', async () => {
    const { gateway } = setup();
    const ac = new AbortController();
    const chat = gateway.chat('worker', [{ role: 'user', content: 'a b c d e f g h' }], () => ac.abort(), ac.signal);
    await expect(chat).rejects.toThrow();

    const deadline = Date.now() + 2000;
    while (gateway.activeStreams() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(gateway.activeStreams()).toBe(0);
  });
});

describe('ModelGateway failover', () => {
  it('fails over to a healthy endpoint when the first is unreachable, marking it unhealthy', async () => {
    const registry = new NodeRegistry(openDb(':memory:'));
    const deadUrl = await closedPortUrl();
    registry.register({ name: 'dead', arch: 'arm64', endpoints: [{ tier: 'worker', url: deadUrl, model: 'mock-model', maxStreams: 2 }] });
    registry.register({ name: 'spark', arch: 'arm64', endpoints: [{ tier: 'worker', url, model: 'mock-model', maxStreams: 2 }] });
    let now = 1_000_000;
    const gateway = new ModelGateway(registry, { now: () => now });

    const full = await gateway.chat('worker', [{ role: 'user', content: 'hi' }]);
    expect(full).toBe('echo: hi');
    expect(gateway.activeStreams()).toBe(0);

    const health = gateway.health();
    const deadKey = Object.keys(health).find((k) => k.startsWith('dead|'));
    expect(deadKey).toBeDefined();
    expect(health[deadKey!]).toBe(now + 10_000);

    // dead has 0 active streams, same as spark right now — start a slow concurrent
    // session on spark so spark's active count is *higher*, and confirm pick still
    // skips dead: unhealthy status overrides a lower active count.
    const tokens: string[] = [];
    const slow = gateway.chat('worker', [{ role: 'user', content: 'a b c d e f g h' }], (t) => tokens.push(t));
    while (tokens.length === 0) await new Promise((r) => setTimeout(r, 5));
    expect(gateway.activeStreams('worker')).toBe(1);
    expect(gateway.pick('worker')?.node.name).toBe('spark');
    await slow;
  });

  it('makes the endpoint eligible again once the unhealthy window elapses', async () => {
    const registry = new NodeRegistry(openDb(':memory:'));
    const deadUrl = await closedPortUrl();
    registry.register({ name: 'dead', arch: 'arm64', endpoints: [{ tier: 'worker', url: deadUrl, model: 'mock-model', maxStreams: 2 }] });
    registry.register({ name: 'spark', arch: 'arm64', endpoints: [{ tier: 'worker', url, model: 'mock-model', maxStreams: 2 }] });
    let now = 1_000_000;
    const gateway = new ModelGateway(registry, { now: () => now });

    await gateway.chat('worker', [{ role: 'user', content: 'hi' }]); // fails over, marks dead unhealthy
    expect(gateway.pick('worker')?.node.name).toBe('spark');

    // saturate spark while dead is still unhealthy, so these can't race onto dead
    const tokensA: string[] = []; const tokensB: string[] = [];
    const a = gateway.chat('worker', [{ role: 'user', content: 'a b c d e f g h' }], (t) => tokensA.push(t));
    const b = gateway.chat('worker', [{ role: 'user', content: 'a b c d e f g h' }], (t) => tokensB.push(t));
    while (tokensA.length === 0 || tokensB.length === 0) await new Promise((r) => setTimeout(r, 5));
    expect(gateway.activeStreams('worker')).toBe(2); // spark saturated at maxStreams
    expect(gateway.pick('worker')).toBeNull(); // spark saturated, dead still unhealthy

    now += 10_001; // past the 10s unhealthy window
    expect(gateway.pick('worker')?.node.name).toBe('dead');
    await Promise.all([a, b]);
  });

  it('does not retry a 4xx response, and does not mark the endpoint unhealthy', async () => {
    const bad = Fastify();
    bad.post('/v1/chat/completions', async (_req, reply) => reply.code(400).send({ error: 'bad request' }));
    await bad.listen({ port: 0, host: '127.0.0.1' });
    const badUrl = `http://127.0.0.1:${(bad.server.address() as { port: number }).port}`;
    try {
      const registry = new NodeRegistry(openDb(':memory:'));
      registry.register({ name: 'bad', arch: 'arm64', endpoints: [{ tier: 'worker', url: badUrl, model: 'mock-model', maxStreams: 2 }] });
      const gateway = new ModelGateway(registry);

      await expect(gateway.chat('worker', [{ role: 'user', content: 'hi' }])).rejects.toThrow('endpoint error 400');
      expect(gateway.activeStreams()).toBe(0);
      expect(Object.keys(gateway.health())).toHaveLength(0);
    } finally {
      await bad.close();
    }
  });

  it('does not blacklist the sole endpoint on a 5xx, so it stays pickable', async () => {
    const bad = Fastify();
    bad.post('/v1/chat/completions', async (_req, reply) => reply.code(500).send({ error: 'boom' }));
    await bad.listen({ port: 0, host: '127.0.0.1' });
    const badUrl = `http://127.0.0.1:${(bad.server.address() as { port: number }).port}`;
    try {
      const registry = new NodeRegistry(openDb(':memory:'));
      registry.register({ name: 'solo', arch: 'arm64', endpoints: [{ tier: 'worker', url: badUrl, model: 'mock-model', maxStreams: 2 }] });
      const gateway = new ModelGateway(registry);

      await expect(gateway.chat('worker', [{ role: 'user', content: 'hi' }])).rejects.toThrow('endpoint error 500');
      expect(Object.keys(gateway.health())).toHaveLength(0);
      expect(gateway.pick('worker')?.node.name).toBe('solo');
    } finally {
      await bad.close();
    }
  });

  // Note on coverage: "if tokens were already streamed, propagate the error (no
  // double replies)" is exercised indirectly by the existing "releases the stream
  // slot when the caller aborts mid-stream" test above — it aborts after the first
  // token and the rejection propagates without a retry attempt. The mock server
  // (@agenthub/mocks createMockOpenAI) has no option to fail a connection *after*
  // it has started streaming tokens, so the `streamedAny` guard in ModelGateway.chat
  // (which suppresses failover once any token has been emitted) isn't exercised by
  // a non-abort mid-stream failure here; extending the mock with such an option was
  // out of scope for this task's file list.
});
