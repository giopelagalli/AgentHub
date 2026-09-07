import type { NodeInfo, Tier } from '@agenthub/shared';
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
 */
export class ResourceManager {
  private readonly held = new Map<string, number>(); // node name -> job id holding the slot
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;

  constructor(private deps: ResourceManagerDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.log = deps.log ?? ((line) => console.error(line));
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
   * Parks the node's worker serving, drains it, and switches the daemon to the `video` profile.
   * Throws (having undone the park) when the slot is taken or the profile switch fails, so the
   * caller can leave the job queued for the next attempt.
   */
  async acquire(nodeName: string, jobId: number): Promise<void> {
    if (this.held.has(nodeName)) throw new VideoSlotBusyError(nodeName);
    this.held.set(nodeName, jobId);
    this.deps.gateway.park(nodeName, PARKED_TIERS);
    try {
      await this.drain(nodeName);
      await this.switchProfile(nodeName, VIDEO_PROFILE);
    } catch (err) {
      this.deps.gateway.unpark(nodeName);
      this.held.delete(nodeName);
      throw err;
    }
  }

  /**
   * Restores serving after the job settled — completion, failure or a node that went offline. A
   * node that doesn't hold the slot (or holds it for another job) is left alone, so a late report
   * can't restore a swap that a newer job is relying on.
   */
  async release(nodeName: string, jobId?: number): Promise<void> {
    const holder = this.held.get(nodeName);
    if (holder === undefined || (jobId !== undefined && holder !== jobId)) return;
    this.held.delete(nodeName);
    try {
      await this.switchProfile(nodeName, LLM_PROFILE);
    } catch (err) {
      this.log(`[resources] restoring the llm profile on ${nodeName} failed: ${(err as Error).message}`);
    } finally {
      this.deps.gateway.unpark(nodeName);
    }
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
    if (!res.ok) throw new Error(`profile switch to ${profile} on ${nodeName} failed: ${res.status}`);
  }
}
