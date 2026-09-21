import { spawn, type ChildProcess } from 'node:child_process';
import type { ServingConfig } from './config.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const KILL_ESCALATION_MS = 3000;

function groupAlive(child: ChildProcess): boolean {
  if (child.pid === undefined) return false;
  try { process.kill(-child.pid, 0); return true; } catch { return false; }
}

function killGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, sig); } catch { /* group already gone (ESRCH) */ }
}

/** Profiles address serving entries by name; an unnamed entry falls back to `<tier>:<port>`. */
export function entryName(s: ServingConfig): string {
  return s.name ?? `${s.tier}:${s.port}`;
}

interface Running { cfg: ServingConfig; child: ChildProcess | undefined; stopping: boolean; }

export class Supervisor {
  private running = new Map<string, Running>();

  constructor(private serving: ServingConfig[], private onChildExit?: (cfg: ServingConfig) => void) {}

  /** Names of the entries currently supervised — the node's live profile. */
  activeEntries(): string[] {
    return [...this.running.keys()];
  }

  async startAll(timeoutMs = 15000): Promise<void> {
    try {
      await this.spawnAndAwait(this.serving, timeoutMs);
    } catch (err) {
      await this.stopAll();
      throw err;
    }
  }

  /**
   * Starts the named entries (unknown names and already-running ones are no-ops), health-checking
   * each the same way `startAll` does. On failure only the entries this call started are torn down —
   * a profile switch must not take down entries that were already serving.
   */
  async startEntries(names: string[], timeoutMs = 15000): Promise<void> {
    const wanted = this.serving.filter((s) => names.includes(entryName(s)) && !this.running.has(entryName(s)));
    if (wanted.length === 0) return;
    try {
      await this.spawnAndAwait(wanted, timeoutMs);
    } catch (err) {
      await this.stopEntries(wanted.map(entryName));
      throw err;
    }
  }

  /** Stops the named entries. Unknown or already-stopped names are no-ops. */
  async stopEntries(names: string[]): Promise<void> {
    await Promise.all(names.map((name) => {
      const rec = this.running.get(name);
      return rec ? this.terminate(name, rec) : Promise.resolve();
    }));
  }

  async stopAll(): Promise<void> {
    await this.stopEntries([...this.running.keys()]);
  }

  private async spawnAndAwait(entries: ServingConfig[], timeoutMs: number): Promise<void> {
    const spawnErrors: Error[] = [];
    const started: Running[] = [];
    for (const s of entries) {
      if (!s.cmd) {
        // Attach mode: the server is started elsewhere. Nothing to spawn — just track it so the
        // health check below and stop/terminate see a running entry.
        const rec: Running = { cfg: s, child: undefined, stopping: false };
        this.running.set(entryName(s), rec);
        started.push(rec);
        continue;
      }
      const [cmd, ...args] = s.cmd;
      // detached: true makes the child a process-group leader (setsid), so its pid doubles as its
      // group id — matches job-runner/shell-task's discipline, letting stopEntries below kill a whole
      // serving tree (e.g. an `npx` wrapper and the process it execs) via a negative-pid signal.
      const child = spawn(cmd, args, { stdio: 'inherit', detached: true });
      const rec: Running = { cfg: s, child, stopping: false };
      child.on('error', (err) => { spawnErrors.push(err); });
      child.on('exit', () => {
        if (this.running.get(entryName(s)) === rec) this.running.delete(entryName(s));
        if (!rec.stopping) this.onChildExit?.(s);
      });
      this.running.set(entryName(s), rec);
      started.push(rec);
    }
    await Promise.all(started.map(async ({ cfg, child }) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (spawnErrors.length) throw spawnErrors[0];
        try {
          const res = await fetch(`http://127.0.0.1:${cfg.port}/v1/models`);
          if (res.ok && (!child || (child.exitCode === null && child.signalCode === null))) return;
        } catch { /* not up yet */ }
        if (Date.now() > deadline) {
          throw new Error(child
            ? `serving process on port ${cfg.port} failed health check`
            : `serving on port ${cfg.port} (attached) failed health check`);
        }
        await sleep(250);
      }
    }));
  }

  private terminate(name: string, rec: Running): Promise<void> {
    rec.stopping = true;
    this.running.delete(name);
    const { child } = rec;
    if (!child) return Promise.resolve(); // attached servers are not ours to stop
    return new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      // A SIGTERM'd child reports exitCode === null (its exit is signal-driven, not code-driven), so
      // checking exitCode alone can't tell us the escalation is moot — clear the timer explicitly
      // once 'exit' fires, and re-probe the group (its pgid could be recycled by an unrelated
      // process by the time the timer would run) before ever escalating to SIGKILL.
      const killTimer = setTimeout(() => {
        if (groupAlive(child)) killGroup(child, 'SIGKILL');
      }, KILL_ESCALATION_MS);
      killTimer.unref();
      child.once('exit', () => { clearTimeout(killTimer); resolve(); });
      killGroup(child, 'SIGTERM');
    });
  }
}
