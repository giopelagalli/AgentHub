import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { BrowserRequesterKind, BrowserStatus } from '@agenthub/shared';
import { NoSuchSlotError, type LeaseManager, type Requester, type SlotRef } from './lease.js';
import { BrowserError, BROWSER_OPS, type BrowserOp, type BrowserProxy } from './proxy.js';
import { LEASE_ID_RE, type Recorder } from './recorder.js';

export interface BrowserRoutesOptions {
  leases: LeaseManager;
  browser: BrowserProxy;
  recorder: Recorder;
  /** The status the hub also broadcasts in its state, so the route and the socket never disagree. */
  status: () => BrowserStatus;
}

const REQUESTER_KINDS: BrowserRequesterKind[] = ['owner', 'orchestrator', 'subagent'];

/** Reads `{kind,id,project}` off a lease request; replies 400 and returns null when it's malformed. */
function parseRequester(body: unknown, reply: FastifyReply, kind?: BrowserRequesterKind): Requester | null {
  const b = (body ?? {}) as Partial<{ kind: BrowserRequesterKind; id: string; project: string }>;
  const wanted = kind ?? b.kind;
  if (wanted === undefined || !REQUESTER_KINDS.includes(wanted)
    || typeof b.id !== 'string' || !b.id
    || (b.project !== undefined && typeof b.project !== 'string')) {
    reply.code(400).send({ error: 'invalid lease request' });
    return null;
  }
  return { kind: wanted, id: b.id, ...(b.project ? { project: b.project } : {}) };
}

/**
 * Reads the optional `{node, slot}` an owner's Take control names. Undefined when there is none —
 * the pre-pool request, which takes a free slot or the first one; null (having replied 400) when
 * it is malformed. A `node` without a `slot` means slot 0.
 */
function parseTarget(body: unknown, reply: FastifyReply): SlotRef | undefined | null {
  const b = (body ?? {}) as Partial<{ node: unknown; slot: unknown }>;
  if (b.node === undefined && b.slot === undefined) return undefined;
  const slot = b.slot ?? 0;
  if (typeof b.node !== 'string' || !b.node || typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0) {
    reply.code(400).send({ error: 'invalid browser slot' });
    return null;
  }
  return { node: b.node, slot };
}

/**
 * The browser pool's HTTP surface (FR-D8). The shapes are the single-browser ones with a slot
 * added — a grant also names its `node` and `slot`, Take control may name the slot it takes — so a
 * client from before the pool keeps working against slot 0 of the first node.
 */
export const browserRoutes: FastifyPluginAsync<BrowserRoutesOptions> = async (app, { leases, browser, recorder, status }) => {
  app.get('/api/browser', async () => {
    leases.expire();
    return status();
  });

  // A draining node's slots are never handed out (the pool marks them), so a fresh request queues
  // for another slot while a holder on that node still renews and finishes normally.
  app.post('/api/browser/lease', async (req, reply) => {
    const requester = parseRequester(req.body, reply);
    if (!requester) return reply;
    return leases.acquire(requester);
  });

  // The owner never queues while there is a slot to take: this preempts the named slot's holder (or,
  // naming none, takes a free slot or the first one), and the displaced holder's next action 409s.
  app.post('/api/browser/preempt', async (req, reply) => {
    const requester = parseRequester(req.body, reply, 'owner');
    if (!requester) return reply;
    const target = parseTarget(req.body, reply);
    if (target === null) return reply;
    try {
      return leases.acquire(requester, target);
    } catch (err) {
      if (err instanceof NoSuchSlotError) return reply.code(404).send({ error: err.message });
      throw err;
    }
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
};
