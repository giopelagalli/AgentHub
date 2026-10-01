import { HARNESS_KINDS, type HarnessKind, type TeamMember } from '@agenthub/shared';
import type { Route } from '../../gateway.js';
import type { ProjectBundle } from '../../projects/bundle.js';
import type { AgentLoop } from '../loop.js';
import type { Tool } from '../tools.js';
import { builtinHarness } from './builtin.js';
import { piBinary } from './detect.js';
import { piHarness } from './pi.js';
import type { Harness, HarnessDoor } from './index.js';

export interface HarnessSelection {
  harness: Harness;
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
  /** The hub's own door, which an external harness calls models through; absent, pi is refused. */
  door?: HarnessDoor;
  onBusy?: (busy: boolean) => void;
  log: (line: string) => void;
}

/**
 * Which harness runs this task. The answer is the employee's `harness`, falling back to the
 * project's default and then to `builtin` — but every reason the choice cannot be honoured falls
 * back to `builtin` rather than failing the task, because a harness is a preference and the work
 * still has to get done. Each fallback says why in the job log and in the run's session events.
 */
export async function selectHarness(opts: HarnessSelectOptions): Promise<HarnessSelection> {
  const builtin = (note?: string): HarnessSelection => ({
    harness: builtinHarness({
      loop: opts.loop,
      tools: opts.tools,
      extraToolNames: opts.extras.map((t) => t.def.name),
      ...(opts.bundle ? { bundle: opts.bundle } : {}),
      ...(opts.onBusy ? { onBusy: opts.onBusy } : {}),
      ...(note ? { note } : {}),
    }),
  });
  /** A pi request that cannot be honoured: said in the job log and recorded in the run's session. */
  const fallback = (reason: string): HarnessSelection => {
    const note = `${reason}; running on the built-in loop`;
    opts.log(note);
    return builtin(note);
  };

  // The manifest is hand-editable YAML, so its value is checked rather than trusted.
  const asked: unknown = opts.member?.harness ?? (await opts.bundle?.manifest())?.harness;
  const wanted: HarnessKind = HARNESS_KINDS.includes(asked as HarnessKind) ? (asked as HarnessKind) : 'builtin';
  if (wanted === 'claude-code') return fallback('claude-code is not implemented yet');
  if (wanted !== 'pi') return builtin();
  // FR-G4: the reviewer judges a milestone with read-only tools, and until a harness is verified to
  // be restrictable *and* contained it keeps running on the loop that already guarantees both.
  if (opts.pinnedTools) return builtin();
  if (opts.extras.length) return fallback(`pi has no ${opts.extras.map((t) => t.def.name).join('/')}`);
  if (!opts.bundle) return builtin();
  const bin = await piBinary();
  if (!bin) return fallback('pi is not installed on this host');
  // pi reaches models only through the hub's own door (decision 0050): a provider key never enters
  // the subprocess, so without the door there is nothing pi may be pointed at.
  const base = opts.door?.base();
  if (!opts.door || !base) return fallback("the hub's door is not available to pi");
  return {
    harness: piHarness({
      bin: bin.path,
      transcript: opts.loop.transcript,
      door: { base, tokens: opts.door.tokens },
      ...(opts.onBusy ? { onBusy: opts.onBusy } : {}),
    }),
  };
}
