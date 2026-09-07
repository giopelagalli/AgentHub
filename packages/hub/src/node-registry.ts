import type { Db } from './db.js';
import type { JobType, NodeInfo, NodeRegistration, ServingEndpoint } from '@agenthub/shared';

interface Row { id: number; name: string; arch: string; endpoints_json: string; status: 'online' | 'offline'; last_heartbeat: number; job_types_json: string; browser_json: string | null; profiles_json: string; video: number; control_json: string | null; }

const toInfo = (r: Row): NodeInfo => ({
  id: r.id, name: r.name, arch: r.arch, status: r.status,
  lastHeartbeat: r.last_heartbeat, endpoints: JSON.parse(r.endpoints_json) as ServingEndpoint[],
  jobTypes: JSON.parse(r.job_types_json) as JobType[],
  ...(r.browser_json ? { browser: JSON.parse(r.browser_json) as { url: string } } : {}),
  profiles: JSON.parse(r.profiles_json) as string[],
  video: r.video === 1,
  ...(r.control_json ? { control: JSON.parse(r.control_json) as { url: string } } : {}),
});

export class NodeRegistry {
  private staleMs: number;
  constructor(private db: Db, opts: { staleMs?: number } = {}) { this.staleMs = opts.staleMs ?? 15000; }

  register(reg: NodeRegistration, now = Date.now()): NodeInfo {
    this.db.prepare(`
      INSERT INTO nodes (name, arch, endpoints_json, status, last_heartbeat, job_types_json, browser_json,
                         profiles_json, video, control_json)
        VALUES (?,?,?, 'online', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET arch=excluded.arch, endpoints_json=excluded.endpoints_json,
        status='online', last_heartbeat=excluded.last_heartbeat, job_types_json=excluded.job_types_json,
        browser_json=excluded.browser_json, profiles_json=excluded.profiles_json, video=excluded.video,
        control_json=excluded.control_json
    `).run(reg.name, reg.arch, JSON.stringify(reg.endpoints), now, JSON.stringify(reg.jobTypes ?? []),
           reg.browser ? JSON.stringify(reg.browser) : null,
           JSON.stringify(reg.profiles ?? []), reg.video ? 1 : 0,
           reg.control ? JSON.stringify(reg.control) : null);
    return this.byName(reg.name)!;
  }

  heartbeat(name: string, now = Date.now()): boolean {
    const res = this.db.prepare(`UPDATE nodes SET status='online', last_heartbeat=? WHERE name=?`).run(now, name);
    return res.changes > 0;
  }

  sweep(now = Date.now()): NodeInfo[] {
    const stale = this.db.prepare(`SELECT * FROM nodes WHERE status='online' AND last_heartbeat < ?`)
      .all(now - this.staleMs) as Row[];
    if (stale.length) {
      const ids = stale.map(r => r.id);
      this.db.prepare(`UPDATE nodes SET status='offline' WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    }
    return stale.map(r => toInfo({ ...r, status: 'offline' }));
  }

  online(now = Date.now()): NodeInfo[] {
    return (this.db.prepare(`SELECT * FROM nodes WHERE status='online' AND last_heartbeat >= ?`)
      .all(now - this.staleMs) as Row[]).map(toInfo);
  }

  all(): NodeInfo[] {
    return (this.db.prepare(`SELECT * FROM nodes ORDER BY id`).all() as Row[]).map(toInfo);
  }

  byName(name: string): NodeInfo | null {
    const r = this.db.prepare(`SELECT * FROM nodes WHERE name=?`).get(name) as Row | undefined;
    return r ? toInfo(r) : null;
  }
}
