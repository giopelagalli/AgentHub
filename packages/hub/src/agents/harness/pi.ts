import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TokenUsage, TurnEvent } from '@agenthub/shared';
import { secretsStripped } from '@agenthub/shared/shell';
import { harnessTokenLabel, type ApiTokens, type MintedApiToken } from '../../door.js';
import { ADMIN_USER } from '../../enrollment.js';
import type { Route } from '../../gateway.js';
import { costUsd, priceFor } from '../../providers/fireworks.js';
import { piSubagentPrompt } from '../../projects/prompts.js';
import { clip } from '../loop.js';
import type { SessionOutcome, Transcript } from '../transcript.js';
import type { Harness, HarnessContext, HarnessResult, HarnessTask, HarnessToolPolicy } from './index.js';
import { insideWorkspace, runJsonStream } from './process.js';
import { doorOf, hiddenPaths, hostSecrets, sandboxedCommand, serveDoorSocket } from './sandbox.js';

/** Same caps the built-in loop puts on a live event: a glance, not the transcript. */
const EVENT_TEXT_LIMIT = 300;
const EVENT_SUMMARY_LIMIT = 200;

/** The provider name pi is told to use; only ever defined in the per-run config this adapter writes. */
const PROVIDER = 'agenthub';
/** The env var the per-run config names for the door's bearer; the value is passed in pi's env. */
const API_KEY_ENV = 'AGENTHUB_HARNESS_KEY';
/** The door's tier name for the worker: routing stays the gateway's call, as for any door client. */
const WORKER_MODEL = 'agenthub/worker';
/**
 * The model pi asks the door for, carrying the run's route the way `gateway.chat` would have honoured
 * it (decision 0050). `local` is `@local` whatever model is named, because the gateway only ever
 * applies a named model to a cloud endpoint; `cloud` asks for the named model, else the provider,
 * else any cloud. `auto` is the plain tier name: a named model or provider there only shapes the
 * cloud fallback, which the door cannot express, and sending either would put the cloud first.
 */
export function doorModel(route: Route | undefined): string {
  if (route?.prefer === 'local') return `${WORKER_MODEL}@local`;
  if (route?.prefer === 'cloud') return route.model ?? `${WORKER_MODEL}@${route.provider ?? 'cloud'}`;
  return WORKER_MODEL;
}

/** How much of one stderr line reaches the session's event log. */
const STDERR_LINE_LIMIT = 200;

/**
 * pi's built-in tools, by policy. `bash` is what makes the workspace-writing set useful; pi itself
 * cannot contain it (decision 0049), so the whole process runs in an OS sandbox (decision 0055).
 * The read-only set is what the reviewer runs with, and is the set FR-G4 asks for.
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
      const model = doorModel(task.route);

      let token: MintedApiToken | undefined;
      let configDir: string | undefined;
      let bridge: { close: () => Promise<void> } | undefined;
      try {
        let workspace: string;
        let command: { cmd: string; args: string[] };
        try {
          // One `agent` token per run, revoked below: it is the only credential pi is given.
          token = deps.door.tokens.mint(ADMIN_USER, 'agent', harnessTokenLabel(ctx.subject, task.member?.id));
          // Resolved like the workspace: the sandbox matches real paths, and macOS's tmpdir is a symlink.
          configDir = await realpath(await mkdtemp(join(tmpdir(), 'agenthub-pi-')));
          await writeFile(join(configDir, 'models.json'), modelsConfig(deps.door.base, model), 'utf8');
          // Resolved once, so a workspace behind a symlink (macOS's /var) still contains pi's paths.
          workspace = await realpath(task.workspace);
          // pi only ever runs sandboxed (decision 0055): the workspace (unless the policy is read-only)
          // and its own config dir are the only places it may write, the hub's secrets and other
          // projects are unreadable, and the door is the only address it may reach.
          const door = doorOf(deps.door.base);
          const wrapped = sandboxedCommand(process.platform, {
            workspace, tmpDir: configDir, door, writableWorkspace: task.tools === 'workspace',
            ...hiddenPaths(hostSecrets(), workspace),
            argv: [deps.bin, ...piArgs(model, system, task)],
          });
          if ('unavailable' in wrapped) throw new Error(wrapped.unavailable);
          if (wrapped.doorSocket) bridge = await serveDoorSocket(wrapped.doorSocket, door);
          command = wrapped;
        } catch (err) {
          const why = `the pi harness could not start: ${(err as Error).message}`;
          deps.transcript.appendEvent(sessionId, why);
          deps.transcript.endSession(sessionId, 'error');
          return { report: why, filesWritten: [], outcome: 'error', sessionId, toolCalls: 0 };
        }
        const run = await spawnPi(command, { configDir, workspace, model, key: token.token }, task, ctx, emit, record);
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
        await bridge?.close();
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

/** pi's own command line, after the binary. */
function piArgs(model: string, system: string, task: HarnessTask): string[] {
  return [
    '-p', '--mode', 'json',
    '--model', `${PROVIDER}/${model}`,
    '--append-system-prompt', system,
    // Thinking is off for workers (decision 0008), and the host's own pi extensions, skills and
    // prompt templates must not leak into a project's run.
    '--thinking', 'off',
    '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates',
    '--tools', TOOLS[task.tools],
    task.task,
  ];
}

/**
 * One pi process, start to finish, as the sandboxed `command`. Resolves rather than rejects: a pi
 * that will not start is an `error` outcome with the reason in the report, the same as a gateway
 * failure is for the loop.
 */
async function spawnPi(
  command: { cmd: string; args: string[] }, setup: { configDir: string; workspace: string; model: string; key: string },
  task: HarnessTask, ctx: HarnessContext, emit: (e: TurnEvent) => void, record: (line: string) => void,
): Promise<PiRun> {
  // The run's door token is the one credential added back to the stripped environment, under the
  // name the per-run models.json points at — never on the command line, where it would be visible
  // in the workspace's own process list.
  const env: NodeJS.ProcessEnv = {
    ...secretsStripped(),
    PI_CODING_AGENT_DIR: setup.configDir,
    PI_OFFLINE: '1',
    // The config dir is the one writable place besides the workspace, so scratch files go there too.
    TMPDIR: setup.configDir,
    npm_config_cache: join(setup.configDir, 'npm'),
    [API_KEY_ENV]: setup.key,
  };
  // Only a concrete cloud model can be priced here; for a tier name the door alone knows what
  // served each call, and its ledger row is the priced record.
  const named = task.route?.model === setup.model ? task.route : undefined;
  const price = named?.model && named.provider ? priceFor(named.provider, named.model) : null;

  const filesWritten: string[] = [];
  const pending = new Map<string, { tool: string; args: Record<string, unknown>; at: number }>();
  let report = '';
  let toolCalls = 0;
  let lastTool: string | undefined;
  let failure = '';

  const onEvent = (event: PiEvent, exhaust: (why: string) => void): void => {
    if (event.type === 'tool_execution_start') {
      const e = event as Extract<PiEvent, { type: 'tool_execution_start' }>;
      const tool = e.toolName ?? 'tool';
      const args = e.args ?? {};
      pending.set(e.toolCallId ?? '', { tool, args, at: Date.now() });
      toolCalls++;
      lastTool = tool;
      emit({ kind: 'tool-call', who: ctx.who, tool, args: clip(JSON.stringify(args), EVENT_SUMMARY_LIMIT) });
      // pi has no tool-call limit of its own, so the budget is enforced by stopping the process
      // at the first call past it: every call within the budget runs, as in the built-in loop.
      if (toolCalls > task.budget.toolCalls) exhaust(`pi went past its tool call budget of ${task.budget.toolCalls}`);
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

  const end = await runJsonStream({
    name: 'pi', command, cwd: task.workspace, env, wallClockMs: task.budget.wallClockMs,
    ...(task.signal ? { signal: task.signal } : {}),
    onEvent: (e, exhaust) => onEvent(e as PiEvent, exhaust),
    record,
  });
  const ran = { filesWritten, toolCalls, ...(lastTool ? { lastTool } : {}) };
  if (end.startError) {
    return { ...ran, report: report || `the pi harness could not start: ${end.startError}`, outcome: 'error', ...(end.note ? { note: end.note } : {}) };
  }
  if (end.stopped) return { ...ran, report, outcome: end.stopped, ...(end.note ? { note: end.note } : {}) };
  if (end.code === 0 && !failure) return { ...ran, report, outcome: 'stop' };
  const why = failure || `pi exited with code ${end.code}`;
  return { ...ran, report: report || `the pi harness ended without a report: ${why}`, outcome: 'error', note: why };
}

/** pi's token counts as the hub's, or undefined when the message carried none. */
function tokensOf(usage: PiUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
  const tokens = { promptTokens: n(usage.input), cachedTokens: n(usage.cacheRead), completionTokens: n(usage.output) };
  return tokens.promptTokens || tokens.completionTokens ? tokens : undefined;
}
