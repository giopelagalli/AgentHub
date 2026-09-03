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

export class Supervisor {
  private children: ChildProcess[] = [];
  private stopping = false;

  constructor(private serving: ServingConfig[], private onChildExit?: (cfg: ServingConfig) => void) {}

  async startAll(timeoutMs = 15000): Promise<void> {
    const spawnErrors: Error[] = [];
    for (const s of this.serving) {
      const [cmd, ...args] = s.cmd;
      // detached: true makes the child a process-group leader (setsid), so its pid doubles as its
      // group id — matches job-runner/shell-task's discipline, letting stopAll below kill a whole
      // serving tree (e.g. an `npx` wrapper and the process it execs) via a negative-pid signal.
      const child = spawn(cmd, args, { stdio: 'inherit', detached: true });
      child.on('error', (err) => { spawnErrors.push(err); });
      child.on('exit', () => {
        if (!this.stopping) this.onChildExit?.(s);
      });
      this.children.push(child);
    }
    try {
      await Promise.all(this.serving.map(async (s, i) => {
        const child = this.children[i];
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          if (spawnErrors.length) throw spawnErrors[0];
          try {
            const res = await fetch(`http://127.0.0.1:${s.port}/v1/models`);
            if (res.ok && child.exitCode === null && child.signalCode === null) return;
          } catch { /* not up yet */ }
          if (Date.now() > deadline) throw new Error(`serving process on port ${s.port} failed health check`);
          await sleep(250);
        }
      }));
    } catch (err) {
      await this.stopAll();
      throw err;
    }
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    await Promise.all(this.children.map((child) => new Promise<void>((resolve) => {
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
    })));
    this.children = [];
    this.stopping = false;
  }
}
