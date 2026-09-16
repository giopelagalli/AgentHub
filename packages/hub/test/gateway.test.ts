import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMockOpenAI } from '@agenthub/mocks';
import Fastify, { type FastifyInstance } from 'fastify';
import { createServer } from 'node:net';
import type { ChatMessage, ToolDef } from '@agenthub/shared';
import { openDb } from '../src/db.js';
import { NodeRegistry } from '../src/node-registry.js';
import { ModelGateway, toOpenAiMessages } from '../src/gateway.js';

// Binds an ephemeral port and closes it immediately, yielding a URL that reliably
// rejects with ECONNREFUSED — used to simulate an unreachable endpoint.
async function closedPortUrl(): Promise<string> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

let mock: FastifyInstance; let url: string;
beforeAll(async () => {
  mock = createMockOpenAI({ tokenDelayMs: 5 });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`;
});
afterAll(async () => { await mock.close(); });

function setup(maxStreams = 2) {
  const registry = new NodeRegistry(openDb(':memory:'));
  registry.register({ name: 'spark', arch: 'arm64', endpoints: [{ tier: 'worker', url, model: 'mock-model', maxStreams }] });
  return { registry, gateway: new ModelGateway(registry) };
}

describe('ModelGateway', () => {
  it('picks null for unserved tier and errors on chat', async () => {
    const { gateway } = setup();
    expect(gateway.pick('video-gen')).toBeNull();
    await expect(gateway.chat('video-gen', [{ role: 'user', content: 'x' }])).rejects.toThrow('no capacity');
  });

  it('streams tokens and resolves the full text', async () => {
    const { gateway } = setup();
    const tokens: string[] = [];
    const full = await gateway.chat('worker', [{ role: 'user', content: 'hello world' }], (t) => tokens.push(t));
    expect(full).toBe('echo: hello world');
    expect(tokens.length).toBeGreaterThan(1);
    expect(tokens.join('')).toBe(full);
    expect(gateway.activeStreams()).toBe(0);
  });

  it('runs two sessions concurrently and enforces maxStreams', async () => {
    const { gateway } = setup(2);
    let maxActive = 0;
    const run = () => gateway.chat('worker', [{ role: 'user', content: 'a b c d e' }], () => {
      maxActive = Math.max(maxActive, gateway.activeStreams('worker'));
    });
    const [r1, r2] = await Promise.all([run(), run()]);
    expect(r1).toBe('echo: a b c d e'); expect(r2).toBe('echo: a b c d e');
    expect(maxActive).toBe(2);
    // saturate: occupy both slots, third pick returns null
    const p = Promise.all([run(), run()]);
    expect(gateway.pick('worker')).toBeNull();
    await p;
  });

  it('returns a ChatResult with toolCalls parsed and finish "tool_calls" when the options form is used', async () => {
    const toolMock = createMockOpenAI({ script: [{ toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt', mode: 'r' } }] }] });
    await toolMock.listen({ port: 0, host: '127.0.0.1' });
    try {
      const toolUrl = `http://127.0.0.1:${(toolMock.server.address() as { port: number }).port}`;
      const registry = new NodeRegistry(openDb(':memory:'));
      registry.register({ name: 'spark', arch: 'arm64', endpoints: [{ tier: 'worker', url: toolUrl, model: 'mock-model', maxStreams: 2 }] });
      const gateway = new ModelGateway(registry);

      const result = await gateway.chat('worker', [{ role: 'user', content: 'read it' }], {});
      expect(result.finish).toBe('tool_calls');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe('read_file');
      expect(JSON.parse(result.toolCalls[0].arguments)).toEqual({ path: 'a.txt', mode: 'r' });
      expect(result.content).toBe('');
    } finally {
      await toolMock.close();
    }
  });

  it('returns finish "stop" and empty toolCalls for a plain reply via the options form', async () => {
    const { gateway } = setup();
    const result = await gateway.chat('worker', [{ role: 'user', content: 'hello' }], {});
    expect(result.finish).toBe('stop');
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe('echo: hello');
  });

  it('keeps the legacy positional call returning a plain string', async () => {
    const { gateway } = setup();
    const full: string = await gateway.chat('worker', [{ role: 'user', content: 'hello' }]);
    expect(full).toBe('echo: hello');
  });

  it('releases the stream slot when the caller aborts mid-stream', async () => {
    const { gateway } = setup();
    const ac = new AbortController();
    const chat = gateway.chat('worker', [{ role: 'user', content: 'a b c d e f g h' }], () => ac.abort(), ac.signal);
    await expect(chat).rejects.toThrow();

    const deadline = Date.now() + 2000;
    while (gateway.activeStreams() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(gateway.activeStreams()).toBe(0);
  });
});

describe('ModelGateway failover', () => {
  it('fails over to a healthy endpoint when the first is unreachable, marking it unhealthy', async () => {
    const registry = new NodeRegistry(openDb(':memory:'));
    const deadUrl = await closedPortUrl();
    registry.register({ name: 'dead', arch: 'arm64', endpoints: [{ tier: 'worker', url: deadUrl, model: 'mock-model', maxStreams: 2 }] });
    registry.register({ name: 'spark', arch: 'arm64', endpoints: [{ tier: 'worker', url, model: 'mock-model', maxStreams: 2 }] });
    let now = 1_000_000;
    const gateway = new ModelGateway(registry, { now: () => now });

    const full = await gateway.chat('worker', [{ role: 'user', content: 'hi' }]);
    expect(full).toBe('echo: hi');
    expect(gateway.activeStreams()).toBe(0);

    const health = gateway.health();
    const deadKey = Object.keys(health).find((k) => k.startsWith('dead|'));
    expect(deadKey).toBeDefined();
    expect(health[deadKey!]).toBe(now + 10_000);

    // dead has 0 active streams, same as spark right now — start a slow concurrent
    // session on spark so spark's active count is *higher*, and confirm pick still
    // skips dead: unhealthy status overrides a lower active count.
    const tokens: string[] = [];
    const slow = gateway.chat('worker', [{ role: 'user', content: 'a b c d e f g h' }], (t) => tokens.push(t));
    while (tokens.length === 0) await new Promise((r) => setTimeout(r, 5));
    expect(gateway.activeStreams('worker')).toBe(1);
    expect(gateway.pick('worker')?.node.name).toBe('spark');
    await slow;
  });

  it('makes the endpoint eligible again once the unhealthy window elapses', async () => {
    const registry = new NodeRegistry(openDb(':memory:'));
    const deadUrl = await closedPortUrl();
    registry.register({ name: 'dead', arch: 'arm64', endpoints: [{ tier: 'worker', url: deadUrl, model: 'mock-model', maxStreams: 2 }] });
    registry.register({ name: 'spark', arch: 'arm64', endpoints: [{ tier: 'worker', url, model: 'mock-model', maxStreams: 2 }] });
    let now = 1_000_000;
    const gateway = new ModelGateway(registry, { now: () => now });

    await gateway.chat('worker', [{ role: 'user', content: 'hi' }]); // fails over, marks dead unhealthy
    expect(gateway.pick('worker')?.node.name).toBe('spark');

    // saturate spark while dead is still unhealthy, so these can't race onto dead
    const tokensA: string[] = []; const tokensB: string[] = [];
    const a = gateway.chat('worker', [{ role: 'user', content: 'a b c d e f g h' }], (t) => tokensA.push(t));
    const b = gateway.chat('worker', [{ role: 'user', content: 'a b c d e f g h' }], (t) => tokensB.push(t));
    while (tokensA.length === 0 || tokensB.length === 0) await new Promise((r) => setTimeout(r, 5));
    expect(gateway.activeStreams('worker')).toBe(2); // spark saturated at maxStreams
    expect(gateway.pick('worker')).toBeNull(); // spark saturated, dead still unhealthy

    now += 10_001; // past the 10s unhealthy window
    expect(gateway.pick('worker')?.node.name).toBe('dead');
    await Promise.all([a, b]);
  });

  it('does not retry a 4xx response, and does not mark the endpoint unhealthy', async () => {
    const bad = Fastify();
    bad.post('/v1/chat/completions', async (_req, reply) => reply.code(400).send({ error: 'bad request' }));
    await bad.listen({ port: 0, host: '127.0.0.1' });
    const badUrl = `http://127.0.0.1:${(bad.server.address() as { port: number }).port}`;
    try {
      const registry = new NodeRegistry(openDb(':memory:'));
      registry.register({ name: 'bad', arch: 'arm64', endpoints: [{ tier: 'worker', url: badUrl, model: 'mock-model', maxStreams: 2 }] });
      const gateway = new ModelGateway(registry);

      await expect(gateway.chat('worker', [{ role: 'user', content: 'hi' }])).rejects.toThrow('endpoint error 400');
      expect(gateway.activeStreams()).toBe(0);
      expect(Object.keys(gateway.health())).toHaveLength(0);
    } finally {
      await bad.close();
    }
  });

  it('does not blacklist the sole endpoint on a 5xx, so it stays pickable', async () => {
    const bad = Fastify();
    bad.post('/v1/chat/completions', async (_req, reply) => reply.code(500).send({ error: 'boom' }));
    await bad.listen({ port: 0, host: '127.0.0.1' });
    const badUrl = `http://127.0.0.1:${(bad.server.address() as { port: number }).port}`;
    try {
      const registry = new NodeRegistry(openDb(':memory:'));
      registry.register({ name: 'solo', arch: 'arm64', endpoints: [{ tier: 'worker', url: badUrl, model: 'mock-model', maxStreams: 2 }] });
      const gateway = new ModelGateway(registry);

      await expect(gateway.chat('worker', [{ role: 'user', content: 'hi' }])).rejects.toThrow('endpoint error 500');
      expect(Object.keys(gateway.health())).toHaveLength(0);
      expect(gateway.pick('worker')?.node.name).toBe('solo');
    } finally {
      await bad.close();
    }
  });

  // Note on coverage: "if tokens were already streamed, propagate the error (no
  // double replies)" is exercised indirectly by the existing "releases the stream
  // slot when the caller aborts mid-stream" test above — it aborts after the first
  // token and the rejection propagates without a retry attempt. The mock server
  // (@agenthub/mocks createMockOpenAI) has no option to fail a connection *after*
  // it has started streaming tokens, so the `streamedAny` guard in ModelGateway.chat
  // (which suppresses failover once any token has been emitted) isn't exercised by
  // a non-abort mid-stream failure here; extending the mock with such an option was
  // out of scope for this task's file list.
});

describe('ModelGateway upstream errors', () => {
  it('includes the upstream error body in the thrown message', async () => {
    const bad = Fastify();
    bad.post('/v1/chat/completions', async (_req, reply) =>
      reply.code(400).send({
        error: { message: "56 request validation errors: Input should be 'function', field: 'tools[0].type'" },
      }));
    await bad.listen({ port: 0, host: '127.0.0.1' });
    const badUrl = `http://127.0.0.1:${(bad.server.address() as { port: number }).port}`;
    try {
      const registry = new NodeRegistry(openDb(':memory:'));
      registry.register({ name: 'bad', arch: 'arm64', endpoints: [{ tier: 'worker', url: badUrl, model: 'mock-model', maxStreams: 2 }] });
      const gateway = new ModelGateway(registry);
      const tools: ToolDef[] = [
        { type: 'tool', name: 'list_nodes', description: 'list registered nodes', parameters: { type: 'object', properties: {}, required: [] } },
      ];

      let error: unknown;
      try {
        await gateway.chat('worker', [{ role: 'user', content: 'hi' }], { tools });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('endpoint error 400');
      expect((error as Error).message).toContain('request validation errors');
    } finally {
      await bad.close();
    }
  });

  it('sends tools in the OpenAI function envelope a strict validator accepts', async () => {
    type ToolEntry = {
      type?: unknown;
      function?: { name?: unknown; parameters?: { type?: unknown; properties?: unknown; required?: unknown } };
    };
    const isValidEntry = (entry: ToolEntry): boolean =>
      entry.type === 'function' &&
      typeof entry.function?.name === 'string' &&
      entry.function.parameters?.type === 'object' &&
      typeof entry.function.parameters?.properties === 'object' &&
      entry.function.parameters?.properties !== null &&
      !Array.isArray(entry.function.parameters?.properties) &&
      Array.isArray(entry.function.parameters?.required);

    const chatBodies: { tools?: ToolEntry[] }[] = [];
    const app = Fastify();
    app.post('/v1/chat/completions', async (req, reply) => {
      const body = req.body as { tools?: ToolEntry[] };
      chatBodies.push(body);
      const invalid = (body.tools ?? []).find((t) => !isValidEntry(t));
      if (invalid) return reply.code(400).send({ error: { message: `invalid tool entry: ${JSON.stringify(invalid)}` } });
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
      reply.raw.write(chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_nodes', arguments: '{}' } }] }, null));
      reply.raw.write(chunk({}, 'tool_calls'));
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
      return reply;
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    try {
      const registry = new NodeRegistry(openDb(':memory:'));
      registry.register({ name: 'spark', arch: 'arm64', endpoints: [{ tier: 'worker', url, model: 'mock-model', maxStreams: 2 }] });
      const gateway = new ModelGateway(registry);

      // Exercises the defects toParameterSchema must fix: an already-clean empty-object schema
      // (list_nodes), a free-form nested property (submit_job's payload), and a schema that omits
      // `required` entirely (read_doc).
      const tools: ToolDef[] = [
        { type: 'tool', name: 'list_nodes', description: 'list registered nodes', parameters: { type: 'object', properties: {}, required: [] } },
        {
          type: 'tool', name: 'submit_job', description: 'submit a job',
          parameters: { type: 'object', properties: { payload: { type: 'object', description: 'free-form job payload' } }, required: ['payload'] },
        },
        { type: 'tool', name: 'read_doc', description: 'read a project doc', parameters: { type: 'object', properties: { slug: { type: 'string' } } } },
      ];

      const result = await gateway.chat('worker', [{ role: 'user', content: 'hi' }], { tools });
      expect(result.toolCalls[0].name).toBe('list_nodes');

      const sent = chatBodies[0].tools!;
      expect(sent[0].type).toBe('function');
      const readDoc = sent.find((t) => t.function?.name === 'read_doc');
      expect(readDoc?.function?.parameters?.required).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe('toOpenAiMessages', () => {
  it('wraps an assistant tool_calls entry in the OpenAI function envelope with stringified arguments', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_0', name: 'read_file', arguments: '{"path":"."}' }] },
    ];
    expect(toOpenAiMessages(messages)).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'read_file', arguments: '{"path":"."}' } }],
      },
    ]);
  });

  it('sends content: null, not "", for a tool-calling turn with no text', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_0', name: 'read_file', arguments: '{}' }] },
    ];
    expect(toOpenAiMessages(messages)[0]).toMatchObject({ content: null });
  });

  it('passes system, user and tool messages through unchanged', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'tool', tool_call_id: 'call_0', content: 'result' },
    ];
    expect(toOpenAiMessages(messages)).toEqual(messages);
  });

  it('leaves a plain-text assistant message untouched', () => {
    const messages: ChatMessage[] = [{ role: 'assistant', content: 'hello' }];
    expect(toOpenAiMessages(messages)).toEqual(messages);
  });
});
