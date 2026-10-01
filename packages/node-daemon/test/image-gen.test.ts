import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImagePayload, Job, VideoPayload } from '@agenthub/shared';
import { createComfyMock, type MockComfy } from '../../mocks/src/comfy-mock.js';
import { createHub, type Hub } from '../../hub/src/server.js';
import { JobRunner } from '../src/job-runner.js';
import { workflowPaths } from '../src/config.js';
import { fillWorkflow, parseImagePayload, runImageGen } from '../src/video-gen.js';

const IMAGE_TEMPLATE = readFileSync(join(process.cwd(), 'deploy/amd/comfy/qwen-image-t2i.json'), 'utf8');
const WAN_TEMPLATE = readFileSync(join(process.cwd(), 'deploy/amd/comfy/wan22-t2v.json'), 'utf8');

const PAYLOAD: ImagePayload = { prompt: 'a "tomato" app icon, flat', negativePrompt: 'text', width: 1024, height: 768, seed: 7 };

type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
const byClass = (w: Workflow, cls: string) => Object.values(w).filter((n) => n.class_type === cls);

let comfy: MockComfy | undefined;
let hub: Hub | undefined;
const dirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ah-image-'));
  dirs.push(dir);
  return dir;
}

async function startComfy(pollsUntilDone = 1): Promise<string> {
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

describe('runImageGen', () => {
  it('submits the filled Qwen-Image template, polls history and downloads the png', async () => {
    const comfyUrl = await startComfy(2);
    const outDir = join(tmpDir(), 'media', 'image');

    const result = await runImageGen(PAYLOAD, { comfyUrl, workflowTemplate: IMAGE_TEMPLATE, outDir, jobId: 5, onLine: () => {}, pollIntervalMs: 10 });

    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({ path: join(outDir, '5.png') });
    expect(comfy!.polls).toBe(3);
    const bytes = readFileSync(join(outDir, '5.png'));
    expect(bytes).toEqual(comfy!.imageBytes);
    expect(bytes.subarray(1, 4).toString()).toBe('PNG');

    const sent = comfy!.prompts[0] as Workflow;
    expect(byClass(sent, 'CLIPTextEncode').map((n) => n.inputs.text)).toEqual([PAYLOAD.prompt, 'text']);
    expect(byClass(sent, 'EmptySD3LatentImage')[0]!.inputs).toMatchObject({ width: 1024, height: 768 });
    expect(byClass(sent, 'KSampler')[0]!.inputs.seed).toBe(7);
  });

  it('picks a seed when the payload names none and reports it', async () => {
    const comfyUrl = await startComfy(0);
    const { prompt, width, height } = PAYLOAD;
    const result = await runImageGen({ prompt, width, height }, {
      comfyUrl, workflowTemplate: IMAGE_TEMPLATE, outDir: tmpDir(), jobId: 1, onLine: () => {}, pollIntervalMs: 10,
    });
    const seed = (result.data as { seed?: number }).seed;
    expect(Number.isInteger(seed)).toBe(true);
    expect(byClass(comfy!.prompts[0] as Workflow, 'KSampler')[0]!.inputs.seed).toBe(seed);
  });

  it('validates the image payload', () => {
    expect(parseImagePayload(PAYLOAD)).toEqual(PAYLOAD);
    expect(parseImagePayload({ ...PAYLOAD, width: 1000 })).toBeNull(); // not on the 16-px grid
    expect(parseImagePayload({ ...PAYLOAD, height: 4096 })).toBeNull();
    expect(parseImagePayload({ ...PAYLOAD, seed: -1 })).toBeNull();
    expect(parseImagePayload({ ...PAYLOAD, prompt: '  ' })).toBeNull();
    expect(parseImagePayload({ ...PAYLOAD, extra: 1 })).toEqual(PAYLOAD);
  });
});

describe('the Wan 2.2 video template', () => {
  it('takes size, fps, seed and a 4k+1 frame count', () => {
    const payload: VideoPayload = { prompt: 'waves', mode: 't2v', durationSec: 5, aspect: '16:9', resolution: '768p', width: 832, height: 480, fps: 16, seed: 3 };
    const w = fillWorkflow(WAN_TEMPLATE, payload) as Workflow;
    expect(byClass(w, 'Wan22ImageToVideoLatent')[0]!.inputs).toMatchObject({ width: 832, height: 480, length: 81 });
    expect(byClass(w, 'CreateVideo')[0]!.inputs.fps).toBe(16);
    expect(byClass(w, 'KSampler')[0]!.inputs.seed).toBe(3);
  });

  it('fills defaults for a legacy-shaped payload', () => {
    const w = fillWorkflow(WAN_TEMPLATE, { prompt: 'waves', mode: 't2v', durationSec: 6, aspect: '16:9', resolution: '768p' }) as Workflow;
    expect(byClass(w, 'Wan22ImageToVideoLatent')[0]!.inputs).toMatchObject({ width: 832, height: 480, length: 97 });
  });
});

describe('workflowPaths', () => {
  it('reads workflows.{image,video} per job type', () => {
    expect(workflowPaths({ comfyUrl: 'x', workflows: { image: '/i.json', video: '/v.json' } })).toEqual({ image: '/i.json', video: '/v.json' });
  });

  it('keeps the legacy single video.workflow working', () => {
    const paths = workflowPaths({ comfyUrl: 'x', workflow: '/old.json' });
    expect(paths.video).toBe('/old.json');
    expect(paths.image).toMatch(/deploy\/amd\/comfy\/qwen-image-t2i\.json$/);
    expect(workflowPaths({ comfyUrl: 'x', workflow: '/old.json', workflows: { video: '/new.json' } }).video).toBe('/new.json');
  });

  it('falls back to the repo templates when the config names none', () => {
    expect(workflowPaths({ comfyUrl: 'x' }).video).toMatch(/deploy\/spark\/minimax-h3-t2v\.json$/);
  });
});

describe('JobRunner image-gen dispatch', () => {
  async function runOne(payload: unknown, video: { comfyUrl: string; workflowTemplate: string; imageTemplate?: string }): Promise<Job> {
    hub = createHub({ staleMs: 60000 });
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const hubUrl = `http://127.0.0.1:${(hub.app.server.address() as { port: number }).port}`;
    await fetch(`${hubUrl}/api/nodes/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'pc', arch: 'x64', endpoints: [], jobTypes: ['image-gen'], video: true }),
    });
    const job = hub.queue.enqueue({ type: 'image-gen', tier: 'video-gen', priority: 'batch', payload });
    const runner = new JobRunner({ hub: hubUrl, node: 'pc', types: ['image-gen'], workspaceRoot: tmpDir(), claimIntervalMs: 20, video });
    runner.start();
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const j = hub.queue.get(job.id)!;
        if (j.status === 'failed' || j.status === 'done') return j;
        await new Promise((r) => setTimeout(r, 20));
      }
      return hub.queue.get(job.id)!;
    } finally {
      await runner.stop();
    }
  }

  it('renders, uploads the png to the hub and completes', async () => {
    const comfyUrl = await startComfy(0);
    const j = await runOne(PAYLOAD, { comfyUrl, workflowTemplate: WAN_TEMPLATE, imageTemplate: IMAGE_TEMPLATE });
    // `done` at all means the upload went through: a refused artifact fails the job instead.
    expect(j.status).toBe('done');
    expect(j.result?.data).toMatchObject({ path: expect.stringMatching(/media\/image\/\d+\.png$/) });
  });

  it('refuses image-gen on a node with no image template, without requeueing', async () => {
    const comfyUrl = await startComfy(0);
    const j = await runOne(PAYLOAD, { comfyUrl, workflowTemplate: WAN_TEMPLATE });
    expect(j.status).toBe('failed');
    expect(j.error).toMatch(/image capability not configured/);
  });
});
