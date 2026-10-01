import { describe, it, expect } from 'vitest';
import { LeaseManager, NoSuchSlotError, type LeaseStatus, type PoolSlot, type Requester } from '../src/browser/lease.js';

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
    expect(first).toEqual({ granted: true, leaseId: expect.any(String), node: 'browser', slot: 0 });
    expect(leases.holder()).toEqual({ leaseId: granted(first), requester: sub, expiresAt: at() + 1000, node: 'browser', slot: 0, since: at() });
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
    expect(leases.acquire(sub)).toEqual({ granted: true, leaseId: id, node: 'browser', slot: 0 });
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
    expect(leases.acquire(orch)).toEqual({ granted: true, leaseId: expect.any(String), node: 'browser', slot: 0 });
  });

  it('a re-acquire at a different priority is a new request, not a renewal', () => {
    const { leases } = fixture();
    const held = granted(leases.acquire(sub));
    // Same id, higher priority: an owner preempts itself rather than renewing the subagent lease.
    const asOwner = granted(leases.acquire({ kind: 'owner', id: 'sub-1' }));
    expect(asOwner).not.toBe(held);
    expect(leases.renew(held)).toBe(false);
    // Same id at two waiting priorities queues twice — they are different requests.
    leases.acquire(orch);
    expect(leases.acquire({ kind: 'subagent', id: 'orch-1' })).toEqual({ queued: true, position: 2 });
    expect(leases.acquire(orch)).toEqual({ queued: true, position: 1 });
    expect(leases.queue().map((r) => r.kind)).toEqual(['orchestrator', 'subagent']);
  });

  it('expires lazily on read: an overdue holder is gone before anyone can act on it', () => {
    const { leases, advance } = fixture();
    const id = granted(leases.acquire(sub));
    leases.acquire(orch);
    advance(1001);
    // No sweep has run, but neither reader may hand back the dead lease.
    expect(leases.holder()?.requester).toEqual(orch);
    expect(leases.status().holder?.requester).toEqual(orch);
    expect(leases.renew(id)).toBe(false);
  });

  it('notifies listeners when a renew triggers expiry and handover', () => {
    const { leases, advance } = fixture();
    const seen: LeaseStatus[] = [];
    const id = granted(leases.acquire(sub));
    leases.acquire(orch);
    leases.onChange((s) => seen.push(s));
    advance(1001);
    // The sweep never ran; the renew is what discovers the expiry, and watchers must still hear it.
    expect(leases.renew(id)).toBe(false);
    expect(seen.map((s) => [s.holder?.requester.id ?? null, s.queue.length])).toEqual([['orch-1', 0]]);
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

  it('withdraw removes a queued request, but never the holder, and no-ops when not queued', () => {
    const { leases } = fixture();
    const id = granted(leases.acquire(sub));
    leases.acquire(orch);
    // Not queued (never asked, or already holds): false, and nothing changes.
    expect(leases.withdraw('nobody', 'orchestrator')).toBe(false);
    expect(leases.withdraw(sub.id, 'subagent')).toBe(false); // sub holds; withdraw only touches the queue
    expect(leases.holder()?.requester).toEqual(sub);
    expect(leases.withdraw(orch.id, 'orchestrator')).toBe(true);
    expect(leases.queue()).toEqual([]);
    expect(leases.withdraw(orch.id, 'orchestrator')).toBe(false); // already gone
  });
});

describe('LeaseManager pool (FR-D8)', () => {
  /** Two nodes, `a` with two slots and `b` with one; `pool` is mutable so a test can drain or drop a node. */
  function pooled() {
    let pool: PoolSlot[] = [{ node: 'a', slot: 0 }, { node: 'a', slot: 1 }, { node: 'b', slot: 0 }];
    const leases = new LeaseManager({ ttlMs: 1000, now: () => 1_000_000, slots: () => pool });
    return { leases, setPool: (p: PoolSlot[]) => { pool = p; } };
  }
  const proj = (project: string, kind: Requester['kind'] = 'orchestrator', id = `project:${project}`): Requester => ({ kind, id, project });
  const slotOf = (r: ReturnType<LeaseManager['acquire']>) => ('granted' in r ? `${r.node}#${r.slot}` : null);

  it('gives two projects different slots, spreading across nodes', () => {
    const { leases } = pooled();
    expect(slotOf(leases.acquire(proj('x')))).toBe('a#0');
    expect(slotOf(leases.acquire(proj('y')))).toBe('b#0');
    expect(slotOf(leases.acquire(proj('z')))).toBe('a#1');
  });

  it('hands a second acquire from the same project its existing lease', () => {
    const { leases } = pooled();
    const first = granted(leases.acquire(proj('x')));
    expect(granted(leases.acquire(proj('x', 'subagent', 'subagent:x:s1')))).toBe(first);
    expect(leases.status().slots.filter((s) => s.lease)).toHaveLength(1);
  });

  it('queues when every slot is held, and a release hands the freed slot to the head', () => {
    const { leases } = pooled();
    for (const p of ['x', 'y', 'z']) leases.acquire(proj(p));
    expect(leases.acquire(proj('w'))).toEqual({ queued: true, position: 1 });
    const y = leases.holderFor(proj('y'))!;
    expect(leases.release(y.leaseId)).toBe(true);
    const w = leases.holderFor(proj('w'));
    expect(w && `${w.node}#${w.slot}`).toBe(`${y.node}#${y.slot}`);
    expect(leases.queue()).toEqual([]);
  });

  it('never hands out a draining slot, but its holder keeps renewing', () => {
    const { leases, setPool } = pooled();
    const x = granted(leases.acquire(proj('x'))); // a#0
    setPool([{ node: 'a', slot: 0, draining: true }, { node: 'a', slot: 1, draining: true }, { node: 'b', slot: 0 }]);
    expect(leases.renew(x)).toBe(true);
    expect(slotOf(leases.acquire(proj('y')))).toBe('b#0');
    expect(leases.acquire(proj('z'))).toEqual({ queued: true, position: 1 });
    expect(leases.status().slots.find((s) => s.node === 'a' && s.slot === 0)).toMatchObject({ draining: true, lease: { leaseId: x } });
  });

  it('drops a lease whose node left the pool, and grants the queue when a node arrives', () => {
    const { leases, setPool } = pooled();
    setPool([{ node: 'a', slot: 0 }]);
    const x = granted(leases.acquire(proj('x')));
    expect(leases.acquire(proj('y'))).toEqual({ queued: true, position: 1 });
    setPool([{ node: 'b', slot: 0 }]); // a removed, b arrived
    expect(leases.expire()).toEqual([x]);
    expect(leases.holderFor(proj('y'))?.node).toBe('b');
  });

  it("lets the owner take control of a named slot, preempting only that slot's holder", () => {
    const { leases } = pooled();
    leases.acquire(proj('x')); // a#0
    const y = granted(leases.acquire(proj('y'))); // b#0
    expect(slotOf(leases.acquire(owner, { node: 'b', slot: 0 }))).toBe('b#0');
    expect(leases.renew(y)).toBe(false);
    expect(leases.holderFor(proj('x'))?.node).toBe('a');
    expect(() => leases.acquire(owner, { node: 'nope', slot: 0 })).toThrow(NoSuchSlotError);
  });

  it("lifts a project's queued entry to its best member's rank, and keeps it while one still waits", () => {
    const { leases, setPool } = pooled();
    setPool([{ node: 'a', slot: 0 }]);
    leases.acquire(proj('held'));
    expect(leases.acquire(proj('other'))).toEqual({ queued: true, position: 1 });
    expect(leases.acquire(proj('x', 'subagent', 'sub-x'))).toEqual({ queued: true, position: 2 });
    // x's orchestrator joins the wait: same entry, but at orchestrator rank — still behind `other`.
    expect(leases.acquire(proj('x'))).toEqual({ queued: true, position: 2 });
    expect(leases.acquire({ kind: 'subagent', id: 'loner' })).toEqual({ queued: true, position: 3 });
    expect(leases.queue().map((r) => r.id)).toEqual(['project:other', 'project:x', 'loner']);

    // The orchestrator gives up: the subagent still waits, at subagent rank again.
    expect(leases.withdraw('project:x', 'orchestrator')).toBe(true);
    expect(leases.queue().map((r) => r.id)).toEqual(['project:other', 'loner', 'sub-x']);
    expect(leases.withdraw('sub-x', 'subagent')).toBe(true);
    expect(leases.queue().map((r) => r.id)).toEqual(['project:other', 'loner']);
  });

  it('queues everyone, the owner first, while the pool is empty', () => {
    const { leases, setPool } = pooled();
    setPool([]);
    expect(leases.acquire(proj('x'))).toEqual({ queued: true, position: 1 });
    expect(leases.acquire(owner)).toEqual({ queued: true, position: 1 });
    setPool([{ node: 'a', slot: 0 }]);
    expect(leases.holder()?.requester).toEqual(owner);
  });
});
