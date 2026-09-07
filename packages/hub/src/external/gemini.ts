import type { Tool } from '../agents/tools.js';
import { callExternal, type ToolAudit } from './audit.js';

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const DEFAULT_QUESTION = 'Summarize this video.';

export interface GeminiDeps {
  audit: ToolAudit;
  apiKey: string;
  timeoutMs: number;
  model?: string;
  baseUrl?: string;
}

const YOUTUBE_RE = /^https:\/\/(www\.|m\.)?(youtube\.com\/watch\?|youtu\.be\/|youtube\.com\/shorts\/)/;

const str = (args: unknown, key: string): string => {
  const v = (args && typeof args === 'object' ? (args as Record<string, unknown>) : {})[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${key} must be a non-empty string`);
  return v;
};

const optStr = (args: unknown, key: string): string | undefined => {
  const v = (args && typeof args === 'object' ? (args as Record<string, unknown>) : {})[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`${key} must be a string`);
  return v;
};

/**
 * Gemini watches a YouTube video for us: the URL is handed over as a `file_data` part rather than
 * downloaded here, so the bytes never touch the owner's machines — only the URL and the question do.
 */
export function geminiTools(deps: GeminiDeps): Tool[] {
  const model = deps.model ?? DEFAULT_GEMINI_MODEL;
  const url = `${deps.baseUrl ?? GEMINI_BASE_URL}/models/${model}:generateContent`;
  return [
    {
      def: {
        type: 'tool', name: 'youtube_understand',
        description: 'Watch a YouTube video with Gemini and answer a question about it. The URL leaves the owner\'s machines and is logged in the audit trail.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'A YouTube video URL.' },
            question: { type: 'string', description: `What to answer about the video. Defaults to "${DEFAULT_QUESTION}"` },
          },
          required: ['url'],
        },
      },
      run: async (args, ctx) => {
        try {
          const videoUrl = str(args, 'url');
          if (!YOUTUBE_RE.test(videoUrl)) return 'error: url must be a YouTube video URL';
          const question = optStr(args, 'question') ?? DEFAULT_QUESTION;
          const body = await callExternal(deps.audit, {
            tool: 'youtube_understand', purpose: `${videoUrl} — ${question}`, url,
            headers: { 'x-goog-api-key': deps.apiKey }, timeoutMs: deps.timeoutMs, sessionId: ctx.sessionId,
            body: { contents: [{ parts: [{ file_data: { file_uri: videoUrl } }, { text: question }] }] },
          }) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
          const text = (body.candidates?.[0]?.content?.parts ?? [])
            .map((p) => p.text).filter((t): t is string => typeof t === 'string').join('\n').trim();
          if (!text) throw new Error('youtube_understand: no answer in the response');
          return text;
        } catch (e) {
          return `error: ${(e as Error).message}`;
        }
      },
    },
  ];
}
