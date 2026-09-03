import { PRIORITY_RANK, type Priority } from '@agenthub/shared';
import type { AgentLoop } from '../agents/loop.js';
import type { Tool } from '../agents/tools.js';
import type { ProjectService, BriefingDoc } from './service.js';
import { SLUG_RE, type Briefing, type Manifest } from './schema.js';

const SUBJECT = 'master';
const BRIEF_LIMIT = 1500;
const COMMAND_TOOL_CALLS = 8;
const PRIORITIES = Object.keys(PRIORITY_RANK) as Priority[];

const NEVER_RAW_CONTEXT = [
  `You never see a project's raw context — no workspace files, no charters, no task boards, no`,
  `agent transcripts. Project orchestrators own that; you read only the briefings they publish.`,
  `If a question needs more than the briefings say, ask for a turn rather than inventing an answer.`,
].join(' ');

const strProp = (description: string) => ({ type: 'string', description });

function field(args: unknown, key: string): unknown {
  return args && typeof args === 'object' ? (args as Record<string, unknown>)[key] : undefined;
}

function str(args: unknown, key: string): string {
  const v = field(args, key);
  if (typeof v !== 'string' || !v) throw new Error(`${key} must be a non-empty string`);
  return v;
}

function slug(args: unknown): string {
  const v = str(args, 'slug');
  if (!SLUG_RE.test(v)) throw new Error(`slug must match ${SLUG_RE.source}`);
  return v;
}

function priority(args: unknown, key: string): Priority {
  const v = str(args, key);
  if (!PRIORITIES.includes(v as Priority)) throw new Error(`${key} must be one of: ${PRIORITIES.join(', ')}`);
  return v as Priority;
}

const SLUG_PARAM = { type: 'object', properties: { slug: strProp('Project slug.') }, required: ['slug'] };

/**
 * The master's lifecycle tools. Each records its name in `actions` so the caller can report what the
 * command actually did, and returns one line of confirmation — never project context.
 */
function masterTools(service: ProjectService, actions: string[]): Tool[] {
  // Recorded only once the tool has actually succeeded: a rejected call (unknown slug, bad
  // priority) comes back to the model as `error: …` and changed nothing, so it is not an action.
  const track = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const result = await run();
    actions.push(name);
    return result;
  };
  return [
    {
      def: {
        type: 'tool', name: 'create_project', description: 'Create a new project bundle and start it active.',
        parameters: {
          type: 'object',
          properties: {
            slug: strProp('Kebab-case identifier, [a-z0-9-]{1,40}.'),
            title: strProp('Human-readable project title.'),
            intent: strProp("The owner's intent for this project, in one or two sentences."),
            priority: { type: 'string', enum: [...PRIORITIES], description: 'Defaults to project.' },
          },
          required: ['slug', 'title', 'intent'],
        },
      },
      run: async (args) => track('create_project', async () => {
        const p = field(args, 'priority') === undefined ? undefined : priority(args, 'priority');
        const manifest = await service.create({
          slug: slug(args), title: str(args, 'title'), intent: str(args, 'intent'), ...(p ? { priority: p } : {}),
        });
        return `project ${manifest.slug} created (${manifest.priority})`;
      }),
    },
    {
      def: { type: 'tool', name: 'pause_project', description: 'Pause a project: it stops being scheduled for turns.', parameters: SLUG_PARAM },
      run: async (args) => track('pause_project', async () => `project ${(await service.pause(slug(args))).slug} paused`),
    },
    {
      def: { type: 'tool', name: 'resume_project', description: 'Resume a paused project so it is scheduled again.', parameters: SLUG_PARAM },
      run: async (args) => track('resume_project', async () => `project ${(await service.resume(slug(args))).slug} resumed`),
    },
    {
      def: {
        type: 'tool', name: 'set_priority', description: 'Change a project priority (it orders scheduled turns).',
        parameters: {
          type: 'object',
          properties: { slug: strProp('Project slug.'), priority: { type: 'string', enum: [...PRIORITIES] } },
          required: ['slug', 'priority'],
        },
      },
      run: async (args) => track('set_priority', async () => {
        const manifest = await service.setPriority(slug(args), priority(args, 'priority'));
        return `project ${manifest.slug} priority set to ${manifest.priority}`;
      }),
    },
    {
      def: {
        type: 'tool', name: 'run_turn', description: 'Run one orchestrator turn on a project now and read back its briefing.',
        parameters: {
          type: 'object',
          properties: { slug: strProp('Project slug.'), instruction: strProp('Optional instruction for this turn.') },
          required: ['slug'],
        },
      },
      run: async (args) => track('run_turn', async () => {
        const instruction = field(args, 'instruction');
        const briefing = await service.runTurn(slug(args), typeof instruction === 'string' ? instruction : undefined);
        return `turn complete for ${briefing.slug}: ${briefing.summary}`;
      }),
    },
  ];
}

function roster(manifests: Manifest[]): string {
  if (!manifests.length) return '(no projects yet)';
  return manifests.map((m) => `- ${m.slug}: ${m.title} — ${m.status}, ${m.priority}`).join('\n');
}

function briefSystemPrompt(): string {
  return [
    `You are the master orchestrator of AgentHub. You supervise one orchestrator per active project`,
    `and report to the owner.`,
    ``,
    NEVER_RAW_CONTEXT,
    ``,
    `Write the owner's briefing: what moved, what is blocked, and what needs a decision. Prose, no`,
    `headings, no bullet lists, at most 1500 characters. Name every project you mention by its title.`,
    `Say plainly when a project reported nothing worth relaying.`,
  ].join('\n');
}

function commandSystemPrompt(manifests: Manifest[]): string {
  return [
    `You are the master orchestrator of AgentHub, acting on a command from the owner.`,
    ``,
    NEVER_RAW_CONTEXT,
    ``,
    `Use your tools to carry out the command, then reply in one or two sentences saying what you did.`,
    `Resolve a project the owner names loosely to its slug using the roster below. If the command is`,
    `ambiguous or names no project you know, change nothing and say so.`,
    ``,
    `# Projects`,
    roster(manifests),
  ].join('\n');
}

function briefingInput(docs: BriefingDoc[]): string {
  if (!docs.length) return 'No project has published a briefing yet.';
  return [
    `# Latest briefings (JSON)`,
    JSON.stringify(docs.map((d) => d.briefing), null, 2),
    ``,
    `# Latest briefings (prose)`,
    ...docs.map((d) => d.md.trim()),
  ].join('\n');
}

/** The last-resort briefing: what the owner still needs to see when the model returns nothing. */
function templatedSummary(briefings: Briefing[]): string {
  if (!briefings.length) return 'No project has published a briefing yet.';
  return [
    'Projects:',
    ...briefings.map((b) => `- ${b.title} — ${b.status}, ${b.progress.done}/${b.progress.total} done`),
  ].join('\n');
}

/**
 * The always-on supervisor. Its whole view of the fleet is the briefings project orchestrators
 * publish, so it can be cheap and short-lived per invocation while the projects stay long-lived.
 */
export class MasterOrchestrator {
  constructor(private deps: { service: ProjectService; loop: AgentLoop }) {}

  async dailyBriefing(): Promise<{ text: string; briefings: Briefing[] }> {
    const docs = await this.deps.service.briefingDocs();
    const briefings = docs.map((d) => d.briefing);
    const result = await this.deps.loop.run({
      kind: 'master', subject: SUBJECT, tier: 'orchestrator',
      system: briefSystemPrompt(),
      user: briefingInput(docs),
      tools: [],
      ctx: {},
      maxToolCalls: 0,
    });
    const text = (result.text.trim() || templatedSummary(briefings)).slice(0, BRIEF_LIMIT);
    return { text, briefings };
  }

  async command(text: string): Promise<{ text: string; actions: string[] }> {
    const actions: string[] = [];
    const result = await this.deps.loop.run({
      kind: 'master', subject: SUBJECT, tier: 'orchestrator',
      system: commandSystemPrompt(await this.deps.service.list()),
      user: text,
      tools: masterTools(this.deps.service, actions),
      ctx: {},
      maxToolCalls: COMMAND_TOOL_CALLS,
    });
    return { text: result.text.trim(), actions };
  }
}
