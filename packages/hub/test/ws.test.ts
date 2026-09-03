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

  it('catches up a socket that connects mid-stream with the agent-busy it missed', async () => {
    const mockUrl = `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`;
    const agent = await (await fetch(`${base}/api/agents`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'slow', tier: 'worker', systemPrompt: 's' }) })).json();
    await fetch(`${base}/api/nodes/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'slow-node', arch: 'x64', endpoints: [{ tier: 'worker', url: mockUrl, model: 'mock-model', maxStreams: 4 }] }) });

    // Many tokens at 5ms/token gives a wide window for the late socket to join
    // mid-stream without racing the reply's completion.
    const slowText = Array(30).fill('word').join(' ');
    const chatDone = fetch(`${base}/api/agents/${agent.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: slowText }) });

    // Give the chat a moment to start streaming before the late socket joins.
    await new Promise((r) => setTimeout(r, 30));

    const late = new WebSocket(wsUrl);
    // Both listeners must be attached before either message can arrive: the
    // server sends state and the busy catch-up back to back on connect, so
    // awaiting one before registering the other risks missing the second.
    const statePromise = nextMessage(late, (m) => m.type === 'state');
    const caughtUpPromise = nextMessage(
      late,
      (m) => m.type === 'agent-busy' && m.agentId === agent.id && m.busy === true,
    );
    expect((await statePromise).state).toBeDefined();
    expect((await caughtUpPromise).busy).toBe(true);

    late.close();
    await chatDone;
  });
});
