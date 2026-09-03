import { join } from 'node:path';
import type { NodeRegistration } from '@agenthub/shared';
import type { DaemonConfig } from './config.js';
import { Supervisor } from './supervisor.js';
import { JobRunner } from './job-runner.js';

// Bounds Daemon.stop()'s wait for the runner's in-flight execution to actually settle, so a real
// shell-task's SIGKILL escalation (shell-task.ts's KILL_ESCALATION_MS, 5s after SIGTERM) has time to
// fire before this process exits.
const RUNNER_STOP_WAIT_MS = 6000;

export class Daemon {
  private supervisor: Supervisor;
  private runner?: JobRunner;
  private timer?: NodeJS.Timeout;
  private reregistering = false;
  constructor(private cfg: DaemonConfig) {
    this.supervisor = new Supervisor(cfg.serving, (s) => {
      console.error(`[daemon] serving process for ${s.tier}:${s.model} on port ${s.port} exited unexpectedly`);
      void this.stop().then(() => process.exit(1));
    });
  }

  registration(): NodeRegistration {
    const host = this.cfg.advertiseHost ?? '127.0.0.1';
    return {
      name: this.cfg.node.name, arch: this.cfg.node.arch,
      endpoints: this.cfg.serving.map((s) => ({ tier: s.tier, url: `http://${host}:${s.port}`, model: s.model, maxStreams: s.maxStreams })),
      jobTypes: this.cfg.jobTypes ?? [],
    };
  }

  async start(): Promise<void> {
    await this.supervisor.startAll();
    const res = await fetch(`${this.cfg.hub}/api/nodes/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(this.registration()),
    });
    if (!res.ok) throw new Error(`hub registration failed: ${res.status}`);
    const interval = this.cfg.heartbeatMs ?? 5000;
    this.timer = setInterval(() => {
      fetch(`${this.cfg.hub}/api/nodes/${this.cfg.node.name}/heartbeat`, { method: 'POST' })
        .then((res) => { if (res.status === 404) void this.reregister('heartbeat'); })
        .catch(() => { /* hub temporarily unreachable; keep beating */ });
    }, interval);

    const jobTypes = this.cfg.jobTypes ?? [];
    if (jobTypes.length > 0) {
      this.runner = new JobRunner({
        hub: this.cfg.hub,
        node: this.cfg.node.name,
        types: jobTypes,
        workspaceRoot: this.cfg.workspaceRoot ?? join(process.cwd(), 'workspace'),
        claimIntervalMs: this.cfg.claimIntervalMs ?? 1000,
        onNodeNotFound: () => { void this.reregister('claim'); },
      });
      this.runner.start();
    }
  }

  // Re-registers with the hub after it stops recognizing this node — most notably a hub restart
  // (fresh in-memory registry), surfaced as a 404 from heartbeat or claim. Guarded against overlap
  // (a heartbeat tick and a claim tick can both notice this around the same time); register itself
  // is idempotent (NodeRegistry.register upserts by name), so a skipped, overlapping occurrence is
  // covered by the in-flight call.
  private async reregister(reason: 'heartbeat' | 'claim'): Promise<void> {
    if (this.reregistering) return;
    this.reregistering = true;
    console.error(`[daemon] hub doesn't know node ${this.cfg.node.name} (${reason} 404) — re-registering`);
    try {
      const res = await fetch(`${this.cfg.hub}/api/nodes/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(this.registration()),
      });
      if (!res.ok) console.error(`[daemon] re-registration failed: ${res.status}`);
    } catch (err) {
      console.error('[daemon] re-registration failed:', err);
    } finally {
      this.reregistering = false;
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.runner) {
      await this.runner.stop();
      await this.runner.waitForIdle(RUNNER_STOP_WAIT_MS);
    }
    await this.supervisor.stopAll();
  }
}
