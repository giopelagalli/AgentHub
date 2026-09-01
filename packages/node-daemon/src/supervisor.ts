import { spawn, type ChildProcess } from 'node:child_process';
import type { ServingConfig } from './config.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Supervisor {
  private children: ChildProcess[] = [];
  private stopping = false;

  constructor(private serving: ServingConfig[], private onChildExit?: (cfg: ServingConfig) => void) {}

  async startAll(timeoutMs = 15000): Promise<void> {
    const spawnErrors: Error[] = [];
    for (const s of this.serving) {
      const [cmd, ...args] = s.cmd;
      const child = spawn(cmd, args, { stdio: 'inherit' });
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
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000).unref();
    })));
    this.children = [];
    this.stopping = false;
  }
}
