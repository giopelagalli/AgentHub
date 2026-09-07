import type { NodeInfo, Tier } from '@agenthub/shared';
import type { Db } from './db.js';
import type { ModelGateway } from './gateway.js';
import type { NodeRegistry } from './node-registry.js';

/** The tiers a video job displaces. The orchestrator tier stays resident (PRD §4.3). */
export const PARKED_TIERS: Tier[] = ['worker'];

/** Profile names the daemon's `POST /control/profile` is driven with. */
const VIDEO_PROFILE = 'video';
const LLM_PROFILE = 'llm';

const DEFAULT_DRAIN_TIMEOUT_MS = 60_000;
const DEFAULT_DRAIN_POLL_MS = 100;
const DEFAULT_CONTROL_TIMEOUT_MS = 30_000;
const DEFAULT_COOLDOWN_MS = 30_000;

/**
 * Where held slots live across a hub restart. `held` alone is in-memory, so without this a hub that
 * dies mid-video leaves the node on its `video` profile with nothing left to hand it back.
 */
export interface SlotStore {
  load(): { node: string; jobId: number }[];
  save(node: string, jobId: number): void;
  clear(node: string): void;
}

export function sqliteSlotStore(db: Db): SlotStore {
  return {
    load: () => db.prepare(`SELECT node_name AS node, job_id AS jobId FROM video_slots`).all() as { node: string; jobId: number }[],
    save: (node, jobId) => {
      db.prepare(`INSERT INTO video_slots (node_name, job_id) VALUES (?,?)
                  ON CONFLICT(node_name) DO UPDATE SET job_id=excluded.job_id`).run(node, jobId);
    },
    clear: (node) => { db.prepare(`DELETE FROM video_slots WHERE node_name=?`).run(node); },
  };
}

/** Used by a manager built without a database — every test that doesn't care about restarts. */
const memorySlotStore = (): SlotStore => {
  const rows = new Map<string, number>();
  return {
    load: () => [...rows].map(([node, jobId]) => ({ node, jobId })),
    save: (node, jobId) => { rows.set(node, jobId); },
    clear: (node) => { rows.delete(node); },
  };
};

export interface ResourceManagerDeps {
  registry: NodeRegistry;
  gateway: ModelGateway;
  /** Bearer the daemon's control server expects; without one the swap is skipped, not forged. */
  daemonToken?: string;
  /** Swapped in tests. */
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  drainTimeoutMs?: number;
  drainPollMs?: number;
  controlTimeoutMs?: number;
  /** Persists held slots; omitted, they only live as long as the process. */
  store?: SlotStore;
  /** How long a node is passed over for video work after a failed swap. */
  cooldownMs?: number;
  now?: () => number;
}

export class VideoSlotBusyError extends Error {
  constructor(node: string) { super(`node ${node} is already running a video job`); }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The Spark exclusivity swap (PRD §4.3). A `video-gen` job needs the whole GPU, so before one runs
 * the hub parks the node's worker-tier serving — new sessions go to another node, in-flight ones are
 * drained — and tells the daemon to switch to its `video` profile; when the job settles the `llm`
 * profile comes back and the endpoints go back into rotation.
 *
 * One slot per node: `acquire` throws `VideoSlotBusyError` while a job holds it, which is what keeps
 * two video jobs off the same GPU. Restoration is best-effort by design — a control call that fails
 * on the way back is logged and the endpoints are un-parked anyway, because leaving them parked
 * would black out the tier for good.
 *
 * Every operation that touches one node runs under that node's own lock, so the offline sweep's
 * release can never interleave with an in-flight acquire and land the `llm` switch before `video`.
 */
export class ResourceManager {
  private readonly held = new Map<string, number>(); // node name -> job id holding the slot
  /** node name -> timestamp until which the node is passed over for video claims. */
  private readonly cooldowns = new Map<string, number>();
  /** Nodes already reconciled since this hub started; see `reconcile`. */
  private readonly reconciled = new Set<string>();
  /** node name -> tail of that node's serialized operations. */
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;
  private readonly store: SlotStore;
  private readonly now: () => number;

  constructor(private deps: ResourceManagerDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.log = deps.log ?? ((line) => console.error(line));
    this.store = deps.store ?? memorySlotStore();
    this.now = deps.now ?? Date.now;
  }

  /** The online node that can run a video job: `video: true` and the `video-gen` job type. */
  pickVideoNode(): NodeInfo | null {
    return this.deps.registry.online().find((n) => n.video && n.jobTypes.includes('video-gen')) ?? null;
  }

  /** True while a video job holds `nodeName`'s slot. */
  busy(nodeName: string): boolean {
    return this.held.has(nodeName);
  }

  holder(nodeName: string): number | undefined {
    return this.held.get(nodeName);
  }

  /**
   * Rebuilds the held slots a previous hub process left behind. A stored slot whose job is no longer
   * running is dropped — `reconcile` then puts the node back on its `llm` profile.
   */
  restore(isRunning: (jobId: number) => boolean): void {
    for (const { node, jobId } of this.store.load()) {
      if (!isRunning(jobId)) {
        this.store.clear(node);
        continue;
      }
      this.held.set(node, jobId);
      // A node whose last heartbeat is already stale is offline for slot purposes: its serving is
      // not up to be parked, and parking it here would black the tier out on a machine that may
      // never come back. The slot stays held (the job is still running as far as the queue knows)
      // and `reconcile` re-applies the park on the node's first heartbeat — or the sweep releases
      // the slot when it gives up on the node instead.
      if (this.deps.registry.byName(node)?.status !== 'online') {
        this.log(`[resources] ${node} holds the video slot for job ${jobId} but its heartbeat is stale; not parking until it reports in`);
        continue;
      }
      this.deps.gateway.park(node, PARKED_TIERS);
      this.log(`[resources] restored the video slot on ${node} for job ${jobId}`);
    }
  }

  /**
   * Lines a node's live serving profile up with what the hub believes about it. Called on every
   * registration and on a node's first heartbeat after the hub started, which is exactly when the
   * two can disagree: a hub that restarted mid-video would otherwise leave the node on `video`
   * forever, and one whose slot survived would be handing sessions to a GPU that is rendering.
   *
   * Never rejects — it is a best-effort background reconciliation, not part of any request.
   */
  async reconcile(nodeName: string, force = false): Promise<void> {
    if (!force && this.reconciled.has(nodeName)) return;
    await this.lock(nodeName, async () => {
      const node = this.deps.registry.byName(nodeName);
      if (!node?.control?.url || !node.profiles?.includes(VIDEO_PROFILE)) return;
      const read = await this.readProfile(node);
      // A profile that could not be read is not a reconciled node: leaving the mark off means the
      // next heartbeat tries again instead of trusting a hub-restart-shaped silence forever.
      if (read === null) return;
      this.reconciled.add(nodeName);
      const live = read.profile;
      const holder = this.held.get(nodeName);
      try {
        if (live === null) {
          // The daemon restarted and has applied no profile at all, so its serving is whatever its
          // config starts by default. Say it explicitly, either way — both switches are idempotent.
          const wanted = holder === undefined ? LLM_PROFILE : VIDEO_PROFILE;
          this.log(`[resources] ${nodeName} reports no active profile; applying ${wanted}`);
          if (wanted === VIDEO_PROFILE) this.deps.gateway.park(nodeName, PARKED_TIERS);
          await this.switchProfile(nodeName, wanted);
          if (wanted === LLM_PROFILE) this.deps.gateway.unpark(nodeName);
        } else if (live === VIDEO_PROFILE && holder === undefined) {
          this.log(`[resources] ${nodeName} was left on the video profile with no job holding it; restoring llm`);
          await this.switchProfile(nodeName, LLM_PROFILE);
          this.deps.gateway.unpark(nodeName);
        } else if (live !== VIDEO_PROFILE && holder !== undefined) {
          this.log(`[resources] ${nodeName} holds the video slot for job ${holder} but reports profile ${live}; re-applying`);
          this.deps.gateway.park(nodeName, PARKED_TIERS);
          await this.switchProfile(nodeName, VIDEO_PROFILE);
        }
      } catch (err) {
        this.log(`[resources] reconciling ${nodeName} failed: ${(err as Error).message}`);
      }
    });
  }

  /** Passes `nodeName` over for video claims for the cooldown window after a failed swap. */
  coolDown(nodeName: string): void {
    this.cooldowns.set(nodeName, this.now() + (this.deps.cooldownMs ?? DEFAULT_COOLDOWN_MS));
  }

  /** True while `coolDown`'s window is still open. */
  cooling(nodeName: string): boolean {
    const until = this.cooldowns.get(nodeName);
    if (until === undefined) return false;
    if (this.now() >= until) {
      this.cooldowns.delete(nodeName);
      return false;
    }
    return true;
  }

  /**
   * Parks the node's worker serving, drains it, and switches the daemon to the `video` profile.
   * Throws (having undone the park) when the slot is taken or the profile switch fails, so the
   * caller can leave the job queued for the next attempt.
   */
  acquire(nodeName: string, jobId: number): Promise<void> {
    return this.lock(nodeName, async () => {
      if (this.held.has(nodeName)) throw new VideoSlotBusyError(nodeName);
      this.held.set(nodeName, jobId);
      this.store.save(nodeName, jobId);
      this.deps.gateway.park(nodeName, PARKED_TIERS);
      try {
        await this.drain(nodeName);
        await this.switchProfile(nodeName, VIDEO_PROFILE);
      } catch (err) {
        this.deps.gateway.unpark(nodeName);
        this.held.delete(nodeName);
        this.store.clear(nodeName);
        throw err;
      }
    });
  }

  /**
   * Restores serving after the job settled — completion, failure or a node that went offline. A
   * node that doesn't hold the slot (or holds it for another job) is left alone, so a late report
   * can't restore a swap that a newer job is relying on.
   */
  release(nodeName: string, jobId?: number): Promise<void> {
    return this.lock(nodeName, async () => {
      const holder = this.held.get(nodeName);
      if (holder === undefined || (jobId !== undefined && holder !== jobId)) return;
      this.held.delete(nodeName);
      this.store.clear(nodeName);
      try {
        await this.switchProfile(nodeName, LLM_PROFILE);
      } catch (err) {
        this.log(`[resources] restoring the llm profile on ${nodeName} failed: ${(err as Error).message}`);
      } finally {
        this.deps.gateway.unpark(nodeName);
      }
    });
  }

  /** acquire → run → release, for callers that own the whole job (and for the tests). */
  async withVideoSlot<T>(nodeName: string, jobId: number, fn: () => Promise<T>): Promise<T> {
    await this.acquire(nodeName, jobId);
    try {
      return await fn();
    } finally {
      await this.release(nodeName, jobId);
    }
  }

  /**
   * Serializes everything that touches one node's slot. Without it the offline sweep's release could
   * run its `llm` switch while an acquire is still draining, and the node would end up parked on the
   * wrong profile with no operation left to correct it.
   */
  private lock<T>(nodeName: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(nodeName) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(nodeName, next.then(() => {}, () => {}));
    return next;
  }

  /**
   * Waits for the parked endpoints' in-flight streams to finish. Bounded: a session that outlives
   * the window is preempted rather than holding the video job hostage forever — the daemon stops
   * its serving process either way.
   */
  private async drain(nodeName: string): Promise<void> {
    const timeout = this.deps.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    const poll = this.deps.drainPollMs ?? DEFAULT_DRAIN_POLL_MS;
    const deadline = Date.now() + timeout;
    while (this.deps.gateway.activeStreamsOn(nodeName, PARKED_TIERS) > 0) {
      if (Date.now() >= deadline) {
        this.log(`[resources] ${nodeName} still had active streams after ${timeout}ms; parking anyway`);
        return;
      }
      await sleep(poll);
    }
  }

  /**
   * What the node says it is serving. The outer null is "couldn't ask" (unreachable, refused);
   * `{ profile: null }` is the node answering that it has applied no profile at all — a daemon that
   * restarted — which is a reconcilable state and not a reason to give up.
   */
  private async readProfile(node: NodeInfo): Promise<{ profile: string | null } | null> {
    try {
      const res = await this.fetchImpl(`${node.control!.url.replace(/\/$/, '')}/control/profile`, {
        headers: this.deps.daemonToken ? { authorization: `Bearer ${this.deps.daemonToken}` } : {},
        signal: AbortSignal.timeout(this.deps.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      const body = await res.json() as { profile?: unknown };
      return { profile: typeof body.profile === 'string' ? body.profile : null };
    } catch (err) {
      this.log(`[resources] reading the profile of ${node.name} failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** No `video` profile on the node means nothing to switch — the swap is then just the park. */
  private async switchProfile(nodeName: string, profile: string): Promise<void> {
    const node = this.deps.registry.byName(nodeName);
    if (!node?.control?.url || !node.profiles?.includes(profile)) return;
    const res = await this.fetchImpl(`${node.control.url.replace(/\/$/, '')}/control/profile`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.deps.daemonToken ? { authorization: `Bearer ${this.deps.daemonToken}` } : {}),
      },
      body: JSON.stringify({ name: profile }),
      signal: AbortSignal.timeout(this.deps.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS),
    });
    // Read either way: undici keeps the socket — and so the hub's own shutdown — waiting on a body
    // nobody consumed.
    await res.arrayBuffer().catch(() => {});
    if (!res.ok) throw new Error(`profile switch to ${profile} on ${nodeName} failed: ${res.status}`);
  }
}
