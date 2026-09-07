import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockOpenAI, type MockOpenAI, type ScriptStep } from '@agenthub/mocks';
import { openDb } from '../src/db.js';
import { JobQueue } from '../src/queue.js';
import { NodeRegistry } from '../src/node-registry.js';
import { ModelGateway } from '../src/gateway.js';
import { AgentLoop } from '../src/agents/loop.js';
import { Transcript } from '../src/agents/transcript.js';
import { ProjectService } from '../src/projects/service.js';

let root: string;
let mocks: MockOpenAI[];
let service: ProjectService | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agenthub-service-'));
  mocks = [];
});

afterEach(async () => {
  if (service) await service.stop({ graceMs: 0 }).catch(() => {});
  for (const m of mocks) await m.close();
  await rm(root, { recursive: true, force: true });
});

async function serve(script: ScriptStep[]): Promise<{ mock: MockOpenAI; url: string }> {
  const mock = createMockOpenAI({ script });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  mocks.push(mock);
  return { mock, url: `http://127.0.0.1:${(mock.server.address() as { port: number }).port}` };
}

/** Polls until the process group is gone (the SIGKILL escalation is asynchronous). */
async function groupGone(pgid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(-pgid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface Harness {
  service: ProjectService;
  transcript: Transcript;
}

async function setup(brainScript: ScriptStep[], opts: { turnTimeoutMs?: number } = {}): Promise<Harness> {
  const { url: brainUrl } = await serve(brainScript);
  const { url: workerUrl } = await serve([]);
  const db = openDb(':memory:');
  const registry = new NodeRegistry(db);
  registry.register({
    name: 'spark', arch: 'arm64',
    endpoints: [
      { tier: 'orchestrator', url: brainUrl, model: 'mock-model', maxStreams: 2 },
      { tier: 'worker', url: workerUrl, model: 'mock-model', maxStreams: 2 },
    ],
  });
  const transcript = new Transcript(db);
  const gateway = new ModelGateway(registry);
  const loop = new AgentLoop({ gateway, transcript });
  const queue = new JobQueue(db);
  service = new ProjectService({ root, loop, gateway, queue, registry, transcript, ...opts });
  return { service, transcript };
}

describe('ProjectService.stop', () => {
  it('gives an in-flight turn graceMs to end, then aborts it and kills the shell it was running', async () => {
    const { service: svc, transcript } = await setup([
      { toolCalls: [{ name: 'run_shell', arguments: { cmd: ['sh', '-c', 'echo $$ > pid.txt; sleep 30'] } }] },
    ]);
    await svc.create({ slug: 'demo', title: 'Demo', intent: 'ship it' });

    const turn = svc.runTurn('demo');
    // Let the shell tool actually start (write its pid file) before asking the service to stop.
    const bundle = await svc.get('demo');
    const pidPath = join(bundle.workspace, 'pid.txt');
    const pidDeadline = Date.now() + 3000;
    for (;;) {
      try {
        await readFile(pidPath, 'utf8');
        break;
      } catch {
        if (Date.now() > pidDeadline) throw new Error('shell never started');
        await new Promise((r) => setTimeout(r, 20));
      }
    }

    const started = Date.now();
    await svc.stop({ graceMs: 200 });
    expect(Date.now() - started).toBeLessThan(3000);

    await turn;

    const orchestratorSession = transcript.sessions({ kind: 'orchestrator' })[0];
    expect(orchestratorSession.outcome).toBe('aborted');
    expect(transcript.events(orchestratorSession.id).map((e) => e.content).join('\n')).toContain('ended aborted');

    const pgid = Number((await readFile(pidPath, 'utf8')).trim());
    expect(await groupGone(pgid)).toBe(true);
  }, 10_000);

  it('aborts a turn queued behind the one it just stopped, instead of letting it run to completion', async () => {
    const { service: svc, transcript } = await setup([
      { toolCalls: [{ name: 'run_shell', arguments: { cmd: ['sh', '-c', 'echo $$ > pid1.txt; sleep 25'] } }] },
      { toolCalls: [{ name: 'run_shell', arguments: { cmd: ['sh', '-c', 'echo $$ > pid2.txt; sleep 25'] } }] },
    ]);
    await svc.create({ slug: 'demo', title: 'Demo', intent: 'ship it' });

    // Two turns on the same slug: the second queues behind the first in the per-slug chain.
    const turn1 = svc.runTurn('demo');
    const turn2 = svc.runTurn('demo');

    const bundle = await svc.get('demo');
    const pid1Path = join(bundle.workspace, 'pid1.txt');
    const pid2Path = join(bundle.workspace, 'pid2.txt');
    const pidDeadline = Date.now() + 3000;
    for (;;) {
      try {
        await readFile(pid1Path, 'utf8');
        break;
      } catch {
        if (Date.now() > pidDeadline) throw new Error('shell never started');
        await new Promise((r) => setTimeout(r, 20));
      }
    }

    const started = Date.now();
    await svc.stop({ graceMs: 200 });
    expect(Date.now() - started).toBeLessThan(3000);

    await Promise.all([turn1, turn2]);

    const sessions = transcript.sessions({ kind: 'orchestrator' });
    expect(sessions).toHaveLength(2);
    for (const s of sessions) expect(s.outcome).toBe('aborted');

    const pgid = Number((await readFile(pid1Path, 'utf8')).trim());
    expect(await groupGone(pgid)).toBe(true);
    // The queued turn should have been aborted before it ever ran a tool call.
    await expect(readFile(pid2Path, 'utf8')).rejects.toThrow();
  }, 10_000);

  it('resolves promptly when nothing is in flight', async () => {
    const { service: svc } = await setup([]);
    await svc.create({ slug: 'demo', title: 'Demo', intent: 'ship it' });

    const started = Date.now();
    await svc.stop({ graceMs: 5000 });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('ProjectService turnTimeoutMs', () => {
  it('aborts a turn that outruns its deadline', async () => {
    const { service: svc, transcript } = await setup(
      [{ toolCalls: [{ name: 'run_shell', arguments: { cmd: ['sleep', '30'] } }] }],
      { turnTimeoutMs: 200 },
    );
    await svc.create({ slug: 'demo', title: 'Demo', intent: 'ship it' });

    await svc.runTurn('demo');

    const orchestratorSession = transcript.sessions({ kind: 'orchestrator' })[0];
    expect(orchestratorSession.outcome).toBe('aborted');
  }, 10_000);
});
