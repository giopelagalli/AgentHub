import type { ChatMessage, ChatResult, Tier } from '@agenthub/shared';
import type { ModelGateway } from '../gateway.js';
import { runToolCall, type Tool, type ToolContext } from './tools.js';
import type { SessionKind, SessionOutcome, Transcript } from './transcript.js';

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
  ctx: Omit<ToolContext, 'sessionId' | 'log'>;
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
    const sessionId = transcript.startSession(opts.kind, opts.subject, opts.tier);
    const ctx: ToolContext = { ...opts.ctx, sessionId, log: (line) => opts.onLog?.(line), signal: opts.signal };
    const toolDefs = opts.tools.map((t) => t.def);

    const system: ChatMessage = { role: 'system', content: opts.system };
    const user: ChatMessage = { role: 'user', content: opts.user };
    const messages: ChatMessage[] = [system, ...(opts.history ?? []), user];
    for (const m of [system, user]) transcript.append(sessionId, m);

    let toolCalls = 0;
    let text = '';
    let truncated = false;

    const finish = (outcome: SessionOutcome): AgentRunResult => {
      transcript.endSession(sessionId, outcome);
      return { sessionId, text, toolCalls, outcome, truncated };
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
        answer(call, await runToolCall(opts.tools, call, ctx));
      }
    }
  }
}
