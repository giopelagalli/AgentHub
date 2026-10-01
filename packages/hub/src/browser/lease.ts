import { randomUUID } from 'node:crypto';
import type { BrowserLease, BrowserRequester, BrowserRequesterKind, BrowserSlotStatus, BrowserStatus } from '@agenthub/shared';

export type Requester = BrowserRequester;
export type Lease = BrowserLease;
export type LeaseStatus = Omit<BrowserStatus, 'node'> & { slots: BrowserSlotStatus[] };

/** One session in the pool: a browser node and a context on it. */
export interface SlotRef { node: string; slot: number }
/** A slot as the pool provider reports it; a draining slot keeps its lease but takes no new one. */
export interface PoolSlot extends SlotRef { draining?: boolean }

export type AcquireResult = { granted: true; leaseId: string; node: string; slot: number } | { queued: true; position: number };

/** Owner beats orchestrator beats subagent; ties are FIFO. */
const RANK: Record<BrowserRequesterKind, number> = { owner: 0, orchestrator: 1, subagent: 2 };

export const DEFAULT_TTL_MS = 120_000;

/** The pool when nobody supplies one: a single slot, which is the pre-pool, one-browser behaviour. */
const SINGLE_SLOT: PoolSlot[] = [{ node: 'browser', slot: 0 }];

export class NoSuchSlotError extends Error {
  constructor(target: SlotRef) {
    super(`no browser slot ${target.node}#${target.slot}`);
    this.name = 'NoSuchSlotError';
  }
}

/**
 * The browser pool's leases (FR-D8). Every slot the provider reports — `(node, slot)` across the
 * browser nodes — holds at most one lease; a project holds at most one slot, so a second acquire by
 * anyone in the same project gets the project's existing lease back. When every open slot is held,
 * requesters wait in a priority FIFO and the next free slot goes to its head. An owner never waits
 * while there is a slot to take: "Take control" names a slot and preempts its holder on the spot,
 * whose next action then fails with `lease lost` — the displaced holder is deliberately *not*
 * re-queued ahead of requesters who have been waiting.
 *
 * A lease is only valid until `expiresAt`; every action renews it, so a crashed or hung holder is
 * swept away and the slot goes to whoever is next instead of wedging forever. A lease on a slot that
 * left the pool (its node went offline, was removed, or re-registered with fewer slots) is dropped
 * the same way. A draining slot is still in the pool — its holder finishes — but is never handed out.
 * Expiry is not the sweep's alone: every read and every renew runs it first, so nobody can observe
 * or use a lease that is already overdue in the gap between sweeps.
 *
 * State is in memory on purpose: a hub restart means no agent is mid-session, so leases should not
 * survive it.
 */
export class LeaseManager {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly pool: () => PoolSlot[];
  /** Live leases by slot key. */
  private held = new Map<string, Lease>();
  private waiting: Waiter[] = [];
  private listeners: ((status: LeaseStatus) => void)[] = [];

  constructor(opts: { ttlMs?: number; now?: () => number; slots?: () => PoolSlot[] } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.pool = opts.slots ?? (() => SINGLE_SLOT);
  }

  /**
   * Grants a slot, or returns the caller's 1-based place in the queue. A requester already holding a
   * lease — itself, or anyone in its project — gets that lease back, renewed; one already queued
   * re-reads its position instead of piling up duplicate entries. Without a project, requests are
   * keyed by `id` *and* `kind`: the same id coming back as a different kind is a different request at
   * a different priority.
   *
   * An owner names a `target` slot to take it, preempting its holder; without one it renews its own
   * lease, takes a free slot, or preempts the first open slot. Throws `NoSuchSlotError` for a target
   * that is not in the pool.
   */
  acquire(r: Requester, target?: SlotRef): AcquireResult {
    this.expireInternal();
    const slots = this.pool();
    if (r.kind === 'owner' && target) {
      const slot = slots.find((s) => s.node === target.node && s.slot === target.slot);
      if (!slot) throw new NoSuchSlotError(target);
      const current = this.held.get(key(slot));
      if (current && same(current.requester, r)) return this.renewed(current);
      return this.granted(r, slot);
    }
    const own = this.leaseFor(r);
    if (own) return this.renewed(own);
    const waiting = this.waiting.findIndex((w) => same(w.requester, r));
    if (waiting >= 0) return { queued: true, position: this.fold(waiting, r) };

    const free = this.freeSlot(slots);
    if (free) return this.granted(r, free);
    const open = slots.find((s) => !s.draining);
    if (r.kind === 'owner' && open) return this.granted(r, open); // preempts the first open slot

    const position = this.enqueue({ requester: r, members: [r] });
    this.emit();
    return { queued: true, position };
  }

  /** True when `leaseId` was live; the queue's head is granted the freed slot next. */
  release(leaseId: string): boolean {
    const lease = this.byId(leaseId);
    if (!lease) return false;
    this.held.delete(key(lease));
    this.pump();
    this.emit();
    return true;
  }

  /**
   * Removes a *queued* (not held) request, for a caller that gives up waiting before ever being
   * granted a slot — an aborted poll, a cancelled turn. A project's entry stays while anyone else in
   * the project still waits on it, at the best rank of those left. False if `id`/`kind` isn't in the
   * queue (already granted, already withdrawn, or never queued).
   */
  withdraw(id: string, kind: BrowserRequesterKind): boolean {
    const isIt = (m: Requester): boolean => m.id === id && m.kind === kind;
    const i = this.waiting.findIndex((w) => w.members.some(isIt));
    if (i < 0) return false;
    const entry = this.waiting[i];
    entry.members = entry.members.filter((m) => !isIt(m));
    if (entry.members.length === 0) {
      this.waiting.splice(i, 1);
    } else if (isIt(entry.requester)) {
      // The one it was queued as left: it now waits as the best of the rest, at that rank.
      this.waiting.splice(i, 1);
      entry.requester = entry.members.reduce((best, m) => (RANK[m.kind] < RANK[best.kind] ? m : best));
      this.enqueue(entry);
    }
    this.emit();
    return true;
  }

  /** Pushes the lease's expiry out by a full TTL. False once it is gone — preempted, expired or released. */
  renew(leaseId: string): boolean {
    this.expireInternal();
    const lease = this.byId(leaseId);
    if (!lease) return false;
    lease.expiresAt = this.now() + this.ttlMs;
    return true;
  }

  /** The live lease with this id, or null. */
  get(leaseId: string): Lease | null {
    this.expireInternal();
    const lease = this.byId(leaseId);
    return lease ? { ...lease } : null;
  }

  /** The live lease this requester holds — itself or through its project — or null. */
  holderFor(r: Requester): Lease | null {
    this.expireInternal();
    const lease = this.leaseFor(r);
    return lease ? { ...lease } : null;
  }

  /**
   * The first live lease in pool order, or null — the one-browser view clients from before the pool
   * read. Expiry runs here rather than only on the sweep, so a lease that is past its TTL is never
   * handed back to a caller that is about to act on it.
   */
  holder(): Lease | null {
    this.expireInternal();
    return this.snapshot().holder;
  }

  queue(): Requester[] {
    return this.waiting.map((w) => w.requester);
  }

  status(): LeaseStatus {
    this.expireInternal();
    return this.snapshot();
  }

  /**
   * Called by the hub sweep. Returns the ids it dropped (expired, or their slot left the pool), having
   * already granted freed — or newly arrived — slots to the queue.
   */
  expire(now = this.now()): string[] {
    return this.expireInternal(now);
  }

  onChange(cb: (status: LeaseStatus) => void): void {
    this.listeners.push(cb);
  }

  /**
   * Emits only on a change, because every path that drops or grants a lease — the sweep, a renew, an
   * acquire, a plain read — changes what watchers see. The emit is safe against re-entry: a listener
   * that reads back through `status()` re-enters here and finds nothing left to drop or grant.
   */
  private expireInternal(now = this.now()): string[] {
    const inPool = new Set(this.pool().map(key));
    const dropped: string[] = [];
    for (const [k, lease] of this.held) {
      if (lease.expiresAt > now && inPool.has(k)) continue;
      this.held.delete(k);
      dropped.push(lease.leaseId);
    }
    const granted = this.pump();
    if (dropped.length || granted) this.emit();
    return dropped;
  }

  /** Hands free open slots to the head of the queue. True when it granted anything. */
  private pump(): boolean {
    let granted = false;
    const slots = this.pool();
    while (this.waiting.length) {
      const free = this.freeSlot(slots);
      if (!free) break;
      this.grant(this.waiting.shift()!.requester, free);
      granted = true;
    }
    return granted;
  }

  /**
   * Adds `r` to the queued entry its project already has. A higher-priority member lifts the entry
   * to its rank — an orchestrator joining its subagent's wait doesn't wait at subagent priority.
   * Returns the entry's 1-based position.
   */
  private fold(i: number, r: Requester): number {
    const entry = this.waiting[i];
    if (!entry.members.some((m) => m.id === r.id && m.kind === r.kind)) entry.members.push(r);
    if (RANK[r.kind] >= RANK[entry.requester.kind]) return i + 1;
    this.waiting.splice(i, 1);
    entry.requester = r;
    const position = this.enqueue(entry);
    this.emit();
    return position;
  }

  /** Inserts behind everyone of the same or better rank; returns the 1-based position. */
  private enqueue(entry: Waiter): number {
    let i = this.waiting.length;
    while (i > 0 && RANK[this.waiting[i - 1].requester.kind] > RANK[entry.requester.kind]) i--;
    this.waiting.splice(i, 0, entry);
    return i + 1;
  }

  /** A free, non-draining slot on the least-loaded node (ties in pool order), or null. */
  private freeSlot(slots: PoolSlot[]): PoolSlot | null {
    const load = new Map<string, number>();
    for (const lease of this.held.values()) load.set(lease.node, (load.get(lease.node) ?? 0) + 1);
    let best: PoolSlot | null = null;
    for (const s of slots) {
      if (s.draining || this.held.has(key(s))) continue;
      if (!best || (load.get(s.node) ?? 0) < (load.get(best.node) ?? 0)) best = s;
    }
    return best;
  }

  private leaseFor(r: Requester): Lease | null {
    for (const lease of this.held.values()) if (same(lease.requester, r)) return lease;
    return null;
  }

  private byId(leaseId: string): Lease | null {
    for (const lease of this.held.values()) if (lease.leaseId === leaseId) return lease;
    return null;
  }

  private renewed(lease: Lease): AcquireResult {
    lease.expiresAt = this.now() + this.ttlMs;
    return { granted: true, leaseId: lease.leaseId, node: lease.node, slot: lease.slot };
  }

  /** Grants `slot` to `r` — dropping whoever held it — and emits. */
  private granted(r: Requester, slot: SlotRef): AcquireResult {
    const lease = this.grant(r, slot);
    this.emit();
    return { granted: true, leaseId: lease.leaseId, node: lease.node, slot: lease.slot };
  }

  private grant(r: Requester, slot: SlotRef): Lease {
    const now = this.now();
    const lease: Lease = { leaseId: randomUUID(), requester: r, expiresAt: now + this.ttlMs, node: slot.node, slot: slot.slot, since: now };
    this.held.set(key(slot), lease);
    return lease;
  }

  /** The state as it stands, without running expiry — what `emit()` hands listeners. */
  private snapshot(): LeaseStatus {
    const slots = this.pool().map((s): BrowserSlotStatus => {
      const lease = this.held.get(key(s));
      return { node: s.node, slot: s.slot, lease: lease ? { ...lease } : null, ...(s.draining ? { draining: true } : {}) };
    });
    const first = slots.find((s) => s.lease)?.lease ?? null;
    return { holder: first, queue: this.queue(), slots };
  }

  private emit(): void {
    const status = this.snapshot();
    for (const cb of this.listeners) cb(status);
  }
}

/**
 * One place in the queue. `requester` is who it is queued as — the best-ranked of `members`, and
 * who is granted the slot; `members` are everyone in its project who asked while it waited.
 */
interface Waiter { requester: Requester; members: Requester[] }

function key(s: SlotRef): string {
  return `${s.node}#${s.slot}`;
}

/**
 * Whether two requests are the same holder. Within a project they are: the project holds one slot,
 * whoever in it asks. The owner is never folded into a project, and requests without a project are
 * the same request only when both the requester id and its priority match.
 */
function same(a: Requester, b: Requester): boolean {
  if (a.kind !== 'owner' && b.kind !== 'owner' && a.project && b.project) return a.project === b.project;
  return a.id === b.id && a.kind === b.kind;
}
