import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job } from '@agenthub/shared';
import { createComfyMock, type MockComfy } from '../../mocks/src/comfy-mock.js';
import { createHub, type Hub } from '../../hub/src/server.js';
import { JobRunner } from '../src/job-runner.js';
import { runVideoGen, parseVideoPayload, type VideoPayload } from '../src/video-gen.js';

const WORKFLOW = readFileSync(join(process.cwd(), 'deploy/spark/minimax-h3-t2v.json'), 'utf8');

const PAYLOAD: VideoPayload = {
  prompt: 'a "neon" cat, cinematic',
  mode: 't2v',
  durationSec: 6,
  aspect: '16:9',
  resolution: '1080p',
};

let comfy: MockComfy | undefined;
let hub: Hub | undefined;
const dirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ah-video-'));
  dirs.push(dir);
  return dir;
}

async function startComfy(pollsUntilDone: number): Promise<string> {
  comfy = createComfyMock({ pollsUntilDone });
  await comfy.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${(comfy.server.address() as { port: number }).port}`;
}

afterEach(async () => {
  await comfy?.close(); comfy = undefined;
  await hub?.stop(); hub = undefined;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe('runVideoGen', () => {
  it('fills the workflow, polls history and writes the mp4', async () => {
    const comfyUrl = await startComfy(2);
    const outDir = join(tmpDir(), 'media', 'video');

    const result = await runVideoGen(PAYLOAD, {
      comfyUrl, workflowTemplate: WORKFLOW, outDir, jobId: 42,
      onLine: () => {}, pollIntervalMs: 10,
    });

    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({ path: join(outDir, '42.mp4'), durationSec: 6 });
    expect(readFileSync(join(outDir, '42.mp4'))).toEqual(comfy!.videoBytes);

    // the workflow reached ComfyUI as JSON with the payload substituted (duration as a number)
    const sent = comfy!.prompts[0] as Record<string, { inputs: Record<string, unknown> }>;
    expect(sent['2'].inputs.prompt).toBe(PAYLOAD.prompt);
    expect(sent['3'].inputs.seconds).toBe(6);
    expect(sent['3'].inputs.resolution).toBe('1080p');
    expect(sent['1'].inputs.mode).toBe('t2v');
  });

  it('reports an abort mid-poll instead of a failure', async () => {
    const comfyUrl = await startComfy(1000); // never completes on its own
    const outDir = join(tmpDir(), 'media', 'video');
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 60);

    const result = await runVideoGen(PAYLOAD, {
      comfyUrl, workflowTemplate: WORKFLOW, outDir, jobId: 7,
      onLine: () => {}, pollIntervalMs: 10, signal: abort.signal,
    });

    expect(result).toMatchObject({ signal: 'aborted' });
    expect(existsSync(join(outDir, '7.mp4'))).toBe(false);
  });

  it('rejects payloads outside the spec schema', () => {
    expect(parseVideoPayload(PAYLOAD)).toEqual(PAYLOAD);
    expect(parseVideoPayload({ ...PAYLOAD, durationSec: 20 })).toBeNull();
    expect(parseVideoPayload({ ...PAYLOAD, mode: 'x2v' })).toBeNull();
    expect(parseVideoPayload({ ...PAYLOAD, aspect: '5:4' })).toBeNull();
    expect(parseVideoPayload({ ...PAYLOAD, resolution: '4k' })).toBeNull();
    expect(parseVideoPayload({ prompt: 'hi' })).toBeNull();
  });
});

describe('JobRunner video-gen dispatch', () => {
  async function startHub(): Promise<string> {
    hub = createHub({ staleMs: 60000 });
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    return `http://127.0.0.1:${(hub.app.server.address() as { port: number }).port}`;
  }

  async function runOne(payload: unknown, comfyUrl: string, workspaceRoot: string): Promise<Job> {
    const hubUrl = await startHub();
    await fetch(`${hubUrl}/api/nodes/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'vid', arch: 'arm64', endpoints: [], jobTypes: ['video-gen'], video: true }),
    });
    const job = hub!.queue.enqueue({ type: 'video-gen', tier: 'video-gen', priority: 'batch', payload });
    const runner = new JobRunner({
      hub: hubUrl, node: 'vid', types: ['video-gen'], workspaceRoot, claimIntervalMs: 20,
      video: { comfyUrl, workflowTemplate: WORKFLOW },
    });
    runner.start();
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const j = hub!.queue.get(job.id)!;
        if (j.status === 'failed' || j.status === 'done') return j;
        await new Promise((r) => setTimeout(r, 20));
      }
      return hub!.queue.get(job.id)!;
    } finally {
      await runner.stop();
    }
  }

  it('fails an invalid payload without requeueing it', async () => {
    const comfyUrl = await startComfy(0);
    const j = await runOne({ prompt: 'hi', mode: 't2v', durationSec: 99, aspect: '16:9', resolution: '1080p' }, comfyUrl, tmpDir());
    expect(j.status).toBe('failed');
    expect(j.error).toMatch(/invalid video-gen payload/);
    expect(comfy!.prompts).toHaveLength(0); // never reached ComfyUI
  });

  it('runs a valid payload into the project workspace', async () => {
    const comfyUrl = await startComfy(0);
    const workspaceRoot = tmpDir();
    const j = await runOne(PAYLOAD, comfyUrl, workspaceRoot);
    expect(j.status).toBe('done');
    expect(j.result?.data).toMatchObject({ path: join(workspaceRoot, '_default', 'media', 'video', `${j.id}.mp4`), durationSec: 6 });
    // The runner uploads the clip before reporting done, so the hub holds its own copy.
    const logs = (await hub!.app.inject({ method: 'GET', url: `/api/jobs/${j.id}` })).json().logs as { line: string }[];
    expect(logs.some((l) => /\[hub\] stored \d+ bytes/.test(l.line))).toBe(true);
  });
});
