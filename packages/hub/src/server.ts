import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { HubState, JobResult, JobSpec, JobType, NodeRegistration, Priority, Tier } from '@agenthub/shared';
import { PRIORITY_RANK } from '@agenthub/shared';
import { openDb, type Db } from './db.js';
import { NodeRegistry } from './node-registry.js';
import { JobQueue } from './queue.js';
import { JobLogs } from './job-logs.js';
import { ModelGateway } from './gateway.js';
import { AgentRuntime } from './agents.js';
import { registerWs } from './ws.js';

export interface Hub { app: FastifyInstance; db: Db; registry: NodeRegistry; queue: JobQueue; gateway: ModelGateway; runtime: AgentRuntime; stop(): Promise<void>; }

const TIERS: Tier[] = ['orchestrator', 'worker', 'vision', 'video-gen'];
const JOB_TYPES: JobType[] = ['llm-session', 'video-gen', 'shell-task', 'browser-lease'];
const PRIORITIES: Priority[] = Object.keys(PRIORITY_RANK) as Priority[];

export function createHub(opts: { dbPath?: string; staleMs?: number; sweepIntervalMs?: number; uiDist?: string } = {}): Hub {
  const dbPath = opts.dbPath ?? ':memory:';
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  const registry = new NodeRegistry(db, { staleMs: opts.staleMs });
  const queue = new JobQueue(db);
  const jobLogs = new JobLogs(db);
  const gateway = new ModelGateway(registry);
  const runtime = new AgentRuntime(db, gateway);
  const app = Fastify();

  if (opts.uiDist && existsSync(opts.uiDist)) {
    app.register(fastifyStatic, { root: opts.uiDist });
  }

  const getState = (): HubState => ({
    nodes: registry.all(),
    agents: runtime.listAgents(),
    jobs: queue.list(),
    streams: Object.fromEntries(TIERS.map((tier) => [tier, gateway.activeStreams(tier)])),
  });

  // In-flight busy agents, so a socket that connects mid-stream can be caught up.
  const busyAgents = new Set<number>();
  const { broadcastState, broadcast } = registerWs(app, getState, () => [...busyAgents]);

  const sweepAndRequeue = () => {
    for (const node of registry.sweep()) {
      const n = queue.requeueForNode(node.id);
      if (n) app.log.info(`requeued ${n} jobs from offline node ${node.name}`);
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
    return getState();
  });

  app.post('/api/jobs', async (req, reply) => {
    const spec = req.body as JobSpec;
    if (!JOB_TYPES.includes(spec.type) || !TIERS.includes(spec.tier) || !PRIORITIES.includes(spec.priority)) {
      return reply.code(400).send({ error: 'invalid job spec' });
    }
    const job = queue.enqueue(spec);
    broadcastState();
    return reply.code(201).send(job);
  });

  app.get('/api/jobs/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const job = queue.get(id);
    if (!job) return reply.code(404).send({ error: 'unknown job' });
    return { ...job, logs: jobLogs.list(id) };
  });

  app.post('/api/jobs/claim', async (req, reply) => {
    const { node, types } = req.body as { node: string; types: JobType[] };
    const info = registry.byName(node);
    if (!info) return reply.code(404).send({ error: 'unknown node' });
    if (!types.every((t) => info.jobTypes.includes(t))) return reply.code(403).send({ error: 'node cannot run requested job types' });
    const job = queue.claim(types, info.id);
    if (!job) return reply.code(204).send();
    return job;
  });

  app.post('/api/jobs/:id/log', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { line } = req.body as { line: string };
    if (!queue.get(id)) return reply.code(404).send({ error: 'unknown job' });
    return jobLogs.append(id, line);
  });

  app.post('/api/jobs/:id/complete', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { result } = req.body as { result?: JobResult };
    if (!queue.get(id)) return reply.code(404).send({ error: 'unknown job' });
    queue.complete(id, result);
    broadcastState();
    return queue.get(id);
  });

  app.post('/api/jobs/:id/fail', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { error, requeue } = req.body as { error: string; requeue?: boolean };
    if (!queue.get(id)) return reply.code(404).send({ error: 'unknown job' });
    queue.fail(id, { requeue, error });
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

  return {
    app, db, registry, queue, gateway, runtime,
    async stop() { clearInterval(sweeper); await app.close(); db.close(); },
  };
}
