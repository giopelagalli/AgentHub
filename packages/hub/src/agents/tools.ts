import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveWorkspace, type JobType, type Priority, type Tier, type ToolCall, type ToolDef } from '@agenthub/shared';
import type { JobQueue } from '../queue.js';
import type { NodeRegistry } from '../node-registry.js';
import type { ProjectBundle } from '../projects/bundle.js';
import { validateBriefing, type Briefing, type TaskItem } from '../projects/schema.js';

const TOOL_RESULT_LIMIT = 8000;
const TRUNCATION_MARKER = '\n[truncated]';
const SHELL_TIMEOUT_MS = 60_000;
const OUTPUT_TAIL = 4000;

export interface HubDeps {
  queue: JobQueue;
  nodes: NodeRegistry;
}

export interface ToolContext {
  bundle?: ProjectBundle;
  hub: HubDeps;
  sessionId: number;
  log(line: string): void;
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

// Workspace paths resolve inside `<bundle>/workspace`; `'.'` stands in for the daemon's per-project
// segment because the bundle workspace is already project-scoped.
function inWorkspace(ctx: ToolContext, path: string | undefined): string {
  return resolveWorkspace(needBundle(ctx).workspace, '.', path);
}

const strProp = (description: string) => ({ type: 'string', description });

// --- workspace tools --------------------------------------------------------

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
        const cmd = strArray(args, 'cmd');
        const cwd = inWorkspace(ctx, optStr(args, 'cwd'));
        const timeoutRaw = fields(args).timeoutMs;
        const timeoutMs = typeof timeoutRaw === 'number' && timeoutRaw > 0 ? timeoutRaw : SHELL_TIMEOUT_MS;
        return runShell(cmd, cwd, timeoutMs, ctx.log);
      },
    },
  ];
}

function runShell(cmd: string[], cwd: string, timeoutMs: number, log: (line: string) => void): Promise<string> {
  mkdirSync(cwd, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], cmd.slice(1), { cwd });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);

    // Best-effort progress lines: a chunk boundary can split a line, which is fine for a log.
    const collect = (prefix: 'out' | 'err') => (chunk: Buffer) => {
      const text = chunk.toString();
      if (prefix === 'out') stdout = (stdout + text).slice(-OUTPUT_TAIL);
      else stderr = (stderr + text).slice(-OUTPUT_TAIL);
      for (const line of text.split('\n')) if (line.trim()) log(`${prefix}: ${line}`);
    };
    child.stdout.on('data', collect('out'));
    child.stderr.on('data', collect('err'));

    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const lines = [timedOut ? `timed out after ${timeoutMs}ms` : `exit: ${code ?? `killed (${signal})`}`];
      if (stdout.trim()) lines.push(`stdout:\n${stdout.trimEnd()}`);
      if (stderr.trim()) lines.push(`stderr:\n${stderr.trimEnd()}`);
      resolve(lines.join('\n'));
    });
  });
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
            slug: strProp('Project slug.'), title: strProp('Project title.'),
            status: { type: 'string', enum: ['active', 'paused', 'blocked', 'done'] },
            priority: { type: 'string', enum: ['interactive', 'project', 'batch'] },
            summary: strProp('At most 600 characters.'),
            progress: { type: 'object', properties: { done: { type: 'number' }, total: { type: 'number' } }, required: ['done', 'total'] },
            blockers: { type: 'array', items: { type: 'string' } },
            nextSteps: { type: 'array', items: { type: 'string' } },
            updatedAt: { type: 'number', description: 'Epoch ms; defaults to now.' },
          },
          required: ['slug', 'title', 'status', 'priority', 'summary', 'progress', 'blockers', 'nextSteps'],
        },
      },
      run: async (args, ctx) => {
        const bundle = needBundle(ctx);
        const briefing = { updatedAt: Date.now(), ...fields(args) };
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

// spawn_subagent joins this registry in Task 4, once the subagent runner exists.
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
        const job = ctx.hub.queue.enqueue({
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
        const nodes = ctx.hub.nodes.online().map((n) => ({
          name: n.name, arch: n.arch, tiers: n.endpoints.map((e) => e.tier), jobTypes: n.jobTypes,
        }));
        return nodes.length ? JSON.stringify(nodes, null, 2) : '(no nodes online)';
      },
    },
  ];
}
