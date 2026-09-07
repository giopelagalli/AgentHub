import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { JobQueue } from '../src/queue.js';
import type { JobSpec } from '@agenthub/shared';

const spec = (priority: JobSpec['priority'], type: JobSpec['type'] = 'shell-task'): JobSpec =>
  ({ type, tier: 'worker', priority, payload: { p: priority } });

let db: Db; let q: JobQueue;
beforeEach(() => { db = openDb(':memory:'); q = new JobQueue(db); });

describe('JobQueue', () => {
  it('claims by priority then FIFO, filtered by type', () => {
    q.enqueue(spec('batch'), 1);
    const b = q.enqueue(spec('interactive'), 2);
    const c = q.enqueue(spec('interactive'), 3);
    q.enqueue(spec('interactive', 'video-gen'), 4);
    expect(q.claim(['shell-task'], 7)?.id).toBe(b.id);
    expect(q.claim(['shell-task'], 7)?.id).toBe(c.id);
    expect(q.claim(['shell-task'], 7)?.priority).toBe('batch');
    expect(q.claim(['shell-task'], 7)).toBeNull();
  });

  it('complete and fail transitions', () => {
    const j = q.enqueue(spec('project'));
    q.claim(['shell-task'], 1);
    q.complete(j.id, 1);
    expect(q.list('done')).toHaveLength(1);
    const k = q.enqueue(spec('project'));
    q.claim(['shell-task'], 1);
    q.fail(k.id, 1, { requeue: true });
    expect(q.list('queued')[0].nodeId).toBeNull();
  });

  it('requeueForNode returns running jobs of a dead node to the queue', () => {
    q.enqueue(spec('project')); q.enqueue(spec('project'));
    q.claim(['shell-task'], 5); q.claim(['shell-task'], 5);
    expect(q.requeueForNode(5)).toEqual({ requeued: 2, failed: [] });
    expect(q.list('queued')).toHaveLength(2);
    expect(q.requeueForNode(5)).toEqual({ requeued: 0, failed: [] });
  });

  it('claim increments attempts each time', () => {
    const j = q.enqueue(spec('project'));
    expect(q.claim(['shell-task'], 1)?.attempts).toBe(1);
    q.fail(j.id, 1, { requeue: true });
    expect(q.claim(['shell-task'], 1)?.attempts).toBe(2);
  });

  it('fail with requeue true on attempts >= 3 marks failed with exact error', () => {
    const j = q.enqueue(spec('project'));
    q.claim(['shell-task'], 1); q.fail(j.id, 1, { requeue: true }); // attempts 1 -> queued
    q.claim(['shell-task'], 1); q.fail(j.id, 1, { requeue: true }); // attempts 2 -> queued
    q.claim(['shell-task'], 1); // attempts 3
    q.fail(j.id, 1, { requeue: true });
    const failed = q.get(j.id)!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('max attempts exceeded');
  });

  it('fail without requeue marks failed immediately with the given error', () => {
    const j = q.enqueue(spec('project'));
    q.claim(['shell-task'], 1);
    q.fail(j.id, 1, { error: 'boom' });
    const failed = q.get(j.id)!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('boom');
  });

  it('complete stores the result', () => {
    const j = q.enqueue(spec('project'));
    q.claim(['shell-task'], 1);
    q.complete(j.id, 1, { exitCode: 0, stdoutTail: 'hi' });
    const done = q.get(j.id)!;
    expect(done.status).toBe('done');
    expect(done.result).toEqual({ exitCode: 0, stdoutTail: 'hi' });
  });

  it('requeueForNode applies the attempts cap per job', () => {
    const j = q.enqueue(spec('project'));
    const k = q.enqueue(spec('project'));
    q.claim(['shell-task'], 5); q.claim(['shell-task'], 5); // both attempts 1
    q.requeueForNode(5);
    q.claim(['shell-task'], 5); q.claim(['shell-task'], 5); // both attempts 2
    q.requeueForNode(5);
    q.claim(['shell-task'], 5); q.claim(['shell-task'], 5); // both attempts 3
    const { requeued, failed } = q.requeueForNode(5);
    expect(requeued).toBe(0);
    expect(failed.sort()).toEqual([j.id, k.id].sort());
    expect(q.get(j.id)!.status).toBe('failed');
    expect(q.get(j.id)!.error).toBe('max attempts exceeded');
    expect(q.get(k.id)!.status).toBe('failed');
  });

  it('complete/fail are fenced to the current running node and report whether they applied', () => {
    const j = q.enqueue(spec('project'));
    q.claim(['shell-task'], 1); // running under node 1
    expect(q.complete(j.id, 2, { exitCode: 0 })).toBe(false); // wrong node
    expect(q.get(j.id)!.status).toBe('running');
    expect(q.get(j.id)!.result).toBeNull();
    expect(q.complete(j.id, 1, { exitCode: 0 })).toBe(true); // right node
    expect(q.get(j.id)!.status).toBe('done');

    const k = q.enqueue(spec('project'));
    q.claim(['shell-task'], 1);
    expect(q.fail(k.id, 2, { error: 'nope' })).toBe(false); // wrong node
    expect(q.get(k.id)!.status).toBe('running');
    expect(q.fail(k.id, 1, { error: 'yes' })).toBe(true); // right node
    expect(q.get(k.id)!.status).toBe('failed');
  });

  it('unclaim returns a job to the queue without spending the attempt', () => {
    const j = q.enqueue(spec('project'));
    q.claim(['shell-task'], 1);
    expect(q.get(j.id)!.attempts).toBe(1);

    expect(q.unclaim(j.id, 2)).toBe(false); // fenced to the current runner
    expect(q.unclaim(j.id, 1)).toBe(true);
    expect(q.get(j.id)).toMatchObject({ status: 'queued', nodeId: null, attempts: 0 });
    expect(q.unclaim(j.id, 1)).toBe(false); // not running any more
  });
});