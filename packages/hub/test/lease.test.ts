import { describe, it, expect } from 'vitest';
import { LeaseManager, type LeaseStatus, type Requester } from '../src/browser/lease.js';

const owner: Requester = { kind: 'owner', id: 'owner' };
const orch: Requester = { kind: 'orchestrator', id: 'orch-1', project: 'p' };
const orch2: Requester = { kind: 'orchestrator', id: 'orch-2' };
const sub: Requester = { kind: 'subagent', id: 'sub-1' };

/** A hand-cranked clock: every lease test moves time explicitly, none of them sleeps. */
function fixture(ttlMs = 1000) {
  let now = 1_000_000;
  const leases = new LeaseManager({ ttlMs, now: () => now });
  return { leases, advance: (ms: number) => { now += ms; }, at: () => now };
}

const granted = (r: ReturnType<LeaseManager['acquire']>): string => {
  if (!('granted' in r)) throw new Error('expected a granted lease');
  return r.leaseId;
};

describe('LeaseManager', () => {
  it('grants a free browser and queues everyone else', () => {
    const { leases, at } = fixture();
    const first = leases.acquire(sub);
    expect(first).toEqual({ granted: true, leaseId: expect.any(String) });
    expect(leases.holder()).toEqual({ leaseId: granted(first), requester: sub, expiresAt: at() + 1000 });
    expect(leases.acquire(orch)).toEqual({ queued: true, position: 1 });
    expect(leases.queue()).toEqual([orch]);
  });

  it('orders the queue by priority and FIFO within a priority', () => {
    const { leases } = fixture();
    leases.acquire(sub);
    expect(leases.acquire({ kind: 'subagent', id: 'sub-2' })).toEqual({ queued: true, position: 1 });
    // An orchestrator jumps ahead of the waiting subagent...
    expect(leases.acquire(orch)).toEqual({ queued: true, position: 1 });
    // ...but not ahead of an orchestrator that was already waiting.
    expect(leases.acquire(orch2)).toEqual({ queued: true, position: 2 });
    expect(leases.queue().map((r) => r.id)).toEqual(['orch-1', 'orch-2', 'sub-2']);
  });

  it('re-acquiring is idempotent: the holder renews, a waiter re-reads its position', () => {
    const { leases, advance, at } = fixture();
    const id = granted(leases.acquire(sub));
    leases.acquire(orch);
    advance(400);
    expect(leases.acquire(sub)).toEqual({ granted: true, leaseId: id });
    expect(leases.holder()?.expiresAt).toBe(at() + 1000);
    expect(leases.acquire(orch)).toEqual({ queued: true, position: 1 });
    expect(leases.queue()).toHaveLength(1);
  });

  it('release hands the browser to the head of the queue', () => {
    const { leases } = fixture();
    const id = granted(leases.acquire(sub));
    leases.acquire({ kind: 'subagent', id: 'sub-2' });
    leases.acquire(orch);
    expect(leases.release('not-a-lease')).toBe(false);
    expect(leases.release(id)).toBe(true);
    expect(leases.holder()?.requester).toEqual(orch);
    expect(leases.queue().map((r) => r.id)).toEqual(['sub-2']);
    expect(leases.renew(id)).toBe(false);
  });

  it('an owner preempts the holder instantly and does not disturb the queue', () => {
    const { leases } = fixture();
    const victim = granted(leases.acquire(sub));
    leases.acquire(orch);
    const ownerLease = granted(leases.acquire(owner));
    expect(ownerLease).not.toBe(victim);
    expect(leases.holder()?.requester).toEqual(owner);
    // The displaced holder is gone, not re-queued ahead of the orchestrator that was already waiting.
    expect(leases.renew(victim)).toBe(false);
    expect(leases.queue()).toEqual([orch]);
    leases.release(ownerLease);
    expect(leases.holder()?.requester).toEqual(orch);
  });

  it('expires a lease past its TTL and grants the next in line; renewal prevents it', () => {
    const { leases, advance } = fixture();
    const id = granted(leases.acquire(sub));
    leases.acquire(orch);
    advance(900);
    expect(leases.renew(id)).toBe(true);
    advance(900);
    expect(leases.expire()).toEqual([]);
    expect(leases.holder()?.leaseId).toBe(id);
    // A crashed holder stops renewing — the browser must not stay wedged.
    advance(200);
    expect(leases.expire()).toEqual([id]);
    expect(leases.holder()?.requester).toEqual(orch);
    expect(leases.queue()).toEqual([]);
  });

  it('an expired holder is swept by the next acquire, not only by the sweep', () => {
    const { leases, advance } = fixture();
    leases.acquire(sub);
    advance(1001);
    expect(leases.acquire(orch)).toEqual({ granted: true, leaseId: expect.any(String) });
  });

  it('notifies listeners whenever the holder or queue changes', () => {
    const { leases, advance } = fixture();
    const seen: LeaseStatus[] = [];
    leases.onChange((s) => seen.push(s));
    const id = granted(leases.acquire(sub));
    leases.acquire(orch);
    advance(1001);
    leases.expire();
    expect(seen.map((s) => [s.holder?.requester.id ?? null, s.queue.length])).toEqual([
      ['sub-1', 0], ['sub-1', 1], ['orch-1', 0],
    ]);
    expect(leases.release(id)).toBe(false);
  });
});
