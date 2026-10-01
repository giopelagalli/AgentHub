import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockOpenAI, type MockOpenAI, type ScriptStep } from '@agenthub/mocks';
import { routeAccess } from '../src/auth.js';
import { API_TOKEN_PREFIX, KIND_PRIORITY, type MintedApiToken, type TokenKind } from '../src/door.js';
import { DEFAULT_FIREWORKS_WORKER_MODEL, FIREWORKS_API_KEY_ENV } from '../src/providers/fireworks.js';
import { createHub, type Hub } from '../src/server.js';

const FIREWORKS_MODEL = DEFAULT_FIREWORKS_WORKER_MODEL;
const savedKey = process.env[FIREWORKS_API_KEY_ENV];

const hubs: Hub[] = [];
const mocks: MockOpenAI[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.stop();
  for (const mock of mocks.splice(0)) await mock.close();
  if (savedKey === undefined) delete process.env[FIREWORKS_API_KEY_ENV];
  else process.env[FIREWORKS_API_KEY_ENV] = savedKey;
});

/** A hub with one local node and the Fireworks tier, both served by the same strict mock. */
async function harness(script: ScriptStep[] = []): Promise<{ hub: Hub; mock: MockOpenAI; base: string }> {
  process.env[FIREWORKS_API_KEY_ENV] = 'fw-secret';
  const mock = createMockOpenAI({ script });
  mocks.push(mock);
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`;

  const hub = createHub({ staleMs: 60_000, cloud: { fireworks: { baseUrl: url } } });
  hubs.push(hub);
  await hub.app.inject({
    method: 'POST', url: '/api/nodes/register',
    payload: {
      name: 'spark', arch: 'arm64',
      endpoints: [
        { tier: 'orchestrator', url, model: 'local-orchestrator', maxStreams: 2 },
        { tier: 'worker', url, model: 'local-worker', maxStreams: 2, priority: 7 },
      ],
    },
  });
  await hub.app.listen({ port: 0, host: '127.0.0.1' });
  return { hub, mock, base: `http://127.0.0.1:${(hub.app.server.address() as { port: number }).port}` };
}

async function mint(hub: Hub, kind: TokenKind, label: string): Promise<MintedApiToken> {
  const res = await hub.app.inject({ method: 'POST', url: '/api/tokens', payload: { kind, label } });
  expect(res.statusCode).toBe(201);
  return res.json() as MintedApiToken;
}

const completions = (base: string, token: string, body: unknown): Promise<Response> =>
  fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

/** Every `data:` frame of an SSE body, `[DONE]` dropped. */
const frames = (body: string): Record<string, any>[] =>
  [...body.matchAll(/data: (.+)\n/g)].map((m) => m[1]).filter((d) => d !== '[DONE]').map((d) => JSON.parse(d));

const hello = [{ role: 'user', content: 'hello there' }];

describe('routeAccess', () => {
  it('classifies the door as its own kind, and minting tokens as the owner’s', () => {
    expect(routeAccess('POST', '/v1/chat/completions')).toBe('door');
    expect(routeAccess('GET', '/v1/models')).toBe('door');
    expect(routeAccess('POST', '/api/tokens')).toBe('owner');
    expect(routeAccess('GET', '/api/tokens')).toBe('owner');
    expect(routeAccess('DELETE', '/api/tokens/:id')).toBe('owner');
  });
});

describe('api tokens', () => {
  it('mints once, lists without the secret, and revokes', async () => {
    const { hub } = await harness();
    const minted = await mint(hub, 'agent', 'jd');
    expect(minted.token.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(minted.token.slice(API_TOKEN_PREFIX.length)).toMatch(/^[0-9a-f]{48}$/);
    expect(minted.kind).toBe('agent');
    expect(minted.user).toBe('admin');

    const list = (await hub.app.inject({ method: 'GET', url: '/api/tokens' })).json() as { tokens: unknown[] };
    expect(list.tokens).toHaveLength(1);
    expect(JSON.stringify(list.tokens)).not.toContain(minted.token);
    expect(list.tokens[0]).toMatchObject({ id: minted.id, kind: 'agent', label: 'jd', lastUsedAt: null });

    expect((await hub.app.inject({ method: 'DELETE', url: `/api/tokens/${minted.id}` })).statusCode).toBe(200);
    expect(((await hub.app.inject({ method: 'GET', url: '/api/tokens' })).json() as { tokens: unknown[] }).tokens).toEqual([]);
    expect((await hub.app.inject({ method: 'DELETE', url: `/api/tokens/${minted.id}` })).statusCode).toBe(404);
  });

  it('refuses a bad kind or an empty label', async () => {
    const { hub } = await harness();
    expect((await hub.app.inject({ method: 'POST', url: '/api/tokens', payload: { kind: 'root', label: 'x' } })).statusCode).toBe(400);
    expect((await hub.app.inject({ method: 'POST', url: '/api/tokens', payload: { kind: 'agent', label: '  ' } })).statusCode).toBe(400);
  });
});

describe('GET /v1/models', () => {
  it('lists the two tier names to a token holder and 401s without one', async () => {
    const { hub, base } = await harness();
    const token = await mint(hub, 'assistant', 'pi');

    const res = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${token.token}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { object: string; data: { id: string }[] };
    expect(body.object).toBe('list');
    expect(body.data.map((m) => m.id)).toEqual(['agenthub/orchestrator', 'agenthub/worker']);

    expect((await fetch(`${base}/v1/models`)).status).toBe(401);
  });
});

describe('POST /v1/chat/completions', () => {
  it('answers the OpenAI shape without streaming, and records the turn in the ledger', async () => {
    const { hub, base } = await harness();
    const token = await mint(hub, 'assistant', 'pi');

    const res = await completions(base, token.token, { model: 'agenthub/worker', messages: hello });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.object).toBe('chat.completion');
    expect(body.id).toMatch(/^chatcmpl-[0-9a-f]+$/);
    expect(body.model).toBe('local-worker');
    expect(body.choices[0]).toMatchObject({ index: 0, finish_reason: 'stop' });
    expect(body.choices[0].message).toEqual({ role: 'assistant', content: 'echo: hello there' });
    expect(body.usage.completion_tokens).toBeGreaterThan(0);
    expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens + body.usage.completion_tokens);

    const summary = hub.usage.summary({ since: 0 });
    expect(summary.bySubject).toEqual([{ subject: 'door:pi', usd: 0, tokens: expect.any(Number) }]);
    const row = hub.db.prepare('SELECT kind, member_id, session_id, subject FROM usage').get() as Record<string, unknown>;
    expect(row).toEqual({ kind: 'door', member_id: null, session_id: null, subject: 'door:pi' });
  });

  it("books a pi run token's spend to its project and member, and no other token's", async () => {
    const { hub, base } = await harness();
    const run = await mint(hub, 'agent', 'pi:demo/coder-1');
    // Only an `agent` token is a pi run's; an assistant token that happens to look like one is not.
    const lookalike = await mint(hub, 'assistant', 'pi:demo/coder-2');
    for (const token of [run, lookalike]) {
      expect((await completions(base, token.token, { model: 'agenthub/worker', messages: hello })).status).toBe(200);
    }

    const rows = hub.db.prepare('SELECT kind, member_id, subject FROM usage ORDER BY id').all();
    expect(rows).toEqual([
      { kind: 'door', member_id: 'coder-1', subject: 'demo' },
      { kind: 'door', member_id: null, subject: 'door:pi:demo/coder-2' },
    ]);
    // Which is what the project's own cost reads.
    expect(hub.usage.summary({ since: 0, subject: 'demo' }).bySubject).toEqual([
      { subject: 'demo', usd: 0, tokens: expect.any(Number) },
    ]);
  });

  it('revokes pi run tokens a crashed hub left live, and only those, at startup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agenthub-door-'));
    try {
      const dbPath = join(dir, 'hub.db');
      const first = createHub({ dbPath });
      const leftover = await mint(first, 'agent', 'pi:demo/coder-1');
      const kept = await mint(first, 'agent', 'jd');
      await first.stop();

      const second = createHub({ dbPath });
      hubs.push(second);
      const live = (await second.app.inject({ method: 'GET', url: '/api/tokens' })).json() as { tokens: { id: number }[] };
      expect(live.tokens.map((t) => t.id)).toEqual([kept.id]);
      expect(leftover.id).not.toBe(kept.id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('streams OpenAI chunks, with usage in the last one when asked for', async () => {
    const { hub, base } = await harness();
    const token = await mint(hub, 'assistant', 'pi');

    const res = await completions(base, token.token, {
      model: 'agenthub/orchestrator', messages: hello, stream: true, stream_options: { include_usage: true },
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const chunks = frames(await res.text());

    expect(chunks.every((c) => c.object === 'chat.completion.chunk')).toBe(true);
    expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant' });
    expect(chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('')).toBe('echo: hello there');
    const usageChunk = chunks[chunks.length - 1];
    expect(usageChunk.choices).toEqual([]);
    expect(usageChunk.usage.total_tokens).toBeGreaterThan(0);
    expect(chunks[chunks.length - 2].choices[0].finish_reason).toBe('stop');
  });

  it('leaves usage out of a stream that did not ask for it', async () => {
    const { hub, base } = await harness();
    const token = await mint(hub, 'assistant', 'pi');
    const res = await completions(base, token.token, { model: 'agenthub/worker', messages: hello, stream: true });
    const chunks = frames(await res.text());
    expect(chunks.some((c) => c.usage)).toBe(false);
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('stop');
  });

  it('routes a concrete cloud model to that provider, and counts it against the cloud cap', async () => {
    const { hub, base } = await harness();
    const token = await mint(hub, 'agent', 'jd');

    const res = await completions(base, token.token, { model: FIREWORKS_MODEL, messages: hello });
    expect(res.status).toBe(200);
    expect((await res.json() as { model: string }).model).toBe(FIREWORKS_MODEL);

    const summary = hub.usage.summary({ since: 0 });
    expect(summary.byModel[0]).toMatchObject({ provider: 'fireworks', model: FIREWORKS_MODEL });
    expect(hub.usage.cloudUsdSince(0)).toBeGreaterThan(0);
  });

  it('serves a concrete local model id from local endpoints only', async () => {
    const { hub, base } = await harness();
    const token = await mint(hub, 'agent', 'jd');
    const res = await completions(base, token.token, { model: 'local-orchestrator', messages: hello });
    expect((await res.json() as { model: string }).model).toBe('local-orchestrator');
    expect(hub.usage.summary({ since: 0 }).byModel[0]).toMatchObject({ provider: 'openai' });
  });

  it('round-trips tool calls: they come back on the wire and go back in as history', async () => {
    const { hub, base, mock } = await harness([
      { toolCalls: [{ name: 'read_file', arguments: { path: 'README.md' } }] },
      { content: 'It is a readme.' },
    ]);
    const token = await mint(hub, 'agent', 'jd');
    const tools = [{ type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];

    const first = await completions(base, token.token, { model: 'agenthub/worker', messages: hello, tools });
    const firstBody = await first.json() as any;
    expect(firstBody.choices[0].finish_reason).toBe('tool_calls');
    const call = firstBody.choices[0].message.tool_calls[0];
    expect(call).toMatchObject({ type: 'function', function: { name: 'read_file' } });
    expect(JSON.parse(call.function.arguments)).toEqual({ path: 'README.md' });

    // The strict mock rejects a malformed replay, so a 200 here is the round-trip passing.
    const second = await completions(base, token.token, {
      model: 'agenthub/worker',
      messages: [
        ...hello,
        { role: 'assistant', content: null, tool_calls: [call] },
        { role: 'tool', tool_call_id: call.id, content: 'a readme' },
      ],
      tools,
    });
    expect(second.status).toBe(200);
    expect((await second.json() as any).choices[0].message.content).toBe('It is a readme.');
    expect(mock.lastRequest().messages.at(-1)).toEqual({ role: 'tool', tool_call_id: call.id, content: 'a readme' });
  });

  it('streams tool calls as one numbered delta', async () => {
    const { hub, base } = await harness([{ toolCalls: [{ name: 'read_file', arguments: { path: 'a' } }] }]);
    const token = await mint(hub, 'agent', 'jd');
    const res = await completions(base, token.token, {
      model: 'agenthub/worker', messages: hello, stream: true,
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
    });
    const chunks = frames(await res.text());
    const delta = chunks.find((c) => c.choices[0]?.delta?.tool_calls)!.choices[0].delta.tool_calls[0];
    expect(delta).toMatchObject({ index: 0, type: 'function', function: { name: 'read_file' } });
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('tool_calls');
  });

  it('sends the token’s priority tier, overriding the endpoint’s own', async () => {
    const { hub, base, mock } = await harness();
    const assistant = await mint(hub, 'assistant', 'pi');
    const agent = await mint(hub, 'agent', 'jd');

    // The worker endpoint carries priority 7; neither call may inherit it.
    await completions(base, assistant.token, { model: 'agenthub/worker', messages: hello });
    expect('priority' in mock.lastRequest()).toBe(false);
    expect(KIND_PRIORITY.assistant).toBe(0);

    await completions(base, agent.token, { model: 'agenthub/worker', messages: hello });
    expect(mock.lastRequest().priority).toBe(KIND_PRIORITY.agent);
    expect(KIND_PRIORITY.agent).toBe(10);
  });

  it('401s on a missing, unknown or revoked token, in the OpenAI error shape', async () => {
    const { hub, base } = await harness();
    const token = await mint(hub, 'assistant', 'pi');

    const none = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'agenthub/worker', messages: hello }),
    });
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: { message: 'invalid api token', type: 'invalid_request_error', code: 'invalid_api_key' } });
    expect((await completions(base, 'ah_nonsense', { model: 'agenthub/worker', messages: hello })).status).toBe(401);

    expect((await completions(base, token.token, { model: 'agenthub/worker', messages: hello })).status).toBe(200);
    await hub.app.inject({ method: 'DELETE', url: `/api/tokens/${token.id}` });
    expect((await completions(base, token.token, { model: 'agenthub/worker', messages: hello })).status).toBe(401);
  });

  it('locks a client out after repeated bad bearers, but never a token that verifies', async () => {
    const { hub, base } = await harness();
    const good = await mint(hub, 'assistant', 'pi');
    for (let i = 0; i < 5; i++) {
      expect((await completions(base, 'ah_wrong', { model: 'agenthub/worker', messages: hello })).status).toBe(401);
    }
    const blocked = await completions(base, 'ah_wrong', { model: 'agenthub/worker', messages: hello });
    expect(blocked.status).toBe(429);
    // The lockout is for guessing, and a real token is not a guess — a client sharing an address
    // with a misconfigured one (a NAT, the droplet's proxy) keeps working.
    expect((await completions(base, good.token, { model: 'agenthub/worker', messages: hello })).status).toBe(200);
    expect((await completions(base, 'ah_wrong', { model: 'agenthub/worker', messages: hello })).status).toBe(429);
  });

  it('refuses a malformed request and an unknown model with OpenAI errors', async () => {
    const { hub, base } = await harness();
    const token = await mint(hub, 'assistant', 'pi');

    const noModel = await completions(base, token.token, { messages: hello });
    expect(noModel.status).toBe(400);
    expect((await noModel.json() as any).error.type).toBe('invalid_request_error');
    expect((await completions(base, token.token, { model: 'agenthub/worker', messages: [] })).status).toBe(400);
    expect((await completions(base, token.token, { model: 'agenthub/worker', messages: [{ role: 'wizard', content: 'hi' }] })).status).toBe(400);

    const unknown = await completions(base, token.token, { model: 'gpt-9', messages: hello });
    expect(unknown.status).toBe(404);
    expect((await unknown.json() as any).error.code).toBe('model_not_found');
  });

  it('flattens the content-parts array newer clients send, and reads `developer` as a system turn', async () => {
    const { hub, base, mock } = await harness();
    const token = await mint(hub, 'assistant', 'pi');
    const parts = await completions(base, token.token, {
      model: 'agenthub/worker',
      messages: [
        { role: 'developer', content: 'be brief' },
        { role: 'user', content: [{ type: 'text', text: 'hello there' }] },
      ],
    });
    expect((await parts.json() as any).choices[0].message.content).toBe('echo: hello there');
    expect(mock.lastRequest().messages[0]).toEqual({ role: 'system', content: 'be brief' });
  });

  it('refuses a local model id no local endpoint can serve, rather than billing the cloud', async () => {
    const { hub, base } = await harness();
    const token = await mint(hub, 'assistant', 'pi');
    await hub.app.inject({ method: 'POST', url: '/api/nodes/spark/drain', payload: { on: true } });

    const res = await completions(base, token.token, { model: 'local-worker', messages: hello });
    expect(res.status).toBe(503);
    expect((await res.json() as any).error).toMatchObject({ type: 'server_error', code: 'no_capacity' });
    expect(hub.usage.cloudUsdSince(0)).toBe(0);
    // The tier name still falls back to the cloud, which is what it is for.
    expect((await completions(base, token.token, { model: 'agenthub/worker', messages: hello })).status).toBe(200);
    expect(hub.usage.summary({ since: 0 }).byModel[0]).toMatchObject({ provider: 'fireworks' });
  });

  it('names the model that actually served the request on the closing stream chunks', async () => {
    const { hub, base } = await harness();
    const token = await mint(hub, 'assistant', 'pi');
    const res = await completions(base, token.token, {
      model: 'agenthub/worker', messages: hello, stream: true, stream_options: { include_usage: true },
    });
    const chunks = frames(await res.text());
    expect(chunks[0].model).toBe('agenthub/worker');
    expect(chunks.at(-1)!.model).toBe('local-worker');
    expect(chunks.at(-2)!.model).toBe('local-worker');
  });

  it('answers an unknown /v1 path and a malformed body in the OpenAI error shape', async () => {
    const { hub, base } = await harness();
    const token = await mint(hub, 'assistant', 'pi');

    const unknown = await fetch(`${base}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token.token}` },
      body: '{}',
    });
    expect(unknown.status).toBe(404);
    expect((await unknown.json() as any).error).toMatchObject({ code: 'unknown_endpoint', type: 'invalid_request_error' });
    expect((await fetch(`${base}/v1/embeddings`)).status).toBe(401);

    const malformed = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token.token}` },
      body: '{not json',
    });
    expect(malformed.status).toBe(400);
    expect((await malformed.json() as any).error.type).toBe('invalid_request_error');

    // A content type the hub parses nothing from leaves no body behind, which the route refuses
    // like any other malformed request — still the door's shape, never Fastify's.
    const wrongType = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', authorization: `Bearer ${token.token}` },
      body: 'hello',
    });
    expect(wrongType.status).toBe(400);
    expect((await wrongType.json() as any).error.type).toBe('invalid_request_error');

    // The owner's own routes are in the same plugin and keep the hub's error shape.
    const owner = await hub.app.inject({
      method: 'POST', url: '/api/tokens', headers: { 'content-type': 'application/json' }, payload: '{not json',
    });
    expect(owner.statusCode).toBe(400);
    expect(owner.json()).toEqual({ error: expect.any(String) });
  });

  it('reports a tier nothing can serve as a 503, streaming or not', async () => {
    const hub = createHub({ staleMs: 60_000 });
    hubs.push(hub);
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(hub.app.server.address() as { port: number }).port}`;
    const token = await mint(hub, 'assistant', 'pi');

    const res = await completions(base, token.token, { model: 'agenthub/worker', messages: hello });
    expect(res.status).toBe(503);
    expect((await res.json() as any).error).toMatchObject({ type: 'server_error', message: expect.stringContaining('no capacity') });

    // Once a stream's head has gone out there is no status left to send, so the error is a frame.
    const streamed = await completions(base, token.token, { model: 'agenthub/worker', messages: hello, stream: true });
    expect(streamed.status).toBe(200);
    expect(frames(await streamed.text()).at(-1)!.error.message).toContain('no capacity');
  });
});
