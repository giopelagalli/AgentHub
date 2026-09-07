import { randomUUID } from 'node:crypto';
import type { BrowserLease, BrowserRequester, BrowserRequesterKind, BrowserStatus } from '@agenthub/shared';

export type Requester = BrowserRequester;
export type Lease = BrowserLease;
export type LeaseStatus = Omit<BrowserStatus, 'node'>;

export type AcquireResult = { granted: true; leaseId: string } | { queued: true; position: number };

/** Owner beats orchestrator beats subagent; ties are FIFO. */
const RANK: Record<BrowserRequesterKind, number> = { owner: 0, orchestrator: 1, subagent: 2 };

export const DEFAULT_TTL_MS = 120_000;

/**
 * One browser, one holder. Everyone else waits in a priority FIFO — an owner never waits at all: an
 * owner acquisition preempts the current holder on the spot, whose next action then fails with
 * `lease lost`. The displaced holder is deliberately *not* pushed back onto the queue: it lost the
 * browser, and re-queueing it ahead of requesters who have been waiting would be the wrong order.
 *
 * A lease is only valid until `expiresAt`; every action renews it, so a crashed or hung holder is
 * swept away and the browser goes to whoever is next instead of wedging forever. Expiry is not the
 * sweep's alone: every read and every renew runs it first, so nobody can observe or use a lease that
 * is already overdue in the gap between sweeps.
 *
 * State is in memory on purpose: a hub restart means no agent is mid-session, so leases should not
 * survive it.
 */
export class LeaseManager {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private current: Lease | null = null;
  private waiting: Requester[] = [];
  private listeners: ((status: LeaseStatus) => void)[] = [];

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Grants the lease, or returns the caller's 1-based place in the queue. Requests are keyed by
   * `id` *and* `kind`, so an agent polling for its turn re-reads its own position instead of piling
   * up duplicate entries, and the current holder asking again just renews. The kind is part of the
   * key on purpose: the same id coming back as a different kind is a different request at a
   * different priority — an `orchestrator` re-asking as `owner` preempts rather than renews, and one
   * re-asking as `subagent` takes a fresh place in the queue instead of inheriting the old one.
   */
  acquire(r: Requester): AcquireResult {
    this.expireInternal();
    if (this.current) {
      if (same(this.current.requester, r)) {
        this.current.expiresAt = this.now() + this.ttlMs;
        return { granted: true, leaseId: this.current.leaseId };
      }
      if (r.kind !== 'owner') {
        const waiting = this.waiting.findIndex((w) => same(w, r));
        if (waiting >= 0) return { queued: true, position: waiting + 1 };
        let i = this.waiting.length;
        while (i > 0 && RANK[this.waiting[i - 1].kind] > RANK[r.kind]) i--;
        this.waiting.splice(i, 0, r);
        this.emit();
        return { queued: true, position: i + 1 };
      }
      this.current = null; // preempted by the owner
    }
    const leaseId = this.grant(r);
    this.emit();
    return { granted: true, leaseId };
  }

  /** True when `leaseId` was the live holder; the queue's head is granted the browser next. */
  release(leaseId: string): boolean {
    if (this.current?.leaseId !== leaseId) return false;
    this.current = null;
    this.grantNext();
    this.emit();
    return true;
  }

  /** Pushes the holder's expiry out by a full TTL. False once the lease is gone — preempted, expired or released. */
  renew(leaseId: string): boolean {
    this.expireInternal();
    if (this.current?.leaseId !== leaseId) return false;
    this.current.expiresAt = this.now() + this.ttlMs;
    return true;
  }

  /**
   * The live holder, or null. Expiry runs here rather than only on the sweep, so a lease that is
   * past its TTL is never handed back to a caller that is about to act on it.
   */
  holder(): Lease | null {
    this.expireInternal();
    return this.snapshot().holder;
  }

  queue(): Requester[] {
    return [...this.waiting];
  }

  status(): LeaseStatus {
    this.expireInternal();
    return this.snapshot();
  }

  /** Called by the hub sweep. Returns the ids it released, having already granted the next in line. */
  expire(now = this.now()): string[] {
    return this.expireInternal(now);
  }

  onChange(cb: (status: LeaseStatus) => void): void {
    this.listeners.push(cb);
  }

  /**
   * Emits, because every path that drops a lease — the sweep, a renew, an acquire, a plain read —
   * changes what watchers see. The emit is safe against re-entry: a listener that reads back through
   * `status()` re-enters here with either no holder and an empty queue, or a freshly granted lease,
   * so the second pass finds nothing to expire and stops.
   */
  private expireInternal(now = this.now()): string[] {
    if (!this.current || this.current.expiresAt > now) return [];
    const leaseId = this.current.leaseId;
    this.current = null;
    this.grantNext();
    this.emit();
    return [leaseId];
  }

  /** The state as it stands, without running expiry — what `emit()` hands listeners. */
  private snapshot(): LeaseStatus {
    return { holder: this.current ? { ...this.current } : null, queue: this.queue() };
  }

  private grantNext(): void {
    const next = this.waiting.shift();
    if (next) this.grant(next);
  }

  private grant(r: Requester): string {
    this.current = { leaseId: randomUUID(), requester: r, expiresAt: this.now() + this.ttlMs };
    return this.current.leaseId;
  }

  private emit(): void {
    const status = this.snapshot();
    for (const cb of this.listeners) cb(status);
  }
}

/** Requests are the same request only when both the requester id and its priority match. */
function same(a: Requester, b: Requester): boolean {
  return a.id === b.id && a.kind === b.kind;
}
