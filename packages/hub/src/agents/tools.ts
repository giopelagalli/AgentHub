import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { JobResult, JobType, MilestoneStatus, Priority, Tier, ToolCall, ToolDef } from '@agenthub/shared';
import { MILESTONE_STATUSES, PRD_SECTIONS } from '@agenthub/shared';
import { resolveWorkspace, runShellTask } from '@agenthub/shared/shell';
import type { JobQueue } from '../queue.js';
import type { NodeRegistry } from '../node-registry.js';
import type { ProjectBundle } from '../projects/bundle.js';
import { auditPrd } from '../projects/prd.js';
import { subagentSystemPrompt, SUBAGENT_ROLES } from '../projects/prompts.js';
import { normalizeMilestones, patchMilestone } from '../projects/roadmap.js';
import { DOC_SLUG_RE, validateBriefing, type Briefing, type TaskItem } from '../projects/schema.js';
import { browserOperatorTools, type BrowserToolDeps } from './browser-tools.js';
import type { AgentLoop } from './loop.js';
import type { Route } from '../gateway.js';

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
  /** Leaves the owner's own machines (posting, emailing). Such a tool must propose through the
   *  ConfirmationGate rather than act, so nothing reaches the outside world unconfirmed. */
  outward?: boolean;
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

/** The two document tools a turn gets: it keeps the docs true and moves the roadmap along. */
const TURN_DOC_TOOLS = ['write_doc', 'set_milestone_status'];

export function bundleTools(): Tool[] {
  return [
    ...docTools('agent').filter((t) => TURN_DOC_TOOLS.includes(t.def.name)),
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
        await bundle.commit('agent: publish briefing');
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
        type: 'tool', name: 'set_milestone_status', description: 'Set one roadmap milestone\'s status.',
        parameters: {
          type: 'object',
          properties: { id: strProp('Milestone id, e.g. "m2".'), status: { type: 'string', enum: [...MILESTONE_STATUSES] } },
          required: ['id', 'status'],
        },
      },
      run: async (args, ctx) => {
        const bundle = needBundle(ctx);
        const id = str(args, 'id');
        const status = oneOf(args, 'status', MILESTONE_STATUSES) as MilestoneStatus;
        const milestones = await bundle.roadmap();
        if (!milestones.some((m) => m.id === id)) throw new Error(`unknown milestone: ${id}`);
        await bundle.writeRoadmap(patchMilestone(milestones, id, { status }));
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
  ];
}

/** The page slug off a doc tool call, checked here so a bad one reads as a tool error. */
function docSlug(args: unknown): string {
  const page = str(args, 'page');
  if (!DOC_SLUG_RE.test(page)) throw new Error('page must be kebab-case [a-z0-9-]{1,60}');
  return page;
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
export function spawnSubagentTool(deps: {
  loop: AgentLoop; subject: string; browser?: BrowserToolDeps; external?: Tool[];
  /** The project's model policy resolved for the worker tier; absent, the gateway's own ordering. */
  route?: Route;
  /** Notified with (memberId, busy) whenever a subagent run for a roster member starts or ends. */
  onBusy?: (memberId: string, busy: boolean) => void;
}): Tool {
  return {
    def: {
      type: 'tool', name: 'spawn_subagent',
      description: 'Delegate one self-contained task to an ephemeral subagent and get its report back.',
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
      // browser-operator additionally gets the shared browser toolset, and a researcher gets the
      // configured external tools — every other role stays scoped to the workspace, as before.
      const extras = role === 'browser-operator' && deps.browser ? browserOperatorTools(deps.browser)
        : role === 'researcher' ? (deps.external ?? [])
        : [];
      const tools = [...workspaceTools(), ...extras];
      const res = await deps.loop.run({
        kind: 'subagent',
        subject: deps.subject,
        tier: 'worker',
        system: subagentSystemPrompt(role, extras.map((t) => t.def.name), member?.instructions),
        user: task,
        tools,
        ...(member ? { memberId: member.id, onBusy: (busy: boolean) => deps.onBusy?.(member.id, busy) } : {}),
        ...(deps.route ? { route: deps.route } : {}),
        // No hub: a subagent gets its workspace and nothing else — no queue, no node registry.
        ctx: { bundle: ctx.bundle },
        maxToolCalls: SUBAGENT_TOOL_CALLS,
        signal: ctx.signal,
        onLog: ctx.log,
      });
      const text = res.text.trim();
      if (!text) return `subagent ${role} ended (${res.outcome}) without a report`;
      return text.length <= SUBAGENT_RESULT_LIMIT
        ? text
        : text.slice(0, SUBAGENT_RESULT_LIMIT - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
    },
  };
}
