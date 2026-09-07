import type { Tool, ToolContext } from '../agents/tools.js';
import type { ConfirmationGate } from '../assistant/confirm.js';
import { callExternal, type ToolAudit } from './audit.js';

/** xAI's OpenAI-shaped chat completions endpoint. */
export const XAI_CHAT_URL = 'https://api.x.ai/v1/chat/completions';
/** X (Twitter) API v2 post endpoint. Different service, different token — see deploy/external-apis.md. */
export const X_POST_URL = 'https://api.x.com/2/tweets';
export const DEFAULT_XAI_MODEL = 'grok-4';

/** A posted tweet, as much of it as the audit and the owner care about. */
const POST_LIMIT = 280;

export interface XaiDeps {
  audit: ToolAudit;
  apiKey: string;
  timeoutMs: number;
  model?: string;
  chatUrl?: string;
  postUrl?: string;
  /** Token for the X API itself; without one, posting falls back to the xAI key. */
  postKey?: string;
  /** Present only for the owner's assistant: posting is an outward action and must be proposed. */
  gate?: ConfirmationGate;
}

const str = (args: unknown, key: string): string => {
  const v = (args && typeof args === 'object' ? (args as Record<string, unknown>) : {})[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${key} must be a non-empty string`);
  return v;
};

const sessionOf = (ctx: ToolContext) => ({ sessionId: ctx.sessionId });

export function xaiTools(deps: XaiDeps): Tool[] {
  const { audit, apiKey, timeoutMs } = deps;
  const auth = (key: string) => ({ authorization: `Bearer ${key}` });

  const query = async (prompt: string, session: { sessionId?: number }): Promise<string> => {
    const body = await callExternal(audit, {
      tool: 'grok_query', purpose: prompt, url: deps.chatUrl ?? XAI_CHAT_URL,
      headers: auth(apiKey), timeoutMs, ...session,
      body: { model: deps.model ?? DEFAULT_XAI_MODEL, messages: [{ role: 'user', content: prompt }] },
    }) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text) throw new Error('grok_query: no answer in the response');
    return text;
  };

  const post = async (text: string, session: { sessionId?: number }): Promise<string> => {
    const body = await callExternal(audit, {
      tool: 'post_to_x', purpose: text, url: deps.postUrl ?? X_POST_URL,
      headers: auth(deps.postKey ?? apiKey), timeoutMs, body: { text }, ...session,
    }) as { data?: { id?: string } };
    return `posted to X (${body.data?.id ?? 'unknown id'}): ${text}`;
  };

  const tools: Tool[] = [
    {
      def: {
        type: 'tool', name: 'grok_query',
        description: 'Ask Grok (xAI) a question. This leaves the owner\'s machines and is logged in the audit trail.',
        parameters: {
          type: 'object',
          properties: { prompt: { type: 'string', description: 'The question or instruction for Grok.' } },
          required: ['prompt'],
        },
      },
      run: async (args, ctx) => {
        try {
          return await query(str(args, 'prompt'), sessionOf(ctx));
        } catch (e) {
          return `error: ${(e as Error).message}`;
        }
      },
    },
  ];

  if (deps.gate) {
    const gate = deps.gate;
    tools.push({
      def: {
        type: 'tool', name: 'post_to_x',
        description: 'Post to the owner\'s X account. Proposes the post for the owner to confirm; nothing is sent until they do.',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string', description: `The post, at most ${POST_LIMIT} characters.` } },
          required: ['text'],
        },
      },
      outward: true,
      run: async (args, ctx) => {
        const text = str(args, 'text');
        if (text.length > POST_LIMIT) return `error: a post is at most ${POST_LIMIT} characters`;
        const session = sessionOf(ctx);
        const action = gate.propose(`post to X: "${text}"`, () => post(text, session));
        return `pending confirmation ${action.id}`;
      },
    });
  }
  return tools;
}
