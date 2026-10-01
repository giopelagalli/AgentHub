import { join } from 'node:path';
import type { NodeRegistry } from '../node-registry.js';
import type { LeaseManager, PoolSlot } from './lease.js';
import type { Recorder } from './recorder.js';

export type BrowserOp = 'navigate' | 'read' | 'click' | 'type' | 'screenshot';
export const BROWSER_OPS: BrowserOp[] = ['navigate', 'read', 'click', 'type', 'screenshot'];

export interface BrowserAction { op: BrowserOp; args?: Record<string, unknown> }

export interface BrowserFrame { nodeName: string; slot: number; leaseId: string | null; jpegBase64: string; at: number }

/** Matches the daemon's own cap (`MAX_BROWSER_SLOTS`), so a misbehaving registration can't flood the pool. */
const MAX_SLOTS = 8;

/**
 * The browser pool as the registry has it: every slot of every registered node advertising a
 * browser. A draining node's slots are marked so the lease manager finishes them but hands out
 * none; so are an offline node's (heartbeat gone stale), marked `offline` too, so a heartbeat gap
 * doesn't cost a holder its lease — it keeps it until its TTL or a failed renew. A node registered
 * before the pool (no `slots`) is one slot. A removed node is absent, and so are its leases.
 */
export function poolSlots(registry: NodeRegistry): PoolSlot[] {
  const online = new Set(registry.online().map((n) => n.name));
  const slots: PoolSlot[] = [];
  for (const node of registry.all()) {
    if (!node.browser?.url) continue;
    const offline = !online.has(node.name);
    const count = Math.min(MAX_SLOTS, Math.max(1, Math.floor(node.browser.slots ?? 1)));
    for (let slot = 0; slot < count; slot++) {
      slots.push({ node: node.name, slot, ...(node.draining || offline ? { draining: true } : {}), ...(offline ? { offline: true } : {}) });
    }
  }
  return slots;
}

export interface Screencast {
  start(): void;
  stop(): void;
  onFrame(cb: (frame: BrowserFrame) => void): void;
}

/** Carries the status the hub route should answer with — 409 lease lost, 503 no node, or the daemon's own. */
export class BrowserError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'BrowserError';
  }
}

export interface BrowserProxyDeps {
  registry: NodeRegistry;
  leases: LeaseManager;
  recorder: Recorder;
  fetch?: typeof fetch;
  now?: () => number;
  /** Phase-6 daemon token, sent verbatim as `authorization` once there is one. */
  authHeader?: string;
  /** Overridable in tests so a black-holed node doesn't need a real 15s to prove `act()` times out. */
  actionTimeoutMs?: number;
  /** Overridable in tests; kept short so a stuck node can't pin the screencast's `inFlight` flag. */
  screencastTimeoutMs?: number;
}

/** ≤ 2 fps, per the screencast budget. */
const MIN_FRAME_INTERVAL_MS = 500;

/** Bounds one `act()` call (a navigate/click/type/read, or the screenshot it takes for the recording). */
const DEFAULT_ACTION_TIMEOUT_MS = 15_000;
/** Bounds one screencast poll frame — short, so a black-holed node can't wedge the live view. */
const DEFAULT_SCREENCAST_TIMEOUT_MS = 5_000;

/**
 * The hub's side of the browser pool: it resolves the lease's slot to its node and forwards actions
 * to that node's browser server, `?slot=N` — but only for a live lease, so the daemon can stay
 * lease-unaware behind loopback. Every action renews the lease and appends a frame
 * to the recording, which is what makes an abandoned session expire and a finished one replayable.
 */
export class BrowserProxy {
  private readonly registry: NodeRegistry;
  private readonly leases: LeaseManager;
  private readonly recorder: Recorder;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly authHeader: string | undefined;
  private readonly actionTimeoutMs: number;
  private readonly screencastTimeoutMs: number;

  constructor(deps: BrowserProxyDeps) {
    this.registry = deps.registry;
    this.leases = deps.leases;
    this.recorder = deps.recorder;
    // Wrapped rather than stored bare so the global fetch is never called with the proxy as `this`.
    this.doFetch = deps.fetch ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? Date.now;
    this.authHeader = deps.authHeader;
    this.actionTimeoutMs = deps.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    this.screencastTimeoutMs = deps.screencastTimeoutMs ?? DEFAULT_SCREENCAST_TIMEOUT_MS;
  }

  /** The browser server of an online node, or null. */
  private urlOf(name: string): string | null {
    return this.registry.online().find((n) => n.name === name)?.browser?.url ?? null;
  }

  async act(leaseId: string, action: BrowserAction): Promise<unknown> {
    // Renewing *is* the check: it fails for a lease that was preempted, released or has run past its
    // TTL, and it is the same call that pushes the expiry out — so there is no window where an
    // expired holder is read as live and still forwards one last action to the node.
    if (!this.leases.renew(leaseId)) throw new BrowserError(409, 'lease lost');
    const lease = this.leases.get(leaseId);
    const url = lease ? this.urlOf(lease.node) : null;
    if (!lease || !url) throw new BrowserError(503, 'no browser node online');
    const target = { url, slot: lease.slot };

    // A lease is one slot, so its recording (`<root>/<leaseId>/`) is that slot's session.
    const args = action.args ?? {};
    const at = this.now();
    if (action.op === 'screenshot') {
      const recorded = await this.recorder.record(leaseId, { op: 'screenshot', at, jpeg: await this.shot(target, this.actionTimeoutMs) });
      return { seq: recorded.seq, path: recorded.frame ? join(this.recorder.dir(leaseId), recorded.frame) : null };
    }

    const result = await this.send(target, action.op, args);
    // The action already happened; a node that fails to hand back a frame (or a full disk) must not
    // turn a successful navigate into an error for the caller.
    try {
      await this.recorder.record(leaseId, { op: action.op, args, at, jpeg: await this.shot(target, this.actionTimeoutMs) });
    } catch { /* recording is a side channel */ }
    return result;
  }

  /**
   * Polls every held slot for JPEG frames and hands them to subscribers, one frame per slot per
   * tick. Nothing runs until `start()`, so a hub whose screening room nobody is watching never
   * touches a node, and a free slot is never polled — there is nobody's session to show.
   */
  screencast(intervalMs = MIN_FRAME_INTERVAL_MS): Screencast {
    const every = Math.max(MIN_FRAME_INTERVAL_MS, intervalMs);
    const callbacks: ((frame: BrowserFrame) => void)[] = [];
    let timer: NodeJS.Timeout | null = null;
    let inFlight = false;

    const tick = async (): Promise<void> => {
      if (inFlight || callbacks.length === 0) return;
      inFlight = true;
      try {
        const held = this.leases.status().slots.filter((s) => s.lease);
        await Promise.all(held.map(async ({ node, slot, lease }) => {
          const url = this.urlOf(node);
          if (!url) return;
          try {
            const jpeg = await this.shot({ url, slot }, this.screencastTimeoutMs);
            const frame: BrowserFrame = { nodeName: node, slot, leaseId: lease!.leaseId, jpegBase64: jpeg.toString('base64'), at: this.now() };
            for (const cb of callbacks) cb(frame);
          } catch { /* a node that blinks out shouldn't kill the cast */ }
        }));
      } finally {
        inFlight = false;
      }
    };

    return {
      start: () => {
        if (timer) return;
        timer = setInterval(() => { void tick(); }, every);
        timer.unref?.();
        void tick(); // first frame right away, rather than one interval of "NO SIGNAL"
      },
      stop: () => {
        if (timer) clearInterval(timer);
        timer = null;
      },
      onFrame: (cb) => { callbacks.push(cb); },
    };
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', ...(this.authHeader ? { authorization: this.authHeader } : {}) };
  }

  private async send(target: SlotTarget, op: Exclude<BrowserOp, 'screenshot'>, args: Record<string, unknown>): Promise<unknown> {
    const res = await this.call(`${target.url}/browser/${op}?slot=${target.slot}`, { method: 'POST', headers: this.headers(), body: JSON.stringify(args) }, this.actionTimeoutMs);
    // The daemon already separates "asked wrong" (400) from "the browser couldn't" (502); relaying
    // its status keeps that distinction all the way out to the agent.
    if (!res.ok) throw new BrowserError(res.status, await this.readBody(res, errorText, this.actionTimeoutMs));
    return this.readBody(res, (r) => r.json(), this.actionTimeoutMs);
  }

  private async shot(target: SlotTarget, timeoutMs: number): Promise<Buffer> {
    const res = await this.call(`${target.url}/browser/screenshot?slot=${target.slot}`, { headers: this.headers() }, timeoutMs);
    if (!res.ok) throw new BrowserError(res.status, await this.readBody(res, errorText, timeoutMs));
    return this.readBody(res, async (r) => Buffer.from(await r.arrayBuffer()), timeoutMs);
  }

  /**
   * A node that vanished between the registry lookup and the call is unavailable, not a hub bug. A
   * node that accepted the connection but never answers is a different failure — without a timeout it
   * would hang `act()` (or pin the screencast's `inFlight` flag) forever, so every call is bounded.
   */
  private async call(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    try {
      return await this.doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw toBrowserError(err);
    }
  }

  /**
   * Headers can arrive promptly while the body itself stalls (a node that accepted the request but
   * never finishes writing it) — `call`'s timeout only bounds the request that produced `res`, so
   * reading the body needs the same TimeoutError → 504 mapping, not a raw DOMException reaching the
   * caller.
   */
  private async readBody<T>(res: Response, read: (res: Response) => Promise<T>, timeoutMs: number): Promise<T> {
    try {
      return await read(res);
    } catch (err) {
      throw toBrowserError(err);
    }
  }
}

/** A node's browser server and the slot on it a call drives. */
interface SlotTarget { url: string; slot: number }

function toBrowserError(err: unknown): BrowserError {
  if (err instanceof Error && err.name === 'TimeoutError') return new BrowserError(504, 'browser node timeout');
  return new BrowserError(503, `browser node unreachable: ${(err as Error).message}`);
}

async function errorText(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  try {
    return (JSON.parse(body) as { error?: string }).error ?? body;
  } catch {
    return body || `browser node returned ${res.status}`;
  }
}
