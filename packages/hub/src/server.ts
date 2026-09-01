import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { HubState, NodeRegistration, Tier } from '@agenthub/shared';
import { openDb, type Db } from './db.js';
import { NodeRegistry } from './node-registry.js';
import { JobQueue } from './queue.js';
import { ModelGateway } from './gateway.js';
import { AgentRuntime } from './agents.js';
import { registerWs } from './ws.js';

export interface Hub { app: FastifyInstance; db: Db; registry: NodeRegistry; queue: JobQueue; gateway: ModelGateway; runtime: AgentRuntime; stop(): Promise<void>; }

const TIERS: Tier[] = ['orchestrator', 'worker', 'vision', 'video-gen'];

export function createHub(opts: { dbPath?: string; staleMs?: number; sweepIntervalMs?: number; uiDist?: string } = {}): Hub {
  const dbPath = opts.dbPath ?? ':memory:';
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  const registry = new NodeRegistry(db, { staleMs: opts.staleMs });
  const queue = new JobQueue(db);
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

  const { broadcastState, broadcast } = registerWs(app, getState);

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
    try {
      const full = await runtime.send(id, text, (token) => {
        reply.raw.write(`data: ${JSON.stringify({ token })}\n\n`);
      }, ac.signal);
      reply.raw.write(`data: ${JSON.stringify({ done: true, full })}\n\n`);
    } catch (err) {
      reply.raw.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
    } finally {
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
