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
    q.complete(j.id);
    expect(q.list('done')).toHaveLength(1);
    const k = q.enqueue(spec('project'));
    q.claim(['shell-task'], 1);
    q.fail(k.id, { requeue: true });
    expect(q.list('queued')[0].nodeId).toBeNull();
  });

  it('requeueForNode returns running jobs of a dead node to the queue', () => {
    q.enqueue(spec('project')); q.enqueue(spec('project'));
    q.claim(['shell-task'], 5); q.claim(['shell-task'], 5);
    expect(q.requeueForNode(5)).toBe(2);
    expect(q.list('queued')).toHaveLength(2);
    expect(q.requeueForNode(5)).toBe(0);
  });
});
