import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';

describe('db', () => {
  it('creates schema idempotently and accepts inserts', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO nodes (name, arch, endpoints_json, last_heartbeat) VALUES (?,?,?,?)`)
      .run('spark', 'arm64', '[]', Date.now());
    const row = db.prepare('SELECT name, status FROM nodes').get() as { name: string; status: string };
    expect(row).toEqual({ name: 'spark', status: 'online' });
    // idempotent re-open on same handle path shape
    openDb(':memory:');
  });

  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  it('opening the same file db path twice does not throw and inserts still work', () => {
    dir = mkdtempSync(join(tmpdir(), 'ah-db-'));
    const dbPath = join(dir, 'hub.db');

    const db1 = openDb(dbPath);
    expect(() => openDb(dbPath)).not.toThrow();

    db1.prepare(`INSERT INTO nodes (name, arch, endpoints_json, last_heartbeat) VALUES (?,?,?,?)`)
      .run('spark', 'arm64', '[]', Date.now());
    const row = db1.prepare('SELECT name, status FROM nodes').get() as { name: string; status: string };
    expect(row).toEqual({ name: 'spark', status: 'online' });
  });

  it('upgrades an existing DB created with the old jobs/nodes schema in place', () => {
    dir = mkdtempSync(join(tmpdir(), 'ah-db-'));
    const dbPath = join(dir, 'hub.db');

    const oldDb = new Database(dbPath);
    oldDb.exec(`
      CREATE TABLE nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        arch TEXT NOT NULL,
        endpoints_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'online',
        last_heartbeat INTEGER NOT NULL
      );
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        tier TEXT NOT NULL,
        priority INTEGER NOT NULL,
        project TEXT,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        node_id INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    oldDb.prepare(`INSERT INTO nodes (name, arch, endpoints_json, last_heartbeat) VALUES (?,?,?,?)`)
      .run('spark', 'arm64', '[]', Date.now());
    oldDb.prepare(`INSERT INTO jobs (type, tier, priority, payload_json, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
      .run('shell-task', 'worker', 0, '{}', Date.now(), Date.now());
    oldDb.close();

    const db = openDb(dbPath);
    const nodeCols = (db.pragma(`table_info(nodes)`) as { name: string }[]).map(c => c.name);
    const jobCols = (db.pragma(`table_info(jobs)`) as { name: string }[]).map(c => c.name);
    expect(nodeCols).toContain('job_types_json');
    expect(jobCols).toContain('attempts');
    expect(jobCols).toContain('result_json');
    expect(jobCols).toContain('error');

    // pre-existing rows survive the upgrade with sane defaults
    const node = db.prepare(`SELECT job_types_json FROM nodes WHERE name='spark'`).get() as { job_types_json: string };
    expect(node.job_types_json).toBe('[]');
    const job = db.prepare(`SELECT attempts, result_json, error FROM jobs`).get() as { attempts: number; result_json: string | null; error: string | null };
    expect(job.attempts).toBe(0);
    expect(job.result_json).toBeNull();
    expect(job.error).toBeNull();

    // new job_logs table exists and is usable
    db.prepare(`INSERT INTO job_logs (job_id, seq, line, at) VALUES (?,?,?,?)`).run(1, 0, 'hi', Date.now());
    expect((db.prepare(`SELECT COUNT(*) c FROM job_logs`).get() as { c: number }).c).toBe(1);
  });

  it('relaxes messages.agent_id from NOT NULL to nullable, preserving rows, ids and old messages behavior', () => {
    dir = mkdtempSync(join(tmpdir(), 'ah-db-'));
    const dbPath = join(dir, 'hub.db');

    const oldDb = new Database(dbPath);
    oldDb.exec(`
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        tier TEXT NOT NULL,
        system_prompt TEXT NOT NULL
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER NOT NULL REFERENCES agents(id),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    oldDb.prepare(`INSERT INTO agents (name, tier, system_prompt) VALUES (?,?,?)`).run('bot', 'worker', 'you are a bot');
    const agentRow = oldDb.prepare(`SELECT id FROM agents WHERE name='bot'`).get() as { id: number };
    const agentId = agentRow.id;
    const messageIds: number[] = [];
    for (const content of ['hello', 'world', 'again']) {
      const res = oldDb.prepare(`INSERT INTO messages (agent_id, role, content, created_at) VALUES (?,?,?,?)`)
        .run(agentId, 'user', content, Date.now());
      messageIds.push(Number(res.lastInsertRowid));
    }
    oldDb.close();

    const db = openDb(dbPath);

    const messageCols = db.pragma(`table_info(messages)`) as { name: string; notnull: number }[];
    const agentIdCol = messageCols.find((c) => c.name === 'agent_id');
    expect(agentIdCol?.notnull).toBe(0);

    // rows and ids survived the rebuild
    const rows = db.prepare(`SELECT id, agent_id, role, content FROM messages ORDER BY id`)
      .all() as { id: number; agent_id: number; role: string; content: string }[];
    expect(rows.map((r) => r.id)).toEqual(messageIds);
    expect(rows.map((r) => r.content)).toEqual(['hello', 'world', 'again']);
    expect(rows.every((r) => r.agent_id === agentId)).toBe(true);

    // a session-scoped message (no owning agent) can now be inserted with agent_id NULL
    expect(() => db.prepare(`INSERT INTO messages (agent_id, role, content, created_at) VALUES (NULL, 'user', 'session msg', ?)`)
      .run(Date.now())).not.toThrow();

    // re-opening is a no-op: same row count, agent_id still nullable
    const countBefore = (db.prepare(`SELECT COUNT(*) c FROM messages`).get() as { c: number }).c;
    db.close();
    const reopened = openDb(dbPath);
    const countAfter = (reopened.prepare(`SELECT COUNT(*) c FROM messages`).get() as { c: number }).c;
    expect(countAfter).toBe(countBefore);
    const reopenedAgentIdCol = (reopened.pragma(`table_info(messages)`) as { name: string; notnull: number }[])
      .find((c) => c.name === 'agent_id');
    expect(reopenedAgentIdCol?.notnull).toBe(0);
  });
});
