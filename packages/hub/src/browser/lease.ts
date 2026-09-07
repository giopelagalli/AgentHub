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
 * swept away by `expire()` and the browser goes to whoever is next instead of wedging forever.
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
   * `id`, so an agent polling for its turn re-reads its own position instead of piling up
   * duplicate entries, and the current holder asking again just renews.
   */
  acquire(r: Requester): AcquireResult {
    this.expireInternal();
    if (this.current) {
      if (this.current.requester.id === r.id) {
        this.current.expiresAt = this.now() + this.ttlMs;
        return { granted: true, leaseId: this.current.leaseId };
      }
      if (r.kind !== 'owner') {
        const waiting = this.waiting.findIndex((w) => w.id === r.id);
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

  holder(): Lease | null {
    return this.current ? { ...this.current } : null;
  }

  queue(): Requester[] {
    return [...this.waiting];
  }

  status(): LeaseStatus {
    return { holder: this.holder(), queue: this.queue() };
  }

  /** Called by the hub sweep. Returns the ids it released, having already granted the next in line. */
  expire(now = this.now()): string[] {
    const released = this.expireInternal(now);
    if (released.length) this.emit();
    return released;
  }

  onChange(cb: (status: LeaseStatus) => void): void {
    this.listeners.push(cb);
  }

  private expireInternal(now = this.now()): string[] {
    if (!this.current || this.current.expiresAt > now) return [];
    const leaseId = this.current.leaseId;
    this.current = null;
    this.grantNext();
    return [leaseId];
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
    const status = this.status();
    for (const cb of this.listeners) cb(status);
  }
}
