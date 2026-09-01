import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { execSync } from 'node:child_process';
import { createHub, type Hub } from '../../hub/src/server.js';
import { loadConfig } from '../src/config.js';
import { Daemon } from '../src/daemon.js';
import { Supervisor } from '../src/supervisor.js';

const MOCK_SERVE = join(process.cwd(), 'packages/mocks/src/serve.ts');
// run tsx in-process (no npx wrapper) so the spawned child's pid is the actual server process
const TSX_CLI = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs');

function pidListeningOnPort(port: number): number {
  const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`).toString().trim();
  const pid = Number(out.split('\n')[0]);
  if (!pid) throw new Error(`no process listening on port ${port}`);
  return pid;
}

function getEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

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
    const servePort = await getEphemeralPort();

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
    const okPort = await getEphemeralPort();
    const stuckPort = await getEphemeralPort();

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

  it('startAll rejects instead of crashing when a serving process fails to spawn', async () => {
    const supervisor = new Supervisor([
      { tier: 'worker', model: 'mock-model', port: await getEphemeralPort(), maxStreams: 4, cmd: ['definitely-not-a-real-binary-xyz'] },
    ]);
    await expect(supervisor.startAll(2000)).rejects.toThrow();
  }, 10000);

  it('invokes onChildExit when a serving child dies unexpectedly, not via stopAll', async () => {
    const port = await getEphemeralPort();
    let exited: { port: number } | undefined;
    const cfg = { tier: 'worker' as const, model: 'mock-model', port, maxStreams: 4, cmd: ['node', TSX_CLI, MOCK_SERVE, String(port)] };
    const supervisor = new Supervisor([cfg], (c) => { exited = c; });
    await supervisor.startAll(10000);
    try {
      process.kill(pidListeningOnPort(port), 'SIGKILL');
      const deadline = Date.now() + 5000;
      while (!exited && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(exited).toMatchObject({ port });
    } finally {
      await supervisor.stopAll();
    }
  }, 15000);
});
