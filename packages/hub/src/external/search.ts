import type { Tool } from '../agents/tools.js';
import { callExternal, type ToolAudit } from './audit.js';

export const SEARCH_PROVIDERS = ['brave', 'tavily'] as const;
export type SearchProvider = (typeof SEARCH_PROVIDERS)[number];

export const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search';
export const TAVILY_URL = 'https://api.tavily.com/search';

const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 20;

export interface SearchDeps {
  audit: ToolAudit;
  provider: SearchProvider;
  apiKey: string;
  timeoutMs: number;
  /** Overrides the provider's endpoint; tests point it at a local fake. */
  baseUrl?: string;
}

export interface SearchHit { title: string; url: string; snippet: string; }

const str = (args: unknown, key: string): string => {
  const v = (args && typeof args === 'object' ? (args as Record<string, unknown>) : {})[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${key} must be a non-empty string`);
  return v;
};

const count = (args: unknown): number => {
  const v = (args && typeof args === 'object' ? (args as Record<string, unknown>) : {}).n;
  if (v === undefined || v === null) return DEFAULT_RESULTS;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new Error('n must be a positive integer');
  return Math.min(v, MAX_RESULTS);
};

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Both providers answer the same question in their own shape; the tool speaks one shape to agents. */
function hitsFrom(provider: SearchProvider, body: unknown): SearchHit[] {
  if (provider === 'brave') {
    const results = (body as { web?: { results?: unknown[] } }).web?.results ?? [];
    return results.map((r) => {
      const hit = r as Record<string, unknown>;
      return { title: text(hit.title), url: text(hit.url), snippet: text(hit.description) };
    });
  }
  const results = (body as { results?: unknown[] }).results ?? [];
  return results.map((r) => {
    const hit = r as Record<string, unknown>;
    return { title: text(hit.title), url: text(hit.url), snippet: text(hit.content) };
  });
}

export function searchTools(deps: SearchDeps): Tool[] {
  return [
    {
      def: {
        type: 'tool', name: 'web_search',
        description: 'Search the web. The query leaves the owner\'s machines and is logged in the audit trail.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to search for.' },
            n: { type: 'number', description: `How many results to return; defaults to ${DEFAULT_RESULTS}.` },
          },
          required: ['query'],
        },
      },
      run: async (args, ctx) => {
        try {
          const query = str(args, 'query');
          const n = count(args);
          const call: { url: string; headers: Record<string, string>; body?: unknown } = deps.provider === 'brave'
            ? {
                url: `${deps.baseUrl ?? BRAVE_URL}?q=${encodeURIComponent(query)}&count=${n}`,
                headers: { 'x-subscription-token': deps.apiKey },
              }
            : {
                url: deps.baseUrl ?? TAVILY_URL,
                headers: { authorization: `Bearer ${deps.apiKey}` },
                body: { query, max_results: n },
              };
          const body = await callExternal(deps.audit, {
            tool: 'web_search', purpose: query, timeoutMs: deps.timeoutMs, sessionId: ctx.sessionId, ...call,
          });
          const hits = hitsFrom(deps.provider, body).slice(0, n);
          return hits.length ? JSON.stringify(hits, null, 2) : '(no results)';
        } catch (e) {
          return `error: ${(e as Error).message}`;
        }
      },
    },
  ];
}
