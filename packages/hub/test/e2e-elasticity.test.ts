import { describe, it, expect, afterAll } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HubState, Job } from '@agenthub/shared';
import { writeDaemonConfig } from '@agenthub/mocks/daemon-config';
import { createHub, type Hub } from '../src/server.js';

// Spawn the daemon via the tsx CLI directly (not `npx tsx ...`) so the child's pid is the actual
// daemon process — required so SIGKILL below kills the daemon itself, not an npx wrapper.
const TSX_CLI = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
const DAEMON_MAIN = join(process.cwd(), 'packages/node-daemon/src/main.ts');

function spawnDaemon(cfgPath: string): ChildProcess {
  return spawn(process.execPath, [TSX_CLI, DAEMON_MAIN, cfgPath], { stdio: 'inherit' });
}

// The daemon's own serving child (the mock model, started via `npx tsx serve.ts <port>`) is not in
// the daemon's process group and survives a SIGKILL of the daemon pid. Find and kill whatever is
// still listening on its port so it doesn't linger past the test.
function killPort(port: number): void {
  try {
    const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`).toString().trim();
    for (const pid of out.split('\n').filter(Boolean)) {
      try { process.kill(Number(pid), 'SIGKILL'); } catch { /* already gone */ }
    }
  } catch { /* nothing listening */ }
}

async function fetchJson<T>(url: string): Promise<T> {
  return (await fetch(url)).json() as Promise<T>;
}

async function poll<T>(fn: () => Promise<T | undefined>, timeoutMs: number, intervalMs = 150): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const val = await fn();
    if (val !== undefined) return val;
    if (Date.now() > deadline) throw new Error('poll timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

let hub: Hub;
const procs: ChildProcess[] = [];
const ports: number[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const p of procs) {
    if (p.exitCode === null && p.signalCode === null) {
      try { p.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }
  for (const port of ports) killPort(port);
  for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
  await hub?.stop();
});

describe('phase 2 elasticity e2e', () => {
  it('a job survives the death of the node running it', async () => {
    hub = createHub({ staleMs: 1500, sweepIntervalMs: 300 });
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const hubBase = `http://127.0.0.1:${(hub.app.server.address() as { port: number }).port}`;

    const macbookWorkspace = mkdtempSync(join(tmpdir(), 'ah-ws-macbook-'));
    const sparkWorkspace = mkdtempSync(join(tmpdir(), 'ah-ws-spark-'));
    dirs.push(macbookWorkspace, sparkWorkspace);

    const macbookCfg = await writeDaemonConfig({
      name: 'macbook', hubUrl: hubBase, jobTypes: ['shell-task'], workspaceRoot: macbookWorkspace,
    });
    dirs.push(join(macbookCfg.path, '..'));
    ports.push(macbookCfg.servePort);

    const macbookProc = spawnDaemon(macbookCfg.path);
    procs.push(macbookProc);

    const macbookNode = await poll(async () => {
      const state = await fetchJson<HubState>(`${hubBase}/api/state`);
      const node = state.nodes.find((n) => n.name === 'macbook');
      return node?.status === 'online' ? node : undefined;
    }, 20000);

    const job = await (await fetch(`${hubBase}/api/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'shell-task', tier: 'worker', priority: 'batch',
        payload: { cmd: ['node', '-e', 'setTimeout(()=>console.log("done"),4000)'] },
      }),
    })).json() as Job;

    await poll(async () => {
      const j = await fetchJson<Job & { logs: unknown[] }>(`${hubBase}/api/jobs/${job.id}`);
      return j.status === 'running' && j.nodeId === macbookNode.id ? j : undefined;
    }, 20000);

    // Simulate a lid-close/crash: SIGKILL, not a graceful SIGTERM.
    macbookProc.kill('SIGKILL');
    killPort(macbookCfg.servePort);

    const sparkCfg = await writeDaemonConfig({
      name: 'spark', hubUrl: hubBase, jobTypes: ['shell-task'], workspaceRoot: sparkWorkspace,
    });
    dirs.push(join(sparkCfg.path, '..'));
    ports.push(sparkCfg.servePort);

    const sparkProc = spawnDaemon(sparkCfg.path);
    procs.push(sparkProc);

    const jobDone = await poll(async () => {
      const j = await fetchJson<Job & { logs: { line: string }[] }>(`${hubBase}/api/jobs/${job.id}`);
      return j.status === 'done' ? j : undefined;
    }, 15000);

    const state = await fetchJson<HubState>(`${hubBase}/api/state`);
    const sparkNode = state.nodes.find((n) => n.name === 'spark');

    expect(jobDone.nodeId).toBe(sparkNode?.id);
    expect(jobDone.attempts).toBe(2);
    expect(jobDone.logs.some((l) => l.line === 'out: done')).toBe(true);

    const macbookNodeAfter = state.nodes.find((n) => n.name === 'macbook');
    expect(macbookNodeAfter?.status).toBe('offline');
  }, 60000);
});
