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
    const ctx: ToolContext = { ...opts.ctx, sessionId, log: (line) => opts.onLog?.(line) };
    const toolDefs = opts.tools.map((t) => t.def);

    const messages: ChatMessage[] = [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ];
    for (const m of messages) transcript.append(sessionId, m);

    let toolCalls = 0;
    let text = '';

    const finish = (outcome: SessionOutcome): AgentRunResult => {
      transcript.endSession(sessionId, outcome);
      return { sessionId, text, toolCalls, outcome };
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
        if (!aborted) transcript.append(sessionId, { role: 'system', content: `error: ${(err as Error).message}` });
        return finish(aborted ? 'aborted' : 'error');
      }

      text = result.content;
      const assistant: ChatMessage = {
        role: 'assistant',
        content: result.content || null,
        ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}),
      };
      messages.push(assistant);
      transcript.append(sessionId, assistant);

      if (result.toolCalls.length === 0) return finish('stop');

      for (const call of result.toolCalls) {
        if (toolCalls >= opts.maxToolCalls) {
          transcript.append(sessionId, { role: 'system', content: `budget-exhausted: tool call budget of ${opts.maxToolCalls} reached` });
          return finish('budget-exhausted');
        }
        toolCalls++;
        const content = await runToolCall(opts.tools, call, ctx);
        const toolMessage: ChatMessage = { role: 'tool', tool_call_id: call.id, content };
        messages.push(toolMessage);
        transcript.append(sessionId, toolMessage);
      }
    }
  }
}
