import type { ChatMessage, ChatResult, ChatUsage, Tier, TurnEvent } from '@agenthub/shared';
import type { ModelGateway, Route } from '../gateway.js';
import { runToolCall, type Tool, type ToolContext } from './tools.js';
import type { SessionKind, SessionOutcome, Transcript } from './transcript.js';
import { BRIEFING_RESERVE } from './budgets.js';

/** What an `outward` tool must return: a `ConfirmationGate` proposal id, never a done-it result. */
const OUTWARD_RESULT_RE = /^pending confirmation /;

/** Caps on what a live event carries: a glance at what is happening, not the transcript itself. */
const EVENT_TEXT_LIMIT = 300;
const EVENT_SUMMARY_LIMIT = 200;

/** One line of at most `limit` chars, with an ellipsis where it was cut. */
export function clip(text: string, limit: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= limit ? line : `${line.slice(0, limit - 1)}\u2026`;
}

/** One model call's cost, with everything the ledger needs to attribute it. */
export interface LoopUsage {
  sessionId: number;
  /** The run's `usageKind`, else its session kind. */
  kind: string;
  subject: string;
  memberId?: string;
  usage: ChatUsage;
}

export interface AgentRunOptions {
  kind: SessionKind;
  subject: string;
  tier: Tier;
  system: string;
  user: string;
  /**
   * Earlier turns replayed to the model ahead of `user`. Already persisted under the sessions they
   * came from, so this run's transcript records only its own system and user messages.
   */
  history?: ChatMessage[];
  tools: Tool[];
  /** The project roster member this run belongs to; tags the session so the team API can find it. */
  memberId?: string;
  /**
   * What this run is called in the cost ledger, when that differs from its session kind — the PRD
   * drafter runs as a `chat` session but its spend is planning, not conversation.
   */
  usageKind?: string;
  /**
   * The `who` this run's own events carry, overriding the default derived from `memberId`/`kind`.
   * A roster-less subagent (no `memberId`) is still attributed to its role — `spawn_subagent` passes
   * the same `who` it used for the run's `subagent-start`/`subagent-end` bracket, so every event in
   * the turn feed agrees on who did it.
   */
  who?: string;
  /** Called with true when a roster member's run starts and false when it ends, for a "working" dot. */
  onBusy?: (busy: boolean) => void;
  /** Called with the session id as soon as it exists, before the first model call. */
  onStart?: (sessionId: number) => void;
  /**
   * Receives every live event of this run — its text, tool calls and results, plus whatever its
   * tools emit through `ToolContext.onEvent` (a spawned subagent's events, a verification). Each one
   * is also persisted under this run's session, so a turn can be replayed after a restart. `at` is
   * the timestamp it was persisted under — a caller that rebroadcasts the event should use it rather
   * than stamping its own, so the transcript and the broadcast never disagree.
   */
  onEvent?: (e: TurnEvent, at: number) => void;
  ctx: Omit<ToolContext, 'sessionId' | 'log'>;
  /** Which model serves this run's tier — a project's `modelPolicy`, resolved by `routeFor`. */
  route?: Route;
  maxToolCalls: number;
  signal?: AbortSignal;
  onToken?: (t: string) => void;
  /** Receives tool progress lines (what tools write via `ToolContext.log`). */
  onLog?: (line: string) => void;
}

export interface AgentRunResult {
  sessionId: number;
  text: string;
  toolCalls: number;
  outcome: SessionOutcome;
  /** The model hit its output limit on the final turn, so `text` is cut short. */
  truncated: boolean;
  /** The last tool the run actually executed; what "it got this far" means for a turn that ended early. */
  lastTool?: string;
}

/**
 * One bounded tool-use conversation: system+user in, model turns and tool results appended until the
 * model stops calling tools, the tool budget runs out, the run is aborted, or the gateway fails.
 * Every message is persisted to the transcript under one session id.
 */
export class AgentLoop {
  /**
   * `onUsage` is where every model call in the hub is reported: each run's chats go through here, so
   * one hook covers turns, subagents, chats, the PRD drafter and the owner's assistant alike.
   */
  constructor(private deps: { gateway: ModelGateway; transcript: Transcript; onUsage?: (u: LoopUsage) => void }) {}

  /**
   * The gateway and the transcript, for a run that does not go through `run()`. An external harness
   * (`agents/harness/`) resolves its own endpoint and keeps its own session, and everything that
   * hands work to a subagent already holds the loop — so it travels rather than being threaded
   * through every caller of `runSubagent` a second time.
   */
  get gateway(): ModelGateway { return this.deps.gateway; }
  get transcript(): Transcript { return this.deps.transcript; }

  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    const { transcript, gateway } = this.deps;
    const sessionId = transcript.startSession(opts.kind, opts.subject, opts.tier, opts.memberId ? { memberId: opts.memberId } : {});
    opts.onStart?.(sessionId);
    if (opts.memberId) opts.onBusy?.(true);
    // The orchestrator's own events read as the manager's; a roster member's carry their id; `who`
    // overrides both, so a roster-less subagent's events agree with its start/end bracket.
    const who = opts.who ?? opts.memberId ?? (opts.kind === 'orchestrator' ? 'manager' : opts.kind);
    const emit = (e: TurnEvent): void => {
      // Stamped once here, not separately by the persist path and by whatever rebroadcasts it, so
      // the transcript and the live socket frame always agree on when the event happened.
      const at = Date.now();
      transcript.appendTurnEvent(sessionId, e, at);
      opts.onEvent?.(e, at);
    };
    const ctx: ToolContext = { ...opts.ctx, sessionId, log: (line) => opts.onLog?.(line), signal: opts.signal, onEvent: emit };
    const toolDefs = opts.tools.map((t) => t.def);

    const system: ChatMessage = { role: 'system', content: opts.system };
    const user: ChatMessage = { role: 'user', content: opts.user };
    const messages: ChatMessage[] = [system, ...(opts.history ?? []), user];
    for (const m of [system, user]) transcript.append(sessionId, m);

    let toolCalls = 0;
    let text = '';
    let truncated = false;
    let lastTool: string | undefined;
    /** Set once the manager has been told its tool-call budget is running low (see below). */
    let briefingWarned = false;

    const finish = (outcome: SessionOutcome): AgentRunResult => {
      transcript.endSession(sessionId, outcome);
      if (opts.memberId) opts.onBusy?.(false);
      return { sessionId, text, toolCalls, outcome, truncated, ...(lastTool ? { lastTool } : {}) };
    };

    // Every tool_call in an assistant message must be answered by a tool message, or the transcript
    // can't be replayed to a model. Calls we decline to run get an explanatory result instead.
    const answer = (call: { id: string }, content: string): void => {
      const toolMessage: ChatMessage = { role: 'tool', tool_call_id: call.id, content };
      messages.push(toolMessage);
      transcript.append(sessionId, toolMessage);
    };

    for (;;) {
      if (opts.signal?.aborted) return finish('aborted');

      let result: ChatResult;
      try {
        result = await gateway.chat(opts.tier, messages, {
          onToken: opts.onToken,
          signal: opts.signal,
          ...(toolDefs.length ? { tools: toolDefs } : {}),
          ...(opts.route ? { route: opts.route } : {}),
        });
      } catch (err) {
        const aborted = opts.signal?.aborted || (err instanceof Error && err.name === 'AbortError');
        if (!aborted) transcript.appendEvent(sessionId, `gateway error: ${(err as Error).message}`);
        return finish(aborted ? 'aborted' : 'error');
      }

      text = result.content;
      truncated = result.finish === 'length' && result.toolCalls.length === 0;
      const assistant: ChatMessage = {
        role: 'assistant',
        content: result.content || null,
        ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}),
      };
      messages.push(assistant);
      transcript.append(sessionId, assistant);
      if (result.content.trim()) emit({ kind: 'text', who, text: clip(result.content, EVENT_TEXT_LIMIT) });

      // What that model turn cost, landing with the turn it paid for — and before the run can end,
      // so a run that stops right here is still accounted for. The event carries `who`, which is
      // what lets a project turn total its own and its subagents' spend from the same feed.
      if (result.usage) {
        this.deps.onUsage?.({
          sessionId,
          kind: opts.usageKind ?? opts.kind,
          subject: opts.subject,
          ...(opts.memberId ? { memberId: opts.memberId } : {}),
          usage: result.usage,
        });
        emit({
          kind: 'usage', who, usd: result.usage.usd,
          tokens: result.usage.promptTokens + result.usage.completionTokens,
        });
      }

      if (result.toolCalls.length === 0) return finish('stop');

      for (const [i, call] of result.toolCalls.entries()) {
        if (toolCalls >= opts.maxToolCalls) {
          for (const dropped of result.toolCalls.slice(i)) answer(dropped, 'error: tool budget exhausted');
          transcript.appendEvent(sessionId, `budget-exhausted: tool call budget of ${opts.maxToolCalls} reached`);
          return finish('budget-exhausted');
        }
        // Checked per call, not just per model turn: a long tool (run_shell) can span an abort.
        if (opts.signal?.aborted) {
          for (const dropped of result.toolCalls.slice(i)) answer(dropped, 'error: aborted');
          return finish('aborted');
        }
        toolCalls++;
        lastTool = call.name;
        emit({ kind: 'tool-call', who, tool: call.name, args: clip(call.arguments, EVENT_SUMMARY_LIMIT) });
        const startedAt = Date.now();
        const output = this.checkOutward(opts.tools, call, sessionId, await runToolCall(opts.tools, call, ctx));
        emit({
          kind: 'tool-result', who, tool: call.name, ok: !output.startsWith('error:'),
          summary: clip(output, EVENT_SUMMARY_LIMIT), ms: Date.now() - startedAt,
        });
        answer(call, output);

        // The manager (only) is nudged once, right as its room to wrap up gets tight, so a turn that
        // would otherwise keep delegating until the budget check above cuts it off instead leaves time
        // to call publish_briefing.
        if (opts.kind === 'orchestrator' && !briefingWarned && opts.maxToolCalls - toolCalls <= BRIEFING_RESERVE) {
          briefingWarned = true;
          const warn: ChatMessage = {
            role: 'user',
            content: `You have ${BRIEFING_RESERVE} tool calls left in this turn. Stop starting new work: finish what is in flight, then call publish_briefing now.`,
          };
          messages.push(warn);
          transcript.append(sessionId, warn);
        }
      }
    }
  }

  /**
   * A tool marked `outward` must not act — it proposes through the `ConfirmationGate` and hands back
   * that proposal's id. The convention is the whole guarantee that nothing reaches the outside world
   * unconfirmed, so it is checked here rather than trusted: a result that isn't a proposal means the
   * tool did something instead, and the model is told so rather than told it succeeded.
   */
  private checkOutward(tools: Tool[], call: { name: string }, sessionId: number, result: string): string {
    const tool = tools.find((t) => t.def.name === call.name);
    if (!tool?.outward || OUTWARD_RESULT_RE.test(result)) return result;
    console.error(`[loop] outward tool ${call.name} bypassed the confirmation gate: ${result}`);
    this.deps.transcript.appendEvent(sessionId, `outward-tool-bypass: ${call.name} did not return a pending confirmation`);
    return 'error: outward tool did not route through the confirmation gate';
  }
}
