import type { Db } from './db.js';
import { PRIORITY_RANK, type Job, type JobResult, type JobSpec, type JobStatus, type JobType, type Priority } from '@agenthub/shared';

interface Row { id: number; type: JobType; tier: Job['tier']; priority: number; project: string | null; payload_json: string; status: JobStatus; node_id: number | null; created_at: number; updated_at: number; attempts: number; result_json: string | null; error: string | null; }

const RANK_TO_PRIORITY = Object.fromEntries(Object.entries(PRIORITY_RANK).map(([k, v]) => [v, k])) as Record<number, Priority>;

const MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS_ERROR = 'max attempts exceeded';

const toJob = (r: Row): Job => ({
  id: r.id, type: r.type, tier: r.tier, priority: RANK_TO_PRIORITY[r.priority],
  project: r.project ?? undefined, payload: JSON.parse(r.payload_json),
  status: r.status, nodeId: r.node_id, createdAt: r.created_at, updatedAt: r.updated_at,
  attempts: r.attempts, result: r.result_json ? (JSON.parse(r.result_json) as JobResult) : null, error: r.error,
});

export class JobQueue {
  constructor(private db: Db) {}

  enqueue(spec: JobSpec, now = Date.now()): Job {
    const res = this.db.prepare(`
      INSERT INTO jobs (type, tier, priority, project, payload_json, status, created_at, updated_at)
      VALUES (?,?,?,?,?, 'queued', ?, ?)
    `).run(spec.type, spec.tier, PRIORITY_RANK[spec.priority], spec.project ?? null, JSON.stringify(spec.payload), now, now);
    return this.get(Number(res.lastInsertRowid))!;
  }

  claim(types: JobType[], nodeId: number, now = Date.now()): Job | null {
    const claim = this.db.transaction((): Job | null => {
      const row = this.db.prepare(`
        SELECT * FROM jobs WHERE status='queued' AND type IN (${types.map(() => '?').join(',')})
        ORDER BY priority ASC, created_at ASC, id ASC LIMIT 1
      `).get(...types) as Row | undefined;
      if (!row) return null;
      this.db.prepare(`UPDATE jobs SET status='running', node_id=?, attempts=attempts+1, updated_at=? WHERE id=?`).run(nodeId, now, row.id);
      return this.get(row.id);
    });
    return claim();
  }

  // Conditional on the job still being 'running' under nodeId: a report from a node that has since
  // been requeued to another runner (see requeueForNode) is fenced out instead of clobbering the
  // real runner's state. Returns whether the update actually applied.
  complete(id: number, nodeId: number, result?: JobResult, now = Date.now()): boolean {
    const res = this.db.prepare(`UPDATE jobs SET status='done', result_json=?, updated_at=? WHERE id=? AND status='running' AND node_id=?`)
      .run(result ? JSON.stringify(result) : null, now, id, nodeId);
    return res.changes > 0;
  }

  // Same fencing as complete(): only a node that is still the current runner of record may report
  // failure for the job.
  fail(id: number, nodeId: number, opts: { requeue?: boolean; error?: string } = {}, now = Date.now()): boolean {
    const run = this.db.transaction((): boolean => {
      const job = this.get(id);
      if (!job || job.status !== 'running' || job.nodeId !== nodeId) return false;
      if (opts.requeue) {
        if (job.attempts >= MAX_ATTEMPTS) {
          this.db.prepare(`UPDATE jobs SET status='failed', error=?, updated_at=? WHERE id=?`).run(MAX_ATTEMPTS_ERROR, now, id);
        } else {
          this.db.prepare(`UPDATE jobs SET status='queued', node_id=NULL, updated_at=? WHERE id=?`).run(now, id);
        }
      } else {
        this.db.prepare(`UPDATE jobs SET status='failed', error=?, updated_at=? WHERE id=?`).run(opts.error ?? null, now, id);
      }
      return true;
    });
    return run();
  }

  requeueForNode(nodeId: number, now = Date.now()): { requeued: number; failed: number[] } {
    const running = this.db.prepare(`SELECT id FROM jobs WHERE status='running' AND node_id=?`).all(nodeId) as { id: number }[];
    let requeued = 0;
    const failed: number[] = [];
    for (const { id } of running) {
      const job = this.get(id)!;
      if (job.attempts >= MAX_ATTEMPTS) {
        this.db.prepare(`UPDATE jobs SET status='failed', error=?, updated_at=? WHERE id=?`).run(MAX_ATTEMPTS_ERROR, now, id);
        failed.push(id);
      } else {
        this.db.prepare(`UPDATE jobs SET status='queued', node_id=NULL, updated_at=? WHERE id=?`).run(now, id);
        requeued++;
      }
    }
    return { requeued, failed };
  }

  list(status?: JobStatus): Job[] {
    const rows = (status
      ? this.db.prepare(`SELECT * FROM jobs WHERE status=? ORDER BY id`).all(status)
      : this.db.prepare(`SELECT * FROM jobs ORDER BY id`).all()) as Row[];
    return rows.map(toJob);
  }

  get(id: number): Job | null {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE id=?`).get(id) as Row | undefined;
    return row ? toJob(row) : null;
  }
}
