import type { ProjectBundle } from '../../projects/bundle.js';
import { subagentSystemPrompt } from '../../projects/prompts.js';
import type { AgentLoop } from '../loop.js';
import type { Tool } from '../tools.js';
import type { Harness, HarnessContext, HarnessResult, HarnessTask } from './index.js';

export interface BuiltinHarnessDeps {
  loop: AgentLoop;
  /**
   * Builds this run's tool belt, told each workspace-relative path it writes. A factory rather than
   * a list because the belt reports its own writes, and that is where `filesWritten` comes from.
   */
  tools: (onWrite: (path: string) => void) => Tool[];
  /** Tool names beyond the workspace ones, named in the system prompt. */
  extraToolNames: string[];
  /** The bundle a subagent's tools are scoped to. */
  bundle?: ProjectBundle;
  onBusy?: (busy: boolean) => void;
}

/**
 * The hub's own tool loop, behind the `Harness` interface. This is the path every subagent took
 * before harnesses existed and still takes by default: one `loop.run` on the worker tier, with the
 * loop opening the session, persisting the conversation and emitting the run's events.
 */
export function builtinHarness(deps: BuiltinHarnessDeps): Harness {
  return {
    kind: 'builtin',
    async run(task: HarnessTask, ctx: HarnessContext): Promise<HarnessResult> {
      const written: string[] = [];
      const tools = deps.tools((p) => { if (!written.includes(p)) written.push(p); });
      const res = await deps.loop.run({
        kind: 'subagent',
        subject: ctx.subject,
        tier: 'worker',
        system: subagentSystemPrompt(task.role, deps.extraToolNames, task.instructions),
        user: task.task,
        tools,
        who: ctx.who,
        ...(task.member ? { memberId: task.member.id, onBusy: deps.onBusy } : {}),
        ...(task.route ? { route: task.route } : {}),
        // No hub: a subagent gets its workspace and nothing else — no queue, no node registry.
        ctx: { bundle: deps.bundle },
        maxToolCalls: task.budget.toolCalls,
        signal: task.signal,
        onLog: ctx.log,
        onEvent: ctx.onEvent,
      });
      return {
        report: res.text,
        filesWritten: written,
        outcome: res.outcome,
        sessionId: res.sessionId,
        toolCalls: res.toolCalls,
        truncated: res.truncated,
        ...(res.lastTool ? { lastTool: res.lastTool } : {}),
      };
    },
  };
}
