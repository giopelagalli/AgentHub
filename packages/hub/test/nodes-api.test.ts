import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { NodeInfo } from '@agenthub/shared';
import { createHub, type Hub } from '../src/server.js';
import type { AnthropicLike } from '../src/providers/anthropic.js';

// The cloud tests below never actually call this client (they only reach the guard clause).
const unusedClient = { messages: { stream: () => { throw new Error('unused'); } } } as unknown as AnthropicLike;

let hub: Hub;
beforeEach(() => { hub = createHub({ staleMs: 60000 }); });
afterEach(async () => { await hub.stop(); });

const register = (name: string, jobTypes: string[] = ['shell-task']) => hub.app.inject({
  method: 'POST', url: '/api/nodes/register',
  payload: { name, arch: 'arm64', endpoints: [{ tier: 'worker', url: `http://127.0.0.1:81/${name}`, model: 'm', maxStreams: 4 }], jobTypes },
});

describe('drain', () => {
  it('toggles draining, persists it, and a draining node is skipped by the gateway and claim', async () => {
    await register('spark');
    expect(hub.gateway.pick('worker')?.node.name).toBe('spark');

    const on = await hub.app.inject({ method: 'POST', url: '/api/nodes/spark/drain', payload: { on: true } });
    expect(on.statusCode).toBe(200);
    expect(hub.registry.byName('spark')?.draining).toBe(true);
    expect(hub.gateway.pick('worker')).toBeNull();

    // A queued job that spark could otherwise claim is skipped, not just an empty queue.
    await hub.app.inject({
      method: 'POST', url: '/api/jobs',
      payload: { type: 'shell-task', tier: 'worker', priority: 'batch', payload: { cmd: ['echo', 'hi'] } },
    });
    const claim = await hub.app.inject({ method: 'POST', url: '/api/jobs/claim', payload: { node: 'spark', types: ['shell-task'] } });
    expect(claim.statusCode).toBe(204);

    const off = await hub.app.inject({ method: 'POST', url: '/api/nodes/spark/drain', payload: { on: false } });
    expect(off.statusCode).toBe(200);
    expect(hub.registry.byName('spark')?.draining).toBe(false);
    expect(hub.gateway.pick('worker')?.node.name).toBe('spark');

    const claimed = await hub.app.inject({ method: 'POST', url: '/api/jobs/claim', payload: { node: 'spark', types: ['shell-task'] } });
    expect(claimed.statusCode).toBe(200);
  });

  it('404s for an unknown node, 400 for a malformed body, 409 for a cloud node', async () => {
    expect((await hub.app.inject({ method: 'POST', url: '/api/nodes/ghost/drain', payload: { on: true } })).statusCode).toBe(404);

    await register('spark');
    expect((await hub.app.inject({ method: 'POST', url: '/api/nodes/spark/drain' })).statusCode).toBe(400);
    expect((await hub.app.inject({ method: 'POST', url: '/api/nodes/spark/drain', payload: { on: 'yes' } })).statusCode).toBe(400);

    const cloudHub = createHub({ cloud: { anthropic: { client: unusedClient } } });
    try {
      const res = await cloudHub.app.inject({ method: 'POST', url: '/api/nodes/cloud-anthropic/drain', payload: { on: true } });
      expect(res.statusCode).toBe(409);
    } finally {
      await cloudHub.stop();
    }
  });
});

describe('pause models', () => {
  it('takes the node out of the gateway but it still claims jobs; resume restores it', async () => {
    await register('spark');
    expect(hub.gateway.pick('worker')?.node.name).toBe('spark');

    const on = await hub.app.inject({ method: 'POST', url: '/api/nodes/spark/models', payload: { paused: true } });
    expect(on.statusCode).toBe(200);
    expect(hub.registry.byName('spark')?.modelsPaused).toBe(true);
    expect(hub.registry.byName('spark')?.draining).toBe(false);
    expect(hub.gateway.pick('worker')).toBeNull();

    await hub.app.inject({
      method: 'POST', url: '/api/jobs',
      payload: { type: 'shell-task', tier: 'worker', priority: 'batch', payload: { cmd: ['echo', 'hi'] } },
    });
    const claim = await hub.app.inject({ method: 'POST', url: '/api/jobs/claim', payload: { node: 'spark', types: ['shell-task'] } });
    expect(claim.statusCode).toBe(200);

    const off = await hub.app.inject({ method: 'POST', url: '/api/nodes/spark/models', payload: { paused: false } });
    expect(off.statusCode).toBe(200);
    expect(hub.gateway.pick('worker')?.node.name).toBe('spark');
  });

  it('404s for an unknown node, 400 for a malformed body, 409 for a cloud node', async () => {
    expect((await hub.app.inject({ method: 'POST', url: '/api/nodes/ghost/models', payload: { paused: true } })).statusCode).toBe(404);

    await register('spark');
    expect((await hub.app.inject({ method: 'POST', url: '/api/nodes/spark/models' })).statusCode).toBe(400);
    expect((await hub.app.inject({ method: 'POST', url: '/api/nodes/spark/models', payload: { paused: 'yes' } })).statusCode).toBe(400);

    const cloudHub = createHub({ cloud: { anthropic: { client: unusedClient } } });
    try {
      const res = await cloudHub.app.inject({ method: 'POST', url: '/api/nodes/cloud-anthropic/models', payload: { paused: true } });
      expect(res.statusCode).toBe(409);
    } finally {
      await cloudHub.stop();
    }
  });
});

describe('remove', () => {
  it('deletes the node, and 410s heartbeat and register for it within the lockout window', async () => {
    await register('gone');
    const del = await hub.app.inject({ method: 'DELETE', url: '/api/nodes/gone' });
    expect(del.statusCode).toBe(200);
    expect(hub.registry.byName('gone')).toBeNull();

    const heartbeat = await hub.app.inject({ method: 'POST', url: '/api/nodes/gone/heartbeat' });
    expect(heartbeat.statusCode).toBe(410);
    expect(heartbeat.json()).toEqual({ error: 'node removed' });

    const reregister = await hub.app.inject({
      method: 'POST', url: '/api/nodes/register', payload: { name: 'gone', arch: 'arm64', endpoints: [] },
    });
    expect(reregister.statusCode).toBe(410);
    expect(reregister.json()).toEqual({ error: 'node removed' });
  });

  it('404s for an unknown node, 409 for a cloud node', async () => {
    expect((await hub.app.inject({ method: 'DELETE', url: '/api/nodes/ghost' })).statusCode).toBe(404);

    const cloudHub = createHub({ cloud: { anthropic: { client: unusedClient } } });
    try {
      const res = await cloudHub.app.inject({ method: 'DELETE', url: '/api/nodes/cloud-anthropic' });
      expect(res.statusCode).toBe(409);
      expect(cloudHub.registry.byName('cloud-anthropic')).not.toBeNull();
    } finally {
      await cloudHub.stop();
    }
  });

  it('an unrelated node registers and heartbeats normally while another name is locked out', async () => {
    await register('gone');
    await hub.app.inject({ method: 'DELETE', url: '/api/nodes/gone' });

    const res = await register('still-fine');
    expect(res.statusCode).toBe(200);
    expect((await hub.app.inject({ method: 'POST', url: '/api/nodes/still-fine/heartbeat' })).statusCode).toBe(200);
  });
});

describe('register', () => {
  it('400s a malformed node name', async () => {
    const res = await hub.app.inject({
      method: 'POST', url: '/api/nodes/register',
      payload: { name: 'a/b', arch: 'arm64', endpoints: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid node name' });
  });
});

describe('ownership', () => {
  it('gives a node that only registers the admin as its owner, and shows no credential', async () => {
    await register('spark');
    const listed = (await hub.app.inject({ method: 'GET', url: '/api/nodes' })).json() as NodeInfo[];
    expect(listed).toHaveLength(1);
    expect(listed[0]!.owner).toBe('admin');
    // It traded no enrollment token, so it has neither an enrolment time nor a token of its own.
    expect(listed[0]!.enrolledAt).toBeUndefined();
    expect(listed[0]).not.toHaveProperty('tokenHash');
    expect(hub.db.prepare(`SELECT token_hash FROM nodes WHERE name='spark'`).get()).toEqual({ token_hash: null });
  });
});
