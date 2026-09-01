import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMockOpenAI } from '@agenthub/mocks';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../src/db.js';
import { NodeRegistry } from '../src/node-registry.js';
import { ModelGateway } from '../src/gateway.js';

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
    await new Promise((r) => setTimeout(r, 10));
    expect(gateway.pick('worker')).toBeNull();
    await p;
  });
});
