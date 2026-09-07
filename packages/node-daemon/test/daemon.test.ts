import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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

const dirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ah-'));
  dirs.push(dir);
  return dir;
}

async function waitForProcessGone(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // ESRCH: the process is gone
    }
    if (Date.now() > deadline) throw new Error(`process ${pid} still alive after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

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
afterEach(async () => {
  await daemon?.stop(); await hub?.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe('node daemon', () => {
  it('loadConfig validates required fields', () => {
    const dir = tmpDir();
    const bad = join(dir, 'bad.yaml');
    writeFileSync(bad, 'node:\n  name: x\n');
    expect(() => loadConfig(bad)).toThrow(/daemon config/);
  });

  it('spawns serving processes, registers with hub, and heartbeats', async () => {
    hub = createHub({ staleMs: 60000 });
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const hubPort = (hub.app.server.address() as { port: number }).port;
    const servePort = await getEphemeralPort();

    const dir = tmpDir();
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

  it('stopAll clears the escalation timer once a child exits gracefully (no late SIGKILL)', async () => {
    const port = await getEphemeralPort();
    const cfg = { tier: 'worker' as const, model: 'mock-model', port, maxStreams: 4, cmd: ['node', TSX_CLI, MOCK_SERVE, String(port)] };
    const supervisor = new Supervisor([cfg]);
    // Real timers for startup: the health-check poll inside startAll relies on real setTimeout.
    await supervisor.startAll(10000);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const killSpy = vi.spyOn(process, 'kill');
    try {
      // The mock server has no SIGTERM handler, so Node's default disposition kills it immediately —
      // a real ('exit') event, unaffected by the JS-level fake timers above — which should clear the
      // 3s escalation timer stopAll armed for it.
      await supervisor.stopAll();
      await vi.advanceTimersByTimeAsync(4000); // past KILL_ESCALATION_MS (3000) with margin
      const sigkillCalls = killSpy.mock.calls.filter(([, sig]) => sig === 'SIGKILL');
      expect(sigkillCalls).toEqual([]);
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  }, 15000);

  it('stop() waits out the SIGKILL escalation so a SIGTERM-trapping grandchild is reaped before it resolves', async () => {
    hub = createHub({ staleMs: 60000 });
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const hubPort = (hub.app.server.address() as { port: number }).port;
    const servePort = await getEphemeralPort();

    const dir = tmpDir();
    const cfgPath = join(dir, 'daemon.yaml');
    const workspaceRoot = join(dir, 'workspace');
    writeFileSync(cfgPath, [
      'node:', '  name: shutdown-node', '  arch: arm64',
      `hub: http://127.0.0.1:${hubPort}`,
      'heartbeatMs: 500',
      'jobTypes: ["shell-task"]',
      `workspaceRoot: ${workspaceRoot}`,
      'claimIntervalMs: 50',
      'serving:',
      '  - tier: worker', '    model: mock-model', `    port: ${servePort}`, '    maxStreams: 4',
      `    cmd: ["npx", "tsx", "${MOCK_SERVE}", "${servePort}"]`,
    ].join('\n'));

    daemon = new Daemon(loadConfig(cfgPath));
    await daemon.start();

    const jobRes = await fetch(`http://127.0.0.1:${hubPort}/api/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'shell-task', tier: 'worker', priority: 'batch',
        payload: { cmd: ['sh', '-c', 'node -e "process.on(\'SIGTERM\',()=>{});setInterval(()=>{},1000)" & echo $!; sleep 100'] },
      }),
    });
    const job = (await jobRes.json()) as { id: number };

    let grandchildPid: number | undefined;
    const claimDeadline = Date.now() + 5000;
    while (grandchildPid === undefined && Date.now() < claimDeadline) {
      const j = (await (await fetch(`http://127.0.0.1:${hubPort}/api/jobs/${job.id}`)).json()) as { logs: { line: string }[] };
      const pidLine = j.logs.find((l) => /^out: \d+$/.test(l.line));
      if (pidLine) grandchildPid = Number(pidLine.line.slice('out: '.length));
      else await new Promise((r) => setTimeout(r, 100));
    }
    expect(grandchildPid).toBeDefined();

    const t0 = Date.now();
    await daemon.stop();
    expect(Date.now() - t0).toBeLessThanOrEqual(7000);

    await waitForProcessGone(grandchildPid!, 500); // already gone by the time stop() resolved
  }, 20000);

  it('carries the daemon bearer token on register, heartbeat and claim', async () => {
    hub = createHub({ staleMs: 60000, auth: { password: 'owner-pw', daemonToken: 'daemon-tok', sessionSecret: 's' } });
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const hubPort = (hub.app.server.address() as { port: number }).port;

    const dir = tmpDir();
    const cfgPath = join(dir, 'daemon.yaml');
    writeFileSync(cfgPath, [
      'node:', '  name: token-node', '  arch: arm64',
      `hub: http://127.0.0.1:${hubPort}`,
      'hubToken: daemon-tok',
      'heartbeatMs: 100',
      'jobTypes: ["shell-task"]',
      `workspaceRoot: ${join(dir, 'workspace')}`,
      'claimIntervalMs: 50',
    ].join('\n'));

    daemon = new Daemon(loadConfig(cfgPath));
    await daemon.start(); // registration throws on a 401

    const t0 = hub.registry.byName('token-node')!.lastHeartbeat;
    await new Promise((r) => setTimeout(r, 400));
    expect(hub.registry.byName('token-node')!.lastHeartbeat).toBeGreaterThan(t0);

    // Claim, log and complete are the runner's own calls; the job only finishes if all three passed.
    const job = hub.queue.enqueue({ type: 'shell-task', tier: 'worker', priority: 'batch', payload: { cmd: ['echo', 'hi'] } });
    const deadline = Date.now() + 5000;
    while (hub.queue.get(job.id)?.status !== 'done' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(hub.queue.get(job.id)?.status).toBe('done');
  }, 15000);

  it('is refused by an authenticated hub when it has no token', async () => {
    vi.stubEnv('DAEMON_TOKEN', '');
    try {
      hub = createHub({ staleMs: 60000, auth: { password: 'owner-pw', daemonToken: 'daemon-tok', sessionSecret: 's' } });
      await hub.app.listen({ port: 0, host: '127.0.0.1' });
      const hubPort = (hub.app.server.address() as { port: number }).port;

      const dir = tmpDir();
      const cfgPath = join(dir, 'daemon.yaml');
      writeFileSync(cfgPath, [
        'node:', '  name: tokenless-node', '  arch: arm64',
        `hub: http://127.0.0.1:${hubPort}`,
        'jobTypes: ["shell-task"]',
      ].join('\n'));

      daemon = new Daemon(loadConfig(cfgPath));
      await expect(daemon.start()).rejects.toThrow(/hub registration failed: 401/);
      expect(hub.registry.byName('tokenless-node')).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  }, 10000);

  it('re-registers with a fresh hub after a hub restart (heartbeat 404)', async () => {
    let hubA: Hub | undefined;
    let hubB: Hub | undefined;
    try {
      hubA = createHub({ staleMs: 60000 });
      await hubA.app.listen({ port: 0, host: '127.0.0.1' });
      const port = (hubA.app.server.address() as { port: number }).port;
      const hubUrl = `http://127.0.0.1:${port}`;
      const servePort = await getEphemeralPort();

      const dir = tmpDir();
      const cfgPath = join(dir, 'daemon.yaml');
      writeFileSync(cfgPath, [
        'node:', '  name: resilient-node', '  arch: arm64',
        `hub: ${hubUrl}`,
        'heartbeatMs: 150',
        'serving:',
        '  - tier: worker', '    model: mock-model', `    port: ${servePort}`, '    maxStreams: 4',
        `    cmd: ["npx", "tsx", "${MOCK_SERVE}", "${servePort}"]`,
      ].join('\n'));

      daemon = new Daemon(loadConfig(cfgPath));
      await daemon.start();
      expect(hubA.registry.byName('resilient-node')?.status).toBe('online');

      await hubA.stop();

      hubB = createHub({ staleMs: 60000 });
      await hubB.app.listen({ port, host: '127.0.0.1' });

      const deadline = Date.now() + 3000; // ~3 heartbeats at 150ms, plus margin
      let seen = false;
      while (Date.now() < deadline) {
        if (hubB.registry.byName('resilient-node')?.status === 'online') { seen = true; break; }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(seen).toBe(true);
    } finally {
      await hubB?.stop();
    }
  }, 20000);
});
