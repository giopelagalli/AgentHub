import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { createHub, type Hub } from '../src/server.js';

const hubs: Hub[] = [];
const tmpDirs: string[] = [];
const spawn = (uiDist?: string): Hub => {
  const hub = createHub({ uiDist });
  hubs.push(hub);
  return hub;
};
afterAll(async () => {
  for (const hub of hubs) await hub.stop();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe('hub static ui serving', () => {
  it('serves the built ui at / when uiDist exists, without shadowing the api', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'agenthub-ui-'));
    tmpDirs.push(dist);
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>tower</title>');
    const hub = spawn(dist);
    const res = await hub.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>tower</title>');
    const state = await hub.app.inject({ method: 'GET', url: '/api/state' });
    expect(state.statusCode).toBe(200);
    expect(state.json().nodes).toEqual([]);
  });

  it('404s at / without uiDist but still serves the api', async () => {
    const hub = spawn();
    expect((await hub.app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
    const state = await hub.app.inject({ method: 'GET', url: '/api/state' });
    expect(state.statusCode).toBe(200);
    expect(state.json().nodes).toEqual([]);
  });

  it('404s at / when uiDist points at a missing directory', async () => {
    const hub = spawn(join(tmpdir(), 'agenthub-ui-does-not-exist'));
    expect((await hub.app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
    expect((await hub.app.inject({ method: 'GET', url: '/api/state' })).statusCode).toBe(200);
  });
});
