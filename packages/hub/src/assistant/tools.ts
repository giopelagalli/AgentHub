import { VIDEO_ASPECTS, VIDEO_MODES, VIDEO_RESOLUTIONS, videoPayloadFrom, type Job, type JobSpec } from '@agenthub/shared';
import type { Tool } from '../agents/tools.js';
import type { NodeRegistry } from '../node-registry.js';
import type { MasterOrchestrator } from '../projects/master.js';
import type { ProjectService } from '../projects/service.js';
import type { ConfirmationGate } from './confirm.js';
import type { MemoryStore, NoteType } from './memory.js';
import type { Planner, PlannerList } from './planner.js';

const NOTE_TYPES = ['person', 'preference', 'routine', 'goal', 'fact', 'reference'] as const satisfies readonly NoteType[];
const LISTS = ['goals', 'todo', 'backlog'] as const satisfies readonly PlannerList[];

const strProp = (description: string) => ({ type: 'string', description });

function fields(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
}

function str(args: unknown, key: string): string {
  const v = fields(args)[key];
  if (typeof v !== 'string' || !v) throw new Error(`${key} must be a non-empty string`);
  return v;
}

function optStr(args: unknown, key: string): string | undefined {
  const v = fields(args)[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`${key} must be a string`);
  return v;
}

function num(args: unknown, key: string): number {
  const v = fields(args)[key];
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(`${key} must be an integer`);
  return v;
}

function oneOf<T extends string>(args: unknown, key: string, allowed: readonly T[]): T {
  const v = str(args, key);
  if (!allowed.includes(v as T)) throw new Error(`${key} must be one of: ${allowed.join(', ')}`);
  return v as T;
}

const LIST_PARAM = { type: 'object', properties: { list: { type: 'string', enum: [...LISTS] } }, required: ['list'] };
const SLUG_PARAM = { type: 'object', properties: { slug: strProp('Project slug.') }, required: ['slug'] };
const NO_PARAMS = { type: 'object', properties: {}, required: [] };

/** The slice of the job queue the video tools need. */
export interface JobsAccess {
  enqueue(spec: JobSpec): Job;
  get(id: number): Job | null;
}

export interface AssistantToolDeps {
  memory: MemoryStore;
  planner: Planner;
  service: ProjectService;
  master: MasterOrchestrator;
  gate: ConfirmationGate;
  registry: NodeRegistry;
  jobs: JobsAccess;
}

/**
 * The assistant's tool belt: the owner's memory and planner, the project fleet, and one outward
 * action that demonstrates the confirmation gate.
 *
 * Everything here acts on the owner's own hub, so it runs immediately. Anything that would leave it
 * must be flagged `outward` and go through `gate.propose` instead — Phase 6's X posting plugs in
 * where `demo_outward_action` sits.
 */
export function assistantTools(deps: AssistantToolDeps): Tool[] {
  const { memory, planner, service, master, gate, registry, jobs } = deps;
  return [
    {
      def: {
        type: 'tool', name: 'remember',
        description: 'Write a durable fact about the owner to memory, creating or replacing one note.',
        parameters: {
          type: 'object',
          properties: {
            name: strProp('Short title for the note; reusing an existing title updates that note.'),
            description: strProp('One-line hook for the memory index.'),
            type: { type: 'string', enum: [...NOTE_TYPES] },
            body: strProp('The note itself, in markdown.'),
          },
          required: ['name', 'description', 'type', 'body'],
        },
      },
      run: async (args) => {
        const meta = await memory.remember({
          name: str(args, 'name'), description: str(args, 'description'),
          type: oneOf(args, 'type', NOTE_TYPES), body: str(args, 'body'),
        });
        return `remembered ${meta.name}`;
      },
    },
    {
      def: {
        type: 'tool', name: 'recall', description: 'Search memory notes for a phrase and read back the matches.',
        parameters: { type: 'object', properties: { query: strProp('Phrase to look for.') }, required: ['query'] },
      },
      run: async (args) => {
        const hits = await memory.recall(str(args, 'query'));
        if (!hits.length) return '(no matching notes)';
        return hits.map((h) => `- ${h.name} — ${h.description}\n  ${h.snippet}`).join('\n');
      },
    },
    {
      def: { type: 'tool', name: 'list_memory_index', description: 'Read the memory index (one line per note).', parameters: NO_PARAMS },
      run: async () => memory.indexText(),
    },
    {
      def: {
        type: 'tool', name: 'planner_add', description: 'Append an item to one of the owner\'s planner lists.',
        parameters: {
          type: 'object',
          properties: { list: { type: 'string', enum: [...LISTS] }, text: strProp('The item.') },
          required: ['list', 'text'],
        },
      },
      run: async (args) => {
        const which = oneOf(args, 'list', LISTS);
        return `${which} #${await planner.add(which, str(args, 'text'))} added`;
      },
    },
    {
      def: {
        type: 'tool', name: 'planner_complete', description: 'Tick off item n of a planner list.',
        parameters: {
          type: 'object',
          properties: { list: { type: 'string', enum: [...LISTS] }, n: { type: 'number', description: '1-based item number.' } },
          required: ['list', 'n'],
        },
      },
      run: async (args) => {
        const which = oneOf(args, 'list', LISTS);
        const n = num(args, 'n');
        if (!(await planner.complete(which, n))) throw new Error(`${which} has no item ${n}`);
        return `${which} #${n} done`;
      },
    },
    {
      def: { type: 'tool', name: 'planner_list', description: 'Read one planner list, done items included.', parameters: LIST_PARAM },
      run: async (args) => {
        const items = await planner.list(oneOf(args, 'list', LISTS));
        return items.length ? items.map((i) => `${i.n}. [${i.done ? 'x' : ' '}] ${i.text}`).join('\n') : '(empty)';
      },
    },
    {
      def: { type: 'tool', name: 'list_projects', description: 'List every project with its status and priority.', parameters: NO_PARAMS },
      run: async () => {
        const manifests = await service.list();
        if (!manifests.length) return '(no projects yet)';
        return manifests.map((m) => `- ${m.slug}: ${m.title} — ${m.status}, ${m.priority}`).join('\n');
      },
    },
    {
      def: {
        type: 'tool', name: 'create_project', description: 'Create a new project bundle and start it active.',
        parameters: {
          type: 'object',
          properties: {
            slug: strProp('Kebab-case identifier, [a-z0-9-]{1,40}.'),
            title: strProp('Human-readable project title.'),
            intent: strProp("The owner's intent for this project, in one or two sentences."),
          },
          required: ['slug', 'title', 'intent'],
        },
      },
      run: async (args) => {
        const manifest = await service.create({
          slug: str(args, 'slug'), title: str(args, 'title'), intent: str(args, 'intent'),
        });
        return `project ${manifest.slug} created (${manifest.priority})`;
      },
    },
    {
      def: { type: 'tool', name: 'pause_project', description: 'Pause a project: it stops being scheduled for turns.', parameters: SLUG_PARAM },
      run: async (args) => `project ${(await service.pause(str(args, 'slug'))).slug} paused`,
    },
    {
      def: { type: 'tool', name: 'resume_project', description: 'Resume a paused project so it is scheduled again.', parameters: SLUG_PARAM },
      run: async (args) => `project ${(await service.resume(str(args, 'slug'))).slug} resumed`,
    },
    {
      def: {
        type: 'tool', name: 'run_project_turn', description: 'Run one orchestrator turn on a project now and read back its briefing.',
        parameters: {
          type: 'object',
          properties: { slug: strProp('Project slug.'), instruction: strProp('Optional instruction for this turn.') },
          required: ['slug'],
        },
      },
      run: async (args) => {
        const briefing = await service.runTurn(str(args, 'slug'), optStr(args, 'instruction'));
        return `turn complete for ${briefing.slug}: ${briefing.summary}`;
      },
    },
    {
      def: {
        type: 'tool', name: 'get_daily_briefing',
        description: "The master orchestrator's briefing across every project.", parameters: NO_PARAMS,
      },
      run: async () => (await master.dailyBriefing()).text,
    },
    {
      def: { type: 'tool', name: 'list_nodes', description: 'List the currently online compute nodes and the tiers they serve.', parameters: NO_PARAMS },
      run: async () => {
        const nodes = registry.online().map((n) => ({
          name: n.name, arch: n.arch, tiers: n.endpoints.map((e) => e.tier), jobTypes: n.jobTypes,
        }));
        return nodes.length ? JSON.stringify(nodes, null, 2) : '(no nodes online)';
      },
    },
    {
      def: {
        type: 'tool', name: 'generate_video',
        description: 'Queue a video generation job on the cluster. It runs for minutes, so this returns a job id — read it back later with get_job.',
        parameters: {
          type: 'object',
          properties: {
            prompt: strProp('What the clip should show.'),
            mode: { type: 'string', enum: [...VIDEO_MODES], description: 'Defaults to t2v (text to video).' },
            durationSec: { type: 'number', description: 'Clip length, 4-15 seconds. Defaults to 6.' },
            aspect: { type: 'string', enum: [...VIDEO_ASPECTS] },
            resolution: { type: 'string', enum: [...VIDEO_RESOLUTIONS] },
            imagePath: strProp('Source image, for the i2v and ref2v modes.'),
            project: strProp('Project slug the clip belongs to; omitted, it lands in memory media/.'),
          },
          required: ['prompt'],
        },
      },
      run: async (args) => {
        const { project, ...rest } = fields(args);
        const payload = videoPayloadFrom(rest);
        if (!payload) throw new Error('invalid video payload');
        const job = jobs.enqueue({
          type: 'video-gen', tier: 'video-gen', priority: 'batch', payload,
          ...(typeof project === 'string' && project ? { project } : {}),
        });
        return `queued video job ${job.id}`;
      },
    },
    {
      def: {
        type: 'tool', name: 'get_job', description: 'Read one job\'s status, result or error by id.',
        parameters: { type: 'object', properties: { id: { type: 'number', description: 'Job id.' } }, required: ['id'] },
      },
      run: async (args) => {
        const id = num(args, 'id');
        const job = jobs.get(id);
        if (!job) throw new Error(`no job ${id}`);
        return JSON.stringify({ id: job.id, type: job.type, status: job.status, result: job.result, error: job.error });
      },
    },
    {
      def: {
        type: 'tool', name: 'demo_outward_action',
        description: 'Stand-in for a real outward action (posting, emailing). Proposes it for the owner to confirm; it does not happen until they do.',
        parameters: { type: 'object', properties: { text: strProp('What would be sent.') }, required: ['text'] },
      },
      outward: true,
      run: async (args) => {
        const text = str(args, 'text');
        const action = gate.propose(`send "${text}"`, async () => `sent: ${text}`);
        return `pending confirmation ${action.id}`;
      },
    },
  ];
}
