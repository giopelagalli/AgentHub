import type { ChatMessage, ChatResult, Tier } from '@agenthub/shared';
import type { ModelGateway, Route } from '../gateway.js';
import { runToolCall, type Tool, type ToolContext } from './tools.js';
import type { SessionKind, SessionOutcome, Transcript } from './transcript.js';

/** What an `outward` tool must return: a `ConfirmationGate` proposal id, never a done-it result. */
const OUTWARD_RESULT_RE = /^pending confirmation /;

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
  /** Called with true when a roster member's run starts and false when it ends, for a "working" dot. */
  onBusy?: (busy: boolean) => void;
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
  constructor(private deps: { gateway: ModelGateway; transcript: Transcript }) {}

  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    const { transcript, gateway } = this.deps;
    const sessionId = transcript.startSession(opts.kind, opts.subject, opts.tier, opts.memberId ? { memberId: opts.memberId } : {});
    if (opts.memberId) opts.onBusy?.(true);
    const ctx: ToolContext = { ...opts.ctx, sessionId, log: (line) => opts.onLog?.(line), signal: opts.signal };
    const toolDefs = opts.tools.map((t) => t.def);

    const system: ChatMessage = { role: 'system', content: opts.system };
    const user: ChatMessage = { role: 'user', content: opts.user };
    const messages: ChatMessage[] = [system, ...(opts.history ?? []), user];
    for (const m of [system, user]) transcript.append(sessionId, m);

    let toolCalls = 0;
    let text = '';
    let truncated = false;
    let lastTool: string | undefined;

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
        answer(call, this.checkOutward(opts.tools, call, sessionId, await runToolCall(opts.tools, call, ctx)));
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
