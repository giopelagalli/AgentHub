import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { JobResult, ShellTaskPayload } from '@agenthub/shared';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const TAIL_LENGTH = 2000;

export function resolveWorkspace(root: string, project: string | undefined, cwd: string | undefined): string {
  const rootResolved = resolve(root);
  const target = resolve(rootResolved, project ?? '_default', cwd ?? '.');
  const rel = relative(rootResolved, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('cwd escapes workspace');
  return target;
}

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
  mkdirSync(cwd, { recursive: true });

  return new Promise<JobResult>((resolvePromise, reject) => {
    const [cmd, ...args] = payload.cmd;
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...payload.env } });

    let settled = false;
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const stdoutSplitter = lineSplitter('out', opts.onLine);
    const stderrSplitter = lineSplitter('err', opts.onLine);

    const timeoutMs = payload.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);

    const onAbort = () => child.kill('SIGKILL');
    opts.signal?.addEventListener('abort', onAbort);

    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); stdoutSplitter.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); stderrSplitter.push(chunk); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      stdoutSplitter.flush();
      stderrSplitter.flush();
      // A killed process (timeout, or an aborted signal) reports `code: null` from Node; JobResult's
      // `exitCode` field only admits `number | undefined`, so we normalize that to `undefined` here.
      // The runner treats a missing exitCode the same as any non-zero exit: a failure to report.
      resolvePromise({
        exitCode: code ?? undefined,
        stdoutTail: stdout.slice(-TAIL_LENGTH),
        stderrTail: timedOut ? `${stderr}\ntimeout`.slice(-TAIL_LENGTH) : stderr.slice(-TAIL_LENGTH),
      });
    });
  });
}
