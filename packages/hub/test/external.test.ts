import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb } from '../src/db.js';
import { ToolAudit } from '../src/external/audit.js';
import { externalTools } from '../src/external/index.js';
import { ConfirmationGate } from '../src/assistant/confirm.js';
import { createHub, type Hub } from '../src/server.js';
import type { Tool, ToolContext } from '../src/agents/tools.js';

const SESSION = 7;
const ctx: ToolContext = { sessionId: SESSION, log: () => {} };

let servers: FastifyInstance[] = [];
let hub: Hub | undefined;

afterEach(async () => {
  for (const s of servers) await s.close();
  servers = [];
  await hub?.stop();
  hub = undefined;
});

interface Recorded { url: string; headers: Record<string, string | undefined>; body: unknown; }

/** A stand-in for one cloud endpoint. Nothing in this file ever reaches the internet. */
async function fake(handler: (rec: Recorded) => unknown, opts: { hang?: boolean } = {}): Promise<{ url: string; calls: Recorded[] }> {
  const app = Fastify();
  const calls: Recorded[] = [];
  app.all('/*', async (req, reply) => {
    calls.push({ url: req.url, headers: req.headers as Record<string, string | undefined>, body: req.body });
    if (opts.hang) return new Promise<never>(() => {});
    return reply.send(handler(calls[calls.length - 1]!));
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  servers.push(app);
  return { url: `http://127.0.0.1:${(app.server.address() as { port: number }).port}`, calls };
}

const audit = (): ToolAudit => new ToolAudit(openDb(':memory:'));

const byName = (tools: Tool[], name: string): Tool => {
  const tool = tools.find((t) => t.def.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
};

describe('grok_query', () => {
  it('calls xAI chat completions and audits the call', async () => {
    const xai = await fake(() => ({ choices: [{ message: { content: 'the answer' } }] }));
    const log = new ToolAudit(openDb(':memory:'));
    const tools = externalTools({
      audit: log, options: { xaiKey: 'k-xai', baseUrls: { xaiChat: `${xai.url}/v1/chat/completions` } }, log: () => {},
    });

    const out = await byName(tools, 'grok_query').run({ prompt: 'why is the sky blue?' }, ctx);
    expect(out).toBe('the answer');

    const call = xai.calls[0]!;
    expect(call.url).toBe('/v1/chat/completions');
    expect(call.headers.authorization).toBe('Bearer k-xai');
    expect(call.body).toMatchObject({ model: 'grok-4', messages: [{ role: 'user', content: 'why is the sky blue?' }] });

    const [row] = log.list();
    expect(row).toMatchObject({ tool: 'grok_query', purpose: 'why is the sky blue?', ok: true, sessionId: SESSION });
    expect(row!.requestBytes).toBeGreaterThan(0);
    expect(row!.responseBytes).toBeGreaterThan(0);
  });

  it('reports an endpoint failure as an error result and audits it as failed', async () => {
    const xai = await fake(() => { throw new Error('boom'); });
    const log = audit();
    const tools = externalTools({ audit: log, options: { xaiKey: 'k', baseUrls: { xaiChat: xai.url } }, log: () => {} });

    const out = await byName(tools, 'grok_query').run({ prompt: 'hi' }, ctx);
    expect(out).toMatch(/^error: grok_query failed: HTTP 500/);
    expect(log.list()[0]).toMatchObject({ tool: 'grok_query', ok: false });
  });

  it('gives up on a hung endpoint and audits the timeout', async () => {
    const xai = await fake(() => ({}), { hang: true });
    const log = audit();
    const tools = externalTools({
      audit: log, options: { xaiKey: 'k', timeoutMs: 50, baseUrls: { xaiChat: xai.url } }, log: () => {},
    });

    const out = await byName(tools, 'grok_query').run({ prompt: 'hi' }, ctx);
    expect(out).toBe('error: grok_query timed out after 50ms');
    expect(log.list()[0]).toMatchObject({ tool: 'grok_query', ok: false, responseBytes: 0 });
  });
});

describe('post_to_x', () => {
  it('proposes the post and only calls X once the owner confirms', async () => {
    const x = await fake(() => ({ data: { id: '1234' } }));
    const log = audit();
    const gate = new ConfirmationGate();
    const tools = externalTools({
      audit: log, gate, options: { xaiKey: 'k-xai', xPostKey: 'k-x', baseUrls: { xPost: `${x.url}/2/tweets` } }, log: () => {},
    });
    const post = byName(tools, 'post_to_x');
    expect(post.outward).toBe(true);

    const pending = await post.run({ text: 'hello world' }, ctx);
    expect(pending).toMatch(/^pending confirmation /);
    expect(x.calls).toHaveLength(0);
    expect(log.list()).toHaveLength(0);

    const result = await gate.confirm(gate.pending()[0]!.id);
    expect(result).toBe('posted to X (1234): hello world');
    expect(x.calls[0]).toMatchObject({ url: '/2/tweets', body: { text: 'hello world' } });
    expect(x.calls[0]!.headers.authorization).toBe('Bearer k-x');
    expect(log.list()[0]).toMatchObject({ tool: 'post_to_x', ok: true, sessionId: SESSION });
  });
});

describe('youtube_understand', () => {
  it('sends the video URL to Gemini as a file_data part', async () => {
    const gemini = await fake(() => ({ candidates: [{ content: { parts: [{ text: 'a cat, mostly' }] } }] }));
    const log = audit();
    const tools = externalTools({
      audit: log, options: { geminiKey: 'k-gem', baseUrls: { gemini: `${gemini.url}/v1beta` } }, log: () => {},
    });

    const url = 'https://www.youtube.com/watch?v=abc123';
    const out = await byName(tools, 'youtube_understand').run({ url, question: 'what happens?' }, ctx);
    expect(out).toBe('a cat, mostly');

    const call = gemini.calls[0]!;
    expect(call.url).toBe('/v1beta/models/gemini-2.5-flash:generateContent');
    expect(call.headers['x-goog-api-key']).toBe('k-gem');
    expect(call.body).toEqual({
      contents: [{ parts: [{ file_data: { file_uri: url } }, { text: 'what happens?' }] }],
    });
    expect(log.list()[0]).toMatchObject({ tool: 'youtube_understand', ok: true });
  });

  it('refuses a URL that is not a YouTube video without calling out', async () => {
    const gemini = await fake(() => ({}));
    const log = audit();
    const tools = externalTools({
      audit: log, options: { geminiKey: 'k', baseUrls: { gemini: gemini.url } }, log: () => {},
    });

    expect(await byName(tools, 'youtube_understand').run({ url: 'https://example.com/clip.mp4' }, ctx))
      .toBe('error: url must be a YouTube video URL');
    expect(gemini.calls).toHaveLength(0);
    expect(log.list()).toHaveLength(0);
  });
});

describe('web_search', () => {
  it('queries Brave and maps its results', async () => {
    const brave = await fake(() => ({
      web: { results: [{ title: 'Fastify', url: 'https://fastify.dev', description: 'a web framework' }] },
    }));
    const log = audit();
    const tools = externalTools({
      audit: log, options: { search: { provider: 'brave', key: 'k-brave' }, baseUrls: { search: `${brave.url}/res/v1/web/search` } }, log: () => {},
    });

    const out = await byName(tools, 'web_search').run({ query: 'fastify docs', n: 3 }, ctx);
    expect(JSON.parse(out)).toEqual([{ title: 'Fastify', url: 'https://fastify.dev', snippet: 'a web framework' }]);

    const call = brave.calls[0]!;
    expect(call.url).toBe('/res/v1/web/search?q=fastify%20docs&count=3');
    expect(call.headers['x-subscription-token']).toBe('k-brave');
    expect(log.list()[0]).toMatchObject({ tool: 'web_search', purpose: 'fastify docs', ok: true });
  });

  it('queries Tavily and maps its results', async () => {
    const tavily = await fake(() => ({ results: [{ title: 'T', url: 'https://t.example', content: 'snippet' }] }));
    const log = audit();
    const tools = externalTools({
      audit: log, options: { search: { provider: 'tavily', key: 'k-tav' }, baseUrls: { search: `${tavily.url}/search` } }, log: () => {},
    });

    const out = await byName(tools, 'web_search').run({ query: 'tavily' }, ctx);
    expect(JSON.parse(out)).toEqual([{ title: 'T', url: 'https://t.example', snippet: 'snippet' }]);
    expect(tavily.calls[0]).toMatchObject({ url: '/search', body: { query: 'tavily', max_results: 5 } });
    expect(tavily.calls[0]!.headers.authorization).toBe('Bearer k-tav');
  });
});

describe('configuration', () => {
  it('builds no tool without keys and says so once per tool', () => {
    const lines: string[] = [];
    const tools = externalTools({ audit: audit(), log: (line) => lines.push(line) });
    expect(tools).toHaveLength(0);
    expect(lines).toEqual([
      '[external] XAI_API_KEY not set; grok_query and post_to_x are disabled',
      '[external] GEMINI_API_KEY not set; youtube_understand is disabled',
      '[external] SEARCH_API_KEY/SEARCH_PROVIDER not set; web_search is disabled',
    ]);
  });

  it('offers post_to_x only where there is a gate to propose through', () => {
    const names = (gate?: ConfirmationGate) => externalTools({
      audit: audit(), options: { xaiKey: 'k' }, log: () => {}, ...(gate ? { gate } : {}),
    }).map((t) => t.def.name);
    expect(names()).toEqual(['grok_query']);
    expect(names(new ConfirmationGate())).toEqual(['grok_query', 'post_to_x']);
  });
});

describe('GET /api/audit', () => {
  it('is the owner\'s and lists rows newest first', async () => {
    hub = createHub({ auth: { password: 'pw', sessionSecret: 'secret' } });
    const log = new ToolAudit(hub.db);
    log.record({ tool: 'web_search', purpose: 'first', requestBytes: 10, responseBytes: 20, ok: true, sessionId: 1 });
    log.record({ tool: 'grok_query', purpose: 'second', requestBytes: 30, responseBytes: 0, ok: false });

    expect((await hub.app.inject({ method: 'GET', url: '/api/audit' })).statusCode).toBe(401);

    const login = await hub.app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
    const cookie = login.headers['set-cookie'] as string;

    const res = await hub.app.inject({ method: 'GET', url: '/api/audit?limit=1', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([{ tool: 'grok_query', purpose: 'second', ok: false, sessionId: null }]);

    const all = await hub.app.inject({ method: 'GET', url: '/api/audit', headers: { cookie } });
    expect(all.json().map((r: { tool: string }) => r.tool)).toEqual(['grok_query', 'web_search']);

    const bad = await hub.app.inject({ method: 'GET', url: '/api/audit?limit=0', headers: { cookie } });
    expect(bad.statusCode).toBe(400);
  });
});
