import { describe, it, expect, beforeEach } from 'vitest';
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
});
