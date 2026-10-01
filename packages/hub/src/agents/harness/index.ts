import type { HarnessKind, TeamMember, TurnEvent } from '@agenthub/shared';
import type { ApiTokens } from '../../door.js';
import type { Route } from '../../gateway.js';
import type { SubagentRole } from '../../projects/prompts.js';
import type { SessionOutcome } from '../transcript.js';

/**
 * One employee task, run somewhere. The point of the interface is that the turn feed, the report
 * and the list of files written come out the same whichever runtime produced them — the manager
 * reads a `pi` subagent's report exactly as it reads a built-in one (FR-G1).
 *
 * `builtin` is the hub's own tool loop and stays the manager's runtime and everyone's fallback;
 * `pi` drives the open-source coding agent as a subprocess in the workspace (FR-G2); `claude-code`
 * drives the `claude` CLI on the host's signed-in subscription (FR-G3).
 */
export interface Harness {
  kind: HarnessKind;
  run(task: HarnessTask, ctx: HarnessContext): Promise<HarnessResult>;
}

/** Which tools a harness may offer. `read-only` is what a reviewer would need (FR-G4). */
export type HarnessToolPolicy = 'workspace' | 'read-only';

/**
 * The hub's own OpenAI-compatible door (`door.ts`), as an external harness reaches it: the base the
 * hub is listening on and the token store a per-run `agent` token is minted from (decision 0050).
 * A subprocess cannot call `gateway.chat`, so it calls the door, which does — and so gets failover,
 * the usage ledger, the cloud cap and `maxStreams` like every other model call.
 */
export interface HarnessDoor {
  /** `http://127.0.0.1:<port>`, without `/v1`; null until the hub is listening. */
  base: () => string | null;
  tokens: ApiTokens;
}

export interface HarnessTask {
  /** The project workspace: the harness's working directory and the only tree it may write in. */
  workspace: string;
  /** The whole assignment, as the manager wrote it. */
  task: string;
  role: SubagentRole;
  /** The member's standing instructions, appended to the role's prompt by whichever harness runs. */
  instructions?: string;
  /** The roster member this run is attributed to; absent when the roster has nobody with the role. */
  member?: TeamMember;
  /** The gateway preference for this run — what `builtin` hands to `loop.run`. */
  route?: Route;
  tools: HarnessToolPolicy;
  budget: HarnessBudget;
  signal?: AbortSignal;
}

/**
 * What bounds one run. `toolCalls` is the built-in loop's own budget; a harness with no call limit
 * of its own enforces it by counting the calls it sees and stopping the run at the cap, and
 * `wallClockMs` is the backstop for a run that stalls without calling anything.
 */
export interface HarnessBudget {
  toolCalls: number;
  wallClockMs: number;
}

export interface HarnessContext {
  /** Who this run's events are attributed to — the member id, else the role. */
  who: string;
  /** The project slug, which is what a session is recorded under. */
  subject: string;
  /** The caller's live event sink; the harness also persists what it emits under its own session. */
  onEvent?: (e: TurnEvent) => void;
  /** Tool progress lines, for the job log. */
  log: (line: string) => void;
}

export interface HarnessResult {
  /** The run's final message: the only thing the manager sees. */
  report: string;
  /** Workspace-relative paths the run wrote, in first-written order. */
  filesWritten: string[];
  outcome: SessionOutcome;
  /** The transcript session this run was recorded under — what the employee drawer replays. */
  sessionId: number;
  toolCalls: number;
  /** The model hit its output limit on the final turn, so `report` is cut short. */
  truncated?: boolean;
  /** The last tool the run actually executed. */
  lastTool?: string;
}

export { builtinHarness } from './builtin.js';
export { piHarness } from './pi.js';
export { claudeCodeHarness } from './claude-code.js';
export { claudeBinary, claudeCodeStatus, harnessStatus, piBinary } from './detect.js';
export { harnessRoutes } from './routes.js';
export { selectHarness, type HarnessSelection, type HarnessSelectOptions } from './select.js';
