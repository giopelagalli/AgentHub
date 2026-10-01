import { mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TokenUsage, TurnEvent } from '@agenthub/shared';
import { secretsStripped } from '@agenthub/shared/shell';
import { piSubagentPrompt } from '../../projects/prompts.js';
import { clip, type LoopUsage } from '../loop.js';
import type { Transcript } from '../transcript.js';
import type { Harness, HarnessContext, HarnessResult, HarnessTask, HarnessToolPolicy } from './index.js';
import { insideWorkspace, runJsonStream } from './process.js';
import { hiddenPaths, hostSecrets, sandboxedCommand } from './sandbox.js';

/** Same caps the built-in loop puts on a live event: a glance, not the transcript. */
const EVENT_TEXT_LIMIT = 300;
const EVENT_SUMMARY_LIMIT = 200;

/**
 * What a claude-code run's usage rows are filed under. The subscription has no per-token price, so
 * every row carries `usd: null`: its tokens show, and it never counts toward `MAX_CLOUD_USD_PER_DAY`.
 */
export const SUBSCRIPTION_PROVIDER = 'anthropic-subscription';
/** The ledger's `node` for these rows: no hub node served them, the CLI on the hub host did. */
const USAGE_NODE = 'claude-code';

/**
 * Claude Code's built-in tools, by policy. `--tools` is the whole set the model is offered and
 * `--allowedTools` pre-approves the same set, so with `--permission-mode dontAsk` nothing ever waits
 * for a person (decision 0064). The read-only set is the one FR-G4 asks for.
 */
const TOOLS: Record<HarnessToolPolicy, string> = {
  workspace: 'Read,Edit,Write,Bash,Grep,Glob',
  'read-only': 'Read,Grep,Glob',
};
/** Tools whose `file_path` input names a file the run created or changed. */
const WRITING_TOOLS = new Set(['Write', 'Edit']);
/** Directories the after-run scan does not descend into: git's own, and installed dependencies. */
const SCAN_SKIP = new Set(['.git', 'node_modules']);
/** How many entries the after-run scan looks at before it stops; a bound, not an expectation. */
const SCAN_LIMIT = 50_000;

export interface ClaudeCodeHarnessDeps {
  /** The claude executable, from `claudeBinary()`. */
  bin: string;
  transcript: Transcript;
  /** The usage ledger hook — `AgentLoop.recordUsage`. */
  onUsage: (u: LoopUsage) => void;
  onBusy?: (busy: boolean) => void;
}

// --- claude's stream-json output (`-p --output-format stream-json --verbose`) -------------------
// Only the fields this adapter reads; the shapes were captured from claude 2.1 (decision 0064).

interface ClaudeBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | ClaudeBlock[];
  is_error?: boolean;
}
interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
interface ClaudeModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}
interface ClaudeEvent {
  type: string;
  subtype?: string;
  model?: string;
  message?: { id?: string; model?: string; content?: ClaudeBlock[] | string; usage?: ClaudeUsage };
  /** On `result`: the final message, or the error's text when `is_error`. */
  result?: string;
  is_error?: boolean;
  usage?: ClaudeUsage;
  modelUsage?: Record<string, ClaudeModelUsage>;
}

const blocks = (content: ClaudeBlock[] | string | undefined): ClaudeBlock[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : content ?? [];
const textOf = (content: ClaudeBlock[] | string | undefined): string =>
  blocks(content).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');

/** A count from the stream, or 0 for anything that is not a positive number. */
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
/**
 * Claude's counts as the hub's. The hub's `promptTokens` includes its `cachedTokens`; Claude reports
 * fresh input, cache reads and cache writes separately, so the prompt is all three.
 */
const tokens = (input: unknown, cacheRead: unknown, cacheWrite: unknown, output: unknown): TokenUsage => ({
  promptTokens: count(input) + count(cacheRead) + count(cacheWrite),
  cachedTokens: count(cacheRead),
  completionTokens: count(output),
});

/**
 * Claude Code (the `claude` CLI) run as a subprocess in the project workspace on the hub host's own
 * signed-in subscription (FR-G3, decision 0064). The hub never holds a key for it: the CLI finds
 * its login under the hub user's HOME, and the hub's own Anthropic variables are stripped.
 *
 * Like pi it runs in the OS sandbox, but with outbound HTTPS open, because the CLI calls Anthropic
 * itself rather than going through the hub's door — so it bypasses the gateway, its failover and
 * `maxStreams`, and its usage is filed here from the CLI's own counts.
 */
export function claudeCodeHarness(deps: ClaudeCodeHarnessDeps): Harness {
  return {
    kind: 'claude-code',
    async run(task: HarnessTask, ctx: HarnessContext): Promise<HarnessResult> {
      const system = piSubagentPrompt(task.role, task.instructions);
      const sessionId = deps.transcript.startSession(
        'subagent', ctx.subject, 'worker', task.member ? { memberId: task.member.id } : {},
      );
      if (task.member) deps.onBusy?.(true);
      const emit = (e: TurnEvent): void => {
        deps.transcript.appendTurnEvent(sessionId, e, Date.now());
        ctx.onEvent?.(e);
      };
      deps.transcript.append(sessionId, { role: 'system', content: system });
      deps.transcript.append(sessionId, { role: 'user', content: task.task });
      const record = (line: string): void => {
        ctx.log(line);
        deps.transcript.appendEvent(sessionId, line);
      };

      let tmpDir: string | undefined;
      try {
        let workspace: string;
        let command: { cmd: string; args: string[] };
        try {
          tmpDir = await realpath(await mkdtemp(join(tmpdir(), 'agenthub-claude-')));
          workspace = await realpath(task.workspace);
          const secrets = hostSecrets();
          const home = homedir();
          const wrapped = sandboxedCommand(process.platform, {
            workspace, tmpDir, https: true, keychain: true, writableWorkspace: task.tools === 'workspace',
            // The CLI reads its login from ~/.claude (or the keychain), so that stays readable; the
            // owner's other Claude Code transcripts and ~/.claude.json (MCP config) do not.
            ...hiddenPaths({ ...secrets, extra: [...(secrets.extra ?? []), join(home, '.claude', 'projects'), join(home, '.claude.json')] }, workspace),
            argv: [deps.bin, ...claudeArgs(system, task)],
          });
          if ('unavailable' in wrapped) throw new Error(wrapped.unavailable);
          command = wrapped;
        } catch (err) {
          const why = `the claude-code harness could not start: ${(err as Error).message}`;
          deps.transcript.appendEvent(sessionId, why);
          deps.transcript.endSession(sessionId, 'error');
          return { report: why, filesWritten: [], outcome: 'error', sessionId, toolCalls: 0 };
        }
        const run = await spawnClaude(command, { workspace, tmpDir }, task, ctx, emit, record);
        for (const usage of run.usage) {
          deps.onUsage({
            sessionId, kind: 'subagent', subject: ctx.subject,
            ...(task.member ? { memberId: task.member.id } : {}), usage,
          });
        }
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
        if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
      }
    },
  };
}

/** claude's own command line, after the binary. */
export function claudeArgs(system: string, task: HarnessTask): string[] {
  const tools = TOOLS[task.tools];
  return [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--append-system-prompt', system,
    '--tools', tools,
    '--allowedTools', tools,
    // Never prompts: anything not pre-approved above is denied, not asked about.
    '--permission-mode', 'dontAsk',
    // The host's own CLAUDE.md, skills, plugins, hooks and MCP servers (claude.ai connectors
    // included) must not leak into a project's run, and nothing of it is saved under ~/.claude.
    '--safe-mode', '--strict-mcp-config', '--no-session-persistence',
    // Claude Code's own Bash sandbox is Seatbelt/bwrap too, and one cannot be started inside ours;
    // ours is the containment (decision 0064), so the host's setting for it is overridden off.
    '--settings', JSON.stringify({ sandbox: { enabled: false } }),
    // `--` ends the variadic `--tools`/`--allowedTools` lists, and lets a task start with a dash.
    '--', task.task,
  ];
}

interface ClaudeRun {
  report: string;
  filesWritten: string[];
  outcome: HarnessResult['outcome'];
  toolCalls: number;
  lastTool?: string;
  note?: string;
  /** One ledger row per model the run used. */
  usage: LoopUsage['usage'][];
}

async function spawnClaude(
  command: { cmd: string; args: string[] }, setup: { workspace: string; tmpDir: string },
  task: HarnessTask, ctx: HarnessContext, emit: (e: TurnEvent) => void, record: (line: string) => void,
): Promise<ClaudeRun> {
  const env = claudeEnv(setup.tmpDir);
  const startedAt = Date.now();
  const filesWritten: string[] = [];
  const pending = new Map<string, { tool: string; input: Record<string, unknown>; at: number }>();
  let text = '';
  let toolCalls = 0;
  let lastTool: string | undefined;
  let usedBash = false;
  let initModel: string | undefined;
  let result: ClaudeEvent | undefined;
  /** Per-message usage, for a run killed before its `result` event: one entry per message id. */
  const messages = new Map<string, { model: string; usage: ClaudeUsage }>();

  const onEvent = (e: ClaudeEvent, exhaust: (why: string) => void): void => {
    if (e.type === 'system' && e.subtype === 'init') { initModel = e.model; return; }
    if (e.type === 'result') { result = e; return; }
    if (e.type === 'assistant' && e.message) {
      const m = e.message;
      if (m.id && m.usage) messages.set(m.id, { model: m.model ?? initModel ?? 'claude', usage: m.usage });
      const said = textOf(m.content).trim();
      if (said) {
        text = said;
        emit({ kind: 'text', who: ctx.who, text: clip(said, EVENT_TEXT_LIMIT) });
      }
      for (const b of blocks(m.content)) {
        if (b.type !== 'tool_use') continue;
        const tool = b.name ?? 'tool';
        const input = b.input ?? {};
        pending.set(b.id ?? '', { tool, input, at: Date.now() });
        toolCalls++;
        lastTool = tool;
        if (tool === 'Bash') usedBash = true;
        emit({ kind: 'tool-call', who: ctx.who, tool, args: clip(JSON.stringify(input), EVENT_SUMMARY_LIMIT) });
        // Claude Code's own `--max-turns` counts model turns, not calls, so the budget is enforced
        // the way pi's is: the run is stopped at the first call past it.
        if (toolCalls > task.budget.toolCalls) exhaust(`claude went past its tool call budget of ${task.budget.toolCalls}`);
      }
      return;
    }
    if (e.type === 'user' && e.message) {
      for (const b of blocks(e.message.content)) {
        if (b.type !== 'tool_result') continue;
        const started = pending.get(b.tool_use_id ?? '');
        pending.delete(b.tool_use_id ?? '');
        const tool = started?.tool ?? 'tool';
        emit({
          kind: 'tool-result', who: ctx.who, tool, ok: !b.is_error,
          summary: clip(textOf(b.content), EVENT_SUMMARY_LIMIT), ms: started ? Date.now() - started.at : 0,
        });
        if (!b.is_error && started && WRITING_TOOLS.has(tool)) {
          const rel = insideWorkspace(setup.workspace, started.input.file_path);
          if (rel) { if (!filesWritten.includes(rel)) filesWritten.push(rel); }
          else record(`claude wrote outside the workspace: ${clip(String(started.input.file_path), EVENT_SUMMARY_LIMIT)}`);
        }
      }
    }
  };

  const end = await runJsonStream({
    name: 'claude', command, cwd: setup.workspace, env, wallClockMs: task.budget.wallClockMs,
    ...(task.signal ? { signal: task.signal } : {}),
    onEvent: (e, exhaust) => onEvent(e as ClaudeEvent, exhaust),
    record,
  });

  // Edit/Write inputs name what the model wrote with its file tools; a `Bash` command that wrote a
  // file names nothing, so a run that used Bash also has the workspace scanned for files changed
  // since it started. Anything else writing the workspace meanwhile would be counted too (0064).
  if (usedBash) {
    const scan = await changedSince(setup.workspace, startedAt);
    if (scan.truncated) record(`claude: the written-files scan stopped after ${SCAN_LIMIT} entries; the list may be incomplete`);
    for (const rel of scan.files) if (!filesWritten.includes(rel)) filesWritten.push(rel);
  }

  const usage = usageRows(result, messages, initModel);
  for (const u of usage) emit({ kind: 'usage', who: ctx.who, usd: null, tokens: u.promptTokens + u.completionTokens });

  const final = typeof result?.result === 'string' ? result.result.trim() : '';
  const ran = { filesWritten, toolCalls, usage, ...(lastTool ? { lastTool } : {}) };
  if (end.startError) {
    return { ...ran, report: `the claude-code harness could not start: ${end.startError}`, outcome: 'error', ...(end.note ? { note: end.note } : {}) };
  }
  if (end.stopped) return { ...ran, report: text, outcome: end.stopped, ...(end.note ? { note: end.note } : {}) };
  if (end.code === 0 && result && !result.is_error) return { ...ran, report: final || text, outcome: 'stop' };
  // A failed run's `result` is the error itself — "Not logged in · Please run /login" for a host
  // whose CLI was never signed in — which is exactly what the manager and the owner need to see.
  const why = (result?.is_error && final) || `claude exited with code ${end.code}${result ? ` (${result.subtype ?? 'error'})` : ''}`;
  return { ...ran, report: `the claude-code harness failed: ${why}`, outcome: 'error', note: why };
}

/**
 * The CLI's environment: the hub's secrets stripped as for every agent-run command, and every
 * Anthropic or Claude Code variable too, so the run uses the host's signed-in subscription and
 * nothing the hub's own environment says (no key, no base URL). HOME stays: it is where the login is.
 */
function claudeEnv(tmpDir: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(secretsStripped()).filter(([k]) => !k.startsWith('ANTHROPIC_') && !k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDECODE'),
  );
  // The run's temp dir is the one writable place besides the workspace, so scratch files go there —
  // including Claude Code's own per-uid dir (its Bash tool's output), which is /tmp/claude-<uid>
  // and shared with the owner's own sessions unless CLAUDE_CODE_TMPDIR moves it.
  return { ...env, TMPDIR: tmpDir, CLAUDE_CODE_TMPDIR: tmpDir, npm_config_cache: join(tmpDir, 'npm') };
}

/**
 * The run's usage, one row per model. The `result` event's `modelUsage` is the CLI's own total;
 * a run stopped before it (budget, abort, wall clock) is summed from its messages instead.
 */
function usageRows(
  result: ClaudeEvent | undefined, messages: Map<string, { model: string; usage: ClaudeUsage }>, initModel: string | undefined,
): LoopUsage['usage'][] {
  const byModel = new Map<string, TokenUsage>();
  const add = (model: string, t: TokenUsage): void => {
    const was = byModel.get(model) ?? { promptTokens: 0, cachedTokens: 0, completionTokens: 0 };
    byModel.set(model, {
      promptTokens: was.promptTokens + t.promptTokens,
      cachedTokens: was.cachedTokens + t.cachedTokens,
      completionTokens: was.completionTokens + t.completionTokens,
    });
  };
  if (result?.modelUsage && Object.keys(result.modelUsage).length) {
    for (const [model, u] of Object.entries(result.modelUsage)) {
      add(model, tokens(u.inputTokens, u.cacheReadInputTokens, u.cacheCreationInputTokens, u.outputTokens));
    }
  } else if (result?.usage) {
    const u = result.usage;
    add(initModel ?? 'claude', tokens(u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens, u.output_tokens));
  } else {
    for (const { model, usage: u } of messages.values()) {
      add(model, tokens(u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens, u.output_tokens));
    }
  }
  return [...byModel].filter(([, t]) => t.promptTokens || t.completionTokens).map(([model, t]) => ({
    ...t, usd: null, provider: SUBSCRIPTION_PROVIDER, model, node: USAGE_NODE,
  }));
}

/**
 * Workspace-relative paths of files modified at or after `since`, sorted; `truncated` when the walk
 * stopped at `SCAN_LIMIT` entries. A filesystem scan rather
 * than a before/after `git status`: git in a workspace the agent could write runs whatever that
 * workspace's config says (`core.fsmonitor`, clean filters) — here, outside the sandbox.
 */
async function changedSince(workspace: string, since: number): Promise<{ files: string[]; truncated: boolean }> {
  const found: string[] = [];
  let seen = 0;
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > SCAN_LIMIT) return;
      const path = join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SCAN_SKIP.has(e.name)) await walk(path, relPath);
      } else if (e.isFile()) {
        try { if ((await stat(path)).mtimeMs >= since) found.push(relPath); } catch { /* gone */ }
      }
    }
  };
  await walk(workspace, '');
  return { files: found.sort(), truncated: seen > SCAN_LIMIT };
}
