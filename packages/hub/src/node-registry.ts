import type { Db } from './db.js';
import type { NodeInfo, NodeRegistration, ServingEndpoint } from '@agenthub/shared';

interface Row { id: number; name: string; arch: string; endpoints_json: string; status: 'online' | 'offline'; last_heartbeat: number; }

const toInfo = (r: Row): NodeInfo => ({
  id: r.id, name: r.name, arch: r.arch, status: r.status,
  lastHeartbeat: r.last_heartbeat, endpoints: JSON.parse(r.endpoints_json) as ServingEndpoint[],
});

export class NodeRegistry {
  private staleMs: number;
  constructor(private db: Db, opts: { staleMs?: number } = {}) { this.staleMs = opts.staleMs ?? 15000; }

  register(reg: NodeRegistration, now = Date.now()): NodeInfo {
    this.db.prepare(`
      INSERT INTO nodes (name, arch, endpoints_json, status, last_heartbeat) VALUES (?,?,?, 'online', ?)
      ON CONFLICT(name) DO UPDATE SET arch=excluded.arch, endpoints_json=excluded.endpoints_json,
        status='online', last_heartbeat=excluded.last_heartbeat
    `).run(reg.name, reg.arch, JSON.stringify(reg.endpoints), now);
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
