import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { NodeRegistration, Tier } from '@agenthub/shared';
import { openDb, type Db } from './db.js';
import { NodeRegistry } from './node-registry.js';
import { JobQueue } from './queue.js';
import { ModelGateway } from './gateway.js';
import { AgentRuntime } from './agents.js';

export interface Hub { app: FastifyInstance; db: Db; registry: NodeRegistry; queue: JobQueue; gateway: ModelGateway; runtime: AgentRuntime; stop(): Promise<void>; }

export function createHub(opts: { dbPath?: string; staleMs?: number; sweepIntervalMs?: number } = {}): Hub {
  const dbPath = opts.dbPath ?? ':memory:';
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  const registry = new NodeRegistry(db, { staleMs: opts.staleMs });
  const queue = new JobQueue(db);
  const gateway = new ModelGateway(registry);
  const runtime = new AgentRuntime(db, gateway);
  const app = Fastify();

  const sweepAndRequeue = () => {
    for (const node of registry.sweep()) {
      const n = queue.requeueForNode(node.id);
      if (n) app.log.info(`requeued ${n} jobs from offline node ${node.name}`);
    }
  };

  const sweeper = setInterval(sweepAndRequeue, opts.sweepIntervalMs ?? 5000);
  sweeper.unref();

  app.post('/api/nodes/register', async (req) => registry.register(req.body as NodeRegistration));

  app.post('/api/nodes/:name/heartbeat', async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!registry.heartbeat(name)) return reply.code(404).send({ ok: false });
    return { ok: true };
  });

  app.get('/api/nodes', async () => {
    sweepAndRequeue();
    return registry.all();
  });

  app.get('/api/state', async () => {
    sweepAndRequeue();
    return { nodes: registry.all(), agents: runtime.listAgents(), jobs: queue.list() };
  });

  app.post('/api/agents', async (req) =>
    runtime.createAgent(req.body as { name: string; tier: Tier; systemPrompt: string }));

  app.post('/api/agents/:id/messages', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { text } = req.body as { text: string };
    if (!runtime.getAgent(id)) return reply.code(404).send({ error: 'unknown agent' });
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    try {
      const full = await runtime.send(id, text, (token) => {
        reply.raw.write(`data: ${JSON.stringify({ token })}\n\n`);
      });
      reply.raw.write(`data: ${JSON.stringify({ done: true, full })}\n\n`);
    } catch (err) {
      reply.raw.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
    }
    reply.raw.end();
    return reply;
  });

  return {
    app, db, registry, queue, gateway, runtime,
    async stop() { clearInterval(sweeper); await app.close(); db.close(); },
  };
}
