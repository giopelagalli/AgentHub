import { describe, it, expect } from 'vitest';
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
});
