import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMockOpenAI } from '@agenthub/mocks';
import type { FastifyInstance } from 'fastify';
import { createHub, type Hub } from '../src/server.js';

let orch: FastifyInstance; let work: FastifyInstance; let hub: Hub; let base: string;

beforeAll(async () => {
  orch = createMockOpenAI({ tokenDelayMs: 20, replyFor: (u) => `orchestrator says: ${u}` });
  work = createMockOpenAI({ tokenDelayMs: 20, replyFor: (u) => `worker says: ${u}` });
  await orch.listen({ port: 0, host: '127.0.0.1' });
  await work.listen({ port: 0, host: '127.0.0.1' });
  const urlOf = (a: FastifyInstance) => `http://127.0.0.1:${(a.server.address() as { port: number }).port}`;

  hub = createHub();
  await hub.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(hub.app.server.address() as { port: number }).port}`;

  await fetch(`${base}/api/nodes/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'spark', arch: 'arm64',
      endpoints: [
        { tier: 'orchestrator', url: urlOf(orch), model: 'qwen3.8-flash-next-nvfp4', maxStreams: 4 },
        { tier: 'worker', url: urlOf(work), model: 'qwen3.6-35b-a3b-nvfp4', maxStreams: 48 },
      ],
    }),
  });
});
afterAll(async () => { await hub.stop(); await orch.close(); await work.close(); });

async function chat(agentId: number, text: string, events: { at: number; kind: string }[]) {
  const res = await fetch(`${base}/api/agents/${agentId}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = ''; let full = ''; let first = true;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const m = frame.match(/^data: (\{.*\})$/m);
      if (!m) continue;
      const ev = JSON.parse(m[1]);
      if (ev.token) { if (first) { events.push({ at: Date.now(), kind: `first:${agentId}` }); first = false; } }
      if (ev.done) { full = ev.full; events.push({ at: Date.now(), kind: `done:${agentId}` }); }
    }
  }
  return full;
}

describe('phase 1 e2e', () => {
  it('two agents on different tiers stream concurrently through the gateway', async () => {
    const mk = async (name: string, tier: string) => (await (await fetch(`${base}/api/agents`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, tier, systemPrompt: `You are ${name}.` }),
    })).json()).id as number;

    const master = await mk('master', 'orchestrator');
    const scout = await mk('scout', 'worker');

    const events: { at: number; kind: string }[] = [];
    const [a, b] = await Promise.all([
      chat(master, 'plan the day please now', events),
      chat(scout, 'scan the repo please now', events),
    ]);
    expect(a).toBe('orchestrator says: plan the day please now');
    expect(b).toBe('worker says: scan the repo please now');

    // concurrency: both sessions produced their first token before either finished
    const firstDone = Math.min(...events.filter(e => e.kind.startsWith('done')).map(e => e.at));
    const lastFirst = Math.max(...events.filter(e => e.kind.startsWith('first')).map(e => e.at));
    expect(lastFirst).toBeLessThanOrEqual(firstDone);
  }, 30000);
});
