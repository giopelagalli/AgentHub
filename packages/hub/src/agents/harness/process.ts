import { spawn } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { clip } from '../loop.js';

/**
 * How the hub runs an external harness CLI (pi, claude): one sandboxed subprocess in its own
 * process group, a JSON-Lines event stream on stdout, stderr into the run's log — bounded by a wall
 * clock and the turn's abort signal, and stoppable early by the adapter (its tool-call budget).
 * The adapters own what the events mean; this owns the process.
 */

/** How long output still arriving after the CLI's exit is given to land before the run is settled. */
const DRAIN_MS = 200;
/** How long a terminated process group gets before SIGKILL. */
const KILL_ESCALATION_MS = 5000;
/** How much of one stderr or unparsable line reaches the session's event log. */
const LINE_LIMIT = 200;

export interface StreamRunOptions {
  /** The CLI's name in log lines and notes: `pi`, `claude`. */
  name: string;
  /** Already wrapped in the sandbox. */
  command: { cmd: string; args: string[] };
  cwd: string;
  env: NodeJS.ProcessEnv;
  wallClockMs: number;
  signal?: AbortSignal;
  /** One parsed stdout line. `exhaust(why)` ends the run as `budget-exhausted`. Never called after settling. */
  onEvent: (event: unknown, exhaust: (why: string) => void) => void;
  /** A line for the job log and the session's events. */
  record: (line: string) => void;
}

export interface StreamRunEnd {
  /** Set when the run was ended here rather than by the CLI itself. */
  stopped?: 'aborted' | 'budget-exhausted';
  /** Why it was stopped, or why it failed to start — for the session's event log. */
  note?: string;
  /** The CLI's exit code; null when a signal ended it. */
  code: number | null;
  /** Set when the CLI could not be spawned at all. */
  startError?: string;
}

/**
 * One CLI process, start to finish. Resolves rather than rejects: a CLI that will not start is a
 * `startError`, and the adapter turns that into an `error` outcome the way a gateway failure is one
 * for the loop.
 */
export function runJsonStream(o: StreamRunOptions): Promise<StreamRunEnd> {
  return new Promise<StreamRunEnd>((settle) => {
    // detached: true makes the CLI its own process-group leader, so an abort can take down the whole
    // tree — a `bash` tool spawns children of its own that a plain child.kill would leave behind.
    // `sandbox-exec` execs the CLI in place, so the group is the CLI's; `bwrap --new-session` puts it
    // in a session of its own, and killing bwrap takes the sandbox's whole pid namespace with it.
    //
    // stdin is ignored, not piped: pi and claude both accept a piped-in prompt, so an open stdin with
    // neither data nor EOF makes even `-p` wait forever. An ignored stdin is the EOF they wait for.
    const child = spawn(o.command.cmd, o.command.args, { cwd: o.cwd, env: o.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });

    let stopped: StreamRunEnd['stopped'];
    let note: string | undefined;
    let done = false;

    // Re-probed right before escalating: a group id is a pid, pids get reused once freed, and
    // enough time passes between deciding to kill and sending SIGKILL for it to be someone else's.
    const groupAlive = (): boolean => {
      if (child.pid === undefined) return false;
      try { process.kill(-child.pid, 0); return true; } catch { return false; }
    };
    const killGroup = (sig: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      if (sig === 'SIGKILL' && !groupAlive()) return;
      try { process.kill(-child.pid, sig); } catch { /* already gone */ }
    };
    const terminate = (): void => {
      killGroup('SIGTERM');
      const escalate = setTimeout(() => killGroup('SIGKILL'), KILL_ESCALATION_MS);
      escalate.unref?.();
    };
    const stop = (reason: 'aborted' | 'budget-exhausted', why: string): void => {
      if (stopped) return;
      stopped = reason;
      note = why;
      terminate();
    };
    const exhaust = (why: string): void => stop('budget-exhausted', why);

    const timer = setTimeout(
      () => exhaust(`${o.name} ran past its ${o.wallClockMs}ms wall clock without reporting`),
      o.wallClockMs,
    );
    const onAbort = (): void => stop('aborted', `${o.name} was stopped with the turn`);
    o.signal?.addEventListener('abort', onAbort);
    if (o.signal?.aborted) onAbort();

    const lines = jsonLines(
      (event) => { if (!done) o.onEvent(event, exhaust); },
      (bad) => o.record(`${o.name}: unparsable event line: ${clip(bad, LINE_LIMIT)}`),
    );
    child.stdout.on('data', (chunk: Buffer) => lines.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) if (line.trim()) o.record(`${o.name}: ${clip(line.trim(), LINE_LIMIT)}`);
    });

    const finish = (end: StreamRunEnd): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      // The CLI has exited, but whatever its `bash` backgrounded is still in its group and must not
      // outlive the run — whatever the outcome.
      if (groupAlive()) terminate();
      settle({ ...end, ...(stopped ? { stopped } : {}), ...(note ? { note } : {}) });
    };

    child.on('error', (err) => {
      note = `${o.name} failed to start: ${err.message}`;
      finish({ code: null, startError: err.message });
    });
    // Settled on 'exit' plus a short drain rather than on 'close': a killed CLI that left a
    // backgrounded grandchild holding the inherited pipes open may never emit 'close', and the
    // final event — the report itself — routinely lands in the last chunk after 'exit'.
    child.on('exit', (code) => {
      const drain = setTimeout(() => {
        lines.flush();
        finish({ code });
      }, DRAIN_MS);
      drain.unref?.();
    });
  });
}

/** `path` as a workspace-relative path, or null when it points outside the workspace. */
export function insideWorkspace(workspace: string, path: unknown): string | null {
  if (typeof path !== 'string' || !path) return null;
  const full = isAbsolute(path) ? path : resolve(workspace, path);
  const rel = relative(resolve(workspace), full);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/**
 * A JSON Lines reader that splits on LF and nothing else. pi's own protocol note is explicit about
 * this: a generic line reader that also breaks on U+2028/U+2029 would cut a record in half whenever
 * one of those characters appears inside a JSON string, which a file the agent read may well carry.
 */
function jsonLines(onEvent: (e: unknown) => void, onBad: (line: string) => void) {
  let buf = '';
  const take = (line: string): void => {
    const text = line.replace(/\r$/, '').trim();
    if (!text) return;
    try {
      onEvent(JSON.parse(text));
    } catch {
      onBad(text);
    }
  };
  return {
    push(chunk: Buffer): void {
      buf += chunk.toString();
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const part of parts) take(part);
    },
    flush(): void {
      const rest = buf;
      buf = '';
      take(rest);
    },
  };
}
