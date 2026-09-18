import { describe, it, expect, afterEach } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockOpenAI, type MockOpenAI, type ScriptStep } from '@agenthub/mocks';
import { createHub, type Hub } from '../src/server.js';

let hub: Hub | undefined;
let mock: MockOpenAI | undefined;
let root: string | undefined;

/** A hub with a temp projects root, one mock node, and a `demo` project. */
async function setup(script: ScriptStep[] = []): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'agenthub-autorun-api-'));
  mock = createMockOpenAI({ script });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`;
  hub = createHub({ projectsRoot: root });
  await hub.app.inject({
    method: 'POST', url: '/api/nodes/register',
    payload: {
      name: 'spark', arch: 'arm64',
      endpoints: [
        { tier: 'orchestrator', url, model: 'mock-model', maxStreams: 2 },
        { tier: 'worker', url, model: 'mock-model', maxStreams: 2 },
      ],
    },
  });
  await hub.app.inject({ method: 'POST', url: '/api/projects', payload: { slug: 'demo', title: 'Demo', intent: 'ship the demo' } });
}

afterEach(async () => {
  await hub?.stop();
  await mock?.close();
  if (root) await rm(root, { recursive: true, force: true });
  hub = undefined; mock = undefined; root = undefined;
});

const app = (): Hub['app'] => {
  if (!hub) throw new Error('setup() not called');
  return hub.app;
};

function setAutoRun(payload: Record<string, unknown>, slug = 'demo'): Promise<LightMyRequestResponse> {
  return app().inject({ method: 'POST', url: `/api/projects/${slug}/autorun`, payload });
}

describe('POST /api/projects/:slug/autorun', () => {
  it('rejects a body outside the allowed ranges before touching the project', async () => {
    await setup();
    expect((await setAutoRun({ enabled: 'yes' })).statusCode).toBe(400);
    expect((await setAutoRun({ enabled: 'yes' })).json()).toEqual({ error: 'invalid enabled' });
    expect((await setAutoRun({ enabled: true, everyMinutes: 4 })).json()).toEqual({ error: 'invalid everyMinutes' });
    expect((await setAutoRun({ enabled: true, everyMinutes: 1441 })).json()).toEqual({ error: 'invalid everyMinutes' });
    expect((await setAutoRun({ enabled: true, maxTurnsPerDay: 0 })).json()).toEqual({ error: 'invalid maxTurnsPerDay' });
    expect((await setAutoRun({ enabled: true, maxTurnsPerDay: 101 })).json()).toEqual({ error: 'invalid maxTurnsPerDay' });
    expect((await setAutoRun({ enabled: true }, 'nope')).statusCode).toBe(404);
    expect((await (await hub!.projects.get('demo')).manifest()).autoRun).toBeUndefined();
  });

  it('stores the opt-in on the manifest, filling defaults and keeping values it was not sent', async () => {
    await setup();
    const res = await setAutoRun({ enabled: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().autoRun).toEqual({ enabled: true, everyMinutes: 60, maxTurnsPerDay: 6 });

    const tuned = await setAutoRun({ enabled: true, everyMinutes: 30, maxTurnsPerDay: 3 });
    expect(tuned.json().autoRun).toEqual({ enabled: true, everyMinutes: 30, maxTurnsPerDay: 3 });

    // Switching off keeps the numbers, so switching back on picks them up again.
    const off = await setAutoRun({ enabled: false });
    expect(off.json().autoRun).toEqual({ enabled: false, everyMinutes: 30, maxTurnsPerDay: 3 });
    expect((await (await hub!.projects.get('demo')).manifest()).autoRun).toEqual({ enabled: false, everyMinutes: 30, maxTurnsPerDay: 3 });
  });
});

describe('turn budget over HTTP', () => {
  it('reports the budget on GET /turns and answers 409 once the project cap is spent', async () => {
    await setup([{ content: 'done' }, { content: 'done' }]);
    await setAutoRun({ enabled: false, maxTurnsPerDay: 1 });

    const before = (await app().inject({ method: 'GET', url: '/api/projects/demo/turns' })).json();
    expect(before.budget).toEqual({ usedToday: 0, maxPerDay: 1, hubUsedToday: 0, hubMaxPerDay: 24 });

    expect((await app().inject({ method: 'POST', url: '/api/projects/demo/turn' })).statusCode).toBe(200);

    const after = (await app().inject({ method: 'GET', url: '/api/projects/demo/turns' })).json();
    expect(after.budget).toEqual({ usedToday: 1, maxPerDay: 1, hubUsedToday: 1, hubMaxPerDay: 24 });

    const refused = await app().inject({ method: 'POST', url: '/api/projects/demo/turn' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain('project cap of 1');
  });
});
