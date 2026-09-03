import type { ModelGateway } from '../gateway.js';
import type { JobQueue } from '../queue.js';
import type { NodeRegistry } from '../node-registry.js';
import type { AgentLoop } from '../agents/loop.js';
import type { Transcript } from '../agents/transcript.js';
import { bundleTools, hubTools, spawnSubagentTool, workspaceTools } from '../agents/tools.js';
import type { ProjectBundle } from './bundle.js';
import { orchestratorSystemPrompt } from './prompts.js';
import type { Briefing, Manifest, TaskItem } from './schema.js';

const ORCHESTRATOR_TOOL_CALLS = 12;
const SUMMARY_LIMIT = 600;
const SYNTHESIZED_NEXT_STEPS = 5;

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
    const { bundle, loop, queue, registry } = this.deps;
    const manifest = await bundle.manifest();
    const before = await bundle.latestBriefing();

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
        spawnSubagentTool({ loop, subject: manifest.slug }),
      ],
      ctx: { bundle, hub: { queue, nodes: registry } },
      maxToolCalls: ORCHESTRATOR_TOOL_CALLS,
      signal: opts.signal,
    });

    // The master reads briefings and nothing else, so a turn always leaves one behind — even when
    // the model forgot to publish, ran out of budget, or died mid-turn.
    const published = await bundle.latestBriefing();
    let briefing = published;
    if (!briefing || briefing.updatedAt === before?.updatedAt) {
      briefing = await this.synthesize(manifest, result.text);
      await bundle.publishBriefing(briefing);
    }

    this.turns++;
    // Empty when the turn changed nothing: the marker commit is the turn boundary in bundle history.
    await bundle.commit(`agent: turn ${this.turns}`, { allowEmpty: true });
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
