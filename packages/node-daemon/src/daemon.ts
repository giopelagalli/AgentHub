import { join } from 'node:path';
import type { NodeRegistration } from '@agenthub/shared';
import type { DaemonConfig } from './config.js';
import { Supervisor } from './supervisor.js';
import { JobRunner } from './job-runner.js';

export class Daemon {
  private supervisor: Supervisor;
  private runner?: JobRunner;
  private timer?: NodeJS.Timeout;
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
      });
      this.runner.start();
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.runner?.stop();
    await this.supervisor.stopAll();
  }
}
