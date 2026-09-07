import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Job } from '@agenthub/shared';
import { createHub, type Hub } from '../src/server.js';
import { FakeTelegramPort } from '../src/telegram/port.js';
import { assistantTools } from '../src/assistant/tools.js';

const OWNER = '4242';
const CLIP = Buffer.from('00000018667479706d7034320000000000', 'hex');
const PAYLOAD = { prompt: 'a sunset over the ocean', mode: 't2v', durationSec: 6, aspect: '16:9', resolution: '768p' };

let hub: Hub | undefined;
/** A second hub over the same database, standing in for a restart of the first. */
let restarted: Hub | undefined;
let control: FastifyInstance | undefined;
let dirs: string[] = [];
let profileCalls: string[] = [];
/** What the fake control server reports on GET /control/profile; the POST handler moves it. */
let liveProfile: string | null = 'llm';
/** Status the fake control server answers POST /control/profile with. */
let profileStatus = 200;

const tmpDir = async (name: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), `agenthub-${name}-`));
  dirs.push(dir);
  return dir;
};

/** A stand-in for the daemon's control server, so the claim path really performs the swap. */
async function startControl(): Promise<string> {
  const app = Fastify();
  app.post('/control/profile', async (req, reply) => {
    const { name } = req.body as { name: string };
    if (profileStatus !== 200) return reply.code(profileStatus).send({ error: 'switch failed' });
    profileCalls.push(name);
    liveProfile = name;
    return { profile: name, entries: [] };
  });
  app.get('/control/profile', async () => ({ profile: liveProfile, entries: [] }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  control = app;
  return `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
}

interface Setup { hub: Hub; port: FakeTelegramPort; projectsRoot: string; memoryRoot: string; }

async function setup(extra: Partial<Parameters<typeof createHub>[0]> = {}): Promise<Setup> {
  const projectsRoot = await tmpDir('projects');
  const memoryRoot = await tmpDir('memory');
  const port = new FakeTelegramPort();
  hub = createHub({
    projectsRoot, staleMs: 60_000,
    assistant: { memoryRoot, telegram: { port, ownerChatId: OWNER } },
    ...extra,
  });
  await hub.projects.stop();
  await hub.assistant();
  return { hub, port, projectsRoot, memoryRoot };
}

/** Registers a node the way a video-capable daemon does, control server included. */
async function registerVideoNode(h: Hub, controlUrl?: string): Promise<void> {
  await h.app.inject({
    method: 'POST', url: '/api/nodes/register',
    payload: {
      name: 'spark', arch: 'arm64', jobTypes: ['video-gen'], video: true,
      endpoints: [{ tier: 'worker', url: 'http://127.0.0.1:8001', model: 'qwen', maxStreams: 4 }],
      ...(controlUrl ? { profiles: ['llm', 'video'], control: { url: controlUrl } } : {}),
    },
  });
}

const claim = async (h: Hub) => h.app.inject({
  method: 'POST', url: '/api/jobs/claim', payload: { node: 'spark', types: ['video-gen'] },
});

const uploadArtifact = async (h: Hub, id: number, bytes: Buffer, node = 'spark') => h.app.inject({
  method: 'POST', url: `/api/jobs/${id}/artifact?node=${node}`,
  headers: { 'content-type': 'application/octet-stream' }, payload: bytes,
});

const complete = async (h: Hub, id: number) => h.app.inject({
  method: 'POST', url: `/api/jobs/${id}/complete`, payload: { node: 'spark', result: { exitCode: 0 } },
});

afterEach(async () => {
  await hub?.stop();
  await restarted?.stop();
  await control?.close();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  hub = undefined; restarted = undefined; control = undefined; dirs = [];
  profileCalls = []; liveProfile = 'llm'; profileStatus = 200;
});

describe('POST /api/video', () => {
  it('enqueues a batch video-gen job and reports where the clip will land', async () => {
    const { hub: h, memoryRoot } = await setup();
    const res = await h.app.inject({ method: 'POST', url: '/api/video', payload: { prompt: 'a cat' } });

    expect(res.statusCode).toBe(201);
    const job = res.json() as Job & { outputPath: string };
    expect(job.type).toBe('video-gen');
    expect(job.tier).toBe('video-gen');
    expect(job.priority).toBe('batch');
    // The unnamed fields take the documented defaults.
    expect(job.payload).toEqual({ prompt: 'a cat', mode: 't2v', durationSec: 6, aspect: '16:9', resolution: '768p' });
    expect(job.outputPath).toBe(join(memoryRoot, 'media', `${job.id}.mp4`));
  });

  it('rejects payloads outside the schema', async () => {
    const { hub: h } = await setup();
    const bad = [
      {}, { prompt: '' },
      { ...PAYLOAD, durationSec: 3 }, { ...PAYLOAD, durationSec: 16 },
      { ...PAYLOAD, mode: 'x2v' }, { ...PAYLOAD, aspect: '5:4' }, { ...PAYLOAD, resolution: '4k' },
      { ...PAYLOAD, imagePath: 7 },
    ];
    for (const payload of bad) {
      const res = await h.app.inject({ method: 'POST', url: '/api/video', payload });
      expect([payload, res.statusCode]).toEqual([payload, 400]);
    }
    const badProject = await h.app.inject({ method: 'POST', url: '/api/video', payload: { ...PAYLOAD, project: '../etc' } });
    expect(badProject.statusCode).toBe(400);
  });

  it('stores an uploaded clip in the requesting project bundle', async () => {
    const { hub: h } = await setup();
    await h.projects.create({ slug: 'reel', title: 'Reel', intent: 'clips' });
    await registerVideoNode(h);

    const job = (await h.app.inject({ method: 'POST', url: '/api/video', payload: { ...PAYLOAD, project: 'reel' } })).json() as Job;
    const claimed = await claim(h);
    expect(claimed.json().id).toBe(job.id);

    const stored = await uploadArtifact(h, job.id, CLIP);
    expect(stored.statusCode).toBe(200);
    const bundle = await h.projects.get('reel');
    const path = join(bundle.workspace, 'media', 'video', `${job.id}.mp4`);
    expect(stored.json().path).toBe(path);
    expect(await readFile(path)).toEqual(CLIP);
  });

  it('refuses an empty artifact and one for a job that takes none', async () => {
    const { hub: h } = await setup();
    await registerVideoNode(h);
    const job = (await h.app.inject({ method: 'POST', url: '/api/video', payload: PAYLOAD })).json() as Job;
    await claim(h);
    expect((await uploadArtifact(h, job.id, Buffer.alloc(0))).statusCode).toBe(400);
    expect((await uploadArtifact(h, 999999, CLIP)).statusCode).toBe(404);

    const shell = (await h.app.inject({
      method: 'POST', url: '/api/jobs',
      payload: { type: 'shell-task', tier: 'worker', priority: 'batch', payload: { cmd: ['true'] } },
    })).json() as Job;
    expect((await uploadArtifact(h, shell.id, CLIP)).statusCode).toBe(400);
  });

  it('takes the clip only from the node the job is running on, and only while it runs', async () => {
    const { hub: h } = await setup();
    await registerVideoNode(h);
    await h.app.inject({
      method: 'POST', url: '/api/nodes/register',
      payload: { name: 'mb', arch: 'arm64', endpoints: [], jobTypes: ['video-gen'] },
    });
    const job = (await h.app.inject({ method: 'POST', url: '/api/video', payload: PAYLOAD })).json() as Job;

    expect((await uploadArtifact(h, job.id, CLIP)).statusCode).toBe(409); // still queued
    await claim(h);
    expect((await uploadArtifact(h, job.id, CLIP, 'mb')).statusCode).toBe(409); // not the runner
    expect((await uploadArtifact(h, job.id, CLIP, 'ghost')).statusCode).toBe(409); // unknown node
    expect((await uploadArtifact(h, job.id, CLIP)).statusCode).toBe(200);

    await complete(h, job.id);
    expect((await uploadArtifact(h, job.id, CLIP)).statusCode).toBe(409); // no longer running
  });
});

describe('video-gen claim', () => {
  it('performs the exclusivity swap around the job and restores it on completion', async () => {
    const { hub: h } = await setup();
    const controlUrl = await startControl();
    await registerVideoNode(h, controlUrl);
    const job = (await h.app.inject({ method: 'POST', url: '/api/video', payload: PAYLOAD })).json() as Job;

    const claimed = await claim(h);
    expect(claimed.json().id).toBe(job.id);
    expect(profileCalls).toEqual(['video']);
    expect(h.gateway.parkedKeys()).toEqual(['spark|worker|http://127.0.0.1:8001']);
    expect(h.resources.busy('spark')).toBe(true);

    await uploadArtifact(h, job.id, CLIP);
    expect((await complete(h, job.id)).json().status).toBe('done');
    await vi.waitFor(() => expect(profileCalls).toEqual(['video', 'llm']));
    expect(h.gateway.parkedKeys()).toEqual([]);
    expect(h.resources.busy('spark')).toBe(false);
  });

  it('restores serving when the job fails', async () => {
    const { hub: h } = await setup();
    const controlUrl = await startControl();
    await registerVideoNode(h, controlUrl);
    const job = (await h.app.inject({ method: 'POST', url: '/api/video', payload: PAYLOAD })).json() as Job;
    await claim(h);

    await h.app.inject({
      method: 'POST', url: `/api/jobs/${job.id}/fail`,
      payload: { node: 'spark', error: 'comfy exploded', requeue: false },
    });
    await vi.waitFor(() => expect(profileCalls).toEqual(['video', 'llm']));
    expect(h.gateway.parkedKeys()).toEqual([]);
  });

  it('offers video work only to a node that advertises the capability', async () => {
    const { hub: h } = await setup();
    await h.app.inject({
      method: 'POST', url: '/api/nodes/register',
      payload: { name: 'spark', arch: 'arm64', endpoints: [], jobTypes: ['video-gen'] },
    });
    await h.app.inject({ method: 'POST', url: '/api/video', payload: PAYLOAD });
    expect((await claim(h)).statusCode).toBe(204);
  });

  it('leaves a second video job queued while the first holds the slot', async () => {
    const { hub: h } = await setup();
    const controlUrl = await startControl();
    await registerVideoNode(h, controlUrl);
    await h.app.inject({ method: 'POST', url: '/api/video', payload: PAYLOAD });
    const second = (await h.app.inject({ method: 'POST', url: '/api/video', payload: PAYLOAD })).json() as Job;

    await claim(h);
    expect((await claim(h)).statusCode).toBe(204);
    expect(h.queue.get(second.id)?.status).toBe('queued');
  });

  it('gives the attempt back and cools the node off when the swap fails', async () => {
    let now = 1_000_000;
    const { hub: h } = await setup({ video: { cooldownMs: 30_000, now: () => now } });
    const controlUrl = await startControl();
    await registerVideoNode(h, controlUrl);
    const job = (await h.app.inject({ method: 'POST', url: '/api/video', payload: PAYLOAD })).json() as Job;

    profileStatus = 500;
    expect((await claim(h)).statusCode).toBe(503);
    // The node never saw the job, so the claim is not held against it.
    expect(h.queue.get(job.id)).toMatchObject({ status: 'queued', attempts: 0, nodeId: null });
    const logs = (await h.app.inject({ method: 'GET', url: `/api/jobs/${job.id}` })).json().logs as { line: string }[];
    expect(logs.some((l) => l.line.includes('video slot unavailable on spark') && l.line.includes('500'))).toBe(true);

    // Inside the cooldown the node is simply not offered video work; it isn't charged another attempt.
    profileStatus = 200;
    now += 10_000;
    expect((await claim(h)).statusCode).toBe(204);
    expect(h.queue.get(job.id)?.attempts).toBe(0);

    now += 25_000;
    const claimed = await claim(h);
    expect(claimed.json().id).toBe(job.id);
    expect(profileCalls).toEqual(['video']);
  });
});

describe('generate_video tool', () => {
  it('queues a batch job and get_job reads it back', async () => {
    const { hub: h } = await setup();
    const { memory, planner, gate } = await h.assistant();
    const tools = assistantTools({
      memory, planner, gate, service: h.projects, master: h.master, registry: h.registry, jobs: h.queue,
    });
    const generate = tools.find((t) => t.def.name === 'generate_video')!;
    const getJob = tools.find((t) => t.def.name === 'get_job')!;

    const ctx = { sessionId: 0, log: () => {} };
    const reply = await generate.run({ prompt: 'a heron taking off', durationSec: 8 }, ctx);
    const id = Number(reply.match(/\d+/)![0]);
    const job = h.queue.get(id)!;
    expect(job).toMatchObject({ type: 'video-gen', priority: 'batch' });
    expect(job.payload).toMatchObject({ prompt: 'a heron taking off', durationSec: 8, mode: 't2v' });

    expect(JSON.parse(await getJob.run({ id }, ctx))).toMatchObject({ id, status: 'queued' });
    await expect(generate.run({ prompt: 'x', durationSec: 99 }, ctx)).rejects.toThrow('invalid video payload');
    // The slug becomes a path segment of the bundle the clip is written to.
    await expect(generate.run({ prompt: 'x', project: '../etc' }, ctx)).rejects.toThrow(/project must match/);
  });
});

describe('/video over Telegram', () => {
  it('queues the job and sends the finished clip back to the owner', async () => {
    const { hub: h, port, memoryRoot } = await setup();
    await registerVideoNode(h);

    await port.simulateMessage(OWNER, '/video a sunset over the ocean');
    await (await h.assistant()).router!.idle();

    const job = h.queue.list().find((j) => j.type === 'video-gen')!;
    expect(job.project).toBe('_telegram');
    expect(port.sent.map((s) => s.msg.text)).toEqual([`Queued video job #${job.id}: a sunset over the ocean`]);

    await claim(h);
    const stored = await uploadArtifact(h, job.id, CLIP);
    // No project bundle behind `_telegram`, so the clip lands under the memory root (§ constraints).
    expect(stored.json().path).toBe(join(memoryRoot, 'media', `${job.id}.mp4`));
    await complete(h, job.id);

    await vi.waitFor(() => expect(port.sent).toHaveLength(2));
    const delivered = port.sent[1]!.msg;
    expect(delivered.video).toEqual(CLIP);
    expect(delivered.text).toContain(`#${job.id}`);
  });

  it('names the path instead of sending a clip Telegram would refuse', async () => {
    const { hub: h, port, memoryRoot } = await setup();
    await registerVideoNode(h);
    await port.simulateMessage(OWNER, '/video a very long sunset');
    await (await h.assistant()).router!.idle();
    const job = h.queue.list().find((j) => j.type === 'video-gen')!;
    await claim(h);

    // Written straight to disk rather than uploaded: a 50MB body is past the artifact route's limit,
    // and a sparse file gives the size without the bytes.
    const path = join(memoryRoot, 'media', `${job.id}.mp4`);
    await mkdir(join(memoryRoot, 'media'), { recursive: true });
    await writeFile(path, '');
    await truncate(path, 50 * 1024 * 1024);
    await complete(h, job.id);

    await vi.waitFor(() => expect(port.sent).toHaveLength(2));
    expect(port.sent[1]!.msg.video).toBeUndefined();
    expect(port.sent[1]!.msg.text).toContain('too large to send (50MB)');
    expect(port.sent[1]!.msg.text).toContain(path);
  });

  it('tells the owner when the job failed instead of sending a clip', async () => {
    const { hub: h, port } = await setup();
    await registerVideoNode(h);
    await port.simulateMessage(OWNER, '/video a sunset');
    await (await h.assistant()).router!.idle();
    const job = h.queue.list().find((j) => j.type === 'video-gen')!;

    await claim(h);
    await h.app.inject({
      method: 'POST', url: `/api/jobs/${job.id}/fail`,
      payload: { node: 'spark', error: 'comfy exploded', requeue: false },
    });

    await vi.waitFor(() => expect(port.sent).toHaveLength(2));
    expect(port.sent[1]!.msg.text).toContain('comfy exploded');
    expect(port.sent[1]!.msg.video).toBeUndefined();
  });
});

describe('hub restart', () => {
  /** Both halves of the restart use the same database and control server as the first hub. */
  const restartHub = async (dbPath: string, projectsRoot: string, memoryRoot: string, port: FakeTelegramPort): Promise<Hub> => {
    const h = createHub({
      dbPath, projectsRoot, staleMs: 60_000,
      assistant: { memoryRoot, telegram: { port, ownerChatId: OWNER } },
    });
    await h.projects.stop();
    await h.assistant();
    restarted = h;
    return h;
  };

  it('keeps the node parked on the video profile when its job survived the restart', async () => {
    const dbPath = join(await tmpDir('db'), 'hub.db');
    const { hub: h, port, projectsRoot, memoryRoot } = await setup({ dbPath });
    const controlUrl = await startControl();
    await registerVideoNode(h, controlUrl);
    const job = (await h.app.inject({ method: 'POST', url: '/api/video', payload: PAYLOAD })).json() as Job;
    await claim(h);
    expect(liveProfile).toBe('video');

    await h.stop();
    hub = undefined;
    const h2 = await restartHub(dbPath, projectsRoot, memoryRoot, port);

    // The slot came back off the job row, so the endpoints are parked again without a control call.
    expect(h2.resources.holder('spark')).toBe(job.id);
    expect(h2.gateway.parkedKeys()).toEqual(['spark|worker|http://127.0.0.1:8001']);

    await registerVideoNode(h2, controlUrl);
    await vi.waitFor(() => expect(liveProfile).toBe('video'));
    expect(profileCalls).toEqual(['video']); // node and hub already agree; nothing to switch
    expect(h2.resources.busy('spark')).toBe(true);
  });

  it('puts a node stranded on the video profile back on llm', async () => {
    const dbPath = join(await tmpDir('db'), 'hub.db');
    const { hub: h, port, projectsRoot, memoryRoot } = await setup({ dbPath });
    const controlUrl = await startControl();
    await registerVideoNode(h, controlUrl);
    const job = (await h.app.inject({ method: 'POST', url: '/api/video', payload: PAYLOAD })).json() as Job;
    await claim(h);
    // The job goes away with the hub — a crash between the swap and the report leaves no runner.
    h.queue.fail(job.id, h.registry.byName('spark')!.id, { error: 'hub died' });
    await h.stop();
    hub = undefined;
    expect(liveProfile).toBe('video');

    const h2 = await restartHub(dbPath, projectsRoot, memoryRoot, port);
    expect(h2.resources.busy('spark')).toBe(false);

    await registerVideoNode(h2, controlUrl);
    await vi.waitFor(() => expect(liveProfile).toBe('llm'));
    expect(profileCalls).toEqual(['video', 'llm']);
    expect(h2.gateway.parkedKeys()).toEqual([]);
  });

  it('reconciles on the first heartbeat when the node never re-registers', async () => {
    const dbPath = join(await tmpDir('db'), 'hub.db');
    const { hub: h, port, projectsRoot, memoryRoot } = await setup({ dbPath });
    const controlUrl = await startControl();
    await registerVideoNode(h, controlUrl);
    const job = (await h.app.inject({ method: 'POST', url: '/api/video', payload: PAYLOAD })).json() as Job;
    await claim(h);
    h.queue.fail(job.id, h.registry.byName('spark')!.id, { error: 'hub died' });
    await h.stop();
    hub = undefined;

    const h2 = await restartHub(dbPath, projectsRoot, memoryRoot, port);
    await h2.app.inject({ method: 'POST', url: '/api/nodes/spark/heartbeat' });
    await vi.waitFor(() => expect(profileCalls).toEqual(['video', 'llm']));
  });
});
