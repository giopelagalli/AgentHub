import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});
