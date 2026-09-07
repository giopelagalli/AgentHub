import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { BrowserRequesterKind, BrowserStatus, HubState, Job, JobResult, JobSpec, JobType, NodeInfo, NodeRegistration, Priority, ProjectManifest, Tier, VideoPayload } from '@agenthub/shared';
import { PRIORITY_RANK, videoPayloadFrom } from '@agenthub/shared';
import { Auth, LoginThrottle, routeAccess, type AuthOptions } from './auth.js';
import { openDb, type Db } from './db.js';
import { NodeRegistry } from './node-registry.js';
import { JobQueue } from './queue.js';
import { JobLogs } from './job-logs.js';
import { ModelGateway } from './gateway.js';
import { ResourceManager, VideoSlotBusyError } from './resources.js';
import { AgentRuntime } from './agents.js';
import { AgentLoop } from './agents/loop.js';
import { Transcript } from './agents/transcript.js';
import { ProjectService, type StopOptions } from './projects/service.js';
import { MasterOrchestrator } from './projects/master.js';
import type { ProjectBundle } from './projects/bundle.js';
import { InvalidSlugError, SLUG_RE } from './projects/schema.js';
import { LeaseManager, type Requester } from './browser/lease.js';
import { BrowserError, BrowserProxy, BROWSER_OPS, type BrowserOp } from './browser/proxy.js';
import { LEASE_ID_RE, Recorder } from './browser/recorder.js';
import { Assistant } from './assistant/assistant.js';
import { ConfirmationGate } from './assistant/confirm.js';
import { MemoryStore } from './assistant/memory.js';
import { Planner, type PlannerList } from './assistant/planner.js';
import { assistantTools } from './assistant/tools.js';
import { externalTools, ToolAudit, AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT, type ExternalOptions } from './external/index.js';
import { Alerts, TELEGRAM_PROJECT, type AlertEvents } from './telegram/alerts.js';
import type { TelegramPort } from './telegram/port.js';
import { CommandRouter } from './telegram/router.js';
import { Scheduler, SystemClock, type Clock } from './telegram/scheduler.js';
import { registerWs } from './ws.js';

/** Everything the assistant wiring builds, once `MemoryStore.open` has finished. */
export interface AssistantHandle {
  memory: MemoryStore;
  planner: Planner;
  gate: ConfirmationGate;
  assistant: Assistant;
  /** Telegram parts, present only when `assistant.telegram` was configured. */
  port: TelegramPort | null;
  router: CommandRouter | null;
  scheduler: Scheduler | null;
  alerts: Alerts | null;
}

export interface Hub {
  app: FastifyInstance; db: Db; registry: NodeRegistry; queue: JobQueue; gateway: ModelGateway;
  runtime: AgentRuntime; transcript: Transcript; projects: ProjectService; master: MasterOrchestrator;
  leases: LeaseManager; browser: BrowserProxy; resources: ResourceManager;
  /** Resolves once the assistant is wired; rejects when no `assistant` option was given. */
  assistant(): Promise<AssistantHandle>;
  stop(opts?: StopOptions): Promise<void>;
}

const TIERS: Tier[] = ['orchestrator', 'worker', 'vision', 'video-gen'];
const JOB_TYPES: JobType[] = ['llm-session', 'video-gen', 'shell-task', 'browser-lease'];
const PRIORITIES: Priority[] = Object.keys(PRIORITY_RANK) as Priority[];
const PLANNER_LISTS: PlannerList[] = ['goals', 'todo', 'backlog'];
const REQUESTER_KINDS: BrowserRequesterKind[] = ['owner', 'orchestrator', 'subagent'];
const DEFAULT_RECORDINGS_ROOT = 'data/media/browser';
const DEFAULT_MEMORY_ROOT = 'data/memory';
/** Cap on an uploaded clip. A 15s 1080p MiniMax-H3 render is a few tens of MB. */
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const DEFAULT_BRIEFING_TIME = '08:00';
const DEFAULT_CHECKIN_TIMES = ['13:00', '18:00'];

export interface AssistantOptions {
  /** Root of the git-versioned memory bundle (MEMORY.md, notes/, planner/). */
  memoryRoot: string;
  /** Telegram transport plus the one chat allowed to drive it; omitted, the bot never starts. */
  telegram?: { port: TelegramPort; ownerChatId: string };
  schedule?: { briefingTime?: string; checkinTimes?: string[]; tz?: string };
  /** Injected in tests so the scheduler and alert dedupe never wait on real time. */
  clock?: Clock;
}

export interface BrowserOptions {
  /** Lease lifetime; every action renews it. */
  ttlMs?: number;
  /** Where screenshot timelines land: `<root>/<leaseId>/`. */
  recordingsRoot?: string;
  /** Screencast poll interval; floored at 500ms (≤ 2 fps) by the proxy. */
  screencastIntervalMs?: number;
  /** Injected in tests so lease expiry can be driven without waiting on real time. */
  now?: () => number;
}

export interface HubOptions {
  dbPath?: string;
  staleMs?: number;
  sweepIntervalMs?: number;
  uiDist?: string;
  projectsRoot?: string;
  tickIntervalMs?: number;
  assistant?: AssistantOptions;
  browser?: BrowserOptions;
  /** Omitted, the hub is open — every route answers unauthenticated, as it did before Phase 6. */
  auth?: AuthOptions;
  /** Keys for the three sanctioned external tools; each one missing simply removes its tool. */
  external?: ExternalOptions;
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
  const browserNow = opts.browser?.now ? { now: opts.browser.now } : {};
  const leases = new LeaseManager({ ...(opts.browser?.ttlMs ? { ttlMs: opts.browser.ttlMs } : {}), ...browserNow });
  const recorder = new Recorder({ root: opts.browser?.recordingsRoot ?? DEFAULT_RECORDINGS_ROOT });
  const browser = new BrowserProxy({ registry, leases, recorder, ...browserNow });
  // The audit ledger and the confirmation gate exist before anything that can call out, so the one
  // external tool belt is built once and shared: the assistant gets all of it, project agents get
  // everything that is not outward (posting is the owner's own action, never a project's).
  const toolAudit = new ToolAudit(db);
  const gate = new ConfirmationGate();
  // The "disabled" lines are for the owner starting a real hub, which always passes an `external`
  // block (however empty); a hub constructed without one — every test — stays quiet.
  const external = externalTools({
    audit: toolAudit, gate,
    ...(opts.external ? { options: opts.external } : { log: () => {} }),
  });
  const projectExternal = external.filter((t) => !t.outward);
  const projects = new ProjectService({
    root: opts.projectsRoot ?? 'data/projects',
    loop, gateway, queue, registry, transcript, leases, browser, external: projectExternal,
    ...(opts.tickIntervalMs ? { tickIntervalMs: opts.tickIntervalMs } : {}),
  });
  const master = new MasterOrchestrator({ service: projects, loop });
  const resources = new ResourceManager({
    registry, gateway,
    ...(opts.auth?.daemonToken ? { daemonToken: opts.auth.daemonToken } : {}),
  });
  const app = Fastify();

  // Finished clips arrive as raw bytes on POST /api/jobs/:id/artifact; Fastify's 1MB default body
  // limit is per-parser, so this one carries its own.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_ARTIFACT_BYTES },
    (_req, body, done) => { done(null, body); });

  // Registered before any route or plugin so it also covers the static UI and the /ws upgrade —
  // @fastify/websocket runs the route's onRequest hooks, and a 401 sent here means the handshake
  // never completes. Without `auth` the hook does not exist at all and the hub stays open.
  const auth = opts.auth ? new Auth(opts.auth) : null;
  const loginThrottle = new LoginThrottle(opts.auth?.now);
  if (auth) {
    app.addHook('onRequest', async (req, reply) => {
      // Two rejections that precede the policy: a path that is not valid percent-encoding, and one
      // that still carries traversal after decoding. Neither can name a legitimate route.
      const raw = req.url.split('?')[0]!;
      let pathname: string;
      try {
        pathname = decodeURIComponent(raw);
      } catch {
        return reply.code(400).send({ error: 'bad request' });
      }
      if (pathname.startsWith('//') || pathname.split('/').includes('..')) {
        return reply.code(400).send({ error: 'bad request' });
      }
      // Classified on the route the router matched, not on `req.url`: find-my-way percent-decodes
      // before matching, so `/%61pi/state` reaches `/api/state` while its raw path looks like
      // nothing at all. An unmatched request has no route and is denied.
      const route = req.routeOptions?.url;
      const access = routeAccess(req.method, route);
      if (access === 'none' || access === 'open') return;
      if (auth.ownerOk(req.headers.cookie)) return;
      if (access === 'daemon' && auth.bearerOk(req.headers.authorization)) return;
      // A refused upgrade also has to close its connection by hand: @fastify/websocket has already
      // taken the socket off the HTTP server's hands, so nobody else ever will — it would linger
      // half-dead and hold `app.close()` open forever. Only the one route it owns, so an ordinary
      // request carrying an `Upgrade` header is not hung up on.
      if (route === '/ws' && req.headers.upgrade) reply.raw.on('finish', () => reply.raw.socket?.end());
      return reply.code(401).send({ error: 'unauthorized' });
    });
  }
  /** A cookie is only marked Secure when the request actually arrived over TLS, directly or via a proxy. */
  const isHttps = (req: FastifyRequest): boolean =>
    req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';

  if (opts.uiDist && existsSync(opts.uiDist)) {
    app.register(fastifyStatic, { root: opts.uiDist });
  }

  // `getState` is synchronous (the WS broadcast path), so the manifest list is cached and refreshed
  // whenever a project changes rather than read from disk per frame.
  let projectList: ProjectManifest[] = [];

  // `online()` and not `all()`: the proxy resolves the node it forwards to the same way, so a node
  // whose heartbeat went stale must disappear from the status too rather than be advertised as the
  // browser while every action against it 503s.
  const browserStatus = (): BrowserStatus => ({
    ...leases.status(),
    node: registry.online().find((n) => n.browser?.url)?.name ?? null,
  });

  const getState = (): HubState => {
    const nodes = registry.all();
    return {
      nodes,
      agents: runtime.listAgents(),
      jobs: queue.list(),
      streams: Object.fromEntries(TIERS.map((tier) => [tier, gateway.activeStreams(tier)])),
      projects: projectList,
      browser: browserStatus(),
    };
  };

  // In-flight busy agents, so a socket that connects mid-stream can be caught up.
  const busyAgents = new Set<number>();
  // Frames are only produced while somebody is watching the screening room, so the browser node is
  // left alone until the first `subscribe` and stops being polled after the last unsubscribe/close.
  const { broadcastState, broadcast, broadcastTo } = registerWs(app, getState, () => [...busyAgents], {
    onTopicCount: (topic, count) => {
      if (topic !== 'browser') return;
      if (count > 0) screencast.start(); else screencast.stop();
    },
  });
  const screencast = browser.screencast(opts.browser?.screencastIntervalMs);
  screencast.onFrame((frame) => broadcastTo('browser', { type: 'browser-frame', ...frame }));
  leases.onChange(() => broadcastState());

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

  // The sweep is the only place a node is known to have just gone offline, so the alert hookup
  // hangs off it; briefings pass straight through to the service's own listeners, and a settled job
  // is announced by the two report routes below.
  const jobSettledListeners: ((job: Job) => void)[] = [];
  const emitJobSettled = (job: Job | null): void => {
    if (!job) return;
    for (const listener of jobSettledListeners) listener(job);
  };

  const nodeOfflineListeners: ((node: NodeInfo, requeued: number) => void)[] = [];
  const hubEvents: AlertEvents = {
    onNodeOffline: (cb) => { nodeOfflineListeners.push(cb); },
    onBriefing: (cb) => { projects.onBriefing(cb); },
    onJobSettled: (cb) => { jobSettledListeners.push(cb); },
  };

  /**
   * Where a finished clip is stored (plan Global Constraints): `workspace/media/video/<jobId>.mp4`
   * in the requesting project's bundle, or `media/` under the memory root when the job names no
   * project — or names one that isn't a bundle, which is what `/video`'s `_telegram` does.
   */
  const videoArtifactPath = async (job: Job): Promise<string> => {
    if (job.project) {
      try {
        const bundle = await projects.get(job.project);
        return join(bundle.workspace, 'media', 'video', `${job.id}.mp4`);
      } catch { /* not a project bundle; fall through to the memory root */ }
    }
    return join(opts.assistant?.memoryRoot ?? DEFAULT_MEMORY_ROOT, 'media', `${job.id}.mp4`);
  };

  const readVideoArtifact = async (job: Job): Promise<Buffer | null> => {
    try {
      return await readFile(await videoArtifactPath(job));
    } catch {
      return null;
    }
  };

  /** Every path into a video job builds the spec here, so priority and tier can't drift apart. */
  const enqueueVideo = (payload: VideoPayload, project?: string): Job => {
    const job = queue.enqueue({
      type: 'video-gen', tier: 'video-gen', priority: 'batch', payload,
      ...(project ? { project } : {}),
    });
    broadcastState();
    return job;
  };

  /**
   * Gives back the node's serving after a video job settled. Called from every path a video job can
   * leave `running` by: the two report routes and the offline sweep.
   */
  const releaseVideoSlot = (job: Job | null, nodeName: string): void => {
    if (!job || job.type !== 'video-gen') return;
    void resources.release(nodeName, job.id)
      .catch((err) => app.log.error(`releasing the video slot on ${nodeName} failed: ${(err as Error).message}`));
  };

  const sweepAndRequeue = () => {
    for (const node of registry.sweep()) {
      // Read before requeueing: afterwards the jobs no longer name this node.
      for (const job of queue.list('running')) if (job.nodeId === node.id) releaseVideoSlot(job, node.name);
      const { requeued, failed } = queue.requeueForNode(node.id);
      if (requeued) app.log.info(`requeued ${requeued} jobs from offline node ${node.name}`);
      for (const jobId of failed) jobLogs.append(jobId, `[hub] max attempts exceeded after node ${node.name} went offline`);
      for (const listener of nodeOfflineListeners) listener(node, requeued);
    }
  };

  const sweeper = setInterval(() => { sweepAndRequeue(); leases.expire(); broadcastState(); }, opts.sweepIntervalMs ?? 5000);
  sweeper.unref();

  // --- auth ---------------------------------------------------------------------

  // Unauthenticated on purpose: a health probe that needs a session can't tell a down hub from a
  // logged-out one.
  app.get('/api/health', async () => ({ ok: true }));

  // The UI's boot check. The hook answers 401 for it when there is a session to be had and none was
  // sent; reaching the handler at all means the caller is the owner (or the hub is open).
  app.get('/api/me', async () => ({ owner: true }));

  if (auth) {
    // Guessing the password is the one attack a single-password hub is wide open to, so failures
    // are counted per client and a run of them shuts that client out for the window — the check
    // comes before the comparison, so a correct password during a lockout is refused too.
    app.post('/api/login', async (req, reply) => {
      const client = req.ip;
      if (loginThrottle.blocked(client)) {
        console.warn(`[auth] throttled login from ${client}`);
        return reply.code(429).send({ error: 'too many attempts' });
      }
      const body = req.body as Partial<{ password: string }> | undefined;
      if (!auth.passwordOk(body?.password)) {
        const count = loginThrottle.fail(client);
        console.warn(`[auth] failed login from ${client} (${count})`);
        return reply.code(401).send({ error: 'invalid password' });
      }
      loginThrottle.succeed(client);
      reply.header('set-cookie', auth.sessionCookie(isHttps(req)));
      return { owner: true };
    });

    app.post('/api/logout', async (req, reply) => {
      reply.header('set-cookie', auth.clearedCookie(isHttps(req)));
      return { ok: true };
    });
  }

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
    // Only a node with a local ComfyUI, and only one video job at a time on it: a claim is what
    // triggers the exclusivity swap, so swapping a node that cannot render would park its serving
    // for nothing, and claiming a second clip while the first runs would only cost the job an
    // attempt before being handed straight back.
    const takesVideo = info.video && !resources.busy(info.name);
    const claimable = takesVideo ? types : types.filter((t) => t !== 'video-gen');
    if (!claimable.length) return reply.code(204).send();
    const job = queue.claim(claimable, info.id);
    if (!job) return reply.code(204).send();
    if (job.type === 'video-gen') {
      // The swap happens before the job is handed over (PRD §4.3): worker serving is parked and
      // drained, then the daemon switches to its video profile. If that fails the job goes back on
      // the queue rather than running against a GPU that is still serving.
      try {
        await resources.acquire(info.name, job.id);
      } catch (err) {
        jobLogs.append(job.id, `[hub] video slot unavailable on ${info.name}: ${(err as Error).message}`);
        queue.fail(job.id, info.id, { requeue: true });
        broadcastState();
        return reply.code(err instanceof VideoSlotBusyError ? 204 : 503).send();
      }
      broadcastState();
    }
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
    const settled = queue.get(id);
    releaseVideoSlot(settled, info.name);
    emitJobSettled(settled);
    broadcastState();
    return settled;
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
    const settled = queue.get(id);
    releaseVideoSlot(settled, info.name);
    // A requeued job hasn't settled — it will be claimed again — so only a terminal failure is
    // announced.
    if (settled?.status === 'failed') emitJobSettled(settled);
    broadcastState();
    return settled;
  });

  /**
   * Where a daemon puts a finished clip. The hub usually runs on another machine, so the file the
   * executor wrote to the node's own disk is unreachable from here — the daemon uploads the bytes
   * and the hub stores them at the path the Global Constraints fix.
   */
  app.post('/api/jobs/:id/artifact', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const job = queue.get(id);
    if (!job) return reply.code(404).send({ error: 'unknown job' });
    if (job.type !== 'video-gen') return reply.code(400).send({ error: 'job type has no artifact' });
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: 'empty artifact' });
    const path = await videoArtifactPath(job);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    jobLogs.append(id, `[hub] stored ${body.length} bytes at ${path}`);
    return { path, bytes: body.length };
  });

  app.post('/api/video', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { project, ...rest } = body;
    if (project !== undefined && (typeof project !== 'string' || !SLUG_RE.test(project))) {
      return reply.code(400).send({ error: 'invalid project' });
    }
    const payload = videoPayloadFrom(rest);
    if (!payload) return reply.code(400).send({ error: 'invalid video payload' });
    const job = enqueueVideo(payload, project as string | undefined);
    return reply.code(201).send({ ...job, outputPath: await videoArtifactPath(job) });
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

  // --- browser lease ------------------------------------------------------------

  /** Reads `{kind,id,project}` off a lease request; replies 400 and returns null when it's malformed. */
  const parseRequester = (body: unknown, reply: FastifyReply, kind?: BrowserRequesterKind): Requester | null => {
    const b = (body ?? {}) as Partial<{ kind: BrowserRequesterKind; id: string; project: string }>;
    const wanted = kind ?? b.kind;
    if (wanted === undefined || !REQUESTER_KINDS.includes(wanted)
      || typeof b.id !== 'string' || !b.id
      || (b.project !== undefined && typeof b.project !== 'string')) {
      reply.code(400).send({ error: 'invalid lease request' });
      return null;
    }
    return { kind: wanted, id: b.id, ...(b.project ? { project: b.project } : {}) };
  };

  app.get('/api/browser', async () => {
    leases.expire();
    return browserStatus();
  });

  app.post('/api/browser/lease', async (req, reply) => {
    const requester = parseRequester(req.body, reply);
    if (!requester) return reply;
    return leases.acquire(requester);
  });

  // The owner never queues: this preempts whoever is holding the browser, and their next action 409s.
  app.post('/api/browser/preempt', async (req, reply) => {
    const requester = parseRequester(req.body, reply, 'owner');
    if (!requester) return reply;
    return leases.acquire(requester);
  });

  app.delete('/api/browser/lease/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!leases.release(id)) return reply.code(404).send({ error: 'not the lease holder' });
    return { released: true };
  });

  app.post('/api/browser/act', async (req, reply) => {
    const body = req.body as Partial<{ leaseId: string; op: BrowserOp; args: Record<string, unknown> }> | undefined;
    if (!body || typeof body.leaseId !== 'string' || body.op === undefined || !BROWSER_OPS.includes(body.op)) {
      return reply.code(400).send({ error: 'invalid browser action' });
    }
    try {
      return await browser.act(body.leaseId, { op: body.op, ...(body.args ? { args: body.args } : {}) });
    } catch (err) {
      if (err instanceof BrowserError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  app.get('/api/browser/recordings/:leaseId', async (req, reply) => {
    const { leaseId } = req.params as { leaseId: string };
    if (!LEASE_ID_RE.test(leaseId)) return reply.code(400).send({ error: 'invalid lease id' });
    return { leaseId, actions: await recorder.list(leaseId) };
  });

  // --- external tool audit -------------------------------------------------------

  // Owner-only (the default class for an /api route): the ledger names everything that has left the
  // owner's machines, so it is read with the session cookie and nothing weaker.
  app.get('/api/audit', async (req, reply) => {
    const { limit: raw } = req.query as { limit?: string };
    let limit = AUDIT_DEFAULT_LIMIT;
    if (raw !== undefined) {
      limit = Number(raw);
      if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_MAX_LIMIT) {
        return reply.code(400).send({ error: 'invalid limit' });
      }
    }
    return toolAudit.list(limit);
  });

  // --- assistant ---------------------------------------------------------------

  /**
   * Opening the memory store is async (git init, scaffolding), so the wiring is a promise the
   * routes await rather than something `createHub` can finish synchronously. Telegram only starts
   * when a port was supplied — no token, no bot, and the rest of the assistant still works.
   */
  const initAssistant = async (cfg: AssistantOptions): Promise<AssistantHandle> => {
    const memory = await MemoryStore.open(cfg.memoryRoot);
    const planner = new Planner(join(cfg.memoryRoot, 'planner'), (msg) => memory.commit(msg));
    const tools = [
      ...assistantTools({ memory, planner, gate, service: projects, master, registry, jobs: queue }),
      ...external,
    ];
    const assistant = new Assistant({ loop, tools, memory, planner, gate, transcript });

    const handle: AssistantHandle = { memory, planner, gate, assistant, port: null, router: null, scheduler: null, alerts: null };
    if (!cfg.telegram) return handle;

    const { port, ownerChatId } = cfg.telegram;
    const clock = cfg.clock ?? new SystemClock();
    const router = new CommandRouter({
      port, ownerChatId, assistant, service: projects, master, planner, registry, gate,
      enqueueVideo: (payload) => enqueueVideo(payload, TELEGRAM_PROJECT),
    });
    const scheduler = new Scheduler({
      clock, port, ownerChatId, master, service: projects, assistant,
      briefingTime: cfg.schedule?.briefingTime ?? DEFAULT_BRIEFING_TIME,
      checkinTimes: cfg.schedule?.checkinTimes ?? DEFAULT_CHECKIN_TIMES,
      ...(cfg.schedule?.tz ? { tz: cfg.schedule.tz } : {}),
    });
    // Telegram is one optional surface on the assistant, not a precondition for it: a bad token, an
    // unreachable Telegram, or a malformed BRIEFING_TIME costs the bot and nothing else — the
    // handle still comes back usable and the HTTP assistant routes keep working. Polling starts
    // first so nothing is wired to a port that never came up.
    try {
      await port.start();
      router.start();
      scheduler.start();
      const alerts = new Alerts({ port, ownerChatId, registry, service: projects, clock, videoArtifact: readVideoArtifact });
      alerts.attach(hubEvents);
      handle.port = port;
      handle.router = router;
      handle.scheduler = scheduler;
      handle.alerts = alerts;
    } catch (err) {
      app.log.error(`telegram startup failed, continuing without it: ${(err as Error).message}`);
      scheduler.stop();
      await port.stop().catch((stopErr) => app.log.error(`telegram port stop failed: ${(stopErr as Error).message}`));
    }
    return handle;
  };

  const assistantReady = opts.assistant ? initAssistant(opts.assistant) : null;
  // Nothing awaits the wiring until the first request, so a failure would otherwise surface as an
  // unhandled rejection minutes later; this logs it and marks the promise handled.
  if (assistantReady) void assistantReady.catch((err) => app.log.error(`assistant wiring failed: ${(err as Error).message}`));

  /**
   * Resolves the wired assistant, or replies 503 and returns null when the hub has none — including
   * when the wiring itself failed (a memory root that won't open). That is unavailability, not a
   * request-handling bug, so it must not reach the client as a 500 from a rejected route promise.
   */
  const requireAssistant = async (reply: FastifyReply): Promise<AssistantHandle | null> => {
    const handle = assistantReady ? await assistantReady.catch(() => null) : null;
    if (!handle) {
      reply.code(503).send({ error: assistantReady ? 'assistant unavailable' : 'assistant not configured' });
      return null;
    }
    return handle;
  };

  const resolveList = (value: string, reply: FastifyReply): PlannerList | null => {
    if (!PLANNER_LISTS.includes(value as PlannerList)) {
      reply.code(400).send({ error: 'unknown planner list' });
      return null;
    }
    return value as PlannerList;
  };

  app.post('/api/assistant/messages', async (req, reply) => {
    const body = req.body as Partial<{ text: string }> | undefined;
    if (!body || typeof body.text !== 'string' || !body.text) return reply.code(400).send({ error: 'invalid message' });
    const handle = await requireAssistant(reply);
    if (!handle) return reply;
    // Same framing as the agent chat route, plus the pending actions this reply proposed so the
    // caller can render Confirm/Cancel for them.
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    // Same abort wiring as the agent chat route: a client that closes the stream (navigated away,
    // hit stop) should not leave a model session running to completion for nobody.
    const ac = new AbortController();
    reply.raw.on('close', () => ac.abort());
    try {
      const result = await handle.assistant.reply(body.text, {
        onToken: (token) => { reply.raw.write(`data: ${JSON.stringify({ token })}\n\n`); },
        signal: ac.signal,
      });
      const pending = result.pending.map(({ id, description }) => ({ id, description }));
      reply.raw.write(`data: ${JSON.stringify({ done: true, full: result.text, pending })}\n\n`);
    } catch (err) {
      reply.raw.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
    }
    reply.raw.end();
    return reply;
  });

  app.get('/api/assistant/pending', async (req, reply) => {
    const handle = await requireAssistant(reply);
    if (!handle) return reply;
    return handle.gate.pending().map(({ id, description, createdAt }) => ({ id, description, createdAt }));
  });

  app.post('/api/assistant/pending/:id/confirm', async (req, reply) => {
    const handle = await requireAssistant(reply);
    if (!handle) return reply;
    const { id } = req.params as { id: string };
    try {
      return { result: await handle.gate.confirm(id) };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  app.post('/api/assistant/pending/:id/cancel', async (req, reply) => {
    const handle = await requireAssistant(reply);
    if (!handle) return reply;
    const { id } = req.params as { id: string };
    if (!handle.gate.cancel(id)) return reply.code(404).send({ error: 'unknown pending action' });
    return { ok: true };
  });

  app.get('/api/memory/index', async (req, reply) => {
    const handle = await requireAssistant(reply);
    if (!handle) return reply;
    return { text: await handle.memory.indexText(), entries: await handle.memory.index() };
  });

  app.get('/api/planner', async (req, reply) => {
    const handle = await requireAssistant(reply);
    if (!handle) return reply;
    const lists = await Promise.all(PLANNER_LISTS.map((which) => handle.planner.list(which)));
    return Object.fromEntries(PLANNER_LISTS.map((which, i) => [which, lists[i]]));
  });

  app.post('/api/planner/:list', async (req, reply) => {
    const handle = await requireAssistant(reply);
    if (!handle) return reply;
    const which = resolveList((req.params as { list: string }).list, reply);
    if (!which) return reply;
    const body = req.body as Partial<{ text: string }> | undefined;
    if (!body || typeof body.text !== 'string' || !body.text.trim()) return reply.code(400).send({ error: 'invalid item' });
    const n = await handle.planner.add(which, body.text.trim());
    return reply.code(201).send({ n, items: await handle.planner.list(which) });
  });

  app.post('/api/planner/:list/:n/done', async (req, reply) => {
    const handle = await requireAssistant(reply);
    if (!handle) return reply;
    const params = req.params as { list: string; n: string };
    const which = resolveList(params.list, reply);
    if (!which) return reply;
    if (!(await handle.planner.complete(which, Number(params.n)))) return reply.code(404).send({ error: 'unknown item' });
    return { items: await handle.planner.list(which) };
  });

  return {
    app, db, registry, queue, gateway, runtime, transcript, projects, master, leases, browser, resources,
    assistant() {
      if (!assistantReady) return Promise.reject(new Error('assistant not configured'));
      return assistantReady;
    },
    async stop(opts) {
      clearInterval(sweeper);
      screencast.stop();
      // A failed wiring has already been logged; stopping must still tear the rest of the hub down.
      const handle = await assistantReady?.catch(() => null);
      handle?.scheduler?.stop();
      await handle?.port?.stop();
      await projects.stop(opts);
      await Promise.all([...refreshes]);
      await app.close();
      db.close();
    },
  };
}
