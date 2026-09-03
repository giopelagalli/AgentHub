import type { Db } from './db.js';
import type { JobLogLine } from '@agenthub/shared';

interface Row { job_id: number; seq: number; line: string; at: number; }

const toLine = (r: Row): JobLogLine => ({ jobId: r.job_id, seq: r.seq, line: r.line, at: r.at });

export class JobLogs {
  constructor(private db: Db) {}

  append(jobId: number, line: string, now = Date.now()): JobLogLine {
    const append = this.db.transaction((): JobLogLine => {
      const row = this.db.prepare(`SELECT MAX(seq) as maxSeq FROM job_logs WHERE job_id=?`).get(jobId) as { maxSeq: number | null };
      const seq = (row.maxSeq ?? 0) + 1;
      this.db.prepare(`INSERT INTO job_logs (job_id, seq, line, at) VALUES (?,?,?,?)`).run(jobId, seq, line, now);
      return { jobId, seq, line, at: now };
    });
    return append();
  }

  list(jobId: number, afterSeq = 0): JobLogLine[] {
    return (this.db.prepare(`SELECT * FROM job_logs WHERE job_id=? AND seq > ? ORDER BY seq`).all(jobId, afterSeq) as Row[])
      .map(toLine);
  }
}
