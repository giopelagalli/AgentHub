import { basename } from 'node:path';
import type { BrowserRequesterKind } from '@agenthub/shared';
import type { LeaseManager, Lease, Requester } from '../browser/lease.js';
import { BrowserError, type BrowserOp, type BrowserProxy } from '../browser/proxy.js';
import type { Tool, ToolContext } from './tools.js';

/** How long an orchestrator's `acquire_browser` call polls before giving up and reporting the queue. */
const ORCHESTRATOR_WAIT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves once `signal` fires; never resolves for an absent signal. Used to race against a sleep. */
function whenAborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!signal) return;
    if (signal.aborted) { resolve(); return; }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

export interface BrowserToolDeps {
  leases: LeaseManager;
  proxy: BrowserProxy;
  /** Overridable in tests so `acquire_browser`'s wait loop never needs a real 60s. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

// --- argument helpers (mirrors the style of tools.ts / master.ts's own local copies) ---------------

function fields(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
}

function str(args: unknown, key: string): string {
  const v = fields(args)[key];
  if (typeof v !== 'string' || !v) throw new Error(`${key} must be a non-empty string`);
  return v;
}

function optBool(args: unknown, key: string): boolean | undefined {
  const v = fields(args)[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new Error(`${key} must be a boolean`);
  return v;
}

const strProp = (description: string) => ({ type: 'string', description });

// --- page-shaped results (the daemon's own types live in node-daemon; only the shape is needed here) ---

interface PageStateResult { url: string; title: string }
interface PageReadResult { state: PageStateResult; text: string; links: { text: string; href: string }[] }
interface ScreenshotResult { seq: number; path: string | null }

const pageLine = (s: PageStateResult): string => `page: ${s.title} (${s.url})`;

// --- shared plumbing ---------------------------------------------------------------------------------

/**
 * The requester id used for lease priority and dedup (`LeaseManager.acquire` keys on `(id, kind)`).
 *
 * Orchestrator-kind tools key on the project slug (`project:<slug>`), not the AgentLoop session id.
 * AgentLoop mints a fresh `sessionId` for every turn (see `AgentLoop.run`), so an id built from it
 * would make a returning orchestrator look like a brand-new requester on its next turn and queue
 * behind its *own* still-valid lease from the turn before, stuck there until the lease's TTL lapses.
 * Keying on the slug instead means a returning orchestrator's `acquire_browser` call matches
 * `LeaseManager`'s current holder and re-acquires its lease in place (renewed, same leaseId).
 *
 * Subagents are single-turn — one `sessionId` covers a subagent's whole life — so per-session ids are
 * already correct there; the slug is folded in only for a readable, namespaced id, not for dedup.
 */
function requesterId(kind: BrowserRequesterKind, ctx: ToolContext): string {
  const slug = ctx.bundle ? basename(ctx.bundle.dir) : 'unknown';
  return kind === 'orchestrator' ? `project:${slug}` : `subagent:${slug}:${ctx.sessionId}`;
}

/**
 * The requester as the lease manager sees it: carrying the project, so everyone working on one
 * project shares its one slot of the pool (FR-D8) — a subagent asking while its orchestrator holds
 * the project's browser gets that lease back rather than a second slot.
 */
function requesterOf(kind: BrowserRequesterKind, ctx: ToolContext): Requester {
  const id = requesterId(kind, ctx);
  return ctx.bundle ? { kind, id, project: basename(ctx.bundle.dir) } : { kind, id };
}

/**
 * Per-session state, scoped to one `browserTools()` call: which leaseId (if any) this session last
 * acquired. `LeaseManager.holder()` alone can't tell "never acquired" from "acquired, then lost it to
 * a preemption" — both look like "someone else holds it now" — so the tools remember their own grant
 * and let `BrowserProxy.act`'s own holder check (409) be the source of truth for whether it still
 * stands, exactly as it would for any other client of the proxy.
 */
type Held = Map<string, string>;

/**
 * Runs one browser action for the current holder. `BrowserProxy.act` already renews the lease and
 * records a frame, so auto-renew and recording need no extra code here — only the "who are you"
 * check and turning a lost lease into the model-facing error the brief specifies.
 */
async function act(
  deps: BrowserToolDeps,
  held: Held,
  kind: BrowserRequesterKind,
  ctx: ToolContext,
  op: BrowserOp,
  args: Record<string, unknown> | undefined,
  format: (result: unknown) => string,
): Promise<string> {
  const id = requesterId(kind, ctx);
  const leaseId = held.get(id);
  if (!leaseId) return 'error: no browser lease — call acquire_browser first';
  try {
    const result = await deps.proxy.act(leaseId, args === undefined ? { op } : { op, args });
    return format(result);
  } catch (e) {
    if (e instanceof BrowserError && e.status === 409) {
      held.delete(id);
      return 'error: lease lost — call acquire_browser again';
    }
    throw e;
  }
}

/**
 * The requester's current lease — its own, or its project's — if it holds one right now. Used by every
 * path below that has to give up on a lease it can't address directly by leaseId: `withdraw` only
 * ever removes a *queued* entry, so a requester that was granted the lease between the last poll and
 * a giving-up check (abort, timeout) — or a fresh `held` map (a new turn) that never learned its
 * leaseId — needs this instead to find the lease it's about to release.
 */
function holderMatching(deps: BrowserToolDeps, requester: Requester): Lease | null {
  return deps.leases.holderFor(requester);
}

/**
 * Gives up a request that is no longer wanted (aborted, or the orchestrator's poll timed out).
 * Withdraws the queued entry; if it wasn't queued (it was granted in the gap between the last poll
 * and this check), releases the lease instead so a caller that never recorded the leaseId — it gave
 * up before reaching the `held.set` — doesn't leave it held forever.
 */
function giveUp(deps: BrowserToolDeps, requester: Requester): void {
  if (deps.leases.withdraw(requester.id, requester.kind)) return;
  const holder = holderMatching(deps, requester);
  if (holder && grantedTo(holder, requester)) deps.leases.release(holder.leaseId);
}

/**
 * Whether `requester` was granted `lease` itself. A lease it merely shares through its project is
 * the project's, and neither giving up nor releasing may pull it out from under whoever else in the
 * project is using it.
 */
function grantedTo(lease: Lease, requester: Requester): boolean {
  return lease.requester.id === requester.id && lease.requester.kind === requester.kind;
}

/**
 * Grants the lease, or (for orchestrators only) polls for it — an orchestrator's turn is bounded to a
 * handful of tool calls, so making it burn one just to learn "still queued" would waste the budget a
 * subagent doesn't have. Subagents get the queue position back immediately instead.
 */
async function acquire(deps: BrowserToolDeps, held: Held, kind: BrowserRequesterKind, ctx: ToolContext): Promise<string> {
  const requester = requesterOf(kind, ctx);
  const id = requester.id;
  let result = deps.leases.acquire(requester);
  if (kind === 'orchestrator') {
    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ?? defaultSleep;
    const deadline = now() + ORCHESTRATOR_WAIT_MS;
    // Hoisted out of the loop: one abort listener per acquire call (whenAborted registers it once),
    // reused across every poll iteration instead of piling up a fresh, never-removed listener per poll.
    const aborted = whenAborted(ctx.signal);
    while ('queued' in result && now() < deadline) {
      // Raced against the signal so a cancelled turn (ProjectService.stop(), a turn timeout) doesn't
      // sit through up to a full poll interval before noticing — it can otherwise stall shutdown by
      // as much as POLL_INTERVAL_MS on every poll.
      await Promise.race([sleep(Math.min(POLL_INTERVAL_MS, deadline - now())), aborted]);
      if (ctx.signal?.aborted) {
        giveUp(deps, requester);
        return 'error: aborted';
      }
      result = deps.leases.acquire(requester);
    }
    if ('queued' in result) {
      // Gave up waiting: withdraw (or release, if granted in the gap before this check) rather than
      // report a stale queue position the caller will never poll again to correct.
      giveUp(deps, requester);
      return 'error: browser busy — try again later';
    }
  }
  if ('granted' in result) {
    held.set(id, result.leaseId);
    return 'browser lease granted';
  }
  return `queued: position ${result.position}`;
}

function release(deps: BrowserToolDeps, held: Held, kind: BrowserRequesterKind, ctx: ToolContext): string {
  const requester = requesterOf(kind, ctx);
  const leaseId = held.get(requester.id);
  held.delete(requester.id);
  // No memory of a leaseId in this tool list's `held` map — a fresh turn (browserTools() rebuilds it
  // every call) that re-acquired its still-valid lease in an earlier turn and never held it here —
  // falls back to whatever the LeaseManager says this requester (or its project) holds.
  const lease = leaseId ? deps.leases.get(leaseId) : holderMatching(deps, requester);
  if (!lease) return leaseId ? 'error: lease already lost' : 'error: no browser lease — call acquire_browser first';
  // Shared through the project (the orchestrator's, say): this requester lets go, the project keeps it.
  if (!grantedTo(lease, requester)) return 'browser lease released (project keeps it)';
  deps.leases.release(lease.leaseId);
  return 'browser lease released';
}

// --- tool set ------------------------------------------------------------------------------------

/**
 * The browser toolset an agent gets: acquire/release the shared lease, plus navigate/read/click/type
 * /screenshot, which only work while the caller holds it. `kind` sets the requester's priority
 * (`orchestrator` beats `subagent`) and is fixed per caller — an orchestrator's tool list uses
 * `browserTools(deps, 'orchestrator')`; a browser-operator subagent uses `browserOperatorTools`.
 */
export function browserTools(deps: BrowserToolDeps, kind: BrowserRequesterKind): Tool[] {
  // One map per tool-list build, so it lives exactly as long as the tool list does — a fresh
  // orchestrator turn (a fresh tool list) starts with no memory of a previous turn's lease.
  const held: Held = new Map();
  return [
    {
      def: { type: 'tool', name: 'acquire_browser', description: kind === 'orchestrator' ? 'Request the shared browser lease; returns once granted, or "browser busy" if it times out waiting.' : 'Request the shared browser lease; returns once granted, or your queue position.', parameters: { type: 'object', properties: {}, required: [] } },
      run: async (_args, ctx) => acquire(deps, held, kind, ctx),
    },
    {
      def: { type: 'tool', name: 'release_browser', description: 'Release the browser lease you are holding.', parameters: { type: 'object', properties: {}, required: [] } },
      run: async (_args, ctx) => release(deps, held, kind, ctx),
    },
    {
      def: {
        type: 'tool', name: 'browser_navigate', description: 'Navigate the shared browser to a URL. Requires the lease.',
        parameters: { type: 'object', properties: { url: strProp('URL to load.') }, required: ['url'] },
      },
      run: async (args, ctx) => act(deps, held, kind, ctx, 'navigate', { url: str(args, 'url') }, (r) => pageLine(r as PageStateResult)),
    },
    {
      def: { type: 'tool', name: 'browser_read', description: 'Read the current page: visible text and links. Requires the lease.', parameters: { type: 'object', properties: {}, required: [] } },
      run: async (_args, ctx) => act(deps, held, kind, ctx, 'read', undefined, (r) => {
        const read = r as PageReadResult;
        const lines = [pageLine(read.state), '', read.text];
        if (read.links.length) lines.push('', 'links:', ...read.links.map((l) => `- ${l.text}: ${l.href}`));
        return lines.join('\n');
      }),
    },
    {
      def: {
        type: 'tool', name: 'browser_click', description: 'Click an element (CSS selector or `text=...`). Requires the lease.',
        parameters: { type: 'object', properties: { selector: strProp('CSS selector or `text=<label>`.') }, required: ['selector'] },
      },
      run: async (args, ctx) => act(deps, held, kind, ctx, 'click', { selector: str(args, 'selector') }, (r) => pageLine(r as PageStateResult)),
    },
    {
      def: {
        type: 'tool', name: 'browser_type', description: 'Type into an element, optionally submitting it. Requires the lease.',
        parameters: {
          type: 'object',
          properties: {
            selector: strProp('CSS selector or `text=<label>`.'),
            text: strProp('Text to type.'),
            submit: { type: 'boolean', description: 'Submit the form afterward; defaults to false.' },
          },
          required: ['selector', 'text'],
        },
      },
      run: async (args, ctx) => {
        const typeArgs = { selector: str(args, 'selector'), text: str(args, 'text'), submit: optBool(args, 'submit') ?? false };
        return act(deps, held, kind, ctx, 'type', typeArgs, (r) => pageLine(r as PageStateResult));
      },
    },
    {
      def: { type: 'tool', name: 'browser_screenshot', description: 'Screenshot the current page. Saved to the session recording, not returned to you. Requires the lease.', parameters: { type: 'object', properties: {}, required: [] } },
      run: async (_args, ctx) => act(deps, held, kind, ctx, 'screenshot', undefined, (r) => {
        const shot = r as ScreenshotResult;
        return shot.path ? `saved ${shot.path}` : `screenshot taken (frame ${shot.seq}, not stored — frame cap reached)`;
      }),
    },
  ];
}

/** The browser-operator subagent's browser tools — `browserTools` with `subagent` priority. */
export function browserOperatorTools(deps: BrowserToolDeps): Tool[] {
  return browserTools(deps, 'subagent');
}
