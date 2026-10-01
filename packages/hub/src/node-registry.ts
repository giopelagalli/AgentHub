import type { Db } from './db.js';
import type { JobType, NodeInfo, NodeRegistration, ServingEndpoint } from '@agenthub/shared';

interface Row { id: number; name: string; arch: string; endpoints_json: string; status: 'online' | 'offline'; last_heartbeat: number; job_types_json: string; browser_json: string | null; profiles_json: string; video: number; control_json: string | null; control_node: number; draining: number; models_paused: number; owner: string; token_hash: string | null; enrolled_at: number | null; hardware_json: string | null; }

/**
 * The row as the API shows it. `token_hash` is deliberately not mapped: a node's credential never
 * leaves this file, not even as a hash, so no route can leak it by returning a `NodeInfo`.
 */
const toInfo = (r: Row): NodeInfo => ({
  id: r.id, name: r.name, arch: r.arch, status: r.status,
  lastHeartbeat: r.last_heartbeat, endpoints: JSON.parse(r.endpoints_json) as ServingEndpoint[],
  jobTypes: JSON.parse(r.job_types_json) as JobType[],
  ...(r.browser_json ? { browser: JSON.parse(r.browser_json) as { url: string } } : {}),
  profiles: JSON.parse(r.profiles_json) as string[],
  video: r.video === 1,
  ...(r.control_json ? { control: JSON.parse(r.control_json) as { url: string } } : {}),
  controlNode: r.control_node === 1,
  draining: r.draining === 1,
  modelsPaused: r.models_paused === 1,
  owner: r.owner,
  ...(r.enrolled_at === null ? {} : { enrolledAt: r.enrolled_at }),
  ...(r.hardware_json ? { hardware: JSON.parse(r.hardware_json) as Record<string, unknown> } : {}),
});

/** What `enroll` writes: everything the daemon does not send about itself. */
export interface Enrollment {
  name: string;
  /** What the installer detected; only used when the node has never registered for itself. */
  arch: string;
  owner: string;
  tokenHash: string;
  hardware?: Record<string, unknown>;
}

export class NodeRegistry {
  private staleMs: number;
  constructor(private db: Db, opts: { staleMs?: number } = {}) { this.staleMs = opts.staleMs ?? 15000; }

  register(reg: NodeRegistration, now = Date.now()): NodeInfo {
    this.db.prepare(`
      INSERT INTO nodes (name, arch, endpoints_json, status, last_heartbeat, job_types_json, browser_json,
                         profiles_json, video, control_json, control_node)
        VALUES (?,?,?, 'online', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET arch=excluded.arch, endpoints_json=excluded.endpoints_json,
        status='online', last_heartbeat=excluded.last_heartbeat, job_types_json=excluded.job_types_json,
        browser_json=excluded.browser_json, profiles_json=excluded.profiles_json, video=excluded.video,
        control_json=excluded.control_json, control_node=excluded.control_node
    `).run(reg.name, reg.arch, JSON.stringify(reg.endpoints), now, JSON.stringify(reg.jobTypes ?? []),
           reg.browser ? JSON.stringify(reg.browser) : null,
           JSON.stringify(reg.profiles ?? []), reg.video ? 1 : 0,
           reg.control ? JSON.stringify(reg.control) : null, reg.controlNode ? 1 : 0);
    return this.byName(reg.name)!;
  }

  /**
   * Gives `name` an owner and its own bearer token (PRD FR-D1). Creates the row if the node has
   * never registered — the daemon's own registration follows, so the placeholder starts `offline`
   * with nothing served. Re-enrolling an existing node keeps everything it registered and only
   * rotates the credential, which is what makes a re-install a rotation rather than a reset.
   */
  enroll(enrollment: Enrollment, now = Date.now()): NodeInfo {
    const hardware = enrollment.hardware ? JSON.stringify(enrollment.hardware) : null;
    this.db.prepare(`
      INSERT INTO nodes (name, arch, endpoints_json, status, last_heartbeat, owner, token_hash, enrolled_at, hardware_json)
        VALUES (?, ?, '[]', 'offline', 0, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET owner=excluded.owner, token_hash=excluded.token_hash,
        enrolled_at=excluded.enrolled_at, hardware_json=COALESCE(excluded.hardware_json, nodes.hardware_json)
    `).run(enrollment.name, enrollment.arch, enrollment.owner, enrollment.tokenHash, now, hardware);
    return this.byName(enrollment.name)!;
  }

  /** The node a bearer token belongs to, or null. The hash is the lookup key; the plaintext is never stored. */
  byTokenHash(tokenHash: string): NodeInfo | null {
    const r = this.db.prepare(`SELECT * FROM nodes WHERE token_hash=?`).get(tokenHash) as Row | undefined;
    return r ? toInfo(r) : null;
  }

  /** Drops a node's bearer so it can no longer act as itself; the row and its owner stay. */
  revokeToken(name: string): void {
    this.db.prepare(`UPDATE nodes SET token_hash=NULL WHERE name=?`).run(name);
  }

  heartbeat(name: string, now = Date.now()): boolean {
    const res = this.db.prepare(`UPDATE nodes SET status='online', last_heartbeat=? WHERE name=?`).run(now, name);
    return res.changes > 0;
  }

  /** Toggles whether `name` gets new work; running work is untouched. False if the node is unknown. */
  setDraining(name: string, on: boolean): boolean {
    const res = this.db.prepare(`UPDATE nodes SET draining=? WHERE name=?`).run(on ? 1 : 0, name);
    return res.changes > 0;
  }

  /** Toggles whether the gateway may pick `name`'s serving endpoints; jobs are untouched. False if the node is unknown. */
  setModelsPaused(name: string, on: boolean): boolean {
    const res = this.db.prepare(`UPDATE nodes SET models_paused=? WHERE name=?`).run(on ? 1 : 0, name);
    return res.changes > 0;
  }

  /** Forgets `name` entirely — deletes its row. False if the node was already unknown. */
  remove(name: string): boolean {
    const res = this.db.prepare(`DELETE FROM nodes WHERE name=?`).run(name);
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
