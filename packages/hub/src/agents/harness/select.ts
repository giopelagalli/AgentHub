import type { HarnessKind, TeamMember } from '@agenthub/shared';
import type { ModelGateway, Route } from '../../gateway.js';
import type { ProjectBundle } from '../../projects/bundle.js';
import type { AgentLoop } from '../loop.js';
import type { Tool } from '../tools.js';
import { builtinHarness } from './builtin.js';
import { piBinary } from './detect.js';
import { piHarness } from './pi.js';
import type { Harness, HarnessEndpoint } from './index.js';

/**
 * The endpoint an external harness is pointed at: whatever the gateway would itself have picked for
 * the worker tier under this route, reduced to the four facts a subprocess needs.
 *
 * Anthropic is excluded because it has no OpenAI-compatible url at all — the hub speaks it through
 * its own SDK client, which a subprocess cannot borrow. The model override mirrors the gateway's
 * own rule (a named model only ever replaces a cloud endpoint's), and both this and the mirroring
 * go away once the hub's own door serves every harness (decision 0032).
 */
export function endpointFor(gateway: ModelGateway, route?: Route): HarnessEndpoint | null {
  const picked = gateway.pick('worker', route);
  if (!picked) return null;
  const { endpoint } = picked;
  const provider = endpoint.provider ?? 'openai';
  if (provider === 'anthropic') return null;
  if (endpoint.apiKeyEnv && !process.env[endpoint.apiKeyEnv]) return null;
  return {
    url: endpoint.url,
    model: route?.model && provider !== 'openai' ? route.model : endpoint.model,
    provider,
    ...(endpoint.apiKeyEnv ? { apiKeyEnv: endpoint.apiKeyEnv } : {}),
  };
}

export interface HarnessSelection {
  harness: Harness;
  /** Present only when an external harness was chosen. */
  endpoint?: HarnessEndpoint;
}

export interface HarnessSelectOptions {
  loop: AgentLoop;
  bundle?: ProjectBundle;
  member?: TeamMember;
  /** Tools beyond the workspace ones; an external harness cannot offer them, so it is not used. */
  extras: Tool[];
  /** True when the caller pinned the belt itself — the milestone reviewer, which stays built-in. */
  pinnedTools: boolean;
  /** Builds the built-in belt; see `BuiltinHarnessDeps.tools`. */
  tools: (onWrite: (path: string) => void) => Tool[];
  route?: Route;
  onBusy?: (busy: boolean) => void;
  log: (line: string) => void;
}

/**
 * Which harness runs this task. The answer is the employee's `harness`, falling back to the
 * project's default and then to `builtin` — but every reason the choice cannot be honoured falls
 * back to `builtin` rather than failing the task, because a harness is a preference and the work
 * still has to get done. Each fallback says why in the job log.
 */
export async function selectHarness(opts: HarnessSelectOptions): Promise<HarnessSelection> {
  const builtin = (): HarnessSelection => ({
    harness: builtinHarness({
      loop: opts.loop,
      tools: opts.tools,
      extraToolNames: opts.extras.map((t) => t.def.name),
      ...(opts.bundle ? { bundle: opts.bundle } : {}),
      ...(opts.onBusy ? { onBusy: opts.onBusy } : {}),
    }),
  });

  const wanted: HarnessKind = opts.member?.harness ?? (await opts.bundle?.manifest())?.harness ?? 'builtin';
  if (wanted === 'builtin') return builtin();
  if (wanted === 'claude-code') {
    opts.log('claude-code is not implemented yet; running on the built-in loop');
    return builtin();
  }
  // FR-G4: the reviewer judges a milestone with read-only tools, and until a harness is verified to
  // be restrictable *and* contained it keeps running on the loop that already guarantees both.
  if (opts.pinnedTools) return builtin();
  if (opts.extras.length) {
    opts.log(`pi has no ${opts.extras.map((t) => t.def.name).join('/')}; running on the built-in loop`);
    return builtin();
  }
  if (!opts.bundle) return builtin();
  const bin = await piBinary();
  if (!bin) {
    opts.log('pi is not installed on this host; running on the built-in loop');
    return builtin();
  }
  const endpoint = endpointFor(opts.loop.gateway, opts.route);
  if (!endpoint) {
    opts.log('no OpenAI-compatible worker endpoint for pi; running on the built-in loop');
    return builtin();
  }
  return {
    harness: piHarness({
      bin: bin.path,
      transcript: opts.loop.transcript,
      ...(opts.onBusy ? { onBusy: opts.onBusy } : {}),
    }),
    endpoint,
  };
}
