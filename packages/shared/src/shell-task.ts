import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { JobResult, ShellTaskPayload } from './index.js';

// Lives in its own entry point (`@agenthub/shared/shell`) rather than the package index: the index is
// bundled into the browser UI, which must not pull in node:child_process.

/**
 * Constant-time string comparison. Both sides are hashed first so the comparison never sees
 * different-length buffers (`timingSafeEqual` throws on those, and the throw itself would leak the
 * length of the secret).
 */
export function safeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Resolves `cwd` inside `<root>/<project>` and refuses anything that escapes it. Note this is a
 * lexical check on the requested path — it scopes where a command starts, it does not contain what
 * the command can then reach.
 */
export function resolveWorkspace(root: string, project: string | undefined, cwd: string | undefined): string {
  const rootResolved = resolve(root);
  const target = resolve(rootResolved, project ?? '_default', cwd ?? '.');
  const rel = relative(rootResolved, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('cwd escapes workspace');
  return target;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const SHELL_TAIL_LENGTH = 2000;
const KILL_ESCALATION_MS = 5000;
const DRAIN_MS = 200;

function lineSplitter(prefix: 'out' | 'err', onLine: (line: string) => void) {
  let buf = '';
  return {
    push(chunk: Buffer): void {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) onLine(`${prefix}: ${line.replace(/\r$/, '')}`);
    },
    flush(): void {
      if (buf) onLine(`${prefix}: ${buf.replace(/\r$/, '')}`);
      buf = '';
    },
  };
}

export async function runShellTask(
  payload: ShellTaskPayload,
  opts: { workspaceRoot: string; project?: string; onLine: (line: string) => void; signal?: AbortSignal },
): Promise<JobResult> {
  const cwd = resolveWorkspace(opts.workspaceRoot, opts.project, payload.cwd);

  if (opts.signal?.aborted) {
    return { exitCode: undefined, stdoutTail: '', stderrTail: '', signal: 'aborted', timedOut: false };
  }

  mkdirSync(cwd, { recursive: true });

  return new Promise<JobResult>((resolvePromise, reject) => {
    const [cmd, ...args] = payload.cmd;
    // detached: true makes the child a new process-group leader (setsid), so its pid doubles as its
    // group id. That lets us kill the whole tree below it — including backgrounded grandchildren a
    // shell command may spawn (`x & sleep 100`, npm scripts, `make -j`) — via a negative-pid signal,
    // rather than only the immediate child.
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...payload.env }, detached: true });

    let settled = false; // the direct child has exited/errored; only guards the promise executor itself
    let resolved = false; // the JobResult has actually been produced; guards further onLine emission
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;

    const stdoutSplitter = lineSplitter('out', opts.onLine);
    const stderrSplitter = lineSplitter('err', opts.onLine);

    const timeoutMs = payload.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Whether the process group still has any members. Used before arming/firing a SIGKILL so we
    // never signal a pgid that has since been recycled by an unrelated process — pids (and thus
    // group ids, since detached:true makes this child's pid double as its pgid) get reused once
    // freed, and enough time can pass between "we decided to kill this group" and "we actually send
    // the signal" for that to happen.
    function groupAlive(): boolean {
      if (child.pid === undefined) return false;
      try { process.kill(-child.pid, 0); return true; } catch { return false; }
    }

    function killGroup(sig: NodeJS.Signals): void {
      if (child.pid === undefined) return;
      if (sig === 'SIGKILL' && !groupAlive()) return; // re-probe right before escalating
      try { process.kill(-child.pid, sig); } catch { /* group already gone (ESRCH) */ }
    }

    // SIGTERM the whole group first. A grandchild that traps SIGTERM (unlike the direct child, which
    // we can observe via 'exit') can outlive it, so the SIGKILL escalation is scheduled independently
    // of the direct child's own lifecycle — it fires on its own timer regardless of whether 'exit' has
    // already happened — and is unref'd so it can't itself keep the process alive. killGroup's own
    // re-probe (above) covers the case where the group died on its own before the timer fires.
    function terminate(): void {
      killGroup('SIGTERM');
      const killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_ESCALATION_MS);
      killTimer.unref?.();
    }

    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    const onAbort = () => { aborted = true; terminate(); };
    opts.signal?.addEventListener('abort', onAbort);

    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };

    const onStdoutData = (chunk: Buffer) => {
      if (resolved) return;
      stdout = (stdout + chunk.toString()).slice(-SHELL_TAIL_LENGTH);
      stdoutSplitter.push(chunk);
    };
    const onStderrData = (chunk: Buffer) => {
      if (resolved) return;
      stderr = (stderr + chunk.toString()).slice(-SHELL_TAIL_LENGTH);
      stderrSplitter.push(chunk);
    };
    child.stdout.on('data', onStdoutData);
    child.stderr.on('data', onStderrData);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });

    // Resolve on 'exit', not 'close': 'close' waits for the stdio pipes to end, but a killed process
    // that left a backgrounded grandchild holding the inherited fds open (`x & sleep 100`, npm
    // scripts, `make -j`) may never emit 'close'. We instead give any still-arriving output a short
    // window to land, then resolve regardless of pipe state.
    child.on('exit', (code, sig) => {
      if (settled) return;
      settled = true;
      cleanup();
      const drainTimer = setTimeout(() => {
        stdoutSplitter.flush();
        stderrSplitter.flush();
        if (timedOut || aborted) {
          // Eager follow-up SIGKILL for the timeout/abort paths: don't wait out the full escalation
          // window when we already know the run didn't end on its own.
          killGroup('SIGKILL');
        } else if (groupAlive()) {
          // Clean exit of the direct child doesn't mean the group is empty — a backgrounded
          // grandchild (`x & sleep 100`, npm scripts, `make -j`) can outlive it. Only signal (and
          // only arm the SIGKILL escalation) when the probe shows the group still has members — the
          // common case is a fully clean exit with nothing left, and arming a 5s kill timer against
          // an empty group risks it firing against a since-recycled, unrelated pgid.
          terminate();
        }
        resolved = true;
        child.stdout.off('data', onStdoutData);
        child.stderr.off('data', onStderrData);
        child.stdout.destroy();
        child.stderr.destroy();
        resolvePromise({
          // A killed process (timeout, or an abort) reports `code: null` from Node; JobResult's
          // `exitCode` field only admits `number | undefined`, so null is normalized to undefined
          // here. The runner treats a missing exitCode the same as any non-zero exit: a failure.
          exitCode: code ?? undefined,
          stdoutTail: stdout,
          stderrTail: stderr,
          signal: aborted ? 'aborted' : (sig ?? undefined),
          timedOut,
        });
      }, DRAIN_MS);
      drainTimer.unref?.();
    });
  });
}
