import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMockOpenAI } from '@agenthub/mocks';
import type { FastifyInstance } from 'fastify';
import { createHub, type Hub } from '../src/server.js';

let mock: FastifyInstance; let mockUrl: string; let hub: Hub;
beforeAll(async () => {
  mock = createMockOpenAI({ tokenDelayMs: 2 });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  mockUrl = `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`;
  hub = createHub();
});
afterAll(async () => { await hub.stop(); await mock.close(); });

describe('hub server', () => {
  it('registers nodes and reports state', async () => {
    const res = await hub.app.inject({
      method: 'POST', url: '/api/nodes/register',
      payload: { name: 'spark', arch: 'arm64', endpoints: [{ tier: 'worker', url: mockUrl, model: 'mock-model', maxStreams: 8 }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('spark');
    const hb = await hub.app.inject({ method: 'POST', url: '/api/nodes/spark/heartbeat' });
    expect(hb.json().ok).toBe(true);
    expect((await hub.app.inject({ method: 'POST', url: '/api/nodes/nope/heartbeat' })).statusCode).toBe(404);
    const state = (await hub.app.inject({ method: 'GET', url: '/api/state' })).json();
    expect(state.nodes).toHaveLength(1);
  });

  it('creates an agent and streams a chat via SSE', async () => {
    const created = (await hub.app.inject({
      method: 'POST', url: '/api/agents',
      payload: { name: 'helper', tier: 'worker', systemPrompt: 'You help.' },
    })).json();
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (hub.app.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/agents/${created.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'ping pong' }),
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    const events = [...body.matchAll(/data: (\{.*\})/g)].map((m) => JSON.parse(m[1]));
    const tokens = events.filter((e) => e.token).map((e) => e.token).join('');
    const done = events.find((e) => e.done);
    expect(tokens).toBe('echo: ping pong');
    expect(done.full).toBe('echo: ping pong');
  });

  it('requeues jobs from a node that goes stale between sweep timer ticks', async () => {
    const staleHub = createHub({ staleMs: 50 });
    try {
      const node = (await staleHub.app.inject({
        method: 'POST', url: '/api/nodes/register',
        payload: { name: 'stale-node', arch: 'arm64', endpoints: [{ tier: 'worker', url: mockUrl, model: 'mock-model', maxStreams: 8 }] },
      })).json();
      const job = staleHub.queue.enqueue({ type: 'shell-task', tier: 'worker', priority: 'batch', payload: {} });
      staleHub.queue.claim(['shell-task'], node.id);

      await new Promise((resolve) => setTimeout(resolve, 80));

      const state = (await staleHub.app.inject({ method: 'GET', url: '/api/state' })).json();
      const found = state.nodes.find((n: { id: number }) => n.id === node.id);
      expect(found.status).toBe('offline');

      const queued = staleHub.queue.list('queued');
      const requeued = queued.find((j) => j.id === job.id);
      expect(requeued).toBeDefined();
      expect(requeued!.nodeId).toBeNull();
    } finally {
      await staleHub.stop();
    }
  });
});
