import { describe, it, expect, afterEach } from 'vitest';
import type { Job } from '@agenthub/shared';
import { createHub, type Hub } from '../../hub/src/server.js';
import { JobRunner } from '../src/job-runner.js';

let hub: Hub;
afterEach(async () => { await hub?.stop(); });

async function startHub(): Promise<string> {
  hub = createHub({ staleMs: 60000 });
  await hub.app.listen({ port: 0, host: '127.0.0.1' });
  const port = (hub.app.server.address() as { port: number }).port;
  return `http://127.0.0.1:${port}`;
}

async function registerNode(hubUrl: string, name: string): Promise<void> {
  await fetch(`${hubUrl}/api/nodes/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, arch: 'arm64', endpoints: [], jobTypes: ['shell-task'] }),
  });
}

async function enqueueJob(hubUrl: string): Promise<Job> {
  const res = await fetch(`${hubUrl}/api/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'shell-task', tier: 'worker', priority: 'batch', payload: { cmd: ['echo', 'hi'] } }),
  });
  return (await res.json()) as Job;
}

async function fetchJob(hubUrl: string, id: number): Promise<Job> {
  const res = await fetch(`${hubUrl}/api/jobs/${id}`);
  return (await res.json()) as Job;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not met in time');
}

describe('JobRunner', () => {
  it('claims a job, runs the injected executor, and reports completion', async () => {
    const hubUrl = await startHub();
    await registerNode(hubUrl, 'n1');
    const job = await enqueueJob(hubUrl);

    const runner = new JobRunner({
      hub: hubUrl, node: 'n1', types: ['shell-task'], workspaceRoot: '/tmp', claimIntervalMs: 50,
      execute: async (_job, log) => {
        log('out: hi');
        return { exitCode: 0, stdoutTail: 'hi', stderrTail: '' };
      },
    });
    runner.start();
    try {
      await waitFor(async () => (await fetchJob(hubUrl, job.id)).status === 'done');
      const done = await fetchJob(hubUrl, job.id);
      expect(done.result).toMatchObject({ exitCode: 0 });
    } finally {
      await runner.stop();
    }
  });

  it('requeues the job with attempts 1 when the executor rejects', async () => {
    const hubUrl = await startHub();
    await registerNode(hubUrl, 'n1');
    const job = await enqueueJob(hubUrl);

    const runner = new JobRunner({
      hub: hubUrl, node: 'n1', types: ['shell-task'], workspaceRoot: '/tmp', claimIntervalMs: 50,
      execute: async () => { throw new Error('boom'); },
    });
    runner.start();
    try {
      await waitFor(async () => {
        const j = await fetchJob(hubUrl, job.id);
        return j.status === 'queued' && j.attempts === 1;
      });
    } finally {
      await runner.stop();
    }
  });

  it('stop() reports fail+requeue for an in-flight job instead of waiting forever', async () => {
    const hubUrl = await startHub();
    await registerNode(hubUrl, 'n1');
    const job = await enqueueJob(hubUrl);

    const runner = new JobRunner({
      hub: hubUrl, node: 'n1', types: ['shell-task'], workspaceRoot: '/tmp', claimIntervalMs: 50,
      execute: () => new Promise(() => { /* never resolves */ }),
    });
    runner.start();
    await waitFor(async () => (await fetchJob(hubUrl, job.id)).status === 'running');

    await runner.stop();

    const after = await fetchJob(hubUrl, job.id);
    expect(after.status).toBe('queued');
    expect(after.attempts).toBe(1);
  });
});
