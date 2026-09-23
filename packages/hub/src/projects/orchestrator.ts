import type { TurnEvent } from '@agenthub/shared';
import { routeFor, type ModelGateway } from '../gateway.js';
import type { JobQueue } from '../queue.js';
import type { NodeRegistry } from '../node-registry.js';
import type { AgentLoop } from '../agents/loop.js';
import type { Transcript } from '../agents/transcript.js';
import { bundleTools, hubTools, spawnSubagentTool, workspaceTools, type Tool } from '../agents/tools.js';
import { completeMilestoneTool } from '../agents/verify.js';
import { ORCHESTRATOR_TOOL_CALLS } from '../agents/budgets.js';
import { browserTools } from '../agents/browser-tools.js';
import type { AgentRunResult } from '../agents/loop.js';
import type { LeaseManager } from '../browser/lease.js';
import type { BrowserProxy } from '../browser/proxy.js';
import type { ProjectBundle } from './bundle.js';
import { planningContext } from './prd.js';
import { orchestratorSystemPrompt } from './prompts.js';
import type { Briefing, Manifest, TaskItem } from './schema.js';

const SUMMARY_LIMIT = 600;
const SYNTHESIZED_NEXT_STEPS = 5;
const COMMIT_LABEL_LIMIT = 60;

/** The one-line tail of a turn's commit subject. */
const label = (summary: string): string => summary.replace(/\s+/g, ' ').trim().slice(0, COMMIT_LABEL_LIMIT);

const DEFAULT_INSTRUCTION = [
  'Take the next turn on this project.',
  'Review the context above, move the work forward — delegating concrete tasks to subagents —',
  'keep tasks.yaml and the decision log current, and end the turn by publishing a briefing.',
].join(' ');

export interface ProjectOrchestratorDeps {
  bundle: ProjectBundle;
  loop: AgentLoop;
  gateway: ModelGateway;
  queue: JobQueue;
  registry: NodeRegistry;
  transcript: Transcript;
  /** Present once the hub wires the shared browser; absent, the orchestrator gets no browser tools. */
  leases?: LeaseManager;
  browser?: BrowserProxy;
  /** The configured external tools; the orchestrator gets them and can hand them to a researcher. */
  external?: Tool[];
  /** Notified with (memberId, busy) whenever a delegated subagent run starts or ends. */
  onBusy?: (memberId: string, busy: boolean) => void;
  /** Receives every live event of a turn, keyed by the turn's orchestrator session, with its `at`. */
  onEvent?: (sessionId: number, e: TurnEvent, at: number) => void;
}

/**
 * One long-lived orchestrator per active project, driven in bounded *turns*.
 *
 * A turn is stateless apart from the bundle: the context pack is rebuilt from disk every time, so an
 * orchestrator cold-started after a restart resumes from the same memory a running one has.
 */
export class ProjectOrchestrator {
  private turns = 0;

  constructor(private deps: ProjectOrchestratorDeps) {}

  async turn(opts: { instruction?: string; signal?: AbortSignal } = {}): Promise<Briefing> {
    const { bundle, loop, queue, registry, transcript, leases, browser, external, onBusy, onEvent } = this.deps;
    const manifest = await bundle.manifest();
    const before = await bundle.latestBriefing();
    const browserDeps = leases && browser ? { leases, proxy: browser } : undefined;
    // The owner's model choice for this project. The turn itself runs on the orchestrator tier,
    // resolved here; what it delegates runs on the worker tier, resolved per member inside
    // `runSubagent` — a member's own `model` overrides this policy, so the raw policy travels
    // rather than a route already pinned to the project's own choice.
    const orchestratorRoute = routeFor(manifest.modelPolicy, 'orchestrator');
    const delegation = { loop, subject: manifest.slug, onBusy, ...(manifest.modelPolicy ? { modelPolicy: manifest.modelPolicy } : {}) };

    // The turn's own bracketing events. The loop persists what happens inside it under the session
    // it starts, so these two go through the same store and the same sink once that session exists.
    const startedAt = Date.now();
    let sessionId = 0;
    const emit = (e: TurnEvent): void => {
      const at = Date.now();
      transcript.appendTurnEvent(sessionId, e, at);
      onEvent?.(sessionId, e, at);
    };
    const finish = (briefing: Briefing, outcome: string, summary = briefing.summary): Briefing => {
      emit({ kind: 'turn-end', outcome, ms: Date.now() - startedAt, summary });
      return briefing;
    };

    const result = await loop.run({
      kind: 'orchestrator',
      subject: manifest.slug,
      tier: 'orchestrator',
      system: orchestratorSystemPrompt(await bundle.contextPack(), await bundle.team(), await planningContext(bundle)),
      user: opts.instruction ?? DEFAULT_INSTRUCTION,
      tools: [
        ...workspaceTools(),
        ...bundleTools(),
        ...hubTools(),
        ...(external ?? []),
        ...(browserDeps ? browserTools(browserDeps, 'orchestrator') : []),
        spawnSubagentTool({ ...delegation, browser: browserDeps, external }),
        completeMilestoneTool(delegation),
      ],
      ctx: { bundle, hub: { queue, nodes: registry } },
      ...(orchestratorRoute ? { route: orchestratorRoute } : {}),
      maxToolCalls: ORCHESTRATOR_TOOL_CALLS,
      signal: opts.signal,
      onStart: (id) => { sessionId = id; emit({ kind: 'turn-start', who: 'manager' }); },
      onEvent: (e, at) => onEvent?.(sessionId, e, at),
    });
    const n = ++this.turns;

    // `publish_briefing` commits its own write, so the published path needs nothing further here.
    const published = await bundle.latestBriefing();
    if (published && published.updatedAt !== before?.updatedAt) return finish(published, result.outcome);

    const endedEarly = result.outcome === 'aborted' || result.outcome === 'error';
    if (endedEarly) transcript.appendEvent(result.sessionId, `turn ${n} ended ${result.outcome} without a briefing`);
    // An interrupted turn only saw part of the project. Overwriting the last good briefing with
    // whatever it managed to say would tell the master *less* than it already knows.
    if (endedEarly && before) return finish(before, result.outcome, earlyEndNote(result.outcome));

    // Otherwise the master still needs a report: synthesize one from the board and what was said.
    const briefing = await this.synthesize(manifest, result);
    await bundle.publishBriefing(briefing);
    await bundle.commit(`agent: turn ${n} — ${label(briefing.summary)}`);
    return finish(briefing, result.outcome);
  }

  private async synthesize(manifest: Manifest, result: AgentRunResult): Promise<Briefing> {
    const { tasks } = await this.deps.bundle.tasks();
    const open = tasks.filter((t: TaskItem) => t.status !== 'done');
    const note = incompleteNote(result);
    const summary = note ?? (result.text.trim() || 'The turn ended without a report from the model.');
    return {
      slug: manifest.slug,
      title: manifest.title,
      status: manifest.status,
      priority: manifest.priority,
      summary: summary.slice(0, SUMMARY_LIMIT),
      progress: { done: tasks.length - open.length, total: tasks.length },
      blockers: [...(note ? [note] : []), ...open.filter((t) => t.status === 'blocked').map((t) => t.title)],
      nextSteps: open.filter((t) => t.status !== 'blocked').slice(0, SYNTHESIZED_NEXT_STEPS).map((t) => t.title),
      updatedAt: Date.now(),
    };
  }
}

/** Why a hub-stopped turn never got to report: a restart/redeploy, or the 20-minute turn cap — never the model. */
const CUT_SHORT = 'The turn was cut short (the hub stopped, or the turn hit its time limit)';

/**
 * What a turn that ran out of room (or failed) says instead of its own last words. The model's final
 * assistant text there is mid-thought — "let me try a smaller range" — and publishing it as the
 * project's summary tells the master something that was never reported.
 */
function incompleteNote(result: AgentRunResult): string | null {
  if (result.outcome === 'budget-exhausted') {
    return `The turn hit its tool-call budget (${ORCHESTRATOR_TOOL_CALLS}) before reporting; ${result.toolCalls} tool calls were made, last action: ${result.lastTool ?? 'none'}.`;
  }
  if (result.outcome === 'aborted') {
    return `${CUT_SHORT} before reporting; ${result.toolCalls} tool calls were made, last action: ${result.lastTool ?? 'none'}.`;
  }
  if (result.outcome === 'error') {
    return `The turn ended with an error before reporting; ${result.toolCalls} tool calls were made, last action: ${result.lastTool ?? 'none'}.`;
  }
  return null;
}

/** Same reason, without the in-progress detail, for a turn that falls back to the last good briefing. */
function earlyEndNote(outcome: AgentRunResult['outcome']): string {
  return outcome === 'aborted' ? `${CUT_SHORT} before it could report.` : `The turn ended ${outcome} without a briefing.`;
}
