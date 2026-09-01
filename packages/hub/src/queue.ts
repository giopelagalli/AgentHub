import type { Db } from './db.js';
import { PRIORITY_RANK, type Job, type JobSpec, type JobStatus, type JobType, type Priority } from '@agenthub/shared';

interface Row { id: number; type: JobType; tier: Job['tier']; priority: number; project: string | null; payload_json: string; status: JobStatus; node_id: number | null; created_at: number; updated_at: number; }

const RANK_TO_PRIORITY = Object.fromEntries(Object.entries(PRIORITY_RANK).map(([k, v]) => [v, k])) as Record<number, Priority>;

const toJob = (r: Row): Job => ({
  id: r.id, type: r.type, tier: r.tier, priority: RANK_TO_PRIORITY[r.priority],
  project: r.project ?? undefined, payload: JSON.parse(r.payload_json),
  status: r.status, nodeId: r.node_id, createdAt: r.created_at, updatedAt: r.updated_at,
});

export class JobQueue {
  constructor(private db: Db) {}

  enqueue(spec: JobSpec, now = Date.now()): Job {
    const res = this.db.prepare(`
      INSERT INTO jobs (type, tier, priority, project, payload_json, status, created_at, updated_at)
      VALUES (?,?,?,?,?, 'queued', ?, ?)
    `).run(spec.type, spec.tier, PRIORITY_RANK[spec.priority], spec.project ?? null, JSON.stringify(spec.payload), now, now);
    return this.get(Number(res.lastInsertRowid));
  }

  claim(types: JobType[], nodeId: number, now = Date.now()): Job | null {
    const claim = this.db.transaction((): Job | null => {
      const row = this.db.prepare(`
        SELECT * FROM jobs WHERE status='queued' AND type IN (${types.map(() => '?').join(',')})
        ORDER BY priority ASC, created_at ASC, id ASC LIMIT 1
      `).get(...types) as Row | undefined;
      if (!row) return null;
      this.db.prepare(`UPDATE jobs SET status='running', node_id=?, updated_at=? WHERE id=?`).run(nodeId, now, row.id);
      return this.get(row.id);
    });
    return claim();
  }

  complete(id: number, now = Date.now()): void {
    this.db.prepare(`UPDATE jobs SET status='done', updated_at=? WHERE id=?`).run(now, id);
  }

  fail(id: number, opts: { requeue?: boolean } = {}, now = Date.now()): void {
    if (opts.requeue) this.db.prepare(`UPDATE jobs SET status='queued', node_id=NULL, updated_at=? WHERE id=?`).run(now, id);
    else this.db.prepare(`UPDATE jobs SET status='failed', updated_at=? WHERE id=?`).run(now, id);
  }

  requeueForNode(nodeId: number, now = Date.now()): number {
    return this.db.prepare(`UPDATE jobs SET status='queued', node_id=NULL, updated_at=? WHERE status='running' AND node_id=?`)
      .run(now, nodeId).changes;
  }

  list(status?: JobStatus): Job[] {
    const rows = (status
      ? this.db.prepare(`SELECT * FROM jobs WHERE status=? ORDER BY id`).all(status)
      : this.db.prepare(`SELECT * FROM jobs ORDER BY id`).all()) as Row[];
    return rows.map(toJob);
  }

  private get(id: number): Job {
    return toJob(this.db.prepare(`SELECT * FROM jobs WHERE id=?`).get(id) as Row);
  }
}
