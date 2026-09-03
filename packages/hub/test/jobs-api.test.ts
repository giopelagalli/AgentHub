import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHub, type Hub } from '../src/server.js';

let hub: Hub;
beforeAll(() => { hub = createHub(); });
afterAll(async () => { await hub.stop(); });

const registerNode = async (name: string, jobTypes: string[] = ['shell-task']) =>
  (await hub.app.inject({
    method: 'POST', url: '/api/nodes/register',
    payload: { name, arch: 'arm64', endpoints: [], jobTypes },
  })).json();

describe('jobs API', () => {
  it('enqueues and fetches a job with its logs', async () => {
    const created = await hub.app.inject({
      method: 'POST', url: '/api/jobs',
      payload: { type: 'shell-task', tier: 'worker', priority: 'batch', payload: { cmd: ['echo', 'hi'] } },
    });
    expect(created.statusCode).toBe(201);
    const job = created.json();
    expect(job.id).toBeDefined();
    expect(job.attempts).toBe(0);

    const fetched = await hub.app.inject({ method: 'GET', url: `/api/jobs/${job.id}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().id).toBe(job.id);
    expect(fetched.json().logs).toEqual([]);

    expect((await hub.app.inject({ method: 'GET', url: '/api/jobs/999999' })).statusCode).toBe(404);
  });

  it('validates job spec on create', async () => {
    const badType = await hub.app.inject({
      method: 'POST', url: '/api/jobs',
      payload: { type: 'nope', tier: 'worker', priority: 'batch', payload: {} },
    });
    expect(badType.statusCode).toBe(400);

    const badTier = await hub.app.inject({
      method: 'POST', url: '/api/jobs',
      payload: { type: 'shell-task', tier: 'nope', priority: 'batch', payload: {} },
    });
    expect(badTier.statusCode).toBe(400);

    const badPriority = await hub.app.inject({
      method: 'POST', url: '/api/jobs',
      payload: { type: 'shell-task', tier: 'worker', priority: 'nope', payload: {} },
    });
    expect(badPriority.statusCode).toBe(400);
  });

  it('claim returns 204 when nothing to claim', async () => {
    await registerNode('empty-claimer', ['video-gen']);
    const res = await hub.app.inject({
      method: 'POST', url: '/api/jobs/claim',
      payload: { node: 'empty-claimer', types: ['video-gen'] },
    });
    expect(res.statusCode).toBe(204);
  });

  it('claim returns 404 for an unknown node', async () => {
    const res = await hub.app.inject({
      method: 'POST', url: '/api/jobs/claim',
      payload: { node: 'ghost', types: ['shell-task'] },
    });
    expect(res.statusCode).toBe(404);
  });

  it('claim returns 403 when the node cannot run a requested type', async () => {
    await registerNode('limited', ['shell-task']);
    const res = await hub.app.inject({
      method: 'POST', url: '/api/jobs/claim',
      payload: { node: 'limited', types: ['shell-task', 'video-gen'] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('claim -> log -> complete round trip, with logs returned by GET', async () => {
    await registerNode('worker-1', ['shell-task']);
    const created = (await hub.app.inject({
      method: 'POST', url: '/api/jobs',
      payload: { type: 'shell-task', tier: 'worker', priority: 'interactive', payload: { cmd: ['echo', 'hi'] } },
    })).json();

    const claimed = await hub.app.inject({
      method: 'POST', url: '/api/jobs/claim',
      payload: { node: 'worker-1', types: ['shell-task'] },
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json().id).toBe(created.id);
    expect(claimed.json().attempts).toBe(1);

    const log1 = await hub.app.inject({
      method: 'POST', url: `/api/jobs/${created.id}/log`, payload: { line: 'out: hi' },
    });
    expect(log1.statusCode).toBe(200);
    expect(log1.json()).toEqual({ jobId: created.id, seq: 1, line: 'out: hi', at: expect.any(Number) });

    const completed = await hub.app.inject({
      method: 'POST', url: `/api/jobs/${created.id}/complete`, payload: { result: { exitCode: 0, stdoutTail: 'hi' }, node: 'worker-1' },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().status).toBe('done');
    expect(completed.json().result).toEqual({ exitCode: 0, stdoutTail: 'hi' });

    const fetched = await hub.app.inject({ method: 'GET', url: `/api/jobs/${created.id}` });
    expect(fetched.json().logs).toEqual([{ jobId: created.id, seq: 1, line: 'out: hi', at: expect.any(Number) }]);
  });

  it('fail marks a job failed and broadcasts state', async () => {
    // Uses a job type no other test in this file enqueues, so the claim below can only pick up this
    // job — a queued job left behind by an earlier test (this hub is shared across the whole file)
    // would otherwise win the FIFO claim instead.
    await registerNode('worker-2', ['browser-lease']);
    const created = (await hub.app.inject({
      method: 'POST', url: '/api/jobs',
      payload: { type: 'browser-lease', tier: 'worker', priority: 'batch', payload: {} },
    })).json();
    const claimed = await hub.app.inject({ method: 'POST', url: '/api/jobs/claim', payload: { node: 'worker-2', types: ['browser-lease'] } });
    expect(claimed.json().id).toBe(created.id);
    const failed = await hub.app.inject({
      method: 'POST', url: `/api/jobs/${created.id}/fail`, payload: { error: 'boom', requeue: false, node: 'worker-2' },
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json().status).toBe('failed');
    expect(failed.json().error).toBe('boom');
  });

  it('400 for a malformed job spec (missing body, missing type)', async () => {
    const noBody = await hub.app.inject({ method: 'POST', url: '/api/jobs' });
    expect(noBody.statusCode).toBe(400);

    const missingType = await hub.app.inject({
      method: 'POST', url: '/api/jobs', payload: { tier: 'worker', priority: 'batch', payload: {} },
    });
    expect(missingType.statusCode).toBe(400);
  });

  it('claim returns 400 for a malformed body (missing node, non-array types)', async () => {
    const noNode = await hub.app.inject({
      method: 'POST', url: '/api/jobs/claim', payload: { types: ['shell-task'] },
    });
    expect(noNode.statusCode).toBe(400);

    const badTypes = await hub.app.inject({
      method: 'POST', url: '/api/jobs/claim', payload: { node: 'worker-1', types: 'shell-task' },
    });
    expect(badTypes.statusCode).toBe(400);
  });

  it('complete/fail/log return 400 for a missing or invalid body', async () => {
    const created = (await hub.app.inject({
      method: 'POST', url: '/api/jobs',
      payload: { type: 'shell-task', tier: 'worker', priority: 'batch', payload: {} },
    })).json();

    const completeNoBody = await hub.app.inject({ method: 'POST', url: `/api/jobs/${created.id}/complete` });
    expect(completeNoBody.statusCode).toBe(400);
    const completeBadNode = await hub.app.inject({
      method: 'POST', url: `/api/jobs/${created.id}/complete`, payload: { node: 42 },
    });
    expect(completeBadNode.statusCode).toBe(400);

    const failNoBody = await hub.app.inject({ method: 'POST', url: `/api/jobs/${created.id}/fail` });
    expect(failNoBody.statusCode).toBe(400);
    const failMissingError = await hub.app.inject({
      method: 'POST', url: `/api/jobs/${created.id}/fail`, payload: { node: 'worker-1' },
    });
    expect(failMissingError.statusCode).toBe(400);
    const failBadRequeue = await hub.app.inject({
      method: 'POST', url: `/api/jobs/${created.id}/fail`, payload: { error: 'x', requeue: 'yes' },
    });
    expect(failBadRequeue.statusCode).toBe(400);

    const logNoBody = await hub.app.inject({ method: 'POST', url: `/api/jobs/${created.id}/log` });
    expect(logNoBody.statusCode).toBe(400);
    const logBadLine = await hub.app.inject({
      method: 'POST', url: `/api/jobs/${created.id}/log`, payload: { line: 123 },
    });
    expect(logBadLine.statusCode).toBe(400);
  });

  it('GET /api/jobs/:id returns 400 for a malformed afterSeq', async () => {
    const created = (await hub.app.inject({
      method: 'POST', url: '/api/jobs',
      payload: { type: 'shell-task', tier: 'worker', priority: 'batch', payload: {} },
    })).json();

    const notANumber = await hub.app.inject({ method: 'GET', url: `/api/jobs/${created.id}?afterSeq=abc` });
    expect(notANumber.statusCode).toBe(400);
    const negative = await hub.app.inject({ method: 'GET', url: `/api/jobs/${created.id}?afterSeq=-1` });
    expect(negative.statusCode).toBe(400);
    const notAnInteger = await hub.app.inject({ method: 'GET', url: `/api/jobs/${created.id}?afterSeq=1.5` });
    expect(notAnInteger.statusCode).toBe(400);

    const ok = await hub.app.inject({ method: 'GET', url: `/api/jobs/${created.id}?afterSeq=0` });
    expect(ok.statusCode).toBe(200);
  });

  it('complete/fail return 404 for an unknown or missing node', async () => {
    const created = (await hub.app.inject({
      method: 'POST', url: '/api/jobs',
      payload: { type: 'shell-task', tier: 'worker', priority: 'batch', payload: {} },
    })).json();

    const noNode = await hub.app.inject({
      method: 'POST', url: `/api/jobs/${created.id}/complete`, payload: { result: {} },
    });
    expect(noNode.statusCode).toBe(404);

    const ghostNode = await hub.app.inject({
      method: 'POST', url: `/api/jobs/${created.id}/fail`, payload: { error: 'x', node: 'ghost' },
    });
    expect(ghostNode.statusCode).toBe(404);
  });

  it('fences late complete/fail from a node the job has since been requeued away from', async () => {
    // browser-lease again to dodge the shell-task job left queued by the 404 test just above.
    await registerNode('fence-a', ['browser-lease']);
    await registerNode('fence-b', ['browser-lease']);
    const created = (await hub.app.inject({
      method: 'POST', url: '/api/jobs',
      payload: { type: 'browser-lease', tier: 'worker', priority: 'batch', payload: {} },
    })).json();

    const claimedA = await hub.app.inject({
      method: 'POST', url: '/api/jobs/claim', payload: { node: 'fence-a', types: ['browser-lease'] },
    });
    expect(claimedA.statusCode).toBe(200);
    expect(claimedA.json().id).toBe(created.id);

    const nodeA = hub.registry.byName('fence-a')!;
    expect(hub.queue.requeueForNode(nodeA.id)).toEqual({ requeued: 1, failed: [] });

    const claimedB = await hub.app.inject({
      method: 'POST', url: '/api/jobs/claim', payload: { node: 'fence-b', types: ['browser-lease'] },
    });
    expect(claimedB.statusCode).toBe(200);
    expect(claimedB.json().id).toBe(created.id);
    expect(claimedB.json().attempts).toBe(2);

    const lateFail = await hub.app.inject({
      method: 'POST', url: `/api/jobs/${created.id}/fail`, payload: { error: 'late', requeue: true, node: 'fence-a' },
    });
    expect(lateFail.statusCode).toBe(409);
    let current = (await hub.app.inject({ method: 'GET', url: `/api/jobs/${created.id}` })).json();
    expect(current.status).toBe('running');
    expect(current.attempts).toBe(2);

    const lateComplete = await hub.app.inject({
      method: 'POST', url: `/api/jobs/${created.id}/complete`, payload: { result: { exitCode: 0, stdoutTail: 'wrong' }, node: 'fence-a' },
    });
    expect(lateComplete.statusCode).toBe(409);
    current = (await hub.app.inject({ method: 'GET', url: `/api/jobs/${created.id}` })).json();
    expect(current.result).toBeNull();
    expect(current.status).toBe('running');

    const goodComplete = await hub.app.inject({
      method: 'POST', url: `/api/jobs/${created.id}/complete`, payload: { result: { exitCode: 0, stdoutTail: 'hi' }, node: 'fence-b' },
    });
    expect(goodComplete.statusCode).toBe(200);
    expect(goodComplete.json().status).toBe('done');
  });

  it('GET /api/jobs/:id?afterSeq= only returns logs after the given seq', async () => {
    await registerNode('log-node', ['shell-task']);
    const created = (await hub.app.inject({
      method: 'POST', url: '/api/jobs',
      payload: { type: 'shell-task', tier: 'worker', priority: 'batch', payload: { cmd: ['echo', 'hi'] } },
    })).json();
    await hub.app.inject({ method: 'POST', url: '/api/jobs/claim', payload: { node: 'log-node', types: ['shell-task'] } });
    await hub.app.inject({ method: 'POST', url: `/api/jobs/${created.id}/log`, payload: { line: 'one' } });
    await hub.app.inject({ method: 'POST', url: `/api/jobs/${created.id}/log`, payload: { line: 'two' } });
    await hub.app.inject({ method: 'POST', url: `/api/jobs/${created.id}/log`, payload: { line: 'three' } });

    const all = await hub.app.inject({ method: 'GET', url: `/api/jobs/${created.id}` });
    expect(all.json().logs.map((l: { line: string }) => l.line)).toEqual(['one', 'two', 'three']);

    const after = await hub.app.inject({ method: 'GET', url: `/api/jobs/${created.id}?afterSeq=1` });
    expect(after.json().logs.map((l: { line: string }) => l.line)).toEqual(['two', 'three']);
  });

  it('sweep logs a hub-side note when requeueForNode caps a job at max attempts', async () => {
    const flakyHub = createHub({ staleMs: 100, sweepIntervalMs: 100000 });
    try {
      const registerFlaky = () => flakyHub.app.inject({
        method: 'POST', url: '/api/nodes/register',
        payload: { name: 'flaky', arch: 'arm64', endpoints: [], jobTypes: ['shell-task'] },
      });
      await registerFlaky();
      const created = (await flakyHub.app.inject({
        method: 'POST', url: '/api/jobs',
        payload: { type: 'shell-task', tier: 'worker', priority: 'batch', payload: { cmd: ['echo', 'hi'] } },
      })).json();

      for (let i = 0; i < 2; i++) {
        await flakyHub.app.inject({ method: 'POST', url: '/api/jobs/claim', payload: { node: 'flaky', types: ['shell-task'] } });
        await flakyHub.app.inject({ method: 'POST', url: `/api/jobs/${created.id}/fail`, payload: { error: 'x', requeue: true, node: 'flaky' } });
        await registerFlaky(); // re-heartbeats/keeps the node online between claims
      }
      await flakyHub.app.inject({ method: 'POST', url: '/api/jobs/claim', payload: { node: 'flaky', types: ['shell-task'] } }); // attempts 3, running

      await new Promise((r) => setTimeout(r, 150)); // past staleMs without a heartbeat
      await flakyHub.app.inject({ method: 'GET', url: '/api/nodes' }); // triggers sweepAndRequeue

      const after = await flakyHub.app.inject({ method: 'GET', url: `/api/jobs/${created.id}` });
      const job = after.json();
      expect(job.status).toBe('failed');
      expect(job.error).toBe('max attempts exceeded');
      expect(job.logs.some((l: { line: string }) => l.line === '[hub] max attempts exceeded after node flaky went offline')).toBe(true);
    } finally {
      await flakyHub.stop();
    }
  });
});
