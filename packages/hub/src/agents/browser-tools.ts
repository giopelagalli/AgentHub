import type { BrowserRequesterKind } from '@agenthub/shared';
import type { LeaseManager, Requester } from '../browser/lease.js';
import { BrowserError, type BrowserOp, type BrowserProxy } from '../browser/proxy.js';
import type { Tool, ToolContext } from './tools.js';

/** How long an orchestrator's `acquire_browser` call polls before giving up and reporting the queue. */
const ORCHESTRATOR_WAIT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

/** The requester id is the AgentLoop session id: stable across every tool call in one run. */
function requesterId(ctx: ToolContext): string {
  return String(ctx.sessionId);
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
  ctx: ToolContext,
  op: BrowserOp,
  args: Record<string, unknown> | undefined,
  format: (result: unknown) => string,
): Promise<string> {
  const id = requesterId(ctx);
  const leaseId = held.get(id);
  if (!leaseId) return 'error: no browser lease — call acquire_browser first';
  try {
    const result = await deps.proxy.act(leaseId, args === undefined ? { op } : { op, args });
    return format(result);
  } catch (e) {
    if (e instanceof BrowserError && e.status === 409) {
      held.delete(id);
      return 'error: lease lost — owner took control';
    }
    throw e;
  }
}

/**
 * Grants the lease, or (for orchestrators only) polls for it — an orchestrator's turn is bounded to a
 * handful of tool calls, so making it burn one just to learn "still queued" would waste the budget a
 * subagent doesn't have. Subagents get the queue position back immediately instead.
 */
async function acquire(deps: BrowserToolDeps, held: Held, kind: BrowserRequesterKind, ctx: ToolContext): Promise<string> {
  const id = requesterId(ctx);
  const requester: Requester = { kind, id };
  let result = deps.leases.acquire(requester);
  if (kind === 'orchestrator') {
    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ?? defaultSleep;
    const deadline = now() + ORCHESTRATOR_WAIT_MS;
    while ('queued' in result && now() < deadline) {
      await sleep(Math.min(POLL_INTERVAL_MS, deadline - now()));
      result = deps.leases.acquire(requester);
    }
  }
  if ('granted' in result) {
    held.set(id, result.leaseId);
    return 'browser lease granted';
  }
  return `queued: position ${result.position}`;
}

function release(deps: BrowserToolDeps, held: Held, ctx: ToolContext): string {
  const id = requesterId(ctx);
  const leaseId = held.get(id);
  if (!leaseId) return 'error: no browser lease — call acquire_browser first';
  held.delete(id);
  deps.leases.release(leaseId);
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
      def: { type: 'tool', name: 'acquire_browser', description: 'Request the shared browser lease; returns once granted, or the queue position.', parameters: { type: 'object', properties: {}, required: [] } },
      run: async (_args, ctx) => acquire(deps, held, kind, ctx),
    },
    {
      def: { type: 'tool', name: 'release_browser', description: 'Release the browser lease you are holding.', parameters: { type: 'object', properties: {}, required: [] } },
      run: async (_args, ctx) => release(deps, held, ctx),
    },
    {
      def: {
        type: 'tool', name: 'browser_navigate', description: 'Navigate the shared browser to a URL. Requires the lease.',
        parameters: { type: 'object', properties: { url: strProp('URL to load.') }, required: ['url'] },
      },
      run: async (args, ctx) => act(deps, held, ctx, 'navigate', { url: str(args, 'url') }, (r) => pageLine(r as PageStateResult)),
    },
    {
      def: { type: 'tool', name: 'browser_read', description: 'Read the current page: visible text and links. Requires the lease.', parameters: { type: 'object', properties: {}, required: [] } },
      run: async (_args, ctx) => act(deps, held, ctx, 'read', undefined, (r) => {
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
      run: async (args, ctx) => act(deps, held, ctx, 'click', { selector: str(args, 'selector') }, (r) => pageLine(r as PageStateResult)),
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
        return act(deps, held, ctx, 'type', typeArgs, (r) => pageLine(r as PageStateResult));
      },
    },
    {
      def: { type: 'tool', name: 'browser_screenshot', description: 'Screenshot the current page. Saved to the session recording, not returned to you. Requires the lease.', parameters: { type: 'object', properties: {}, required: [] } },
      run: async (_args, ctx) => act(deps, held, ctx, 'screenshot', undefined, (r) => {
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
