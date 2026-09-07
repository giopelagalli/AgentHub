import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { NodeRegistration } from '@agenthub/shared';
import { openDb, type Db } from '../src/db.js';
import { NodeRegistry } from '../src/node-registry.js';
import { ModelGateway } from '../src/gateway.js';
import { ResourceManager, VideoSlotBusyError } from '../src/resources.js';

const TOKEN = 'daemon-secret';

interface FakeControl {
  app: FastifyInstance;
  url: string;
  /** Every profile name the hub asked for, in order. */
  calls: string[];
  auth: (string | undefined)[];
  fail: boolean;
}

let control: FakeControl | undefined;

async function startControl(): Promise<FakeControl> {
  const app = Fastify();
  const state: FakeControl = { app, url: '', calls: [], auth: [], fail: false };
  app.post('/control/profile', async (req, reply) => {
    const { name } = req.body as { name: string };
    state.auth.push(req.headers.authorization);
    if (state.fail) return reply.code(502).send({ error: 'switch failed' });
    state.calls.push(name);
    return { profile: name, entries: [] };
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  state.url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  control = state;
  return state;
}

afterEach(async () => {
  await control?.app.close();
  control = undefined;
});

const registration = (url: string): NodeRegistration => ({
  name: 'spark', arch: 'arm64',
  endpoints: [
    { tier: 'worker', url: 'http://127.0.0.1:8001', model: 'qwen-worker', maxStreams: 4 },
    { tier: 'orchestrator', url: 'http://127.0.0.1:8002', model: 'qwen-orch', maxStreams: 2 },
  ],
  jobTypes: ['video-gen'], video: true, profiles: ['llm', 'video'], control: { url },
});

function setup(url: string, extra: Partial<ConstructorParameters<typeof ResourceManager>[0]> = {}) {
  const db: Db = openDb(':memory:');
  const registry = new NodeRegistry(db, { staleMs: 60_000 });
  registry.register(registration(url));
  const gateway = new ModelGateway(registry);
  const manager = new ResourceManager({ registry, gateway, daemonToken: TOKEN, drainPollMs: 5, log: () => {}, ...extra });
  return { db, registry, gateway, manager };
}

describe('ResourceManager', () => {
  it('parks worker serving, switches to the video profile, and restores both on success', async () => {
    const fake = await startControl();
    const { gateway, manager } = setup(fake.url);

    const parkedDuringJob = await manager.withVideoSlot('spark', 1, async () => {
      expect(fake.calls).toEqual(['video']);
      expect(gateway.pick('worker')).toBeNull(); // parked: nothing routes here
      expect(gateway.pick('orchestrator')).not.toBeNull(); // orchestrator tier stays resident
      return gateway.parkedKeys();
    });

    expect(parkedDuringJob).toEqual(['spark|worker|http://127.0.0.1:8001']);
    expect(fake.calls).toEqual(['video', 'llm']);
    expect(fake.auth).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
    expect(gateway.parkedKeys()).toEqual([]);
    expect(gateway.pick('worker')).not.toBeNull();
    expect(manager.busy('spark')).toBe(false);
  });

  it('restores the profile and un-parks when the job itself fails', async () => {
    const fake = await startControl();
    const { gateway, manager } = setup(fake.url);

    await expect(manager.withVideoSlot('spark', 2, async () => { throw new Error('comfy exploded'); }))
      .rejects.toThrow('comfy exploded');

    expect(fake.calls).toEqual(['video', 'llm']);
    expect(gateway.parkedKeys()).toEqual([]);
    expect(manager.busy('spark')).toBe(false);
  });

  it('un-parks and frees the slot when the profile switch itself fails', async () => {
    const fake = await startControl();
    fake.fail = true;
    const { gateway, manager } = setup(fake.url);

    await expect(manager.acquire('spark', 3)).rejects.toThrow(/profile switch to video/);
    expect(gateway.parkedKeys()).toEqual([]);
    expect(manager.busy('spark')).toBe(false);
    expect(gateway.pick('worker')).not.toBeNull();
  });

  it('allows only one video job per node at a time', async () => {
    const fake = await startControl();
    const { manager } = setup(fake.url);

    await manager.acquire('spark', 4);
    await expect(manager.acquire('spark', 5)).rejects.toBeInstanceOf(VideoSlotBusyError);
    expect(manager.holder('spark')).toBe(4);

    await manager.release('spark', 5); // a stale report for another job must not restore serving
    expect(manager.busy('spark')).toBe(true);
    await manager.release('spark', 4);
    expect(manager.busy('spark')).toBe(false);
    expect(fake.calls).toEqual(['video', 'llm']);
  });

  it('drains in-flight worker streams before switching the profile', async () => {
    const fake = await startControl();
    let streams = 2;
    const { manager, gateway } = setup(fake.url);
    // Stand in for the gateway's own counter: the manager only ever asks how many are left.
    const activeStreamsOn = () => streams;
    Object.assign(gateway, { activeStreamsOn });

    const acquired = manager.acquire('spark', 6);
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.calls).toEqual([]); // still draining, so nothing has been switched yet

    streams = 0;
    await acquired;
    expect(fake.calls).toEqual(['video']);
  });

  it('proceeds once the drain window expires rather than blocking forever', async () => {
    const fake = await startControl();
    const { manager, gateway } = setup(fake.url, { drainTimeoutMs: 30 });
    Object.assign(gateway, { activeStreamsOn: () => 1 });

    await manager.acquire('spark', 7);
    expect(fake.calls).toEqual(['video']);
  });

  it('picks the online node that advertises the video capability', async () => {
    const fake = await startControl();
    const { registry, manager } = setup(fake.url);
    registry.register({ name: 'mb', arch: 'arm64', endpoints: [], jobTypes: ['video-gen'] });
    expect(manager.pickVideoNode()?.name).toBe('spark');
  });

  it('parks without a control call on a node that has no video profile', async () => {
    const fake = await startControl();
    const { registry, gateway, manager } = setup(fake.url);
    registry.register({ ...registration(fake.url), profiles: [] });

    await manager.withVideoSlot('spark', 8, async () => {
      expect(gateway.parkedKeys()).toHaveLength(1);
    });
    expect(fake.calls).toEqual([]);
    expect(gateway.parkedKeys()).toEqual([]);
  });
});
