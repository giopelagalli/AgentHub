import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub, type Hub } from '../../hub/src/server.js';
import { loadConfig } from '../src/config.js';
import { Daemon } from '../src/daemon.js';
import { Supervisor } from '../src/supervisor.js';

const MOCK_SERVE = join(process.cwd(), 'packages/mocks/src/serve.ts');

let hub: Hub; let daemon: Daemon;
afterEach(async () => { await daemon?.stop(); await hub?.stop(); });

describe('node daemon', () => {
  it('loadConfig validates required fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ah-'));
    const bad = join(dir, 'bad.yaml');
    writeFileSync(bad, 'node:\n  name: x\n');
    expect(() => loadConfig(bad)).toThrow(/daemon config/);
  });

  it('spawns serving processes, registers with hub, and heartbeats', async () => {
    hub = createHub({ staleMs: 60000 });
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const hubPort = (hub.app.server.address() as { port: number }).port;
    const servePort = 18300 + Math.floor(Math.random() * 500);

    const dir = mkdtempSync(join(tmpdir(), 'ah-'));
    const cfgPath = join(dir, 'daemon.yaml');
    writeFileSync(cfgPath, [
      'node:', '  name: dev-node', '  arch: arm64',
      `hub: http://127.0.0.1:${hubPort}`,
      'heartbeatMs: 200',
      'serving:',
      '  - tier: worker', '    model: mock-model', `    port: ${servePort}`, '    maxStreams: 4',
      `    cmd: ["npx", "tsx", "${MOCK_SERVE}", "${servePort}"]`,
    ].join('\n'));

    daemon = new Daemon(loadConfig(cfgPath));
    await daemon.start();

    const node = hub.registry.byName('dev-node');
    expect(node?.status).toBe('online');
    expect(node?.endpoints[0]).toMatchObject({ tier: 'worker', url: `http://127.0.0.1:${servePort}`, maxStreams: 4 });

    // heartbeat advances
    const t0 = hub.registry.byName('dev-node')!.lastHeartbeat;
    await new Promise((r) => setTimeout(r, 500));
    expect(hub.registry.byName('dev-node')!.lastHeartbeat).toBeGreaterThan(t0);

    // the spawned mock actually serves
    const models = await fetch(`http://127.0.0.1:${servePort}/v1/models`);
    expect(models.status).toBe(200);
  }, 30000);

  it('startAll kills already-healthy children when a sibling fails its health check', async () => {
    const okPort = 19300 + Math.floor(Math.random() * 500);
    const stuckPort = okPort + 1;

    const supervisor = new Supervisor([
      { tier: 'worker', model: 'mock-model', port: okPort, maxStreams: 4, cmd: ['npx', 'tsx', MOCK_SERVE, String(okPort)] },
      { tier: 'worker', model: 'mock-model', port: stuckPort, maxStreams: 4, cmd: ['node', '-e', 'setInterval(()=>{},1000)'] },
    ]);

    await expect(supervisor.startAll(1500)).rejects.toThrow(/failed health check/);

    // the healthy sibling must have been torn down too, not left orphaned
    const deadline = Date.now() + 5000;
    let alive = true;
    while (Date.now() < deadline) {
      try {
        await fetch(`http://127.0.0.1:${okPort}/v1/models`);
      } catch {
        alive = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(alive).toBe(false);
  }, 15000);
});
