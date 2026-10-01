import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { TokenUsage, TurnEvent } from '@agenthub/shared';
import { secretsStripped } from '@agenthub/shared/shell';
import type { ApiTokens, MintedApiToken } from '../../door.js';
import { ADMIN_USER } from '../../enrollment.js';
import { costUsd, priceFor } from '../../providers/fireworks.js';
import { piSubagentPrompt } from '../../projects/prompts.js';
import { clip } from '../loop.js';
import type { SessionOutcome, Transcript } from '../transcript.js';
import type { Harness, HarnessContext, HarnessResult, HarnessTask, HarnessToolPolicy } from './index.js';

/** Same caps the built-in loop puts on a live event: a glance, not the transcript. */
const EVENT_TEXT_LIMIT = 300;
const EVENT_SUMMARY_LIMIT = 200;
/** How long output still arriving after pi's exit is given to land before the run is settled. */
const DRAIN_MS = 200;
/** How long a terminated process group gets before SIGKILL. */
const KILL_ESCALATION_MS = 5000;

/** The provider name pi is told to use; only ever defined in the per-run config this adapter writes. */
const PROVIDER = 'agenthub';
/** The env var the per-run config names for the door's bearer; the value is passed in pi's env. */
const API_KEY_ENV = 'AGENTHUB_HARNESS_KEY';
/** The door's tier name for the worker: routing stays the gateway's call, as for any door client. */
const WORKER_MODEL = 'agenthub/worker';
/** How much of one stderr line reaches the session's event log. */
const STDERR_LINE_LIMIT = 200;
/** The longest token label the door accepts (`MAX_LABEL_LENGTH`). */
const TOKEN_LABEL_LIMIT = 64;

/**
 * pi's built-in tools, by policy. `bash` is what makes the workspace-writing set useful and is also
 * the reason pi cannot be contained to the workspace (decision 0049): the read-only set exists for
 * the day a reviewer may run here, and is the set FR-G4 asks for.
 */
const TOOLS: Record<HarnessToolPolicy, string> = {
  workspace: 'read,edit,write,bash,grep,find,ls',
  'read-only': 'read,grep,find,ls',
};
/** pi tool names whose `path` argument names a file the run created or changed. */
const WRITING_TOOLS = new Set(['write', 'edit']);

export interface PiHarnessDeps {
  /** The pi executable, from `piBinary()`. */
  bin: string;
  transcript: Transcript;
  /** The hub's door, already resolved to the base it is listening on (decision 0050). */
  door: { base: string; tokens: ApiTokens };
  onBusy?: (busy: boolean) => void;
}

// --- pi's JSON event stream (`--mode json`) ----------------------------------
// Only the fields this adapter reads. The stream is JSON Lines on stdout, LF-delimited, starting
// with a `session` header; see pi's docs/json.md and the shapes verified in decision 0049.

interface PiTextBlock { type: 'text'; text: string }
interface PiContentBlock { type: string; text?: string }
interface PiUsage { input?: number; output?: number; cacheRead?: number }
interface PiMessage { role?: string; content?: PiContentBlock[] | string; usage?: PiUsage; errorMessage?: string }
type PiEvent =
  | { type: 'message_end'; message?: PiMessage }
  | { type: 'tool_execution_start'; toolCallId?: string; toolName?: string; args?: Record<string, unknown> }
  | { type: 'tool_execution_end'; toolCallId?: string; toolName?: string; result?: { content?: PiContentBlock[] }; isError?: boolean }
  | { type: string };

const isTextBlock = (b: PiContentBlock): b is PiTextBlock => b.type === 'text' && typeof b.text === 'string';

/** The plain text of a pi message — its text blocks joined; tool calls contribute nothing. */
function messageText(message: PiMessage | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  return (message.content ?? []).filter(isTextBlock).map((b) => b.text).join('');
}

/** A tool result's text, which is what the turn feed summarises. */
const resultText = (blocks: PiContentBlock[] | undefined): string =>
  (blocks ?? []).filter(isTextBlock).map((b) => b.text).join('');

/**
 * The models.json pi reads out of `PI_CODING_AGENT_DIR`: one provider, one model, pointed at the
 * hub's own door. `apiKey` names an environment variable rather than holding the token, so the
 * token never lands on disk — pi resolves the name against its own environment.
 *
 * The `compat` flags keep pi to the plainest OpenAI wire shape: the door maps `developer` to
 * `system` itself, and forwards no `reasoning_effort` to whichever endpoint serves the call.
 */
function modelsConfig(base: string, model: string): string {
  return JSON.stringify({
    providers: {
      [PROVIDER]: {
        baseUrl: `${base}/v1`,
        api: 'openai-completions',
        apiKey: API_KEY_ENV,
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        // Prices stay zero: the hub prices the tokens itself from its own table, so pi's numbers
        // would only be a second, disagreeing answer.
        models: [{
          id: model,
          name: model,
          reasoning: false,
          input: ['text'],
          contextWindow: 128_000,
          maxTokens: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  }, null, 2);
}

/** `path` as a workspace-relative path, or null when it points outside the workspace. */
function insideWorkspace(workspace: string, path: unknown): string | null {
  if (typeof path !== 'string' || !path) return null;
  const full = isAbsolute(path) ? path : resolve(workspace, path);
  const rel = relative(resolve(workspace), full);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/**
 * pi (pi.dev) run as a subprocess in the project workspace, its JSON event stream mapped onto the
 * hub's `TurnEvent`s so the Activity feed looks the same as a built-in run's (FR-G2).
 *
 * What this adapter owns and pi does not: the transcript session (pi's own `--no-session` is off,
 * so nothing is written to the host's ~/.pi), the tool-call budget (pi has no call limit, so the
 * count is enforced here by killing the run at the cap), the wall-clock backstop, and the
 * process-group kill an abort needs.
 */
export function piHarness(deps: PiHarnessDeps): Harness {
  return {
    kind: 'pi',
    async run(task: HarnessTask, ctx: HarnessContext): Promise<HarnessResult> {
      const system = piSubagentPrompt(task.role, task.instructions);
      const sessionId = deps.transcript.startSession(
        'subagent', ctx.subject, 'worker', task.member ? { memberId: task.member.id } : {},
      );
      if (task.member) deps.onBusy?.(true);
      // Persisted under this run's own session and forwarded to the caller's sink, exactly as the
      // built-in loop does it — so a pi run replays in the employee drawer like any other.
      const emit = (e: TurnEvent): void => {
        deps.transcript.appendTurnEvent(sessionId, e, Date.now());
        ctx.onEvent?.(e);
      };
      deps.transcript.append(sessionId, { role: 'system', content: system });
      deps.transcript.append(sessionId, { role: 'user', content: task.task });
      // `ctx.log` goes nowhere in production, so what is worth reading later goes to the session too.
      const record = (line: string): void => {
        ctx.log(line);
        deps.transcript.appendEvent(sessionId, line);
      };
      // The member's concrete model when the route names one, else the door's worker tier.
      const model = task.route?.model ?? WORKER_MODEL;

      let token: MintedApiToken | undefined;
      let configDir: string | undefined;
      try {
        let workspace: string;
        try {
          // One `agent` token per run, revoked below: it is the only credential pi is given.
          token = deps.door.tokens.mint(ADMIN_USER, 'agent', clip(`pi:${ctx.subject}/${ctx.who}`, TOKEN_LABEL_LIMIT));
          configDir = await mkdtemp(join(tmpdir(), 'agenthub-pi-'));
          await writeFile(join(configDir, 'models.json'), modelsConfig(deps.door.base, model), 'utf8');
          // Resolved once, so a workspace behind a symlink (macOS's /var) still contains pi's paths.
          workspace = await realpath(task.workspace);
        } catch (err) {
          const why = `the pi harness could not start: ${(err as Error).message}`;
          deps.transcript.appendEvent(sessionId, why);
          deps.transcript.endSession(sessionId, 'error');
          return { report: why, filesWritten: [], outcome: 'error', sessionId, toolCalls: 0 };
        }
        const run = await spawnPi(deps.bin, { configDir, workspace, model, key: token.token }, system, task, ctx, emit, record);
        const report = run.report.trim();
        if (report) deps.transcript.append(sessionId, { role: 'assistant', content: report });
        if (run.note) deps.transcript.appendEvent(sessionId, run.note);
        deps.transcript.endSession(sessionId, run.outcome);
        return {
          report,
          filesWritten: run.filesWritten,
          outcome: run.outcome,
          sessionId,
          toolCalls: run.toolCalls,
          ...(run.lastTool ? { lastTool: run.lastTool } : {}),
        };
      } finally {
        if (task.member) deps.onBusy?.(false);
        if (token) deps.door.tokens.revoke(token.id, ADMIN_USER);
        if (configDir) await rm(configDir, { recursive: true, force: true });
      }
    },
  };
}

interface PiRun {
  report: string;
  filesWritten: string[];
  outcome: SessionOutcome;
  toolCalls: number;
  lastTool?: string;
  /** A line for the session's event log when the run ended for a reason worth recording. */
  note?: string;
}

/**
 * One pi process, start to finish. Resolves rather than rejects: a pi that will not start is an
 * `error` outcome with the reason in the report, the same as a gateway failure is for the loop.
 */
function spawnPi(
  bin: string, setup: { configDir: string; workspace: string; model: string; key: string }, system: string,
  task: HarnessTask, ctx: HarnessContext, emit: (e: TurnEvent) => void, record: (line: string) => void,
): Promise<PiRun> {
  const args = [
    '-p', '--mode', 'json',
    '--model', `${PROVIDER}/${setup.model}`,
    '--append-system-prompt', system,
    // Thinking is off for workers (decision 0008), and the host's own pi extensions, skills and
    // prompt templates must not leak into a project's run.
    '--thinking', 'off',
    '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates',
    '--tools', TOOLS[task.tools],
    task.task,
  ];
  // The run's door token is the one credential added back to the stripped environment, under the
  // name the per-run models.json points at — never on the command line, where it would be visible
  // in the workspace's own process list.
  const env: NodeJS.ProcessEnv = {
    ...secretsStripped(),
    PI_CODING_AGENT_DIR: setup.configDir,
    PI_OFFLINE: '1',
    [API_KEY_ENV]: setup.key,
  };
  // Only a concrete cloud model can be priced here; for the worker tier the door alone knows what
  // served each call, and its ledger row is the priced record.
  const price = task.route?.model && task.route.provider ? priceFor(task.route.provider, task.route.model) : null;

  return new Promise<PiRun>((settle) => {
    // detached: true makes pi its own process-group leader, so an abort can take down the whole
    // tree — pi's `bash` tool spawns children of its own that a plain child.kill would leave behind.
    //
    // stdin is ignored, not piped: pi accepts a piped-in prompt, so an open stdin with neither data
    // nor EOF makes even `-p` wait forever. Nothing here ever writes to it, and an ignored stdin is
    // the EOF it is waiting for.
    const child = spawn(bin, args, { cwd: task.workspace, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });

    const filesWritten: string[] = [];
    const pending = new Map<string, { tool: string; args: Record<string, unknown>; at: number }>();
    let report = '';
    let toolCalls = 0;
    let lastTool: string | undefined;
    let stopped: 'aborted' | 'budget-exhausted' | null = null;
    let note: string | undefined;
    let failure = '';
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

    const timer = setTimeout(
      () => stop('budget-exhausted', `pi ran past its ${task.budget.wallClockMs}ms wall clock without reporting`),
      task.budget.wallClockMs,
    );
    const onAbort = (): void => stop('aborted', 'pi was stopped with the turn');
    task.signal?.addEventListener('abort', onAbort);
    if (task.signal?.aborted) onAbort();

    const onEvent = (event: PiEvent): void => {
      if (done) return;
      if (event.type === 'tool_execution_start') {
        const e = event as Extract<PiEvent, { type: 'tool_execution_start' }>;
        const tool = e.toolName ?? 'tool';
        const args = e.args ?? {};
        pending.set(e.toolCallId ?? '', { tool, args, at: Date.now() });
        toolCalls++;
        lastTool = tool;
        emit({ kind: 'tool-call', who: ctx.who, tool, args: clip(JSON.stringify(args), EVENT_SUMMARY_LIMIT) });
        // pi has no tool-call limit of its own, so the budget is enforced by stopping the process
        // the moment it goes past — the call already in flight is allowed to finish.
        if (toolCalls >= task.budget.toolCalls) {
          stop('budget-exhausted', `pi reached its tool call budget of ${task.budget.toolCalls}`);
        }
        return;
      }
      if (event.type === 'tool_execution_end') {
        const e = event as Extract<PiEvent, { type: 'tool_execution_end' }>;
        const started = pending.get(e.toolCallId ?? '');
        pending.delete(e.toolCallId ?? '');
        const tool = e.toolName ?? started?.tool ?? 'tool';
        const text = resultText(e.result?.content);
        emit({
          kind: 'tool-result', who: ctx.who, tool, ok: !e.isError,
          summary: clip(text, EVENT_SUMMARY_LIMIT), ms: started ? Date.now() - started.at : 0,
        });
        if (!e.isError && WRITING_TOOLS.has(tool)) {
          const rel = insideWorkspace(setup.workspace, started?.args.path);
          if (rel) { if (!filesWritten.includes(rel)) filesWritten.push(rel); }
          else if (started) record(`pi wrote outside the workspace: ${clip(String(started.args.path), STDERR_LINE_LIMIT)}`);
        }
        return;
      }
      if (event.type === 'message_end') {
        const { message } = event as Extract<PiEvent, { type: 'message_end' }>;
        if (message?.role !== 'assistant') return;
        const text = messageText(message).trim();
        if (text) {
          report = text;
          emit({ kind: 'text', who: ctx.who, text: clip(text, EVENT_TEXT_LIMIT) });
        }
        if (message.errorMessage) failure = message.errorMessage;
        const usage = tokensOf(message.usage);
        if (usage) {
          emit({
            kind: 'usage', who: ctx.who,
            usd: costUsd(price, usage),
            tokens: usage.promptTokens + usage.completionTokens,
          });
        }
      }
    };

    const lines = jsonLines(onEvent, (bad) => record(`pi: unparsable event line: ${clip(bad, STDERR_LINE_LIMIT)}`));
    child.stdout.on('data', (chunk: Buffer) => lines.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) if (line.trim()) record(`pi: ${clip(line.trim(), STDERR_LINE_LIMIT)}`);
    });

    const finish = (outcome: SessionOutcome, fallbackReport = ''): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      task.signal?.removeEventListener('abort', onAbort);
      settle({
        report: report || fallbackReport,
        filesWritten, outcome, toolCalls,
        ...(lastTool ? { lastTool } : {}),
        ...(note ? { note } : {}),
      });
    };

    child.on('error', (err) => {
      note = `pi failed to start: ${err.message}`;
      finish('error', `the pi harness could not start: ${err.message}`);
    });
    // Settled on 'exit' plus a short drain rather than on 'close': a killed pi that left a
    // backgrounded grandchild holding the inherited pipes open may never emit 'close', and the
    // final `message_end` — the report itself — routinely lands in the last chunk after 'exit'.
    child.on('exit', (code) => {
      const drain = setTimeout(() => {
        lines.flush();
        if (stopped) return finish(stopped);
        if (code === 0 && !failure) return finish('stop');
        const why = failure || `pi exited with code ${code}`;
        note = why;
        finish('error', `the pi harness ended without a report: ${why}`);
      }, DRAIN_MS);
      drain.unref?.();
    });
  });
}

/** pi's token counts as the hub's, or undefined when the message carried none. */
function tokensOf(usage: PiUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
  const tokens = { promptTokens: n(usage.input), cachedTokens: n(usage.cacheRead), completionTokens: n(usage.output) };
  return tokens.promptTokens || tokens.completionTokens ? tokens : undefined;
}

/**
 * A JSON Lines reader that splits on LF and nothing else. pi's own protocol note is explicit about
 * this: a generic line reader that also breaks on U+2028/U+2029 would cut a record in half whenever
 * one of those characters appears inside a JSON string, which a file the agent read may well carry.
 */
function jsonLines(onEvent: (e: PiEvent) => void, onBad: (line: string) => void) {
  let buf = '';
  const take = (line: string): void => {
    const text = line.replace(/\r$/, '').trim();
    if (!text) return;
    try {
      onEvent(JSON.parse(text) as PiEvent);
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
