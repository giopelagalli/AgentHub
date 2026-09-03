import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('runs a real shell-task through the default executor end to end', async () => {
    const hubUrl = await startHub();
    await registerNode(hubUrl, 'n1');
    const res = await fetch(`${hubUrl}/api/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'shell-task', tier: 'worker', priority: 'batch',
        payload: { cmd: ['node', '-e', 'console.log("hi")'] },
      }),
    });
    const job = (await res.json()) as Job;

    const root = mkdtempSync(join(tmpdir(), 'ah-ws-'));
    // No `execute` override: exercises the real default dispatcher -> runShellTask.
    const runner = new JobRunner({ hub: hubUrl, node: 'n1', types: ['shell-task'], workspaceRoot: root, claimIntervalMs: 50 });
    runner.start();
    try {
      await waitFor(async () => (await fetchJob(hubUrl, job.id)).status === 'done');
      const full = await (await fetch(`${hubUrl}/api/jobs/${job.id}`)).json() as Job & { logs: { line: string }[] };
      expect(full.logs.some((l) => l.line === 'out: hi')).toBe(true);
    } finally {
      await runner.stop();
    }
  });

  it('fails an unsupported job type without requeueing', async () => {
    const hubUrl = await startHub();
    await fetch(`${hubUrl}/api/nodes/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'n1', arch: 'arm64', endpoints: [], jobTypes: ['shell-task', 'llm-session'] }),
    });
    const res = await fetch(`${hubUrl}/api/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'llm-session', tier: 'worker', priority: 'batch', payload: {} }),
    });
    const job = (await res.json()) as Job;

    const runner = new JobRunner({
      hub: hubUrl, node: 'n1', types: ['shell-task', 'llm-session'], workspaceRoot: '/tmp', claimIntervalMs: 50,
    });
    runner.start();
    try {
      await waitFor(async () => (await fetchJob(hubUrl, job.id)).status === 'failed');
      const after = await fetchJob(hubUrl, job.id);
      expect(after.error).toBe('unsupported job type');
      expect(after.attempts).toBe(1);
    } finally {
      await runner.stop();
    }
  });

  it('the idle 204 poll does not throw or log anything', async () => {
    const hubUrl = await startHub();
    await registerNode(hubUrl, 'n1');

    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };

    const runner = new JobRunner({
      hub: hubUrl, node: 'n1', types: ['shell-task'], workspaceRoot: '/tmp', claimIntervalMs: 20,
      execute: async () => ({ exitCode: 0 }),
    });
    runner.start();
    try {
      await new Promise((r) => setTimeout(r, 150)); // several idle poll intervals, nothing queued
    } finally {
      await runner.stop();
      console.error = originalError;
    }
    expect(errors).toEqual([]);
  });
});
