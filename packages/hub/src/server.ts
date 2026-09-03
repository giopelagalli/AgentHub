import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { HubState, JobResult, JobSpec, JobType, NodeRegistration, Priority, ProjectManifest, Tier } from '@agenthub/shared';
import { PRIORITY_RANK } from '@agenthub/shared';
import { openDb, type Db } from './db.js';
import { NodeRegistry } from './node-registry.js';
import { JobQueue } from './queue.js';
import { JobLogs } from './job-logs.js';
import { ModelGateway } from './gateway.js';
import { AgentRuntime } from './agents.js';
import { AgentLoop } from './agents/loop.js';
import { Transcript } from './agents/transcript.js';
import { ProjectService } from './projects/service.js';
import { MasterOrchestrator } from './projects/master.js';
import type { ProjectBundle } from './projects/bundle.js';
import { InvalidSlugError, SLUG_RE } from './projects/schema.js';
import { registerWs } from './ws.js';

export interface Hub {
  app: FastifyInstance; db: Db; registry: NodeRegistry; queue: JobQueue; gateway: ModelGateway;
  runtime: AgentRuntime; transcript: Transcript; projects: ProjectService; master: MasterOrchestrator;
  stop(): Promise<void>;
}

const TIERS: Tier[] = ['orchestrator', 'worker', 'vision', 'video-gen'];
const JOB_TYPES: JobType[] = ['llm-session', 'video-gen', 'shell-task', 'browser-lease'];
const PRIORITIES: Priority[] = Object.keys(PRIORITY_RANK) as Priority[];

export interface HubOptions {
  dbPath?: string;
  staleMs?: number;
  sweepIntervalMs?: number;
  uiDist?: string;
  projectsRoot?: string;
  tickIntervalMs?: number;
}

export function createHub(opts: HubOptions = {}): Hub {
  const dbPath = opts.dbPath ?? ':memory:';
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  const registry = new NodeRegistry(db, { staleMs: opts.staleMs });
  const queue = new JobQueue(db);
  const jobLogs = new JobLogs(db);
  const gateway = new ModelGateway(registry);
  const runtime = new AgentRuntime(db, gateway);
  const transcript = new Transcript(db);
  const loop = new AgentLoop({ gateway, transcript });
  const projects = new ProjectService({
    root: opts.projectsRoot ?? 'data/projects',
    loop, gateway, queue, registry, transcript,
    ...(opts.tickIntervalMs ? { tickIntervalMs: opts.tickIntervalMs } : {}),
  });
  const master = new MasterOrchestrator({ service: projects, loop });
  const app = Fastify();

  if (opts.uiDist && existsSync(opts.uiDist)) {
    app.register(fastifyStatic, { root: opts.uiDist });
  }

  // `getState` is synchronous (the WS broadcast path), so the manifest list is cached and refreshed
  // whenever a project changes rather than read from disk per frame.
  let projectList: ProjectManifest[] = [];

  const getState = (): HubState => ({
    nodes: registry.all(),
    agents: runtime.listAgents(),
    jobs: queue.list(),
    streams: Object.fromEntries(TIERS.map((tier) => [tier, gateway.activeStreams(tier)])),
    projects: projectList,
  });

  // In-flight busy agents, so a socket that connects mid-stream can be caught up.
  const busyAgents = new Set<number>();
  const { broadcastState, broadcast } = registerWs(app, getState, () => [...busyAgents]);

  // Refreshes read the db (via getState), so `stop()` waits for the in-flight ones before closing it.
  const refreshes = new Set<Promise<void>>();
  const refreshProjects = (): Promise<void> => {
    const refresh: Promise<void> = (async () => { projectList = await projects.list(); broadcastState(); })()
      .catch((err) => { app.log.error(`failed to refresh projects: ${(err as Error).message}`); })
      .finally(() => { refreshes.delete(refresh); });
    refreshes.add(refresh);
    return refresh;
  };
  // Scheduled turns change projects with no HTTP request behind them to trigger a broadcast.
  projects.onBriefing(() => { void refreshProjects(); });
  projects.start();
  void refreshProjects();

  /**
   * Resolves a `:slug` route param. A slug is a path segment, so a malformed one is a 400 and never
   * reaches the filesystem; an unknown project is a 404. Returns null once it has sent the reply.
   */
  const resolveProject = async (slug: string, reply: FastifyReply): Promise<ProjectBundle | null> => {
    try {
      return await projects.get(slug);
    } catch (err) {
      reply.code(err instanceof InvalidSlugError ? 400 : 404)
        .send({ error: err instanceof InvalidSlugError ? 'invalid slug' : 'unknown project' });
      return null;
    }
  };

  const sweepAndRequeue = () => {
    for (const node of registry.sweep()) {
      const { requeued, failed } = queue.requeueForNode(node.id);
      if (requeued) app.log.info(`requeued ${requeued} jobs from offline node ${node.name}`);
      for (const jobId of failed) jobLogs.append(jobId, `[hub] max attempts exceeded after node ${node.name} went offline`);
    }
  };

  const sweeper = setInterval(() => { sweepAndRequeue(); broadcastState(); }, opts.sweepIntervalMs ?? 5000);
  sweeper.unref();

  app.post('/api/nodes/register', async (req) => {
    const result = registry.register(req.body as NodeRegistration);
    broadcastState();
    return result;
  });

  app.post('/api/nodes/:name/heartbeat', async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!registry.heartbeat(name)) return reply.code(404).send({ ok: false });
    broadcastState();
    return { ok: true };
  });

  app.get('/api/nodes', async () => {
    sweepAndRequeue();
    return registry.all();
  });

  app.get('/api/state', async () => {
    sweepAndRequeue();
    projectList = await projects.list();
    return getState();
  });

  app.post('/api/jobs', async (req, reply) => {
    const spec = req.body as Partial<JobSpec> | undefined;
    if (!spec || spec.type === undefined || spec.tier === undefined || spec.priority === undefined || spec.payload === undefined) {
      return reply.code(400).send({ error: 'invalid job spec' });
    }
    if (!JOB_TYPES.includes(spec.type) || !TIERS.includes(spec.tier) || !PRIORITIES.includes(spec.priority)) {
      return reply.code(400).send({ error: 'invalid job spec' });
    }
    const job = queue.enqueue(spec as JobSpec);
    broadcastState();
    return reply.code(201).send(job);
  });

  app.get('/api/jobs/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { afterSeq: afterSeqRaw } = req.query as { afterSeq?: string };
    let afterSeq: number | undefined;
    if (afterSeqRaw !== undefined) {
      afterSeq = Number(afterSeqRaw);
      if (!Number.isInteger(afterSeq) || afterSeq < 0) return reply.code(400).send({ error: 'invalid afterSeq' });
    }
    const job = queue.get(id);
    if (!job) return reply.code(404).send({ error: 'unknown job' });
    return { ...job, logs: jobLogs.list(id, afterSeq) };
  });

  app.post('/api/jobs/claim', async (req, reply) => {
    const body = req.body as Partial<{ node: string; types: JobType[] }> | undefined;
    if (!body || typeof body.node !== 'string' || !body.node || !Array.isArray(body.types)) {
      return reply.code(400).send({ error: 'invalid claim request' });
    }
    const { node, types } = body as { node: string; types: JobType[] };
    const info = registry.byName(node);
    if (!info) return reply.code(404).send({ error: 'unknown node' });
    if (!types.every((t) => info.jobTypes.includes(t))) return reply.code(403).send({ error: 'node cannot run requested job types' });
    const job = queue.claim(types, info.id);
    if (!job) return reply.code(204).send();
    return job;
  });

  app.post('/api/jobs/:id/log', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = req.body as Partial<{ line: string }> | undefined;
    if (!body || typeof body.line !== 'string') return reply.code(400).send({ error: 'invalid log request' });
    if (!queue.get(id)) return reply.code(404).send({ error: 'unknown job' });
    return jobLogs.append(id, body.line);
  });

  app.post('/api/jobs/:id/complete', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = req.body as Partial<{ result: JobResult; node: string }> | undefined;
    if (!body || (body.node !== undefined && typeof body.node !== 'string')) {
      return reply.code(400).send({ error: 'invalid complete request' });
    }
    const { result, node } = body;
    if (!queue.get(id)) return reply.code(404).send({ error: 'unknown job' });
    const info = node ? registry.byName(node) : null;
    if (!info) return reply.code(404).send({ error: 'unknown node' });
    if (!queue.complete(id, info.id, result)) return reply.code(409).send({ error: 'not the current runner' });
    broadcastState();
    return queue.get(id);
  });

  app.post('/api/jobs/:id/fail', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = req.body as Partial<{ error: string; requeue: boolean; node: string }> | undefined;
    if (!body || typeof body.error !== 'string'
      || (body.node !== undefined && typeof body.node !== 'string')
      || (body.requeue !== undefined && typeof body.requeue !== 'boolean')) {
      return reply.code(400).send({ error: 'invalid fail request' });
    }
    const { error, requeue, node } = body;
    if (!queue.get(id)) return reply.code(404).send({ error: 'unknown job' });
    const info = node ? registry.byName(node) : null;
    if (!info) return reply.code(404).send({ error: 'unknown node' });
    if (!queue.fail(id, info.id, { requeue, error })) return reply.code(409).send({ error: 'not the current runner' });
    broadcastState();
    return queue.get(id);
  });

  app.post('/api/agents', async (req) => {
    const agent = runtime.createAgent(req.body as { name: string; tier: Tier; systemPrompt: string });
    broadcastState();
    return agent;
  });

  app.post('/api/agents/:id/messages', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { text } = req.body as { text: string };
    if (!runtime.getAgent(id)) return reply.code(404).send({ error: 'unknown agent' });
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const ac = new AbortController();
    reply.raw.on('close', () => ac.abort());
    broadcast({ type: 'agent-busy', agentId: id, busy: true });
    busyAgents.add(id);
    try {
      const full = await runtime.send(id, text, (token) => {
        reply.raw.write(`data: ${JSON.stringify({ token })}\n\n`);
      }, ac.signal);
      reply.raw.write(`data: ${JSON.stringify({ done: true, full })}\n\n`);
    } catch (err) {
      reply.raw.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
    } finally {
      busyAgents.delete(id);
      broadcast({ type: 'agent-busy', agentId: id, busy: false });
    }
    reply.raw.end();
    return reply;
  });

  // --- projects ---------------------------------------------------------------

  app.get('/api/projects', async () => projects.list());

  app.post('/api/projects', async (req, reply) => {
    const body = req.body as Partial<{ slug: string; title: string; intent: string; priority: Priority }> | undefined;
    if (!body || typeof body.slug !== 'string' || !SLUG_RE.test(body.slug)
      || typeof body.title !== 'string' || !body.title
      || typeof body.intent !== 'string' || !body.intent
      || (body.priority !== undefined && !PRIORITIES.includes(body.priority))) {
      return reply.code(400).send({ error: 'invalid project' });
    }
    const duplicate = await projects.get(body.slug).then(() => true, () => false);
    if (duplicate) return reply.code(409).send({ error: 'project already exists' });
    const manifest = await projects.create({
      slug: body.slug, title: body.title, intent: body.intent,
      ...(body.priority ? { priority: body.priority } : {}),
    });
    await refreshProjects();
    return reply.code(201).send(manifest);
  });

  app.get('/api/projects/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const bundle = await resolveProject(slug, reply);
    if (!bundle) return reply;
    return {
      manifest: await bundle.manifest(),
      briefing: await bundle.latestBriefing(),
      tasks: (await bundle.tasks()).tasks,
    };
  });

  const lifecycle: Record<string, (slug: string) => Promise<ProjectManifest>> = {
    pause: (slug) => projects.pause(slug),
    resume: (slug) => projects.resume(slug),
    archive: (slug) => projects.archive(slug),
  };
  for (const [action, apply] of Object.entries(lifecycle)) {
    app.post(`/api/projects/:slug/${action}`, async (req, reply) => {
      const { slug } = req.params as { slug: string };
      if (!(await resolveProject(slug, reply))) return reply;
      const manifest = await apply(slug);
      await refreshProjects();
      return manifest;
    });
  }

  app.post('/api/projects/:slug/priority', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const body = req.body as Partial<{ priority: Priority }> | undefined;
    if (!body || body.priority === undefined || !PRIORITIES.includes(body.priority)) {
      return reply.code(400).send({ error: 'invalid priority' });
    }
    if (!(await resolveProject(slug, reply))) return reply;
    const manifest = await projects.setPriority(slug, body.priority);
    await refreshProjects();
    return manifest;
  });

  app.post('/api/projects/:slug/turn', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const body = req.body as Partial<{ instruction: string }> | undefined;
    if (body?.instruction !== undefined && typeof body.instruction !== 'string') {
      return reply.code(400).send({ error: 'invalid instruction' });
    }
    if (!(await resolveProject(slug, reply))) return reply;
    const briefing = await projects.runTurn(slug, body?.instruction);
    await refreshProjects();
    return briefing;
  });

  app.get('/api/projects/:slug/transcript', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!(await resolveProject(slug, reply))) return reply;
    return transcript.sessions({ subject: slug }).map((session) => ({
      ...session,
      messages: transcript.messages(session.id),
      events: transcript.events(session.id),
    }));
  });

  app.get('/api/briefings', async () => projects.briefings());

  app.post('/api/master/brief', async () => master.dailyBriefing());

  app.post('/api/master/command', async (req, reply) => {
    const body = req.body as Partial<{ text: string }> | undefined;
    if (!body || typeof body.text !== 'string' || !body.text) return reply.code(400).send({ error: 'invalid command' });
    const result = await master.command(body.text);
    await refreshProjects();
    return result;
  });

  return {
    app, db, registry, queue, gateway, runtime, transcript, projects, master,
    async stop() {
      clearInterval(sweeper);
      await projects.stop();
      await Promise.all([...refreshes]);
      await app.close();
      db.close();
    },
  };
}
