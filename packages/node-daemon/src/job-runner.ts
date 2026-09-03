import type { Job, JobResult, JobType, ShellTaskPayload } from '@agenthub/shared';
import { runShellTask } from './shell-task.js';

type Execute = (job: Job, log: (line: string) => void) => Promise<JobResult>;

class UnsupportedJobTypeError extends Error {
  constructor() { super('unsupported job type'); }
}

class InvalidPayloadError extends Error {
  constructor() { super('invalid shell-task payload'); }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface JobRunnerOptions {
  hub: string;
  node: string;
  types: JobType[];
  workspaceRoot: string;
  claimIntervalMs: number;
  execute?: Execute;
}

export class JobRunner {
  private readonly execute: Execute;
  private stopping = false;
  private loopPromise?: Promise<void>;
  private currentAbort?: AbortController;
  private inFlightJobId?: number;
  private inFlightReported = false;
  private logChain: Promise<void> = Promise.resolve();
  private warned403 = false;
  private warned404 = false;

  constructor(private opts: JobRunnerOptions) {
    this.execute = opts.execute ?? this.defaultExecute;
  }

  private defaultExecute: Execute = (job, log) => {
    if (job.type !== 'shell-task') return Promise.reject(new UnsupportedJobTypeError());
    const payload = job.payload as ShellTaskPayload;
    if (!Array.isArray(payload?.cmd) || payload.cmd.length === 0) return Promise.reject(new InvalidPayloadError());
    return runShellTask(payload, {
      workspaceRoot: this.opts.workspaceRoot,
      project: job.project,
      onLine: log,
      signal: this.currentAbort?.signal,
    });
  };

  start(): void {
    this.stopping = false;
    this.loopPromise = this.loop();
  }

  // Aborts the in-flight job (if any) and reports it fail+requeue before resolving. Does not wait
  // for the poll loop or the executor's own promise to settle — for an injected `execute` that never
  // resolves (as in tests, and as a stuck real command can appear before its process actually dies),
  // that promise may never come back, so this resolves independently of it.
  async stop(): Promise<void> {
    this.stopping = true;
    this.currentAbort?.abort();
    if (this.inFlightJobId !== undefined && !this.inFlightReported) {
      this.inFlightReported = true;
      await this.logChain;
      await this.reportFail(this.inFlightJobId, 'daemon stopping', true);
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      if (this.inFlightJobId === undefined) {
        const job = await this.tryClaim();
        if (job && !this.stopping) await this.runJob(job);
      }
      if (this.stopping) return;
      await sleep(this.opts.claimIntervalMs);
    }
  }

  private async tryClaim(): Promise<Job | null> {
    try {
      const res = await fetch(`${this.opts.hub}/api/jobs/claim`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ node: this.opts.node, types: this.opts.types }),
      });
      if (res.status === 204) return null; // nothing to claim right now
      if (res.status === 403) {
        if (!this.warned403) {
          this.warned403 = true;
          console.error("[job-runner] claim refused: node jobTypes don't cover requested types");
        }
        return null;
      }
      if (res.status === 404) {
        if (!this.warned404) {
          this.warned404 = true;
          console.error('[job-runner] hub doesn\'t know this node yet');
        }
        return null;
      }
      if (!res.ok) return null; // other hub errors (5xx); retry next tick
      return (await res.json()) as Job;
    } catch {
      return null; // hub unreachable; retry next tick
    }
  }

  private async runJob(job: Job): Promise<void> {
    this.inFlightJobId = job.id;
    this.inFlightReported = false;
    this.currentAbort = new AbortController();
    const log = (line: string) => { this.postLog(job.id, line); };

    let outcome: { ok: true; result: JobResult } | { ok: false; error: string; requeue: boolean };
    try {
      const result = await this.execute(job, log);
      outcome = result.exitCode === 0
        ? { ok: true, result }
        : { ok: false, error: describeFailure(result), requeue: true };
    } catch (err) {
      if (err instanceof UnsupportedJobTypeError) outcome = { ok: false, error: err.message, requeue: false };
      else if (err instanceof InvalidPayloadError) outcome = { ok: false, error: err.message, requeue: false };
      else outcome = { ok: false, error: err instanceof Error ? err.message : String(err), requeue: true };
    }

    if (this.inFlightReported) {
      // stop() already reported this job (fail+requeue) while we were awaiting the executor.
      this.inFlightJobId = undefined;
      this.currentAbort = undefined;
      return;
    }
    this.inFlightReported = true;
    await this.logChain;
    if (outcome.ok) await this.reportComplete(job.id, outcome.result);
    else await this.reportFail(job.id, outcome.error, outcome.requeue);
    this.inFlightJobId = undefined;
    this.currentAbort = undefined;
  }

  // Chains log posts behind a single promise so lines are delivered to the hub in order, with only
  // one request in flight at a time, instead of racing concurrent fetches.
  private postLog(jobId: number, line: string): void {
    this.logChain = this.logChain.then(() => this.sendLog(jobId, line));
  }

  private async sendLog(jobId: number, line: string): Promise<void> {
    try {
      await fetch(`${this.opts.hub}/api/jobs/${jobId}/log`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ line }),
      });
    } catch { /* best effort */ }
  }

  private reportComplete(jobId: number, result: JobResult): Promise<void> {
    return this.reportWithRetry(() => fetch(`${this.opts.hub}/api/jobs/${jobId}/complete`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ result }),
    }));
  }

  private reportFail(jobId: number, error: string, requeue: boolean): Promise<void> {
    return this.reportWithRetry(() => fetch(`${this.opts.hub}/api/jobs/${jobId}/fail`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error, requeue }),
    }));
  }

  private async reportWithRetry(send: () => Promise<Response>): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await send();
        if (res.ok) return;
      } catch { /* retry */ }
      if (attempt < 3) await sleep(500);
    }
    console.error('[job-runner] failed to report job outcome to hub after 3 attempts');
  }
}

function describeFailure(result: JobResult): string {
  if (result.timedOut) return 'timeout';
  if (result.signal === 'aborted') return 'aborted';
  if (result.exitCode !== undefined) return `exit ${result.exitCode}`;
  if (result.signal) return result.signal;
  return 'unknown failure';
}
