import { readdir, readFile, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { JobResult, JobType, MilestoneStatus, ModelPolicy, Priority, Tier, ToolCall, ToolDef, TurnEvent } from '@agenthub/shared';
import { memberAbilities, MILESTONE_STATUSES, PRD_SECTIONS, type TeamMember } from '@agenthub/shared';
import { resolveWorkspace, runShellTask, secretsStripped, SHELL_TAIL_LENGTH } from '@agenthub/shared/shell';
import type { JobQueue } from '../queue.js';
import type { NodeRegistry } from '../node-registry.js';
import { byline, type ProjectBundle } from '../projects/bundle.js';
import { auditPrd } from '../projects/prd.js';
import { CODE_MAP_MAX_LINES, CODE_MAP_PAGE, SUBAGENT_ROLES, type SubagentRole } from '../projects/prompts.js';
import { normalizeMilestones, patchMilestone } from '../projects/roadmap.js';
import { newCapability, validatePreview } from '../projects/preview.js';
import { DOC_SLUG_RE, validateBriefing, type Briefing, type TaskItem } from '../projects/schema.js';
import { browserOperatorTools, type BrowserToolDeps } from './browser-tools.js';
import { mediaTools } from './media-tools.js';
import type { MediaDesk } from '../projects/media.js';
import { HARNESS_WALL_CLOCK_MS, SUBAGENT_TOOL_CALLS } from './budgets.js';
import type { HarnessDoor } from './harness/index.js';
import { selectHarness } from './harness/select.js';
import { clip, type AgentLoop, type AgentRunResult } from './loop.js';
import { routeFor } from '../gateway.js';

const TOOL_RESULT_LIMIT = 8000;
/** Per-tool cap for read_file/read_bundle — larger than TOOL_RESULT_LIMIT because source files and
 *  bundle documents routinely run past 8k; they page at a line boundary instead of losing the rest. */
const READ_FILE_LIMIT = 32_000;
const SHELL_TIMEOUT_MS = 60_000;
/** How much of a delegated task a `subagent-start` event carries. */
const EVENT_TASK_LIMIT = 200;

export interface HubDeps {
  queue: JobQueue;
  nodes: NodeRegistry;
}

export interface ToolContext {
  bundle?: ProjectBundle;
  /** Absent for sessions that get no hub tools at all — the master's briefing run, for one. */
  hub?: HubDeps;
  sessionId: number;
  log(line: string): void;
  /** Aborts long-running tools (currently `run_shell`) when the owning session is cancelled. */
  signal?: AbortSignal;
  /** The owning run's live event sink: a tool that runs a subagent or a verification reports through it. */
  onEvent?: (e: TurnEvent) => void;
  /** The API token label that asked for the owning turn (0067), for the commits its tools make. */
  requestedBy?: string;
}

export interface Tool {
  def: ToolDef;
  /** Leaves the owner's own machines (posting, emailing). Such a tool must propose through the
   *  ConfirmationGate rather than act, so nothing reaches the outside world unconfirmed. */
  outward?: boolean;
  /** This tool already bounds its own result to a sensible size and shape (read_file/read_bundle
   *  page at a line boundary with a continuation marker) — runToolCall must not re-cut it with the
   *  generic TOOL_RESULT_LIMIT, which would land mid-marker. */
  selfCapped?: boolean;
  /** Returns the tool result text; throwing is fine — `runToolCall` renders it as `error: ...`. */
  run(args: unknown, ctx: ToolContext): Promise<string>;
}

/**
 * Resolves and runs one model-issued tool call. Never throws: unknown tools, malformed argument
 * JSON and tool failures all come back as `error: <message>` so the loop can feed them to the model.
 */
export async function runToolCall(tools: Tool[], call: ToolCall, ctx: ToolContext): Promise<string> {
  const tool = tools.find((t) => t.def.name === call.name);
  if (!tool) return `error: unknown tool: ${call.name}`;
  let args: unknown;
  try {
    args = call.arguments.trim() ? JSON.parse(call.arguments) : {};
  } catch (e) {
    return `error: invalid arguments JSON: ${(e as Error).message}`;
  }
  try {
    const result = await tool.run(args, ctx);
    return tool.selfCapped ? result : truncateResult(result, TOOL_RESULT_LIMIT);
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

/**
 * Head-keeps an oversized result and names what it cut. Keeping the tail — as this used to — is a
 * trap: a model narrowing its read range sees the same end of the file every time, with nothing
 * saying why, and loops until its budget is gone.
 */
export function truncateResult(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[truncated: showing first ${limit} of ${text.length} characters]`;
}

/**
 * 1-based `fromLine`/`maxLines` slice of `text` for read_file/read_bundle: a file comes back whole
 * up to READ_FILE_LIMIT characters, and a longer one — or one `maxLines` cuts short of the end — is
 * cut at the last line that still fits, ending with a marker naming the exact `fromLine` to continue
 * from — unlike `truncateResult`'s flat character cut, a line boundary keeps every returned line
 * intact. A reader that never sees this marker has to be able to assume it saw the rest of the file.
 */
function pageLines(text: string, fromLine: number, maxLines: number | undefined, toolName: string): string {
  const lines = text.split('\n');
  if (fromLine < 1) throw new Error('fromLine must be at least 1');
  if (maxLines !== undefined && maxLines < 1) throw new Error('maxLines must be at least 1');
  if (fromLine > lines.length) throw new Error(`fromLine ${fromLine} is past the end (${lines.length} lines)`);
  const end = maxLines !== undefined ? Math.min(lines.length, fromLine - 1 + maxLines) : lines.length;
  const slice = lines.slice(fromLine - 1, end);
  const whole = slice.join('\n');

  // Keep whole lines up to the character cap; the first line always makes it in, even alone over it.
  let shown = slice;
  let shownText = whole;
  if (whole.length > READ_FILE_LIMIT) {
    shown = [];
    let shownLen = 0;
    for (const line of slice) {
      const add = line.length + (shown.length ? 1 : 0);
      if (shown.length && shownLen + add > READ_FILE_LIMIT) break;
      shown.push(line);
      shownLen += add;
    }
    shownText = shown.join('\n');
  }

  const endLine = fromLine + shown.length - 1;
  if (endLine >= lines.length) return shownText;
  return `${shownText}\n[showing lines ${fromLine}–${endLine} of ${lines.length} ` +
    `(${shownText.length.toLocaleString('en-US')} of ${text.length.toLocaleString('en-US')} characters); ` +
    `call ${toolName} again with fromLine: ${endLine + 1} for the rest]`;
}

// --- argument helpers -------------------------------------------------------

function fields(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
}

function str(args: unknown, key: string): string {
  const v = fields(args)[key];
  if (typeof v !== 'string') throw new Error(`${key} must be a string`);
  return v;
}

function optStr(args: unknown, key: string): string | undefined {
  const v = fields(args)[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`${key} must be a string`);
  return v;
}

function optNum(args: unknown, key: string): number | undefined {
  const v = fields(args)[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(`${key} must be an integer`);
  return v;
}

function strArray(args: unknown, key: string): string[] {
  const v = fields(args)[key];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string') || v.length === 0) {
    throw new Error(`${key} must be a non-empty string array`);
  }
  return v as string[];
}

function oneOf<T extends string>(args: unknown, key: string, allowed: readonly T[]): T {
  const v = str(args, key);
  if (!allowed.includes(v as T)) throw new Error(`${key} must be one of: ${allowed.join(', ')}`);
  return v as T;
}

function needBundle(ctx: ToolContext): ProjectBundle {
  if (!ctx.bundle) throw new Error('no project bundle in this session');
  return ctx.bundle;
}

function needHub(ctx: ToolContext): HubDeps {
  if (!ctx.hub) throw new Error('no hub in this session');
  return ctx.hub;
}

/**
 * Resolves a workspace-relative path inside `workspace`, throwing when it escapes.
 *
 * This is the *lexical* half of the check, and only that: `..` and an absolute path are refused by
 * comparing strings, so a symlink inside the workspace that points out of it still resolves. It is
 * what `read_file`, `write_file` and `list_dir` have always done. A caller that needs the symlink
 * closed too — the Code screen's file routes — calls `realWorkspacePath` below instead.
 */
export function workspacePath(workspace: string, path: string | undefined): string {
  // `'.'` stands in for the daemon's per-project segment because the bundle workspace is already
  // project-scoped.
  return resolveWorkspace(workspace, '.', path);
}

/**
 * `workspacePath` with the symlinks closed: both sides are resolved with `realpath` and compared,
 * so a link inside the workspace pointing at `/etc/passwd` (or at the bundle's own `prd.md`) is
 * refused rather than followed. `realPathish` resolves the deepest existing ancestor when the file
 * itself does not exist yet, which is the ordinary case for a write.
 *
 * The workspace root is resolved too: on macOS it usually sits under a symlinked `/var`, so
 * comparing a real path against an unresolved root would refuse every path in it.
 */
export async function realWorkspacePath(workspace: string, path: string | undefined): Promise<string> {
  const target = workspacePath(workspace, path);
  assertInside(await realPathish(workspace), await realPathish(target), 'path escapes workspace');
  return target;
}

// Workspace paths resolve inside `<bundle>/workspace`.
function inWorkspace(ctx: ToolContext, path: string | undefined): string {
  return workspacePath(needBundle(ctx).workspace, path);
}

const strProp = (description: string) => ({ type: 'string', description });

/**
 * `realpath` of `p`, or of its deepest existing ancestor with the missing tail re-appended. The
 * containment check below compares real paths on both sides — on macOS the workspace root itself
 * usually sits under a symlinked /var — and the path being checked often does not exist yet.
 */
async function realPathish(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    const parent = dirname(p);
    if (parent === p) return p;
    return join(await realPathish(parent), basename(p));
  }
}

/** Refuses `target` when it is not `root` or below it. */
function assertInside(root: string, target: string, message: string): void {
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(message);
}

/**
 * argv entries that name a path. cmd[0] is the executable — an absolute /usr/bin/… is normal and
 * reads nothing — so only the arguments are checked.
 */
function pathArgs(cmd: string[]): string[] {
  return cmd.slice(1).filter((a) => a.startsWith('/') || a.startsWith('.') || a.includes('/'));
}

/**
 * The cwd/containment check `read_file` and `list_dir` already enforce, applied to the shell too:
 * `resolveWorkspace` scopes the cwd, realpath keeps a symlinked cwd from pointing out of the tree,
 * and every path-shaped argument is resolved against that cwd the same way.
 *
 * This is cwd-scoping over the workspace, not a sandbox: a command that builds a path at runtime
 * (`sh -c 'cat /etc/passwd'`) is still whatever the hub's OS user can reach. Real isolation needs a
 * sandboxed user or a container.
 */
async function assertShellInWorkspace(workspace: string, cmd: string[], cwd: string | undefined): Promise<void> {
  const root = await realPathish(workspace);
  const target = resolveWorkspace(workspace, '.', cwd);
  assertInside(root, await realPathish(target), 'cwd escapes workspace');
  for (const arg of pathArgs(cmd)) {
    const p = isAbsolute(arg) ? arg : resolve(target, arg);
    assertInside(root, await realPathish(p), `path argument escapes workspace: ${arg}`);
  }
}

// --- workspace tools --------------------------------------------------------

export interface WorkspaceToolOptions {
  /**
   * Told each workspace-relative path a tool wrote: every `write_file`, and every path-shaped
   * `run_shell` argument that exists after the command and was created or modified by it. It is how
   * a subagent's caller learns what changed without inspecting the workspace itself.
   */
  onWrite?: (path: string) => void;
}

/** `mtimeMs` of an existing file, or null — the before/after pair `run_shell` reports writes from. */
const fileStamp = (p: string): Promise<number | null> => stat(p).then((s) => (s.isFile() ? s.mtimeMs : null), () => null);

/**
 * File and shell tools scoped to `<bundle>/workspace`.
 *
 * The scoping is *cwd-scoping, not containment*: `resolveWorkspace` is a lexical check on the
 * requested path, and `run_shell` additionally realpath-checks its cwd and any path-shaped argv
 * entries (`assertShellInWorkspace`) so a symlink inside the workspace can't point out of it. A
 * command the model runs can still build a path at runtime (`sh -c 'cat /etc/passwd'`), which reads
 * whatever the hub's OS user can reach. Real isolation has to come from running these tools under a
 * sandboxed user or container.
 */
export function workspaceTools(opts: WorkspaceToolOptions = {}): Tool[] {
  return [
    {
      def: {
        type: 'tool', name: 'read_file',
        description: 'Read a UTF-8 file from the project workspace, whole up to 32,000 characters. A longer file is cut ' +
          'at a line boundary and ends with a marker naming the fromLine to continue from.',
        parameters: {
          type: 'object',
          properties: {
            path: strProp('Path relative to the workspace root.'),
            fromLine: { type: 'number', description: '1-based line to start reading from; defaults to 1.' },
            maxLines: { type: 'number', description: 'Maximum number of lines to return; defaults to the rest of the file.' },
          },
          required: ['path'],
        },
      },
      selfCapped: true,
      run: async (args, ctx) => {
        const text = await readFile(inWorkspace(ctx, str(args, 'path')), 'utf8');
        return pageLines(text, optNum(args, 'fromLine') ?? 1, optNum(args, 'maxLines'), 'read_file');
      },
    },
    {
      def: {
        type: 'tool', name: 'write_file', description: 'Write a UTF-8 file in the project workspace, creating parent directories.',
        parameters: {
          type: 'object',
          properties: { path: strProp('Path relative to the workspace root.'), content: strProp('Full file content.') },
          required: ['path', 'content'],
        },
      },
      run: async (args, ctx) => {
        const path = str(args, 'path');
        const content = str(args, 'content');
        const full = inWorkspace(ctx, path);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, content, 'utf8');
        opts.onWrite?.(relative(needBundle(ctx).workspace, full).split(sep).join('/'));
        return `wrote ${path} (${Buffer.byteLength(content)} bytes)`;
      },
    },
    {
      def: {
        type: 'tool', name: 'list_dir', description: 'List a directory in the project workspace.',
        parameters: { type: 'object', properties: { path: strProp('Directory relative to the workspace root; defaults to the root.') }, required: [] },
      },
      run: async (args, ctx) => {
        const entries = await readdir(inWorkspace(ctx, optStr(args, 'path')), { withFileTypes: true });
        const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
        return names.length ? names.join('\n') : '(empty)';
      },
    },
    {
      def: {
        type: 'tool', name: 'run_shell',
        description: 'Run a command (argv form, no shell) in the project workspace and return its exit code and output tail. ' +
          'The cwd and any path-shaped arguments must stay inside the workspace. This is cwd-scoping over the workspace, ' +
          'not a sandbox: a command that builds a path at runtime can still reach whatever the OS user can.',
        parameters: {
          type: 'object',
          properties: {
            cmd: { type: 'array', items: { type: 'string' }, description: 'Argv, e.g. ["npm","test"].' },
            cwd: strProp('Directory relative to the workspace root.'),
            timeoutMs: { type: 'number', description: `Timeout in ms; defaults to ${SHELL_TIMEOUT_MS}.` },
          },
          required: ['cmd'],
        },
      },
      run: async (args, ctx) => {
        const cmd = strArray(args, 'cmd');
        const cwd = optStr(args, 'cwd');
        const workspace = needBundle(ctx).workspace;
        await assertShellInWorkspace(workspace, cmd, cwd);
        const timeoutRaw = fields(args).timeoutMs;
        const timeoutMs = typeof timeoutRaw === 'number' && timeoutRaw > 0 ? timeoutRaw : SHELL_TIMEOUT_MS;
        // The command's path arguments, stamped before it runs: whichever ones it created or touched
        // are reported as writes (`cp a b`, `git apply x.patch`) — merely reading one is not.
        const target = resolveWorkspace(workspace, '.', cwd);
        const paths = opts.onWrite ? pathArgs(cmd).map((arg) => (isAbsolute(arg) ? arg : resolve(target, arg))) : [];
        const before = await Promise.all(paths.map(fileStamp));
        const result = await runShellTask(
          { cmd, cwd, timeoutMs },
          // `'.'` as the project segment: the bundle workspace is already project-scoped, so the
          // sandbox root is the workspace itself. The environment is the hub's minus its
          // credentials — this is cwd-scoping, not a sandbox, so anything left in it is the
          // model's to read and use.
          { workspaceRoot: workspace, project: '.', onLine: ctx.log, signal: ctx.signal, env: secretsStripped() },
        );
        const after = await Promise.all(paths.map(fileStamp));
        paths.forEach((p, i) => {
          if (after[i] !== null && after[i] !== before[i]) opts.onWrite?.(relative(workspace, p).split(sep).join('/'));
        });
        return renderShellResult(result, timeoutMs);
      },
    },
  ];
}

// The shell keeps the *tail*, unlike `truncateResult` above: its output streams to an unbounded
// length (a build log), and for that the end is the useful part rather than the start.
function renderShellResult(result: JobResult, timeoutMs: number): string {
  const head = result.timedOut
    ? `error: timed out after ${timeoutMs}ms`
    : result.signal === 'aborted'
      ? 'error: aborted'
      : `exit: ${result.exitCode ?? `killed (${result.signal})`}`;
  const lines = [head];
  for (const [name, tail] of [['stdout', result.stdoutTail], ['stderr', result.stderrTail]] as const) {
    if (!tail?.trim()) continue;
    const note = tail.length >= SHELL_TAIL_LENGTH
      ? ` [truncated: showing the last ${tail.length} characters; earlier output was dropped]`
      : '';
    lines.push(`${name}${note}:\n${tail.trimEnd()}`);
  }
  return lines.join('\n');
}

// --- bundle tools -----------------------------------------------------------

const TASK_STATUSES = ['backlog', 'in-progress', 'done', 'blocked'] as const;

function parseTasks(args: unknown): TaskItem[] {
  const raw = fields(args).tasks;
  if (!Array.isArray(raw)) throw new Error('tasks must be an array');
  return raw.map((t, i) => {
    const item = fields(t);
    if (typeof item.id !== 'string' || typeof item.title !== 'string') throw new Error(`tasks[${i}]: id and title are required strings`);
    if (!TASK_STATUSES.includes(item.status as TaskItem['status'])) throw new Error(`tasks[${i}]: status must be one of: ${TASK_STATUSES.join(', ')}`);
    return {
      id: item.id, title: item.title, status: item.status as TaskItem['status'],
      ...(typeof item.owner === 'string' ? { owner: item.owner } : {}),
      ...(typeof item.notes === 'string' ? { notes: item.notes } : {}),
    };
  });
}

/** The document tools a turn gets: it keeps the docs true, refreshes the code map, and moves the roadmap along. */
const TURN_DOC_TOOLS = ['write_doc', 'write_code_map', 'set_milestone_status'];

/** What `set_milestone_status` accepts: everything but `done`, which only a verification grants. */
const SETTABLE_MILESTONE_STATUSES = MILESTONE_STATUSES.filter((s) => s !== 'done');

export function bundleTools(): Tool[] {
  return [
    ...docTools('agent').filter((t) => TURN_DOC_TOOLS.includes(t.def.name)),
    {
      def: {
        type: 'tool', name: 'read_bundle',
        description: 'Read one of the project bundle\'s own files: prd.md, roadmap.yaml, tasks.yaml, manifest.yaml, project.md, ' +
          'decisions.log.md, team.yaml, or a page under docs/ or skills/, whole up to 32,000 characters — a longer one pages ' +
          'the same way read_file does. The workspace is not reachable from here — read_file covers that.',
        parameters: {
          type: 'object',
          properties: {
            path: strProp('Bundle-relative path, e.g. "prd.md" or "docs/index.md".'),
            fromLine: { type: 'number', description: '1-based line to start reading from; defaults to 1.' },
            maxLines: { type: 'number', description: 'Maximum number of lines to return; defaults to the rest of the file.' },
          },
          required: ['path'],
        },
      },
      selfCapped: true,
      run: async (args, ctx) => {
        const text = await needBundle(ctx).readBundleFile(str(args, 'path'));
        return pageLines(text, optNum(args, 'fromLine') ?? 1, optNum(args, 'maxLines'), 'read_bundle');
      },
    },
    {
      def: {
        type: 'tool', name: 'list_bundle', description: 'List the bundle files read_bundle can open.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      run: async (_args, ctx) => (await needBundle(ctx).bundleFiles()).join('\n'),
    },
    {
      def: {
        type: 'tool', name: 'update_project_md', description: 'Replace project.md with new content.',
        parameters: { type: 'object', properties: { content: strProp('Full markdown content.') }, required: ['content'] },
      },
      run: async (args, ctx) => {
        const bundle = needBundle(ctx);
        await bundle.writeProject(str(args, 'content'));
        await bundle.commit('agent: update project.md');
        return 'project.md updated';
      },
    },
    {
      def: {
        type: 'tool', name: 'add_decision', description: 'Append a dated entry to decisions.log.md.',
        parameters: {
          type: 'object',
          properties: { title: strProp('Short decision title.'), rationale: strProp('Why this was decided.'), by: strProp('Who decided; defaults to "agent".') },
          required: ['title', 'rationale'],
        },
      },
      run: async (args, ctx) => {
        const bundle = needBundle(ctx);
        const title = str(args, 'title');
        await bundle.appendDecision({ title, rationale: str(args, 'rationale'), by: optStr(args, 'by') ?? 'agent' });
        await bundle.commit(`agent: decision ${title}`);
        return 'decision recorded';
      },
    },
    {
      def: {
        type: 'tool', name: 'update_tasks', description: 'Replace tasks.yaml with the given task list.',
        parameters: {
          type: 'object',
          properties: {
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: strProp('Stable task id.'), title: strProp('Task title.'),
                  status: { type: 'string', enum: [...TASK_STATUSES] },
                  owner: strProp('Optional owner.'), notes: strProp('Optional notes.'),
                },
                required: ['id', 'title', 'status'],
              },
            },
          },
          required: ['tasks'],
        },
      },
      run: async (args, ctx) => {
        const bundle = needBundle(ctx);
        const tasks = parseTasks(args);
        await bundle.writeTasks({ tasks });
        await bundle.commit('agent: update tasks');
        return `tasks updated (${tasks.length})`;
      },
    },
    {
      def: {
        type: 'tool', name: 'set_preview',
        description: 'Declare how this project\'s app is run so the owner can see it live. The hub runs `cmd` in ' +
          'workspace/ on its own machine and serves it on its own port, under a base path it passes to the process ' +
          'as AGENTHUB_PREVIEW_BASE — set the dev server\'s base path from that environment variable (Vite `base`, ' +
          'Next `basePath`) rather than hard-coding one. Set this once the dev server exists; calling it again replaces it.',
        parameters: {
          type: 'object',
          properties: {
            cmd: { type: 'array', items: { type: 'string' }, description: 'Argv, e.g. ["npm", "run", "dev"].' },
            port: { type: 'number', description: 'The port the dev server listens on (1024-65535).' },
          },
          required: ['cmd', 'port'],
        },
      },
      run: async (args, ctx) => {
        const bundle = needBundle(ctx);
        const validated = validatePreview(args);
        if ('error' in validated) throw new Error(validated.error);
        // The capability is the hub's, not the model's: an existing one is kept so the owner's link
        // keeps working, and a project that never had one gets a fresh one here.
        const current = (await bundle.manifest()).preview;
        await bundle.setPreview({ ...validated.preview, cap: current?.cap ?? newCapability() });
        await bundle.commit('agent: set preview');
        return `preview set: ${validated.preview.cmd.join(' ')} on port ${validated.preview.port}`;
      },
    },
    {
      def: {
        type: 'tool', name: 'write_skill', description: 'Write a reusable skill markdown file into the bundle.',
        parameters: {
          type: 'object',
          properties: { name: strProp('Skill file name without extension.'), body: strProp('Markdown body.') },
          required: ['name', 'body'],
        },
      },
      run: async (args, ctx) => {
        const bundle = needBundle(ctx);
        const name = str(args, 'name');
        if (!/^[a-z0-9-]{1,40}$/.test(name)) throw new Error('name must be kebab-case [a-z0-9-]{1,40}');
        await bundle.writeSkill(name, str(args, 'body'));
        await bundle.commit(`agent: write skill ${name}`);
        return `skill ${name} written`;
      },
    },
    {
      def: {
        type: 'tool', name: 'publish_briefing',
        description: 'Publish the structured briefing the master orchestrator reads.',
        parameters: {
          type: 'object',
          properties: {
            title: strProp('Project title.'),
            status: { type: 'string', enum: ['active', 'paused', 'blocked', 'done'] },
            priority: { type: 'string', enum: ['interactive', 'project', 'batch'] },
            summary: strProp('At most 600 characters.'),
            progress: { type: 'object', properties: { done: { type: 'number' }, total: { type: 'number' } }, required: ['done', 'total'] },
            blockers: { type: 'array', items: { type: 'string' } },
            nextSteps: { type: 'array', items: { type: 'string' } },
          },
          required: ['title', 'status', 'priority', 'summary', 'progress', 'blockers', 'nextSteps'],
        },
      },
      run: async (args, ctx) => {
        const bundle = needBundle(ctx);
        const f = fields(args);
        // Only the schema's own keys make it through; `slug` and `updatedAt` are filled in here
        // rather than by the model — a briefing filed under another project's slug, or stamped with
        // a time the model chose, would mislead the master.
        const briefing = {
          slug: (await bundle.manifest()).slug,
          title: f.title,
          status: f.status,
          priority: f.priority,
          summary: f.summary,
          progress: f.progress,
          blockers: f.blockers,
          nextSteps: f.nextSteps,
          updatedAt: Date.now(),
        };
        validateBriefing(briefing);
        await bundle.publishBriefing(briefing as Briefing);
        await bundle.commit(`agent: publish briefing${byline(ctx.requestedBy)}`);
        return 'briefing published';
      },
    },
  ];
}

// --- document tools ---------------------------------------------------------

/** Who is writing, which is the commit-message prefix the bundle's history is read by. */
export type DocActor = 'agent' | 'owner';

/** One-line summary of a PRD's audit, which is what a write_prd call hands back to the model. */
const auditSummary = (markdown: string): string => {
  const audit = auditPrd(markdown);
  return audit.missing.length
    ? `prd.md written — score ${audit.score}/100; still missing or thin: ${audit.missing.join(', ')}`
    : `prd.md written — score ${audit.score}/100; every section is filled in`;
};

/**
 * The tools that write a project's three documents: the PRD, the roadmap and the docs pages.
 *
 * `actor` only picks the commit prefix — `owner:` when the owner drove the edit through a document
 * persona's chat, `agent:` when a turn made it — so the bundle's git log says who changed what.
 * Callers hand out the subset a given persona is allowed (see `ProjectChat`), and `bundleTools`
 * takes the two an orchestrator turn needs.
 */
export function docTools(actor: DocActor = 'agent'): Tool[] {
  const prefix = `${actor}: `;
  return [
    {
      def: {
        type: 'tool', name: 'read_prd', description: 'Read the project PRD (prd.md).',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      run: async (_args, ctx) => (await needBundle(ctx).prd()) || '(empty)',
    },
    {
      def: {
        type: 'tool', name: 'write_prd',
        description: `Replace prd.md with the full document. It must contain every section heading: ${PRD_SECTIONS.map((s) => s.title).join(', ')}.`,
        parameters: { type: 'object', properties: { markdown: strProp('The whole PRD as markdown.') }, required: ['markdown'] },
      },
      run: async (args, ctx) => {
        const bundle = needBundle(ctx);
        const markdown = str(args, 'markdown');
        // A write that dropped sections would quietly lower the score the owner is watching, so it
        // is refused with the list rather than accepted and audited as thin.
        const audit = auditPrd(markdown);
        const absent = audit.sections.filter((s) => !s.present).map((s) => s.title);
        if (absent.length) throw new Error(`prd.md must keep every section heading; missing: ${absent.join(', ')}`);
        await bundle.writePrd(markdown.endsWith('\n') ? markdown : `${markdown}\n`);
        await bundle.commit(`${prefix}update prd`);
        return auditSummary(markdown);
      },
    },
    {
      def: {
        type: 'tool', name: 'read_roadmap', description: 'Read the ordered milestones from roadmap.yaml.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      run: async (_args, ctx) => {
        const milestones = await needBundle(ctx).roadmap();
        return milestones.length ? JSON.stringify(milestones, null, 2) : '(no milestones yet)';
      },
    },
    {
      def: {
        type: 'tool', name: 'write_roadmap',
        description: 'Replace roadmap.yaml with the full ordered milestone list; ids are assigned from the order.',
        parameters: {
          type: 'object',
          properties: {
            milestones: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: strProp('Milestone title.'), summary: strProp('What is built, and what is demonstrable at the end.'),
                  status: { type: 'string', enum: [...MILESTONE_STATUSES], description: 'Defaults to planned.' },
                  estimate: strProp('Coarse and optional, e.g. "2 days".'),
                  dependsOn: { type: 'array', items: { type: 'string' }, description: 'Ids of earlier milestones.' },
                },
                required: ['title', 'summary'],
              },
            },
          },
          required: ['milestones'],
        },
      },
      run: async (args, ctx) => {
        const bundle = needBundle(ctx);
        const milestones = normalizeMilestones(fields(args).milestones);
        await bundle.writeRoadmap(milestones);
        await bundle.commit(`${prefix}update roadmap`);
        return `roadmap updated (${milestones.length} milestones)`;
      },
    },
    {
      def: {
        type: 'tool', name: 'set_milestone_status',
        description: 'Set one roadmap milestone\'s status to planned, in-progress or blocked. A milestone becomes done only ' +
          'through complete_milestone, which verifies it first.',
        parameters: {
          type: 'object',
          properties: { id: strProp('Milestone id, e.g. "m2".'), status: { type: 'string', enum: SETTABLE_MILESTONE_STATUSES } },
          required: ['id', 'status'],
        },
      },
      run: async (args, ctx) => {
        const bundle = needBundle(ctx);
        const id = str(args, 'id');
        const status = oneOf(args, 'status', MILESTONE_STATUSES) as MilestoneStatus;
        if (status === 'done') return 'error: use complete_milestone';
        const milestones = await bundle.roadmap();
        if (!milestones.some((m) => m.id === id)) throw new Error(`unknown milestone: ${id}`);
        // Starting a milestone records where the bundle stood, so its verification can review what
        // changed since rather than the whole workspace.
        const patch = status === 'in-progress' ? { status, startedCommit: await bundle.head() } : { status };
        await bundle.writeRoadmap(patchMilestone(milestones, id, patch));
        await bundle.commit(`${prefix}milestone ${id} ${status}`);
        return `milestone ${id} is now ${status}`;
      },
    },
    {
      def: {
        type: 'tool', name: 'list_docs', description: 'List the documentation pages and the index that links them.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      run: async (_args, ctx) => {
        const { index, pages } = await needBundle(ctx).docs();
        const list = pages.length ? pages.map((p) => `- ${p.slug}: ${p.title}`) : ['(no pages yet)'];
        return [`# index.md`, index.trim(), ``, `# pages`, ...list].join('\n');
      },
    },
    {
      def: {
        type: 'tool', name: 'read_doc', description: 'Read one documentation page.',
        parameters: { type: 'object', properties: { page: strProp('Page slug, without the .md.') }, required: ['page'] },
      },
      run: async (args, ctx) => {
        const page = docSlug(args);
        return (await needBundle(ctx).doc(page)) ?? `error: no such page: ${page}`;
      },
    },
    {
      def: {
        type: 'tool', name: 'write_doc',
        description: 'Write a documentation page (creating it, and linking it from docs/index.md).',
        parameters: {
          type: 'object',
          properties: { page: strProp('Page slug, kebab-case, without the .md.'), markdown: strProp('Full page markdown.') },
          required: ['page', 'markdown'],
        },
      },
      run: async (args, ctx) => {
        const bundle = needBundle(ctx);
        const page = docSlug(args);
        await bundle.writeDoc(page, str(args, 'markdown'));
        await bundle.commit(`${prefix}write doc ${page}`);
        return `docs/${page}.md written`;
      },
    },
    {
      def: {
        type: 'tool', name: 'write_code_map',
        description: `Replace the code map (docs/${CODE_MAP_PAGE}.md): the reader's way into this codebase, chapters from the ` +
          'entry points down, every item a `path:line` link the owner can click open. Write the whole page; it replaces ' +
          `what is there. Keep it under ${CODE_MAP_MAX_LINES} lines.`,
        parameters: { type: 'object', properties: { markdown: strProp('The whole code map as markdown.') }, required: ['markdown'] },
      },
      run: async (args, ctx) => {
        const bundle = needBundle(ctx);
        const markdown = str(args, 'markdown');
        await bundle.writeDoc(CODE_MAP_PAGE, markdown.endsWith('\n') ? markdown : `${markdown}\n`);
        await bundle.commit(`${prefix}write code map`);
        return `docs/${CODE_MAP_PAGE}.md written (${markdown.split('\n').length} lines)`;
      },
    },
  ];
}

/** The page slug off a doc tool call, checked here so a bad one reads as a tool error. */
function docSlug(args: unknown): string {
  const page = str(args, 'page');
  if (!DOC_SLUG_RE.test(page)) throw new Error('page must be kebab-case [a-z0-9-]{1,60}');
  return page;
}

// --- hub tools --------------------------------------------------------------

const JOB_TYPES = ['llm-session', 'image-gen', 'video-gen', 'shell-task', 'browser-lease'] as const satisfies readonly JobType[];
const TIERS = ['orchestrator', 'worker', 'vision', 'video-gen'] as const satisfies readonly Tier[];
const PRIORITIES = ['interactive', 'project', 'batch'] as const satisfies readonly Priority[];

export function hubTools(): Tool[] {
  return [
    {
      def: {
        type: 'tool', name: 'submit_job', description: 'Enqueue a job for a node daemon to run.',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: [...JOB_TYPES] },
            tier: { type: 'string', enum: [...TIERS] },
            priority: { type: 'string', enum: [...PRIORITIES] },
            project: strProp('Optional project slug.'),
            payload: { type: 'object', description: 'Job-type specific payload.' },
          },
          required: ['type', 'tier', 'priority', 'payload'],
        },
      },
      run: async (args, ctx) => {
        const job = needHub(ctx).queue.enqueue({
          type: oneOf(args, 'type', JOB_TYPES),
          tier: oneOf(args, 'tier', TIERS),
          priority: oneOf(args, 'priority', PRIORITIES),
          project: optStr(args, 'project'),
          payload: fields(args).payload,
        });
        return `job ${job.id} queued`;
      },
    },
    {
      def: {
        type: 'tool', name: 'list_nodes', description: 'List the currently online compute nodes and the tiers they serve.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      run: async (_args, ctx) => {
        const nodes = needHub(ctx).nodes.online().map((n) => ({
          name: n.name, arch: n.arch, tiers: n.endpoints.map((e) => e.tier), jobTypes: n.jobTypes,
        }));
        return nodes.length ? JSON.stringify(nodes, null, 2) : '(no nodes online)';
      },
    },
  ];
}

// --- delegation -------------------------------------------------------------

const SUBAGENT_RESULT_LIMIT = 4000;

export interface SubagentDeps {
  loop: AgentLoop;
  subject: string;
  /**
   * The project's model policy — `runSubagent` resolves it for the worker tier, letting a member's
   * own `model` override it. Absent (on both), the gateway's own ordering.
   */
  modelPolicy?: ModelPolicy;
  /** Notified with (memberId, busy) whenever a subagent run for a roster member starts or ends. */
  onBusy?: (memberId: string, busy: boolean) => void;
  /** The hub's own door, which an external harness calls models through; absent, pi is refused. */
  door?: HarnessDoor;
}

export interface SubagentRun {
  role: SubagentRole;
  /** The roster member the run is attributed to; absent when the roster has nobody with the role. */
  member?: TeamMember;
  task: string;
  /** Tools beyond the workspace ones (the browser, the external belt). */
  extras?: Tool[];
  /**
   * Overrides the tool belt entirely, in place of `workspaceTools() + extras` — the milestone
   * reviewer runs with this, so it gets `read_file`/`list_dir` and never `write_file`/`run_shell`.
   */
  tools?: Tool[];
}

export interface SubagentOutcome extends AgentRunResult {
  /** Workspace-relative paths the subagent wrote, in first-written order. */
  filesWritten: string[];
}

/**
 * Runs one ephemeral subagent session inline (awaited) on the worker tier, with workspace tools
 * only (plus `extras`), bracketed by `subagent-start`/`subagent-end` events on the caller's sink
 * with the child's own events forwarded in between. Both `spawn_subagent` and the milestone
 * reviewer come through here, so every delegated run looks the same in the turn feed.
 */
export async function runSubagent(deps: SubagentDeps, ctx: ToolContext, run: SubagentRun): Promise<SubagentOutcome> {
  const { member, role } = run;
  const who = member?.id ?? role;
  ctx.onEvent?.({ kind: 'subagent-start', who, name: member?.name ?? role, role, task: clip(run.task, EVENT_TASK_LIMIT) });
  const startedAt = Date.now();
  // A member's own model override wins over the project's; falling back to it is what makes an
  // unoverridden employee run on the project's policy same as before.
  const route = routeFor(member?.model ?? deps.modelPolicy, 'worker');
  // Which runtime executes the task (FR-G1). `builtin` is this function's own behaviour, unchanged;
  // anything else runs the same assignment elsewhere and reports back through the same events.
  const { harness } = await selectHarness({
    loop: deps.loop,
    extras: run.extras ?? [],
    pinnedTools: !!run.tools,
    tools: (onWrite) => run.tools ?? [...workspaceTools({ onWrite }), ...(run.extras ?? [])],
    log: ctx.log,
    ...(ctx.bundle ? { bundle: ctx.bundle } : {}),
    ...(member ? { member, onBusy: (busy: boolean) => deps.onBusy?.(member.id, busy) } : {}),
    ...(route ? { route } : {}),
    ...(deps.door ? { door: deps.door } : {}),
  });
  const res = await harness.run({
    workspace: ctx.bundle?.workspace ?? process.cwd(),
    task: run.task,
    role,
    // A pinned belt is today only ever the milestone reviewer's read-only one; the policy says so
    // for a harness that reads `tools` rather than being handed the belt itself.
    tools: run.tools ? 'read-only' : 'workspace',
    budget: { toolCalls: SUBAGENT_TOOL_CALLS, wallClockMs: HARNESS_WALL_CLOCK_MS },
    ...(member?.instructions ? { instructions: member.instructions } : {}),
    ...(member ? { member } : {}),
    ...(route ? { route } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  }, { who, subject: deps.subject, log: ctx.log, ...(ctx.onEvent ? { onEvent: ctx.onEvent } : {}) });
  ctx.onEvent?.({ kind: 'subagent-end', who, outcome: res.outcome, ms: Date.now() - startedAt });
  return {
    sessionId: res.sessionId,
    text: res.report,
    toolCalls: res.toolCalls,
    outcome: res.outcome,
    truncated: res.truncated ?? false,
    filesWritten: res.filesWritten,
    ...(res.lastTool ? { lastTool: res.lastTool } : {}),
  };
}

/**
 * Delegates one task to a subagent and hands its final report back as the tool result, ending with
 * the files it wrote. Parallel fan-out is a later optimization; the caller's tool budget is what
 * bounds how many of these a turn can start.
 */
export function spawnSubagentTool(deps: SubagentDeps & { browser?: BrowserToolDeps; external?: Tool[]; media?: MediaDesk }): Tool {
  return {
    def: {
      type: 'tool', name: 'spawn_subagent',
      description: 'Delegate one self-contained task to an ephemeral subagent and get its report back, ending with a ' +
        '"Files written:" line naming what it changed in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          task: strProp('The whole assignment: what to do, which files, and how it will be judged done.'),
          role: { type: 'string', enum: [...SUBAGENT_ROLES], description: 'Subagent role; defaults to coder.' },
          member: strProp('Id of the team member to give this task to; defaults to the first member with the role.'),
        },
        required: ['task'],
      },
    },
    run: async (args, ctx) => {
      const task = str(args, 'task');
      const wantedRole = fields(args).role === undefined ? 'coder' : oneOf(args, 'role', SUBAGENT_ROLES);
      const memberId = optStr(args, 'member');
      const team = ctx.bundle ? await ctx.bundle.team() : [];
      // A named member brings their own role and instructions; otherwise the role picks the member,
      // so every subagent session is still attributed to someone on the roster when there is one.
      const member = memberId ? team.find((m) => m.id === memberId) : team.find((m) => m.role === wantedRole);
      if (memberId && !member) return `error: unknown team member: ${memberId}`;
      const role = member?.role ?? wantedRole;
      if (role === 'browser-operator' && !deps.browser) return 'error: browser-operator is not available in this session';
      // browser-operator additionally gets the shared browser toolset and a researcher the
      // configured external tools; every other role stays scoped to the workspace, as before. On top
      // of the role, an employee gets a render tool per media ability (decision 0073) — a designer
      // with no `abilities` set still gets both.
      const roleExtras = role === 'browser-operator' && deps.browser ? browserOperatorTools(deps.browser)
        : role === 'researcher' ? (deps.external ?? [])
        : [];
      const kinds = memberAbilities(member ?? { role });
      const extras = deps.media && kinds.length ? [...roleExtras, ...mediaTools(deps.media, { kinds })] : roleExtras;
      const res = await runSubagent(deps, ctx, { role, member, task, extras });
      const text = res.text.trim();
      const report = text ? truncateResult(text, SUBAGENT_RESULT_LIMIT)
        : res.outcome === 'aborted' ? `subagent ${role} was cut short (the hub stopped, or the turn hit its time limit) without a report`
        : `subagent ${role} ended (${res.outcome}) without a report`;
      return `${report}\n\nFiles written: ${res.filesWritten.length ? res.filesWritten.join(', ') : '(none)'}`;
    },
  };
}
