import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import type { Job, MediaAsset, MediaList } from '@agenthub/shared';
import { createHub, type Hub } from '../src/server.js';
import { MediaDesk } from '../src/projects/media.js';
import { mediaTools } from '../src/agents/media-tools.js';
import { subagentSystemPrompt } from '../src/projects/prompts.js';
import { routeAccess } from '../src/auth.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

let hub: Hub | undefined;
let dirs: string[] = [];

afterEach(async () => {
  await hub?.stop();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  hub = undefined; dirs = [];
});

async function setup(opts: { node?: boolean } = {}): Promise<Hub> {
  const root = await mkdtemp(join(tmpdir(), 'agenthub-media-'));
  dirs.push(root);
  hub = createHub({ projectsRoot: join(root, 'projects'), staleMs: 60_000, assistant: { memoryRoot: join(root, 'memory') } });
  await hub.projects.stop();
  await hub.projects.create({ slug: 'app', title: 'App', intent: 'an app' });
  if (opts.node !== false) {
    await hub.app.inject({
      method: 'POST', url: '/api/nodes/register',
      payload: { name: 'pc', arch: 'x64', endpoints: [], jobTypes: ['image-gen', 'video-gen'], video: true },
    });
  }
  return hub;
}

/** What the PC's daemon does with a media job: claim it, upload the file, report it done. */
async function render(h: Hub, bytes = PNG): Promise<Job> {
  const claimed = await h.app.inject({ method: 'POST', url: '/api/jobs/claim', payload: { node: 'pc', types: ['image-gen', 'video-gen'] } });
  const job = claimed.json() as Job;
  const up = await h.app.inject({
    method: 'POST', url: `/api/jobs/${job.id}/artifact?node=pc`, headers: { 'content-type': 'application/octet-stream' }, payload: bytes,
  });
  expect(up.statusCode).toBe(200);
  await h.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/complete`, payload: { node: 'pc', result: { exitCode: 0 } } });
  return job;
}

const list = async (h: Hub): Promise<MediaList> => (await h.app.inject({ method: 'GET', url: '/api/projects/app/media' })).json();

describe('project media', () => {
  it('queues an image for the project and lands the file, its sidecar and a commit in the bundle', async () => {
    const h = await setup();
    const queued = await h.app.inject({
      method: 'POST', url: '/api/projects/app/media',
      payload: { kind: 'image', prompt: ' an app icon ', width: 512, height: 512, seed: 9 },
    });
    expect(queued.statusCode).toBe(201);
    const job = queued.json() as Job;
    expect(job).toMatchObject({ type: 'image-gen', project: 'app', payload: { prompt: 'an app icon', width: 512, height: 512, seed: 9 } });
    expect((await list(h)).jobs).toMatchObject([{ jobId: job.id, kind: 'image', status: 'queued' }]);

    await render(h);
    const bundle = await h.projects.get('app');
    expect(await readFile(join(bundle.dir, 'media', `image-${job.id}.png`))).toEqual(PNG);
    const sidecar = JSON.parse(await readFile(join(bundle.dir, 'media', `image-${job.id}.json`), 'utf8')) as MediaAsset;
    expect(sidecar).toMatchObject({
      id: `image-${job.id}`, file: `image-${job.id}.png`, kind: 'image', prompt: 'an app icon', jobId: job.id, node: 'pc',
      params: { width: 512, height: 512, seed: 9 }, bytes: PNG.length,
    });
    expect(sidecar.durationMs).toBeGreaterThanOrEqual(0);
    const log = await simpleGit(bundle.dir).log();
    expect(log.latest?.message).toMatch(new RegExp(`^media: image-${job.id}\\.png — an app icon`));
    expect((await simpleGit(bundle.dir).status()).isClean()).toBe(true);

    const after = await list(h);
    expect(after.assets.map((a) => a.file)).toEqual([`image-${job.id}.png`]);
    expect(after.jobs).toEqual([]);
    expect(after.renderers).toEqual({ image: true, video: true });
  });

  it('queues a clip with seconds and fps, and records them under their media names', async () => {
    const h = await setup();
    const job = (await h.app.inject({ method: 'POST', url: '/api/projects/app/media', payload: { kind: 'video', prompt: 'waves', seconds: 6, fps: 24, width: 480, height: 832 } })).json() as Job;
    expect(job).toMatchObject({ type: 'video-gen', payload: { durationSec: 6, fps: 24, width: 480, height: 832, aspect: '9:16', mode: 't2v' } });
    await render(h, Buffer.from('mp4'));
    const [asset] = (await list(h)).assets;
    expect(asset).toMatchObject({ file: `video-${job.id}.mp4`, kind: 'video', params: { seconds: 6, fps: 24, width: 480, height: 832 } });
    expect(typeof asset!.params.seed).toBe('number'); // the hub picked one
  });

  it('serves a file with its type, and refuses anything outside media/', async () => {
    const h = await setup();
    await h.app.inject({ method: 'POST', url: '/api/projects/app/media', payload: { kind: 'image', prompt: 'x' } });
    const job = await render(h);
    const got = await h.app.inject({ method: 'GET', url: `/api/projects/app/media/image-${job.id}.png` });
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.rawPayload).toEqual(PNG);

    const bundle = await h.projects.get('app');
    await writeFile(join(bundle.dir, 'secret.png'), 'no');
    await symlink(join(bundle.dir, 'secret.png'), join(bundle.dir, 'media', 'link.png'));
    for (const file of [`image-${job.id}.json`, '..%2Fsecret.png', 'link.png', 'missing.png', '.hidden.png']) {
      expect((await h.app.inject({ method: 'GET', url: `/api/projects/app/media/${file}` })).statusCode, file).toBe(404);
    }
    expect((await h.app.inject({ method: 'GET', url: '/api/projects/nope/media' })).statusCode).toBe(404);
  });

  it('validates the request, and refuses a kind no machine renders', async () => {
    const h = await setup({ node: false });
    const post = (payload: unknown) => h.app.inject({ method: 'POST', url: '/api/projects/app/media', payload: payload as object });
    expect((await post({ kind: 'audio', prompt: 'x' })).statusCode).toBe(400);
    expect((await post({ kind: 'image', prompt: '' })).statusCode).toBe(400);
    expect((await post({ kind: 'image', prompt: 'x', width: 1000 })).statusCode).toBe(400);
    const none = await post({ kind: 'image', prompt: 'x' });
    expect(none.statusCode).toBe(409);
    expect(none.json().error).toMatch(/no machine can render images/);
    expect((await list(h)).renderers).toEqual({ image: false, video: false });
  });

  it('is owner-only', () => {
    for (const [method, route] of [['GET', '/api/projects/:slug/media'], ['GET', '/api/projects/:slug/media/:file'], ['POST', '/api/projects/:slug/media']] as const) {
      expect(routeAccess(method, route)).toBe('owner');
    }
  });
});

describe('the designer tools', () => {
  it('generate_image queues for the project, waits for the render and returns its path', async () => {
    const h = await setup();
    const desk = new MediaDesk({ queue: h.queue, registry: h.registry, seed: () => 4 });
    const [generateImage] = mediaTools(desk, { pollMs: 5 });
    const bundle = await h.projects.get('app');
    const lines: string[] = [];
    const pending = generateImage!.run({ prompt: 'a hero image', width: 1344, height: 768 }, { bundle, sessionId: 1, log: (l) => lines.push(l) });

    await new Promise((r) => setTimeout(r, 20));
    const job = await render(h);
    const out = await pending;
    expect(out).toMatch(new RegExp(`^media/image-${job.id}\\.png \\(1344×768, seed 4\\) — rendered on pc in \\d+ s$`));
    expect(job).toMatchObject({ project: 'app', type: 'image-gen' });
    expect(lines).toEqual([`[media] queued image job ${job.id}`]);
  });

  it('stops waiting when the turn is aborted, leaving the job queued', async () => {
    const h = await setup();
    const [, generateVideo] = mediaTools(new MediaDesk({ queue: h.queue, registry: h.registry }), { pollMs: 5 });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 20);
    const out = await generateVideo!.run({ prompt: 'a demo clip' }, { bundle: await h.projects.get('app'), sessionId: 1, log: () => {}, signal: abort.signal });
    expect(out).toMatch(/^error: stopped waiting — job \d+ is still queued/);
  });

  it('a designer is told about them', () => {
    expect(subagentSystemPrompt('designer', ['generate_image', 'generate_video'])).toMatch(/generate_image and generate_video/);
  });
});
