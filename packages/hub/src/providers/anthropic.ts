import type Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, ChatResult, TokenUsage, ToolCall, ToolDef } from '@agenthub/shared';

/** Tier defaults for the synthetic cloud node (see `HubOptions.cloud`). */
export const DEFAULT_ORCHESTRATOR_MODEL = 'claude-opus-4-8';
export const DEFAULT_WORKER_MODEL = 'claude-sonnet-5';

/** Matches what a local endpoint is given; long answers stream, so this is a ceiling, not a target. */
const MAX_TOKENS = 16_000;

/**
 * The slice of the Anthropic SDK client this provider uses. A real `Anthropic` satisfies it; tests
 * inject a fake so no request ever leaves the machine.
 */
export interface AnthropicLike {
  messages: {
    stream(body: Anthropic.MessageStreamParams, options?: { signal?: AbortSignal | null }): AnthropicStream;
  };
}

export interface AnthropicStream {
  on(event: 'text', listener: (delta: string) => void): unknown;
  finalMessage(): Promise<Anthropic.Message>;
}

export interface AnthropicChatParams {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  onToken?: (t: string) => void;
  signal?: AbortSignal;
  /**
   * Receives the final message's token counts. A callback rather than a field on `ChatResult`
   * because pricing and attribution (which node, which provider) are the gateway's business, not
   * this module's — and a refusal returns early, so there is only one place that reports them.
   */
  onUsage?: (usage: TokenUsage) => void;
}

/**
 * A tool call's arguments travel as JSON *text* through the gateway (the OpenAI shape), but the
 * Messages API wants the parsed object. A model that emitted nothing, or something unparseable,
 * means an empty input — not a request the hub should refuse to replay.
 */
function parseToolInput(args: string): Record<string, unknown> {
  if (!args.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(args);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Our `ChatMessage[]` → the Messages API shape. The two differ in three places: system prompts are
 * a top-level field rather than a turn, tool calls and their results are content blocks rather than
 * their own roles, and the API takes all the results of one assistant turn as a *single* user turn —
 * so consecutive `tool` messages merge into one.
 */
export function toAnthropicMessages(messages: ChatMessage[]): { system?: string; messages: Anthropic.MessageParam[] } {
  const systemParts: string[] = [];
  const out: Anthropic.MessageParam[] = [];
  // The open merged tool-result turn, or null when the last message was not a tool result.
  let openToolResults: Anthropic.ToolResultBlockParam[] | null = null;

  for (const msg of messages) {
    if (msg.role === 'system') { systemParts.push(msg.content); continue; }
    if (msg.role === 'tool') {
      const block: Anthropic.ToolResultBlockParam = {
        type: 'tool_result', tool_use_id: msg.tool_call_id, content: msg.content,
      };
      if (openToolResults) { openToolResults.push(block); continue; }
      openToolResults = [block];
      out.push({ role: 'user', content: openToolResults });
      continue;
    }
    openToolResults = null;
    if (msg.role === 'assistant') {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (msg.content) blocks.push({ type: 'text', text: msg.content });
      for (const call of msg.tool_calls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: parseToolInput(call.arguments) });
      }
      // An assistant turn with neither text nor tool calls is not a turn the API will accept.
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
      continue;
    }
    out.push({ role: 'user', content: msg.content });
  }
  return { ...(systemParts.length ? { system: systemParts.join('\n\n') } : {}), messages: out };
}

function toAnthropicTools(tools: ToolDef[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool.InputSchema,
  }));
}

/**
 * Whether a failed request is worth retrying on another endpoint: rate limits and server faults are,
 * a rejected request body is not. A non-HTTP failure (a dropped socket) has no status and is treated
 * as retryable, which is what the OpenAI path does with a failed `fetch`.
 */
export function isRetryableAnthropicError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status !== 'number') return true;
  return status === 429 || status >= 500;
}

/**
 * One chat turn against the Messages API, shaped like the gateway's OpenAI path: text streams
 * through `onToken`, the resolved `ChatResult` carries the whole answer, and any failure throws so
 * the gateway's failover can see it.
 */
export async function anthropicChat(client: AnthropicLike, params: AnthropicChatParams): Promise<ChatResult> {
  const { model, messages, tools, onToken, onUsage, signal } = params;
  const { system, messages: mapped } = toAnthropicMessages(messages);
  const stream = client.messages.stream({
    model,
    max_tokens: MAX_TOKENS,
    // Adaptive is the only accepted form on Opus 4.8 / Sonnet 5; `budget_tokens` is a 400 there.
    thinking: { type: 'adaptive' },
    ...(system ? { system } : {}),
    messages: mapped,
    ...(tools?.length ? { tools: toAnthropicTools(tools) } : {}),
  }, { signal });
  if (onToken) stream.on('text', (delta) => { if (delta.length) onToken(delta); });

  const final = await stream.finalMessage();
  // Guarded rather than assumed: a proxy (or a test double) that answers without a usage block must
  // cost the caller its accounting, not its turn.
  if (onUsage && final.usage) {
    onUsage({
      promptTokens: final.usage.input_tokens,
      cachedTokens: final.usage.cache_read_input_tokens ?? 0,
      completionTokens: final.usage.output_tokens,
    });
  }
  let content = '';
  const toolCalls: ToolCall[] = [];
  for (const block of final.content) {
    if (block.type === 'text') content += block.text;
    else if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
    }
  }
  if (final.stop_reason === 'refusal') {
    // A refusal ends the turn like any other stop; the caller gets a note rather than a half answer.
    return { content: `[refused: ${final.stop_details?.category ?? 'unspecified'}]`, toolCalls, finish: 'stop' };
  }
  const finish: ChatResult['finish'] =
    final.stop_reason === 'tool_use' ? 'tool_calls' : final.stop_reason === 'max_tokens' ? 'length' : 'stop';
  return { content, toolCalls, finish };
}
