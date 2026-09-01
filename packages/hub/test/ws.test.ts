import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMockOpenAI } from '@agenthub/mocks';
import type { FastifyInstance } from 'fastify';
import { createHub, type Hub } from '../src/server.js';

// Node 22 has a global WebSocket client — use it, no new deps.
let mock: FastifyInstance; let hub: Hub; let base: string; let wsUrl: string;
beforeAll(async () => {
  mock = createMockOpenAI({ tokenDelayMs: 5 });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  hub = createHub();
  await hub.app.listen({ port: 0, host: '127.0.0.1' });
  const port = (hub.app.server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`; wsUrl = `ws://127.0.0.1:${port}/ws`;
});
afterAll(async () => { await hub.stop(); await mock.close(); });

const nextMessage = (ws: WebSocket, pred: (m: any) => boolean, timeoutMs = 5000) =>
  new Promise<any>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ws timeout')), timeoutMs);
    ws.addEventListener('message', (ev: MessageEvent) => {
      const m = JSON.parse(String(ev.data));
      if (pred(m)) { clearTimeout(t); resolve(m); }
    });
  });

describe('hub websocket', () => {
  it('sends state on connect and streams tier counters in /api/state', async () => {
    const ws = new WebSocket(wsUrl);
    const first = await nextMessage(ws, (m) => m.type === 'state');
    expect(first.state.nodes).toEqual([]);
    expect(first.state.streams).toEqual({ orchestrator: 0, worker: 0, vision: 0, 'video-gen': 0 });
    const rest = await (await fetch(`${base}/api/state`)).json();
    expect(rest.streams.worker).toBe(0);
    ws.close();
  });

  it('broadcasts state on node register and agent-busy around a chat', async () => {
    const ws = new WebSocket(wsUrl);
    await nextMessage(ws, (m) => m.type === 'state');
    const mockUrl = `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`;
    const stateMsg = nextMessage(ws, (m) => m.type === 'state' && m.state.nodes.length === 1);
    await fetch(`${base}/api/nodes/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'n1', arch: 'x64', endpoints: [{ tier: 'worker', url: mockUrl, model: 'mock-model', maxStreams: 4 }] }) });
    await stateMsg;
    const agent = await (await fetch(`${base}/api/agents`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'a', tier: 'worker', systemPrompt: 's' }) })).json();
    const busyOn = nextMessage(ws, (m) => m.type === 'agent-busy' && m.agentId === agent.id && m.busy === true);
    const busyOff = nextMessage(ws, (m) => m.type === 'agent-busy' && m.agentId === agent.id && m.busy === false);
    await fetch(`${base}/api/agents/${agent.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }) });
    await busyOn; await busyOff;
    ws.close();
  });
});
