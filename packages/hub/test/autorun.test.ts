import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockOpenAI, type MockOpenAI, type ScriptStep } from '@agenthub/mocks';
import { openDb } from '../src/db.js';
import { JobQueue } from '../src/queue.js';
import { NodeRegistry } from '../src/node-registry.js';
import { ModelGateway } from '../src/gateway.js';
import { AgentLoop } from '../src/agents/loop.js';
import { Transcript } from '../src/agents/transcript.js';
import { isPrdScaffold } from '../src/projects/prd.js';
import { gatewayErrorClass, ProjectService, TurnRefusedError, type ProjectServiceDeps } from '../src/projects/service.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const PRD = '# PRD\n\nA real product with a real goal.\n';

let root: string;
let mocks: MockOpenAI[];
let servers: Server[];
let service: ProjectService | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agenthub-autorun-'));
  mocks = [];
  servers = [];
});

afterEach(async () => {
  if (service) await service.stop({ graceMs: 0 }).catch(() => {});
  service = undefined;
  for (const m of mocks) await m.close();
  for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

async function serve(script: ScriptStep[]): Promise<string> {
  const mock = createMockOpenAI({ script });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  mocks.push(mock);
  return `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`;
}

/** An "endpoint" that answers every request with the same 4xx, the way a cloud with a bad model id does. */
async function serveStatus(status: number, body: string): Promise<string> {
  const server = createServer((_req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

interface Harness {
  service: ProjectService;
  transcript: Transcript;
  /** The injected clock, anchored at real time (sessions are stamped with `Date.now`) and advanced by tests. */
  clock: { now: number };
  refused: { slug: string; reason: string }[];
}

type Extra = Partial<Pick<ProjectServiceDeps, 'autoTurns' | 'maxTurnsPerDay' | 'tickIntervalMs'>>;

/** A service on a mock brain that ends every turn with `done`, or on `brainUrl` when given. */
async function setup(extra: Extra = {}, brainUrl?: string): Promise<Harness> {
  const url = brainUrl ?? await serve(Array.from({ length: 20 }, () => ({ content: 'done' })));
  const db = openDb(':memory:');
  const registry = new NodeRegistry(db);
  registry.register({
    name: 'spark', arch: 'arm64',
    endpoints: [
      { tier: 'orchestrator', url, model: 'mock-model', maxStreams: 2 },
      { tier: 'worker', url, model: 'mock-model', maxStreams: 2 },
    ],
  });
  const transcript = new Transcript(db);
  const gateway = new ModelGateway(registry);
  const loop = new AgentLoop({ gateway, transcript });
  const queue = new JobQueue(db);
  const clock = { now: Date.now() };
  const refused: { slug: string; reason: string }[] = [];
  service = new ProjectService({
    root, loop, gateway, queue, registry, transcript,
    now: () => clock.now,
    onTurnRefused: (slug, reason) => refused.push({ slug, reason }),
    tickIntervalMs: 60 * MINUTE,
    ...extra,
  });
  return { service, transcript, clock, refused };
}

/** A project with a drafted PRD, opted in when `autoRun` is given. */
async function project(h: Harness, slug: string, autoRun?: { everyMinutes: number; maxTurnsPerDay: number }, prd = PRD): Promise<void> {
  await h.service.create({ slug, title: slug, intent: 'ship it' });
  if (prd) await (await h.service.get(slug)).writePrd(prd);
  if (autoRun) await h.service.setAutoRun(slug, { enabled: true, ...autoRun });
}

const turnsOf = (h: Harness, slug: string): number => h.transcript.sessions({ kind: 'orchestrator', subject: slug }).length;

describe('auto-run scheduler', () => {
  it('skips an active project that never opted in', async () => {
    const h = await setup();
    await project(h, 'demo');
    expect(isPrdScaffold(PRD)).toBe(false);

    await h.service.tickNow();

    expect(turnsOf(h, 'demo')).toBe(0);
  });

  it('runs an opted-in project once per everyMinutes and remembers when', async () => {
    const h = await setup();
    await project(h, 'demo', { everyMinutes: 30, maxTurnsPerDay: 10 });
    const t0 = h.clock.now;

    await h.service.tickNow();
    expect(turnsOf(h, 'demo')).toBe(1);
    expect((await (await h.service.get('demo')).manifest()).lastAutoTurnAt).toBe(t0);

    h.clock.now = t0 + 10 * MINUTE;
    await h.service.tickNow();
    expect(turnsOf(h, 'demo')).toBe(1);

    h.clock.now = t0 + 31 * MINUTE;
    await h.service.tickNow();
    expect(turnsOf(h, 'demo')).toBe(2);
  });

  it('refuses past the project cap and runs again once the window has rolled', async () => {
    const h = await setup();
    await project(h, 'demo', { everyMinutes: 5, maxTurnsPerDay: 2 });
    const t0 = h.clock.now;

    await h.service.tickNow();
    h.clock.now = t0 + 6 * MINUTE;
    await h.service.tickNow();
    expect(turnsOf(h, 'demo')).toBe(2);

    h.clock.now = t0 + 12 * MINUTE;
    await h.service.tickNow();
    expect(turnsOf(h, 'demo')).toBe(2);
    expect(h.refused).toHaveLength(1);
    expect(h.refused[0]).toMatchObject({ slug: 'demo' });
    expect(h.refused[0].reason).toContain('project cap');

    h.clock.now = t0 + DAY + 30 * MINUTE;
    await h.service.tickNow();
    expect(turnsOf(h, 'demo')).toBe(3);
  });

  it('refuses a manual turn at the project cap with TurnRefusedError', async () => {
    const h = await setup();
    await project(h, 'demo', { everyMinutes: 5, maxTurnsPerDay: 1 });

    await h.service.runTurn('demo');
    await expect(h.service.runTurn('demo')).rejects.toBeInstanceOf(TurnRefusedError);
    expect(turnsOf(h, 'demo')).toBe(1);
  });

  it('holds the hub-wide cap across projects', async () => {
    const h = await setup({ maxTurnsPerDay: 1 });
    await project(h, 'one', { everyMinutes: 5, maxTurnsPerDay: 10 });
    await project(h, 'two', { everyMinutes: 5, maxTurnsPerDay: 10 });

    await h.service.tickNow();

    expect(h.transcript.sessions({ kind: 'orchestrator' })).toHaveLength(1);
    expect(h.refused).toHaveLength(1);
    expect(h.refused[0].reason).toContain('hub-wide');
  });

  it('never runs a project whose PRD is still the scaffold', async () => {
    const h = await setup();
    await project(h, 'demo', { everyMinutes: 5, maxTurnsPerDay: 10 }, '');

    await h.service.tickNow();

    expect(turnsOf(h, 'demo')).toBe(0);
    expect((await (await h.service.get('demo')).manifest()).lastAutoTurnAt).toBeUndefined();
  });

  it('suspends auto-run after three turns die on the same gateway error', async () => {
    const h = await setup({}, await serveStatus(412, '{"detail":"model not found"}'));
    await project(h, 'demo', { everyMinutes: 5, maxTurnsPerDay: 10 });
    const suspended: { slug: string; reason: string }[] = [];
    h.service.onAutoRunSuspended((slug, reason) => suspended.push({ slug, reason }));

    await h.service.runTurn('demo');
    await h.service.runTurn('demo');
    expect(suspended).toHaveLength(0);
    await h.service.runTurn('demo');

    const bundle = await h.service.get('demo');
    expect((await bundle.manifest()).autoRun).toMatchObject({ enabled: false, everyMinutes: 5, maxTurnsPerDay: 10 });
    expect(await bundle.decisions()).toContain('auto-run suspended');
    expect(suspended).toHaveLength(1);
    expect(suspended[0]).toMatchObject({ slug: 'demo' });
    expect(suspended[0].reason).toContain('endpoint error 412');

    await h.service.tickNow();
    expect(turnsOf(h, 'demo')).toBe(3);
  });

  it('never sets its timer when autoTurns is off, while tickNow still works', async () => {
    const h = await setup({ autoTurns: false, tickIntervalMs: 20 });
    await project(h, 'demo', { everyMinutes: 5, maxTurnsPerDay: 10 });

    h.service.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(turnsOf(h, 'demo')).toBe(0);

    await h.service.tickNow();
    expect(turnsOf(h, 'demo')).toBe(1);
  });
});

describe('gatewayErrorClass', () => {
  const events = (...contents: string[]) => contents.map((content) => ({ content }));

  it('keeps the status and drops the endpoint and the response body', () => {
    expect(gatewayErrorClass(events('gateway error: endpoint error 412 from https://x/v1: {"detail":"no such model"}')))
      .toBe('endpoint error 412');
  });

  it('keeps a message with no body as it is', () => {
    expect(gatewayErrorClass(events('gateway error: missing FIREWORKS_API_KEY for https://x  '))).toBe('missing FIREWORKS_API_KEY for https://x');
  });

  it('is null for a session that recorded no gateway error', () => {
    expect(gatewayErrorClass(events('turn 1 ended error without a briefing'))).toBeNull();
    expect(gatewayErrorClass([])).toBeNull();
  });
});
