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

const MAX_LOG_QUEUE = 500;

export interface JobRunnerOptions {
  hub: string;
  node: string;
  types: JobType[];
  workspaceRoot: string;
  claimIntervalMs: number;
  execute?: Execute;
  // Called each time the hub returns 404 from /api/jobs/claim (it doesn't know this node) — lets the
  // daemon re-register itself after e.g. a hub restart.
  onNodeNotFound?: () => void;
}

export class JobRunner {
  private readonly execute: Execute;
  private stopping = false;
  private loopPromise?: Promise<void>;
  private currentAbort?: AbortController;
  private inFlightJobId?: number;
  private inFlightReported = false;
  private logQueue: { jobId: number; line: string }[] = [];
  private logDraining = false;
  private logDrainDone: Promise<void> = Promise.resolve();
  private droppedLogCount = 0;
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
      await this.flushLogs(this.inFlightJobId);
      await this.reportFail(this.inFlightJobId, 'daemon stopping', true);
    }
  }

  // Waits (bounded by timeoutMs) for the poll loop to actually settle — i.e. for the aborted
  // executor's own promise to resolve, which for a real shell-task means its process group has been
  // signaled and, if it didn't die from SIGTERM, the SIGKILL escalation has fired. stop() itself
  // deliberately doesn't wait for this (see its comment); callers that need the process to actually
  // be gone before proceeding (e.g. Daemon.stop() before the daemon process exits) should await this
  // separately after stop().
  async waitForIdle(timeoutMs: number): Promise<void> {
    if (!this.loopPromise) return;
    await Promise.race([this.loopPromise, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
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
        this.opts.onNodeNotFound?.();
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
    const log = (line: string) => { this.enqueueLog(job.id, line); };

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
    await this.flushLogs(job.id);
    if (outcome.ok) await this.reportComplete(job.id, outcome.result);
    else await this.reportFail(job.id, outcome.error, outcome.requeue);
    this.inFlightJobId = undefined;
    this.currentAbort = undefined;
  }

  // Queues log lines behind a single draining loop so they're delivered to the hub in order, with
  // only one POST in flight at a time. Bounded to MAX_LOG_QUEUE entries: once full, the oldest queued
  // line is dropped and counted so a burst of output can't grow this without limit; the drop count is
  // reported to the hub as one synthetic line (see flushLogs) once draining catches up.
  private enqueueLog(jobId: number, line: string): void {
    if (this.logQueue.length >= MAX_LOG_QUEUE) {
      this.logQueue.shift();
      this.droppedLogCount++;
    }
    this.logQueue.push({ jobId, line });
    this.pumpLogQueue();
  }

  private pumpLogQueue(): void {
    if (this.logDraining) return;
    this.logDraining = true;
    this.logDrainDone = (async () => {
      while (this.logQueue.length > 0) {
        const next = this.logQueue.shift()!;
        await this.sendLog(next.jobId, next.line);
      }
      this.logDraining = false;
    })();
  }

  // Waits for the queue to fully drain, then — if any lines were dropped along the way — enqueues a
  // single synthetic notice and waits for that too. Call before reporting complete/fail so the report
  // is never posted ahead of the job's own log lines.
  private async flushLogs(jobId: number): Promise<void> {
    await this.logDrainDone;
    if (this.droppedLogCount > 0) {
      const n = this.droppedLogCount;
      this.droppedLogCount = 0;
      this.enqueueLog(jobId, `[runner] dropped ${n} log lines`);
      await this.logDrainDone;
    }
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
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ result, node: this.opts.node }),
    }));
  }

  private reportFail(jobId: number, error: string, requeue: boolean): Promise<void> {
    return this.reportWithRetry(() => fetch(`${this.opts.hub}/api/jobs/${jobId}/fail`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error, requeue, node: this.opts.node }),
    }));
  }

  private async reportWithRetry(send: () => Promise<Response>): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await send();
        if (res.ok) return;
        if (res.status === 409) {
          // The hub already reassigned this job to another runner (our report arrived late, e.g.
          // after a sweep requeue). Don't retry — that would just fence again — and stop the local
          // execution instead of letting it keep running unsupervised.
          console.error('[job-runner] job report rejected: not the current runner (409)');
          this.currentAbort?.abort();
          return;
        }
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
