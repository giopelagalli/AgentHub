import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataStamp } from '@agenthub/shared/data-stamp';
import { createHub, type Hub } from '../../hub/src/server.js';
import { loadConfig } from '../src/config.js';
import { Daemon } from '../src/daemon.js';

const dirs: string[] = [];
let hub: Hub | undefined;
let daemon: Daemon | undefined;

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ah-cn-'));
  dirs.push(dir);
  return dir;
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

async function healthy(port: number): Promise<boolean> {
  try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { return false; }
}

afterEach(async () => {
  await daemon?.stop(); daemon = undefined;
  await hub?.stop(); hub = undefined;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe('daemon control-node endpoints', () => {
  it('advertises the capability and starts, reports and stops the hub it is given', async () => {
    hub = createHub({ staleMs: 60000, projectsRoot: join(tmpDir(), 'projects') });
    await hub.projects.stop();
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const hubPort = (hub.app.server.address() as { port: number }).port;

    const dir = tmpDir();
    const dataRoot = join(dir, 'data');
    const marker = join(dir, 'env.json');
    const fakeHubPort = await getEphemeralPort();
    // Stands in for the hub itself: records the data-root environment it was started with, then
    // answers the health probe `POST /control/hub/start` waits for.
    const fakeHub = join(dir, 'fake-hub.cjs');
    writeFileSync(fakeHub, [
      `require('fs').mkdirSync(process.env.DATA_ROOT, { recursive: true });`,
      `require('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ dataRoot: process.env.DATA_ROOT, hubDb: process.env.HUB_DB }));`,
      `require('http').createServer((req, res) => { res.statusCode = req.url === '/api/health' ? 200 : 404; res.end('{}'); })`,
      `  .listen(${fakeHubPort}, '127.0.0.1');`,
    ].join('\n'));

    const cfgPath = join(dir, 'daemon.yaml');
    writeFileSync(cfgPath, [
      'node:', '  name: mini-test', '  arch: arm64',
      `hub: http://127.0.0.1:${hubPort}`,
      'hubToken: daemon-tok',
      'heartbeatMs: 1000',
      'controlPort: 0',
      'controlNode:',
      `  hubCmd: ["${process.execPath}", "${fakeHub}"]`,
      `  dataRoot: ${dataRoot}`,
      `  hubUrl: http://127.0.0.1:${fakeHubPort}`,
    ].join('\n'));

    daemon = new Daemon(loadConfig(cfgPath));
    await daemon.start();

    // the capability is advertised and survives the round-trip through the hub's registry
    expect(daemon.registration().controlNode).toBe(true);
    expect(hub.registry.byName('mini-test')?.controlNode).toBe(true);
    const controlUrl = daemon.registration().control!.url;
    const auth = { authorization: 'Bearer daemon-tok' };

    // every hub endpoint is behind the same bearer the profile ones are
    for (const [method, path] of [['GET', '/control/hub'], ['GET', '/control/hub/data-stamp'], ['POST', '/control/hub/start'], ['POST', '/control/hub/stop']] as const) {
      expect((await fetch(`${controlUrl}${path}`, { method })).status).toBe(401);
    }

    const idle = await (await fetch(`${controlUrl}/control/hub`, { headers: auth })).json();
    expect(idle).toMatchObject({ running: false, dataRoot, hubUrl: `http://127.0.0.1:${fakeHubPort}` });

    // the stamp is the same one the handing-over hub computes over its own copy
    writeFileSync(join(dir, 'unrelated.txt'), 'not under the data root');
    const stamp = await (await fetch(`${controlUrl}/control/hub/data-stamp`, { headers: auth })).json();
    expect(stamp.stamp).toBe(await dataStamp(dataRoot));

    // start: answers only once the hub is actually healthy, and hands it the synced data root
    const started = await fetch(`${controlUrl}/control/hub/start`, { method: 'POST', headers: auth });
    expect(started.status).toBe(200);
    const status = await started.json();
    expect(status.running).toBe(true);
    expect(typeof status.pid).toBe('number');
    expect(await healthy(fakeHubPort)).toBe(true);
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ dataRoot, hubDb: join(dataRoot, 'hub.db') });

    // and stop takes it back down
    const stopped = await fetch(`${controlUrl}/control/hub/stop`, { method: 'POST', headers: auth });
    expect(await stopped.json()).toMatchObject({ running: false });
    expect(await healthy(fakeHubPort)).toBe(false);
  }, 30000);

  it('fails the start when the hub never becomes healthy', async () => {
    hub = createHub({ staleMs: 60000, projectsRoot: join(tmpDir(), 'projects') });
    await hub.projects.stop();
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const hubPort = (hub.app.server.address() as { port: number }).port;

    const dir = tmpDir();
    const cfgPath = join(dir, 'daemon.yaml');
    writeFileSync(cfgPath, [
      'node:', '  name: never-healthy', '  arch: arm64',
      `hub: http://127.0.0.1:${hubPort}`,
      'hubToken: daemon-tok',
      'heartbeatMs: 1000',
      'controlPort: 0',
      'controlNode:',
      `  hubCmd: ["${process.execPath}", "-e", "process.exit(3)"]`,
      `  dataRoot: ${join(dir, 'data')}`,
      `  hubUrl: http://127.0.0.1:${await getEphemeralPort()}`,
    ].join('\n'));

    daemon = new Daemon(loadConfig(cfgPath));
    await daemon.start();
    const controlUrl = daemon.registration().control!.url;

    const res = await fetch(`${controlUrl}/control/hub/start`, { method: 'POST', headers: { authorization: 'Bearer daemon-tok' } });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/exited during start-up/);
    expect(body.running).toBe(false);
  }, 30000);

  it('rejects a controlNode config without an argv or a data root', () => {
    const dir = tmpDir();
    const write = (lines: string[]): string => {
      const p = join(dir, `${lines.length}-daemon.yaml`);
      writeFileSync(p, ['node:', '  name: n', '  arch: arm64', 'hub: http://127.0.0.1:1', ...lines].join('\n'));
      return p;
    };
    expect(() => loadConfig(write(['controlNode:', '  hubCmd: []', '  dataRoot: /tmp/x'])))
      .toThrow(/hubCmd must be a non-empty argv list/);
    expect(() => loadConfig(write(['controlNode:', '  hubCmd: ["node"]'])))
      .toThrow(/controlNode.dataRoot required/);
  });
});
