import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { JobResult, JobType, Priority, Tier, ToolCall, ToolDef } from '@agenthub/shared';
import { resolveWorkspace, runShellTask } from '@agenthub/shared/shell';
import type { JobQueue } from '../queue.js';
import type { NodeRegistry } from '../node-registry.js';
import type { ProjectBundle } from '../projects/bundle.js';
import { subagentSystemPrompt, SUBAGENT_ROLES } from '../projects/prompts.js';
import { validateBriefing, type Briefing, type TaskItem } from '../projects/schema.js';
import type { AgentLoop } from './loop.js';

const TOOL_RESULT_LIMIT = 8000;
const TRUNCATION_MARKER = '\n[truncated]';
const SHELL_TIMEOUT_MS = 60_000;

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
}

export interface Tool {
  def: ToolDef;
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
    return truncate(await tool.run(args, ctx));
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

function truncate(text: string): string {
  if (text.length <= TOOL_RESULT_LIMIT) return text;
  return text.slice(0, TOOL_RESULT_LIMIT - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
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

// Workspace paths resolve inside `<bundle>/workspace`; `'.'` stands in for the daemon's per-project
// segment because the bundle workspace is already project-scoped.
function inWorkspace(ctx: ToolContext, path: string | undefined): string {
  return resolveWorkspace(needBundle(ctx).workspace, '.', path);
}

const strProp = (description: string) => ({ type: 'string', description });

// --- workspace tools --------------------------------------------------------

/**
 * File and shell tools scoped to `<bundle>/workspace`.
 *
 * The scoping is *cwd-scoping, not containment*: `resolveWorkspace` is a lexical check on the
 * requested path (no realpath, so a symlink inside the workspace still points out of it), and a
 * command the model runs — `sh -c ...` above all — can read and write anything the hub's OS user
 * can. Real isolation has to come from running these tools under a sandboxed user or container.
 */
export function workspaceTools(): Tool[] {
  return [
    {
      def: {
        type: 'tool', name: 'read_file', description: 'Read a UTF-8 file from the project workspace.',
        parameters: { type: 'object', properties: { path: strProp('Path relative to the workspace root.') }, required: ['path'] },
      },
      run: async (args, ctx) => readFile(inWorkspace(ctx, str(args, 'path')), 'utf8'),
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
        description: 'Run a command (argv form, no shell) in the project workspace and return its exit code and output tail.',
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
        const timeoutRaw = fields(args).timeoutMs;
        const timeoutMs = typeof timeoutRaw === 'number' && timeoutRaw > 0 ? timeoutRaw : SHELL_TIMEOUT_MS;
        const result = await runShellTask(
          { cmd: strArray(args, 'cmd'), cwd: optStr(args, 'cwd'), timeoutMs },
          // `'.'` as the project segment: the bundle workspace is already project-scoped, so the
          // sandbox root is the workspace itself.
          { workspaceRoot: needBundle(ctx).workspace, project: '.', onLine: ctx.log, signal: ctx.signal },
        );
        return renderShellResult(result, timeoutMs);
      },
    },
  ];
}

function renderShellResult(result: JobResult, timeoutMs: number): string {
  const head = result.timedOut
    ? `error: timed out after ${timeoutMs}ms`
    : result.signal === 'aborted'
      ? 'error: aborted'
      : `exit: ${result.exitCode ?? `killed (${result.signal})`}`;
  const lines = [head];
  if (result.stdoutTail?.trim()) lines.push(`stdout:\n${result.stdoutTail.trimEnd()}`);
  if (result.stderrTail?.trim()) lines.push(`stderr:\n${result.stderrTail.trimEnd()}`);
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

export function bundleTools(): Tool[] {
  return [
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
            updatedAt: { type: 'number', description: 'Epoch ms; defaults to now.' },
          },
          required: ['title', 'status', 'priority', 'summary', 'progress', 'blockers', 'nextSteps'],
        },
      },
      run: async (args, ctx) => {
        const bundle = needBundle(ctx);
        const f = fields(args);
        // Only the schema's own keys make it through, and the slug comes from the manifest rather
        // than the model — a briefing filed under another project's slug would mislead the master.
        const briefing = {
          slug: (await bundle.manifest()).slug,
          title: f.title,
          status: f.status,
          priority: f.priority,
          summary: f.summary,
          progress: f.progress,
          blockers: f.blockers,
          nextSteps: f.nextSteps,
          updatedAt: typeof f.updatedAt === 'number' ? f.updatedAt : Date.now(),
        };
        validateBriefing(briefing);
        await bundle.publishBriefing(briefing as Briefing);
        await bundle.commit('agent: publish briefing');
        return 'briefing published';
      },
    },
  ];
}

// --- hub tools --------------------------------------------------------------

const JOB_TYPES = ['llm-session', 'video-gen', 'shell-task', 'browser-lease'] as const satisfies readonly JobType[];
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

const SUBAGENT_TOOL_CALLS = 25;
const SUBAGENT_RESULT_LIMIT = 4000;

/**
 * Runs one ephemeral subagent session inline (awaited) on the worker tier, with workspace tools
 * only, and hands its final report back as the tool result. Parallel fan-out is a later
 * optimization; the caller's tool budget is what bounds how many of these a turn can start.
 */
export function spawnSubagentTool(deps: { loop: AgentLoop; subject: string }): Tool {
  return {
    def: {
      type: 'tool', name: 'spawn_subagent',
      description: 'Delegate one self-contained task to an ephemeral subagent and get its report back.',
      parameters: {
        type: 'object',
        properties: {
          task: strProp('The whole assignment: what to do, which files, and how it will be judged done.'),
          role: { type: 'string', enum: [...SUBAGENT_ROLES], description: 'Subagent role; defaults to coder.' },
        },
        required: ['task'],
      },
    },
    run: async (args, ctx) => {
      const task = str(args, 'task');
      const role = fields(args).role === undefined ? 'coder' : oneOf(args, 'role', SUBAGENT_ROLES);
      const res = await deps.loop.run({
        kind: 'subagent',
        subject: deps.subject,
        tier: 'worker',
        system: subagentSystemPrompt(role),
        user: task,
        tools: workspaceTools(),
        ctx: { bundle: ctx.bundle, hub: ctx.hub },
        maxToolCalls: SUBAGENT_TOOL_CALLS,
        signal: ctx.signal,
        onLog: ctx.log,
      });
      const text = res.text.trim();
      return text ? text.slice(0, SUBAGENT_RESULT_LIMIT) : `subagent ${role} ended (${res.outcome}) without a report`;
    },
  };
}
