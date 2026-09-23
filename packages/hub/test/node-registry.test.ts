import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb, type Db } from '../src/db.js';
import { NodeRegistry } from '../src/node-registry.js';
import type { NodeRegistration } from '@agenthub/shared';

const reg = (name: string): NodeRegistration => ({
  name, arch: 'arm64',
  endpoints: [{ tier: 'worker', url: `http://127.0.0.1:81/${name}`, model: 'mock-model', maxStreams: 4 }],
});

let db: Db; let registry: NodeRegistry;
beforeEach(() => { db = openDb(':memory:'); registry = new NodeRegistry(db, { staleMs: 1000 }); });

describe('NodeRegistry', () => {
  it('registers and upserts by name', () => {
    const a = registry.register(reg('spark'), 100);
    const b = registry.register(reg('spark'), 200);
    expect(b.id).toBe(a.id);
    expect(registry.online(300)).toHaveLength(1);
    expect(registry.byName('spark')?.endpoints[0].tier).toBe('worker');
  });

  it('marks nodes offline after staleMs without heartbeat, and revives on heartbeat', () => {
    registry.register(reg('mb'), 0);
    expect(registry.sweep(500)).toHaveLength(0);
    const gone = registry.sweep(2000);
    expect(gone.map(n => n.name)).toEqual(['mb']);
    expect(registry.online(2000)).toHaveLength(0);
    expect(registry.heartbeat('mb', 2500)).toBe(true);
    expect(registry.online(2600).map(n => n.name)).toEqual(['mb']);
    expect(registry.heartbeat('ghost', 2500)).toBe(false);
  });

  it('round-trips jobTypes on registration', () => {
    const a = registry.register({ ...reg('spark'), jobTypes: ['shell-task'] }, 100);
    expect(a.jobTypes).toEqual(['shell-task']);
    expect(registry.byName('spark')?.jobTypes).toEqual(['shell-task']);
  });

  it('defaults jobTypes to [] when not provided', () => {
    const a = registry.register(reg('mb'), 100);
    expect(a.jobTypes).toEqual([]);
    expect(registry.byName('mb')?.jobTypes).toEqual([]);
  });

  it('round-trips the video capability, its profiles and its control url', () => {
    const spark = registry.register({
      ...reg('spark'), jobTypes: ['video-gen'], video: true,
      profiles: ['llm', 'video'], control: { url: 'http://spark:8131' },
    }, 100);
    expect(spark).toMatchObject({ video: true, profiles: ['llm', 'video'], control: { url: 'http://spark:8131' } });
    expect(registry.byName('spark')).toMatchObject({ video: true, profiles: ['llm', 'video'] });
    expect(registry.online(150)[0]).toMatchObject({ control: { url: 'http://spark:8131' } });
  });

  it('defaults the video columns for a node that declares none', () => {
    const mb = registry.register(reg('mb'), 100);
    expect(mb.video).toBe(false);
    expect(mb.profiles).toEqual([]);
    expect(mb.control).toBeUndefined();
  });

  it('defaults draining to false, and setDraining toggles and persists it', () => {
    const spark = registry.register(reg('spark'), 100);
    expect(spark.draining).toBe(false);

    expect(registry.setDraining('spark', true)).toBe(true);
    expect(registry.byName('spark')?.draining).toBe(true);
    expect(registry.online(150).find((n) => n.name === 'spark')?.draining).toBe(true);

    expect(registry.setDraining('spark', false)).toBe(true);
    expect(registry.byName('spark')?.draining).toBe(false);

    expect(registry.setDraining('ghost', true)).toBe(false);
  });

  it('remove deletes the node from memory and the db table', () => {
    registry.register(reg('spark'), 100);
    expect(registry.remove('spark')).toBe(true);
    expect(registry.byName('spark')).toBeNull();
    expect(registry.all()).toHaveLength(0);
    // Already gone: a second remove finds nothing.
    expect(registry.remove('spark')).toBe(false);
  });

  it('register after remove re-creates the node fresh, not draining', () => {
    registry.register(reg('spark'), 100);
    registry.setDraining('spark', true);
    registry.remove('spark');
    const recreated = registry.register(reg('spark'), 200);
    expect(recreated.draining).toBe(false);
  });
});

describe('nodes table migration', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agenthub-db-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('adds the video columns to a database written before Phase 6', () => {
    const path = join(dir, 'hub.db');
    const old = new Database(path);
    old.exec(`
      CREATE TABLE nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, arch TEXT NOT NULL,
        endpoints_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'online',
        last_heartbeat INTEGER NOT NULL, job_types_json TEXT NOT NULL DEFAULT '[]', browser_json TEXT
      );
      INSERT INTO nodes (name, arch, endpoints_json, last_heartbeat) VALUES ('legacy', 'arm64', '[]', 0);
    `);
    old.close();

    const migrated = openDb(path);
    const registry = new NodeRegistry(migrated, { staleMs: 1000 });
    expect(registry.byName('legacy')).toMatchObject({ video: false, profiles: [] });
    const spark = registry.register({ ...reg('spark'), video: true, profiles: ['video'] }, 100);
    expect(spark.video).toBe(true);
    migrated.close();
  });

  it('adds the draining column to a database written before it existed', () => {
    const path = join(dir, 'hub.db');
    const old = new Database(path);
    old.exec(`
      CREATE TABLE nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, arch TEXT NOT NULL,
        endpoints_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'online',
        last_heartbeat INTEGER NOT NULL, job_types_json TEXT NOT NULL DEFAULT '[]', browser_json TEXT,
        profiles_json TEXT NOT NULL DEFAULT '[]', video INTEGER NOT NULL DEFAULT 0,
        control_json TEXT, control_node INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO nodes (name, arch, endpoints_json, last_heartbeat) VALUES ('legacy', 'arm64', '[]', 0);
    `);
    old.close();

    const migrated = openDb(path);
    const registry = new NodeRegistry(migrated, { staleMs: 1000 });
    expect(registry.byName('legacy')?.draining).toBe(false);
    expect(registry.setDraining('legacy', true)).toBe(true);
    expect(registry.byName('legacy')?.draining).toBe(true);
    migrated.close();
  });
});
