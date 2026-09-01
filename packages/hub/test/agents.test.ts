import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMockOpenAI } from '@agenthub/mocks';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../src/db.js';
import { NodeRegistry } from '../src/node-registry.js';
import { ModelGateway } from '../src/gateway.js';
import { AgentRuntime } from '../src/agents.js';

let mock: FastifyInstance; let url: string;
beforeAll(async () => {
  mock = createMockOpenAI();
  await mock.listen({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`;
});
afterAll(async () => { await mock.close(); });

describe('AgentRuntime', () => {
  it('persists conversation turns across send calls', async () => {
    const db = openDb(':memory:');
    const registry = new NodeRegistry(db);
    registry.register({ name: 'n1', arch: 'x64', endpoints: [{ tier: 'worker', url, model: 'mock-model', maxStreams: 4 }] });
    const runtime = new AgentRuntime(db, new ModelGateway(registry));
    const agent = runtime.createAgent({ name: 'scout', tier: 'worker', systemPrompt: 'You are scout.' });

    const reply1 = await runtime.send(agent.id, 'first message');
    expect(reply1).toBe('echo: first message');
    await runtime.send(agent.id, 'second message');

    const history = runtime.history(agent.id);
    expect(history.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(history[1].content).toBe('echo: first message');
    expect(runtime.getAgent(agent.id)?.name).toBe('scout');
    expect(runtime.listAgents()).toHaveLength(1);
  });
});
