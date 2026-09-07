import { join } from 'node:path';
import type { NodeRegistry } from '../node-registry.js';
import type { LeaseManager } from './lease.js';
import type { Recorder } from './recorder.js';

export type BrowserOp = 'navigate' | 'read' | 'click' | 'type' | 'screenshot';
export const BROWSER_OPS: BrowserOp[] = ['navigate', 'read', 'click', 'type', 'screenshot'];

export interface BrowserAction { op: BrowserOp; args?: Record<string, unknown> }

export interface BrowserFrame { nodeName: string; leaseId: string | null; jpegBase64: string; at: number }

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
}

/** ≤ 2 fps, per the screencast budget. */
const MIN_FRAME_INTERVAL_MS = 500;

/**
 * The hub's side of the browser: it resolves the one online node advertising the capability and
 * forwards actions to that node's browser server — but only for the current lease holder, so the
 * daemon can stay lease-unaware behind loopback. Every action renews the lease and appends a frame
 * to the recording, which is what makes an abandoned session expire and a finished one replayable.
 */
export class BrowserProxy {
  private readonly registry: NodeRegistry;
  private readonly leases: LeaseManager;
  private readonly recorder: Recorder;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly authHeader: string | undefined;

  constructor(deps: BrowserProxyDeps) {
    this.registry = deps.registry;
    this.leases = deps.leases;
    this.recorder = deps.recorder;
    // Wrapped rather than stored bare so the global fetch is never called with the proxy as `this`.
    this.doFetch = deps.fetch ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? Date.now;
    this.authHeader = deps.authHeader;
  }

  /** The browser node, or null when none is online. */
  node(): { name: string; url: string } | null {
    const node = this.registry.online().find((n) => n.browser?.url);
    return node ? { name: node.name, url: node.browser!.url } : null;
  }

  async act(leaseId: string, action: BrowserAction): Promise<unknown> {
    const holder = this.leases.holder();
    if (!holder || holder.leaseId !== leaseId) throw new BrowserError(409, 'lease lost');
    const node = this.node();
    if (!node) throw new BrowserError(503, 'no browser node online');
    this.leases.renew(leaseId);

    const args = action.args ?? {};
    const at = this.now();
    if (action.op === 'screenshot') {
      const recorded = await this.recorder.record(leaseId, { op: 'screenshot', at, jpeg: await this.shot(node.url) });
      return { seq: recorded.seq, path: recorded.frame ? join(this.recorder.dir(leaseId), recorded.frame) : null };
    }

    const result = await this.send(node.url, action.op, args);
    // The action already happened; a node that fails to hand back a frame (or a full disk) must not
    // turn a successful navigate into an error for the caller.
    try {
      await this.recorder.record(leaseId, { op: action.op, args, at, jpeg: await this.shot(node.url) });
    } catch { /* recording is a side channel */ }
    return result;
  }

  /**
   * Polls the browser node for JPEG frames and hands them to subscribers. Nothing runs until
   * `start()`, so a hub whose screening room nobody is watching never touches the node.
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
        const node = this.node();
        if (!node) return;
        const jpeg = await this.shot(node.url);
        const frame: BrowserFrame = {
          nodeName: node.name,
          leaseId: this.leases.holder()?.leaseId ?? null,
          jpegBase64: jpeg.toString('base64'),
          at: this.now(),
        };
        for (const cb of callbacks) cb(frame);
      } catch { /* a node that blinks out shouldn't kill the cast */ } finally {
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

  private async send(url: string, op: Exclude<BrowserOp, 'screenshot'>, args: Record<string, unknown>): Promise<unknown> {
    const res = await this.call(`${url}/browser/${op}`, { method: 'POST', headers: this.headers(), body: JSON.stringify(args) });
    // The daemon already separates "asked wrong" (400) from "the browser couldn't" (502); relaying
    // its status keeps that distinction all the way out to the agent.
    if (!res.ok) throw new BrowserError(res.status, await errorText(res));
    return res.json();
  }

  private async shot(url: string): Promise<Buffer> {
    const res = await this.call(`${url}/browser/screenshot`, { headers: this.headers() });
    if (!res.ok) throw new BrowserError(res.status, await errorText(res));
    return Buffer.from(await res.arrayBuffer());
  }

  /** A node that vanished between the registry lookup and the call is unavailable, not a hub bug. */
  private async call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.doFetch(url, init);
    } catch (err) {
      throw new BrowserError(503, `browser node unreachable: ${(err as Error).message}`);
    }
  }
}

async function errorText(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  try {
    return (JSON.parse(body) as { error?: string }).error ?? body;
  } catch {
    return body || `browser node returned ${res.status}`;
  }
}
