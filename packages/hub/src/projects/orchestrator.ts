import type { ModelGateway } from '../gateway.js';
import type { JobQueue } from '../queue.js';
import type { NodeRegistry } from '../node-registry.js';
import type { AgentLoop } from '../agents/loop.js';
import type { Transcript } from '../agents/transcript.js';
import { bundleTools, hubTools, spawnSubagentTool, workspaceTools, type Tool } from '../agents/tools.js';
import { browserTools } from '../agents/browser-tools.js';
import type { LeaseManager } from '../browser/lease.js';
import type { BrowserProxy } from '../browser/proxy.js';
import type { ProjectBundle } from './bundle.js';
import { orchestratorSystemPrompt } from './prompts.js';
import type { Briefing, Manifest, TaskItem } from './schema.js';

const ORCHESTRATOR_TOOL_CALLS = 12;
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
    const { bundle, loop, queue, registry, transcript, leases, browser, external } = this.deps;
    const manifest = await bundle.manifest();
    const before = await bundle.latestBriefing();
    const browserDeps = leases && browser ? { leases, proxy: browser } : undefined;

    const result = await loop.run({
      kind: 'orchestrator',
      subject: manifest.slug,
      tier: 'orchestrator',
      system: orchestratorSystemPrompt(await bundle.contextPack()),
      user: opts.instruction ?? DEFAULT_INSTRUCTION,
      tools: [
        ...workspaceTools(),
        ...bundleTools(),
        ...hubTools(),
        ...(external ?? []),
        ...(browserDeps ? browserTools(browserDeps, 'orchestrator') : []),
        spawnSubagentTool({ loop, subject: manifest.slug, browser: browserDeps, external }),
      ],
      ctx: { bundle, hub: { queue, nodes: registry } },
      maxToolCalls: ORCHESTRATOR_TOOL_CALLS,
      signal: opts.signal,
    });
    const n = ++this.turns;

    // `publish_briefing` commits its own write, so the published path needs nothing further here.
    const published = await bundle.latestBriefing();
    if (published && published.updatedAt !== before?.updatedAt) return published;

    const endedEarly = result.outcome === 'aborted' || result.outcome === 'error';
    if (endedEarly) transcript.appendEvent(result.sessionId, `turn ${n} ended ${result.outcome} without a briefing`);
    // An interrupted turn only saw part of the project. Overwriting the last good briefing with
    // whatever it managed to say would tell the master *less* than it already knows.
    if (endedEarly && before) return before;

    // Otherwise the master still needs a report: synthesize one from the board and what was said.
    const briefing = await this.synthesize(manifest, result.text);
    await bundle.publishBriefing(briefing);
    await bundle.commit(`agent: turn ${n} — ${label(briefing.summary)}`);
    return briefing;
  }

  private async synthesize(manifest: Manifest, lastText: string): Promise<Briefing> {
    const { tasks } = await this.deps.bundle.tasks();
    const open = tasks.filter((t: TaskItem) => t.status !== 'done');
    const summary = lastText.trim() || 'The turn ended without a report from the model.';
    return {
      slug: manifest.slug,
      title: manifest.title,
      status: manifest.status,
      priority: manifest.priority,
      summary: summary.slice(0, SUMMARY_LIMIT),
      progress: { done: tasks.length - open.length, total: tasks.length },
      blockers: open.filter((t) => t.status === 'blocked').map((t) => t.title),
      nextSteps: open.filter((t) => t.status !== 'blocked').slice(0, SYNTHESIZED_NEXT_STEPS).map((t) => t.title),
      updatedAt: Date.now(),
    };
  }
}
