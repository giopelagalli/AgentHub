import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { ControlNodeConfig } from './config.js';

/** How long a started hub gets to answer `/api/health` before the start is called a failure. */
const DEFAULT_HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 250;
/** SIGTERM first, then SIGKILL this long after, so a wedged hub can still be taken off the node. */
const KILL_ESCALATION_MS = 10_000;

export interface HubStatus {
  running: boolean;
  pid?: number;
  hubUrl: string;
  dataRoot: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The hub, supervised as a child of this daemon (spec §4.2: the target node's daemon starts the hub
 * after the data sync). It is deliberately a child and not a detached service handle: the daemon is
 * the thing systemd/launchd keeps alive on each control node, so the hub's lifetime is tied to it
 * — stopping the daemon stops the hub it started.
 *
 * The data root reaches the hub as the `DATA_ROOT` variable plus the three roots the hub's `main.ts`
 * actually reads, so a hub started here uses the freshly synced copy and nothing else.
 */
export class HubProcess {
  private child?: ChildProcess;
  private readonly healthTimeoutMs: number;

  constructor(private cfg: ControlNodeConfig, private advertiseHost: string, opts: { healthTimeoutMs?: number } = {}) {
    this.healthTimeoutMs = opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  }

  get hubUrl(): string {
    return this.cfg.hubUrl ?? `http://${this.advertiseHost}:4000`;
  }

  status(): HubStatus {
    return {
      running: this.child !== undefined,
      ...(this.child?.pid !== undefined ? { pid: this.child.pid } : {}),
      hubUrl: this.hubUrl,
      dataRoot: this.cfg.dataRoot,
    };
  }

  /** Spawns the hub and resolves once it answers `/api/health`; throws (having killed it) if it doesn't. */
  async start(): Promise<HubStatus> {
    if (this.child) return this.status();
    const [cmd, ...args] = this.cfg.hubCmd as [string, ...string[]];
    const child = spawn(cmd, args, {
      env: {
        ...process.env,
        DATA_ROOT: this.cfg.dataRoot,
        HUB_DB: join(this.cfg.dataRoot, 'hub.db'),
        PROJECTS_ROOT: join(this.cfg.dataRoot, 'projects'),
        MEMORY_ROOT: join(this.cfg.dataRoot, 'memory'),
      },
      stdio: 'inherit',
    });
    this.child = child;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    child.on('error', (err) => { console.error('[daemon] hub process failed to spawn:', err); });
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      if (this.child === child) this.child = undefined;
    });

    const deadline = Date.now() + this.healthTimeoutMs;
    while (Date.now() < deadline) {
      if (exited) throw new Error(`hub exited during start-up (code ${exited.code}, signal ${exited.signal})`);
      if (await this.healthy()) return this.status();
      await sleep(HEALTH_POLL_MS);
    }
    await this.stop();
    throw new Error(`hub did not answer ${this.hubUrl}/api/health within ${this.healthTimeoutMs}ms`);
  }

  /** SIGTERM, escalating to SIGKILL; resolves once the child is actually gone. */
  async stop(): Promise<HubStatus> {
    const child = this.child;
    if (!child) return this.status();
    const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), KILL_ESCALATION_MS);
    kill.unref?.();
    try {
      await gone;
    } finally {
      clearTimeout(kill);
    }
    if (this.child === child) this.child = undefined;
    return this.status();
  }

  private async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.hubUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}
