import type { Job, JobResult, JobType, ShellTaskPayload } from '@agenthub/shared';
import { runShellTask } from './shell-task.js';

type Execute = (job: Job, log: (line: string) => void) => Promise<JobResult>;

class UnsupportedJobTypeError extends Error {
  constructor() { super('unsupported job type'); }
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

  constructor(private opts: JobRunnerOptions) {
    this.execute = opts.execute ?? this.defaultExecute;
  }

  private defaultExecute: Execute = (job, log) => {
    if (job.type !== 'shell-task') return Promise.reject(new UnsupportedJobTypeError());
    return runShellTask(job.payload as ShellTaskPayload, {
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
      if (!res.ok) return null; // includes 204 (nothing to claim), 403/404 (registration issue)
      return (await res.json()) as Job;
    } catch {
      return null; // hub unreachable; retry next tick
    }
  }

  private async runJob(job: Job): Promise<void> {
    this.inFlightJobId = job.id;
    this.inFlightReported = false;
    this.currentAbort = new AbortController();
    const log = (line: string) => { void this.postLog(job.id, line); };

    let outcome: { ok: true; result: JobResult } | { ok: false; error: string; requeue: boolean };
    try {
      const result = await this.execute(job, log);
      outcome = result.exitCode === 0
        ? { ok: true, result }
        : { ok: false, error: describeFailure(result), requeue: true };
    } catch (err) {
      outcome = err instanceof UnsupportedJobTypeError
        ? { ok: false, error: err.message, requeue: false }
        : { ok: false, error: err instanceof Error ? err.message : String(err), requeue: true };
    }

    if (this.inFlightReported) {
      // stop() already reported this job (fail+requeue) while we were awaiting the executor.
      this.inFlightJobId = undefined;
      this.currentAbort = undefined;
      return;
    }
    this.inFlightReported = true;
    if (outcome.ok) await this.reportComplete(job.id, outcome.result);
    else await this.reportFail(job.id, outcome.error, outcome.requeue);
    this.inFlightJobId = undefined;
    this.currentAbort = undefined;
  }

  private async postLog(jobId: number, line: string): Promise<void> {
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
  if (result.exitCode === undefined) return 'timeout';
  return `command exited with code ${result.exitCode}`;
}
