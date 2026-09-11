import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage } from '@agenthub/shared';
import { anthropicChat, type AnthropicLike } from '../src/providers/anthropic.js';
import { openDb } from '../src/db.js';
import { NodeRegistry } from '../src/node-registry.js';
import { ModelGateway } from '../src/gateway.js';
import { createHub, CLOUD_NODE_NAME, type Hub } from '../src/server.js';

interface Call { body: Anthropic.MessageStreamParams; options?: { signal?: AbortSignal | null } }

/**
 * Stands in for the SDK client: records the request it was handed, replays `texts` to whatever
 * `on('text')` listener the provider registered, and resolves `finalMessage()` with `final`.
 * Nothing here touches the network.
 */
function fakeClient(reply: { texts?: string[]; final: Partial<Anthropic.Message> }) {
  const calls: Call[] = [];
  const client: AnthropicLike = {
    messages: {
      stream(body, options) {
        calls.push({ body, ...(options ? { options } : {}) });
        const listeners: ((t: string) => void)[] = [];
        return {
          on(_event: 'text', listener: (t: string) => void) { listeners.push(listener); return this; },
          async finalMessage() {
            for (const t of reply.texts ?? []) for (const l of listeners) l(t);
            return { content: [], stop_reason: 'end_turn', ...reply.final } as Anthropic.Message;
          },
        };
      },
    },
  };
  return { client, calls };
}

const textReply = (text: string) => ({
  texts: text.split(' ').map((w, i) => (i ? ` ${w}` : w)),
  final: { content: [{ type: 'text', text, citations: null }], stop_reason: 'end_turn' } as Partial<Anthropic.Message>,
});

describe('anthropicChat', () => {
  it('maps our messages onto the Messages API request', async () => {
    const { client, calls } = fakeClient(textReply('done'));
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You help.' },
      { role: 'user', content: 'what is up' },
      { role: 'assistant', content: 'checking', tool_calls: [
        { id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
        { id: 'call_2', name: 'read_file', arguments: '{"path":"b.txt"}' },
      ] },
      { role: 'tool', tool_call_id: 'call_1', content: 'AAA' },
      { role: 'tool', tool_call_id: 'call_2', content: 'BBB' },
      { role: 'user', content: 'thanks' },
      // No text and no calls: not a turn the API accepts, so it is dropped.
      { role: 'assistant', content: null },
    ];
    await anthropicChat(client, {
      model: 'claude-sonnet-5', messages,
      tools: [{ type: 'tool', name: 'read_file', description: 'Reads a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    });

    expect(calls).toHaveLength(1);
    const body = calls[0].body;
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.max_tokens).toBe(16000);
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.system).toBe('You help.');
    expect(body.tools).toEqual([
      { name: 'read_file', description: 'Reads a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
    ]);
    expect(body.messages).toEqual([
      { role: 'user', content: 'what is up' },
      { role: 'assistant', content: [
        { type: 'text', text: 'checking' },
        { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.txt' } },
        { type: 'tool_use', id: 'call_2', name: 'read_file', input: { path: 'b.txt' } },
      ] },
      // Both results merged into the single user turn the API expects, ids preserved.
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: 'AAA' },
        { type: 'tool_result', tool_use_id: 'call_2', content: 'BBB' },
      ] },
      { role: 'user', content: 'thanks' },
    ]);
  });

  it('omits system and tools when there are none', async () => {
    const { client, calls } = fakeClient(textReply('hi'));
    await anthropicChat(client, { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] });
    expect(calls[0].body.system).toBeUndefined();
    expect(calls[0].body.tools).toBeUndefined();
  });

  it('streams text deltas and resolves the full reply', async () => {
    const { client } = fakeClient(textReply('all good here'));
    const tokens: string[] = [];
    const res = await anthropicChat(client, {
      model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'status?' }], onToken: (t) => tokens.push(t),
    });
    expect(tokens).toEqual(['all', ' good', ' here']);
    expect(res).toEqual({ content: 'all good here', toolCalls: [], finish: 'stop' });
  });

  it('maps a tool_use reply to tool calls with stringified arguments', async () => {
    const { client } = fakeClient({
      final: {
        content: [
          { type: 'text', text: 'looking', citations: null },
          { type: 'tool_use', id: 'toolu_9', name: 'read_file', input: { path: 'a.txt' } },
        ],
        stop_reason: 'tool_use',
      } as Partial<Anthropic.Message>,
    });
    const res = await anthropicChat(client, { model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'read a.txt' }] });
    expect(res.finish).toBe('tool_calls');
    expect(res.content).toBe('looking');
    expect(res.toolCalls).toEqual([{ id: 'toolu_9', name: 'read_file', arguments: '{"path":"a.txt"}' }]);
  });

  it('maps max_tokens to length', async () => {
    const { client } = fakeClient({ final: { content: [{ type: 'text', text: 'cut off', citations: null }], stop_reason: 'max_tokens' } as Partial<Anthropic.Message> });
    expect((await anthropicChat(client, { model: 'm', messages: [{ role: 'user', content: 'x' }] })).finish).toBe('length');
  });

  it('turns a refusal into a stop with a short note', async () => {
    const { client } = fakeClient({
      final: {
        content: [{ type: 'text', text: 'partial', citations: null }],
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: 'nope' },
      } as unknown as Partial<Anthropic.Message>,
    });
    const res = await anthropicChat(client, { model: 'm', messages: [{ role: 'user', content: 'x' }] });
    expect(res).toEqual({ content: '[refused: cyber]', toolCalls: [], finish: 'stop' });
  });

  it('passes the abort signal to the SDK request options', async () => {
    const { client, calls } = fakeClient(textReply('ok'));
    const ac = new AbortController();
    await anthropicChat(client, { model: 'm', messages: [{ role: 'user', content: 'x' }], signal: ac.signal });
    expect(calls[0].options?.signal).toBe(ac.signal);
  });
});

describe('gateway with an anthropic endpoint', () => {
  const local = (name: string) => ({
    name, arch: 'arm64',
    endpoints: [{ tier: 'worker' as const, url: 'http://127.0.0.1:9/local', model: 'local-model', maxStreams: 4 }],
  });

  function setup(client: AnthropicLike) {
    const registry = new NodeRegistry(openDb(':memory:'));
    registry.register({
      name: CLOUD_NODE_NAME, arch: 'cloud',
      endpoints: [
        { tier: 'orchestrator', provider: 'anthropic', url: 'anthropic://', model: 'claude-opus-4-8', maxStreams: 4 },
        { tier: 'worker', provider: 'anthropic', url: 'anthropic://', model: 'claude-sonnet-5', maxStreams: 8 },
      ],
    });
    return { registry, gateway: new ModelGateway(registry, { anthropic: client }) };
  }

  it('serves a tier through the SDK when the cloud endpoint is the only one', async () => {
    const { client, calls } = fakeClient(textReply('cloud says hi'));
    const { gateway } = setup(client);
    expect(gateway.pick('orchestrator')?.endpoint.model).toBe('claude-opus-4-8');
    const tokens: string[] = [];
    const res = await gateway.chat('worker', [{ role: 'user', content: 'hello' }], { onToken: (t) => tokens.push(t) });
    expect(calls[0].body.model).toBe('claude-sonnet-5');
    expect(res.content).toBe('cloud says hi');
    expect(tokens.join('')).toBe('cloud says hi');
    expect(gateway.activeStreams()).toBe(0);
  });

  it('prefers a local endpoint over the cloud one for the same tier', async () => {
    const { client } = fakeClient(textReply('x'));
    const { registry, gateway } = setup(client);
    registry.register(local('spark'));
    expect(gateway.pick('worker')?.node.name).toBe('spark');
    // The cloud node still answers the tier no local node serves.
    expect(gateway.pick('orchestrator')?.node.name).toBe(CLOUD_NODE_NAME);
  });
});

describe('the synthetic cloud node', () => {
  it('is registered by createHub and stays online across sweeps', async () => {
    const { client } = fakeClient(textReply('hi'));
    const hub: Hub = createHub({ cloud: { anthropic: { client } }, staleMs: 25, sweepIntervalMs: 5 });
    try {
      const node = hub.registry.byName(CLOUD_NODE_NAME)!;
      expect(node.arch).toBe('cloud');
      expect(node.endpoints.map((e) => [e.tier, e.model, e.provider])).toEqual([
        ['orchestrator', 'claude-opus-4-8', 'anthropic'],
        ['worker', 'claude-sonnet-5', 'anthropic'],
      ]);
      // Nothing an API key can reach: no job types, no browser, no video, no control server.
      expect(node.jobTypes).toEqual([]);
      expect(node.browser).toBeUndefined();
      expect(node.control).toBeUndefined();
      expect(node.video).toBe(false);
      expect(node.controlNode).toBe(false);

      await new Promise((r) => setTimeout(r, 80)); // several sweep intervals, well past staleMs
      expect(hub.registry.online().map((n) => n.name)).toEqual([CLOUD_NODE_NAME]);
      expect(hub.gateway.pick('worker')?.endpoint.model).toBe('claude-sonnet-5');

      const res = await hub.gateway.chat('orchestrator', [{ role: 'user', content: 'hello' }], {});
      expect(res.content).toBe('hi');
    } finally {
      await hub.stop();
    }
  });

  it('is absent without the cloud option, and the tier has no capacity', async () => {
    const hub = createHub();
    try {
      expect(hub.registry.byName(CLOUD_NODE_NAME)).toBeNull();
      await expect(hub.gateway.chat('worker', [{ role: 'user', content: 'x' }], {})).rejects.toThrow('no capacity');
    } finally {
      await hub.stop();
    }
  });

  it('overrides the models from options', async () => {
    const { client } = fakeClient(textReply('hi'));
    const hub = createHub({ cloud: { anthropic: { client, orchestratorModel: 'claude-opus-5', workerModel: 'claude-haiku-4-5', maxStreams: 2 } } });
    try {
      const eps = hub.registry.byName(CLOUD_NODE_NAME)!.endpoints;
      expect(eps.map((e) => e.model)).toEqual(['claude-opus-5', 'claude-haiku-4-5']);
      expect(eps.map((e) => e.maxStreams)).toEqual([2, 2]);
    } finally {
      await hub.stop();
    }
  });
});
