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
      method: 'POST', url: `/api/jobs/${created.id}/complete`, payload: { result: { exitCode: 0, stdoutTail: 'hi' } },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().status).toBe('done');
    expect(completed.json().result).toEqual({ exitCode: 0, stdoutTail: 'hi' });

    const fetched = await hub.app.inject({ method: 'GET', url: `/api/jobs/${created.id}` });
    expect(fetched.json().logs).toEqual([{ jobId: created.id, seq: 1, line: 'out: hi', at: expect.any(Number) }]);
  });

  it('fail marks a job failed and broadcasts state', async () => {
    const created = (await hub.app.inject({
      method: 'POST', url: '/api/jobs',
      payload: { type: 'shell-task', tier: 'worker', priority: 'batch', payload: {} },
    })).json();
    const failed = await hub.app.inject({
      method: 'POST', url: `/api/jobs/${created.id}/fail`, payload: { error: 'boom', requeue: false },
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json().status).toBe('failed');
    expect(failed.json().error).toBe('boom');
  });
});
