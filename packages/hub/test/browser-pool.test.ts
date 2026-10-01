import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { FakeDriver } from '../../node-daemon/src/browser/driver.js';
import { createBrowserServer } from '../../node-daemon/src/browser/server.js';
import { createHub, type Hub } from '../src/server.js';
import { openDb } from '../src/db.js';
import { NodeRegistry } from '../src/node-registry.js';
import { LeaseManager } from '../src/browser/lease.js';
import { poolSlots } from '../src/browser/proxy.js';

/** FR-D8 through the hub's routes: one daemon browser server with two slots, each its own FakeDriver. */
let slots: FakeDriver[];
let upstream: FastifyInstance;
let hub: Hub;
let base: string;
let recordings: string;

const post = async (path: string, body: unknown) =>
  (await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const acquire = async (project: string) =>
  (await post('/api/browser/lease', { kind: 'orchestrator', id: `project:${project}`, project })).json();

beforeEach(async () => {
  slots = [new FakeDriver(), new FakeDriver()];
  upstream = createBrowserServer(slots);
  await upstream.listen({ port: 0, host: '127.0.0.1' });
  const upstreamUrl = `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}`;

  recordings = mkdtempSync(join(tmpdir(), 'ah-pool-'));
  hub = createHub({ browser: { recordingsRoot: recordings } });
  await hub.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(hub.app.server.address() as { port: number }).port}`;
  await post('/api/nodes/register', { name: 'mini', arch: 'arm64', endpoints: [], jobTypes: [], browser: { url: upstreamUrl, slots: 2 } });
});

afterEach(async () => {
  await hub.stop();
  await upstream.close();
  rmSync(recordings, { recursive: true, force: true });
});

describe('browser pool routes', () => {
  it('gives two projects different slots, and each drives its own context', async () => {
    const a = await acquire('alpha');
    const b = await acquire('beta');
    expect([a, b].map((r) => `${r.node}#${r.slot}`)).toEqual(['mini#0', 'mini#1']);

    await post('/api/browser/act', { leaseId: a.leaseId, op: 'navigate', args: { url: 'https://a.test/' } });
    await post('/api/browser/act', { leaseId: b.leaseId, op: 'navigate', args: { url: 'https://b.test/' } });
    expect(slots[0].calls.find((c) => c.op === 'navigate')?.args).toEqual(['https://a.test/']);
    expect(slots[1].calls.find((c) => c.op === 'navigate')?.args).toEqual(['https://b.test/']);
  });

  it('hands the same project its existing lease, and lists every slot in the status', async () => {
    const first = await acquire('alpha');
    const again = await (await post('/api/browser/lease', { kind: 'subagent', id: 'subagent:alpha:s1', project: 'alpha' })).json();
    expect(again.leaseId).toBe(first.leaseId);
    const status = await (await fetch(`${base}/api/browser`)).json();
    expect(status.slots.map((s: { node: string; slot: number; lease: { leaseId: string } | null }) => [s.node, s.slot, s.lease?.leaseId ?? null]))
      .toEqual([['mini', 0, first.leaseId], ['mini', 1, null]]);
  });

  it('queues a third project when full, and a release frees its slot for it', async () => {
    const a = await acquire('alpha');
    await acquire('beta');
    expect(await acquire('gamma')).toEqual({ queued: true, position: 1 });
    expect((await fetch(`${base}/api/browser/lease/${a.leaseId}`, { method: 'DELETE' })).status).toBe(200);
    expect(await acquire('gamma')).toMatchObject({ granted: true, node: 'mini', slot: 0 });
  });

  it('stops handing out a draining node’s slots while its holder carries on', async () => {
    const a = await acquire('alpha');
    hub.registry.setDraining('mini', true);
    expect(await acquire('beta')).toEqual({ queued: true, position: 1 });
    expect((await post('/api/browser/act', { leaseId: a.leaseId, op: 'read' })).status).toBe(200);
  });

  it("lets the owner take control of one slot, leaving the other slot's holder alone", async () => {
    const a = await acquire('alpha');
    const b = await acquire('beta');
    const taken = await (await post('/api/browser/preempt', { id: 'owner', node: 'mini', slot: 1 })).json();
    expect(taken).toMatchObject({ granted: true, node: 'mini', slot: 1 });
    expect((await post('/api/browser/act', { leaseId: b.leaseId, op: 'read' })).status).toBe(409);
    expect((await post('/api/browser/act', { leaseId: a.leaseId, op: 'read' })).status).toBe(200);
    expect((await post('/api/browser/preempt', { id: 'owner', node: 'mini', slot: 5 })).status).toBe(404);
    expect((await post('/api/browser/preempt', { id: 'owner', node: 'mini', slot: -1 })).status).toBe(400);
  });

  it('resets a slot before its first action for a different project, not for the same one', async () => {
    const a = await acquire('alpha');
    await post('/api/browser/act', { leaseId: a.leaseId, op: 'navigate', args: { url: 'https://a.test/' } });
    await fetch(`${base}/api/browser/lease/${a.leaseId}`, { method: 'DELETE' });

    const again = await acquire('alpha'); // alpha back on its own slot: nothing to reset
    expect(again.slot).toBe(0);
    await post('/api/browser/act', { leaseId: again.leaseId, op: 'read' });
    expect(slots[0].calls.map((c) => c.op)).not.toContain('reset');
    await fetch(`${base}/api/browser/lease/${again.leaseId}`, { method: 'DELETE' });

    const b = await acquire('beta');
    expect(b.slot).toBe(0);
    const read = await (await post('/api/browser/act', { leaseId: b.leaseId, op: 'read' })).json();
    expect(read.state.url).toBe('about:blank');
    const ops = slots[0].calls.map((c) => c.op);
    expect(ops.lastIndexOf('reset')).toBe(ops.lastIndexOf('read') - 1);
    expect(ops.filter((op) => op === 'reset')).toHaveLength(1);
  });

  it('keeps the single-browser path: no project, no slot, slot 0', async () => {
    const res = await (await post('/api/browser/lease', { kind: 'subagent', id: 'sub-1' })).json();
    expect(res).toMatchObject({ granted: true, node: 'mini', slot: 0 });
    const owner = await (await post('/api/browser/preempt', { id: 'owner' })).json();
    expect(owner).toMatchObject({ granted: true, node: 'mini', slot: 1 });
    const status = await (await fetch(`${base}/api/browser`)).json();
    expect(status.holder.leaseId).toBe(res.leaseId);
    expect(status.node).toBe('mini');
  });
});

describe('browser pool and node liveness', () => {
  it('keeps a lease through a heartbeat gap, hides the offline node’s free slots, and drops it on remove', () => {
    const registry = new NodeRegistry(openDb(':memory:'));
    const mini = { name: 'mini', arch: 'arm64', endpoints: [], jobTypes: [], browser: { url: 'http://127.0.0.1:9', slots: 2 } };
    registry.register(mini);
    const leases = new LeaseManager({ slots: () => poolSlots(registry) });
    const granted = leases.acquire({ kind: 'orchestrator', id: 'project:alpha', project: 'alpha' });
    if (!('granted' in granted)) throw new Error('expected a grant');

    registry.register(mini, Date.now() - 60_000); // heartbeat long stale: offline
    expect(leases.renew(granted.leaseId)).toBe(true);
    expect(leases.status().slots).toEqual([{ node: 'mini', slot: 0, lease: expect.objectContaining({ leaseId: granted.leaseId }), draining: true, offline: true }]);
    expect(leases.acquire({ kind: 'orchestrator', id: 'project:beta', project: 'beta' })).toEqual({ queued: true, position: 1 });

    registry.remove('mini');
    expect(leases.renew(granted.leaseId)).toBe(false);
  });
});
