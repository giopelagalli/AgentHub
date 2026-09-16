import type { ChatMessage, TeamMember } from '@agenthub/shared';
import type { AgentLoop } from '../agents/loop.js';
import { routeFor } from '../gateway.js';
import { docTools, workspaceTools, type Tool } from '../agents/tools.js';
import type { SessionKind, SessionOutcome, Transcript } from '../agents/transcript.js';
import type { ProjectBundle } from './bundle.js';
import { planningContext } from './prd.js';
import { docPersonaPrompt, DOC_PERSONAS, orchestratorSystemPrompt, subagentSystemPrompt, type DocPersona } from './prompts.js';

const KIND: SessionKind = 'chat';
/** Turns of the conversation replayed to the model; one chat session is one turn. */
const HISTORY_TURNS = 20;
/** Messages the history endpoint hands the UI when it opens a chat. */
export const CHAT_HISTORY_LIMIT = 50;
const MAX_TOOL_CALLS = 6;
/** A document persona reads its document, edits it and checks the result — more room than a chat. */
const DOC_TOOL_CALLS = 8;
/** How much of project.md an employee's context carries; the manager gets the capped context pack. */
const PROJECT_MD_LIMIT = 4000;
const TRUNCATION_MARKER = '\n[truncated]';
/** The only workspace tools a chat gets: chatting is for answering, not for changing the project. */
const READ_ONLY_TOOLS = ['read_file', 'list_dir'];

/** 'manager', one of the document personas, or a roster member id. */
export type ChatWho = string;

/** The document tools each persona may call; everything else in `docTools` is another persona's. */
const PERSONA_TOOLS: Record<DocPersona, string[]> = {
  prd: ['read_prd', 'write_prd'],
  roadmap: ['read_roadmap', 'write_roadmap'],
  docs: ['list_docs', 'read_doc', 'write_doc'],
};

/** One transcript subject per agent, so each chat is its own conversation. */
const subjectFor = (slug: string, who: ChatWho): string => `${slug}:${who}`;

export interface ProjectChatDeps {
  loop: AgentLoop;
  transcript: Transcript;
  /** Resolves a slug to its bundle per call, so the service stays the only owner of open bundles. */
  bundleFor(slug: string): Promise<ProjectBundle>;
}

export interface ChatReply {
  text: string;
  /** How the underlying loop ended; 'stop' is the normal case. */
  outcome: SessionOutcome;
}

/**
 * Who a chat is with: the manager, one of the document personas, the roster member, or null when
 * `who` is none of them.
 */
export async function resolveWho(bundle: ProjectBundle, who: string): Promise<'manager' | DocPersona | TeamMember | null> {
  if (who === 'manager') return 'manager';
  const persona = DOC_PERSONAS.find((p) => p === who);
  if (persona) return persona;
  return (await bundle.team()).find((m) => m.id === who) ?? null;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/**
 * The framing every project chat ends with. It is what makes this a conversation rather than a
 * turn: the same persona, asked to answer the owner instead of doing the work.
 */
const CHAT_FRAMING = [
  `# This conversation`,
  `You are chatting with the owner, one on one. Answer their questions about the project, explain`,
  `the plan and where the work stands, and say plainly when you do not know something. You may read`,
  `files with read_file and list_dir to check something before you answer.`,
  `This is a conversation, not a turn: do not spawn subagents, publish briefings, or change the`,
  `project bundle. If something needs doing, say what you would do and leave it to the next turn.`,
  `Reply in a few sentences of plain prose — the owner is reading this in a chat window.`,
].join('\n');

/** The project context an employee chats over: the charter plus what is still open. */
async function employeeContext(bundle: ProjectBundle): Promise<string> {
  const manifest = await bundle.manifest();
  const project = await bundle.readProject().catch(() => '');
  const open = (await bundle.tasks()).tasks.filter((t) => t.status !== 'done');
  return [
    `# Project`,
    `${manifest.title} (${manifest.slug}) — ${manifest.intent}`,
    ``,
    truncate(project.trim(), PROJECT_MD_LIMIT),
    ``,
    `# Open Tasks`,
    ...(open.length ? open.map((t) => `- [${t.status}] ${t.id} ${t.title}`) : ['(none)']),
  ].join('\n');
}

/** The project plus the document this persona owns, so it can answer without spending a tool call. */
async function docPersonaContext(bundle: ProjectBundle, persona: DocPersona): Promise<string> {
  const manifest = await bundle.manifest();
  const head = [`# Project`, `${manifest.title} (${manifest.slug}) — ${manifest.intent}`, ``];
  if (persona === 'prd') {
    return [...head, `# prd.md (as it stands)`, truncate((await bundle.prd()).trim(), PROJECT_MD_LIMIT)].join('\n');
  }
  if (persona === 'roadmap') {
    const milestones = await bundle.roadmap();
    return [
      ...head,
      `# The PRD you are sequencing`,
      truncate((await bundle.prd()).trim(), PROJECT_MD_LIMIT),
      ``,
      `# roadmap.yaml (as it stands)`,
      milestones.length ? JSON.stringify(milestones, null, 2) : '(no milestones yet)',
    ].join('\n');
  }
  const { index, pages } = await bundle.docs();
  return [
    ...head,
    `# docs/index.md`,
    index.trim(),
    ``,
    `# Pages`,
    ...(pages.length ? pages.map((p) => `- ${p.slug}: ${p.title}`) : ['(none yet)']),
  ].join('\n');
}

/**
 * One-on-one chat with a project's agents: the manager (the orchestrator's persona), one of the
 * document personas, or any employee on the roster.
 *
 * Each conversation is persistent the way the owner's assistant is — the last turns are read back
 * out of the transcript rather than held in memory — so a restarted hub picks a chat up where it
 * left off. Nothing here moves the project: the tools are read-only and the bundle is never written.
 */
export class ProjectChat {
  /** Per-(slug,who) promise chain: two messages to the same agent queue instead of racing. */
  private chains = new Map<string, Promise<unknown>>();

  constructor(private deps: ProjectChatDeps) {}

  async reply(
    slug: string,
    who: ChatWho,
    text: string,
    opts: { onToken?: (t: string) => void; signal?: AbortSignal } = {},
  ): Promise<ChatReply> {
    return this.serialize(`${slug}:${who}`, async () => {
      const bundle = await this.deps.bundleFor(slug);
      const target = await resolveWho(bundle, who);
      if (!target) throw new Error(`unknown team member: ${who}`);

      const readOnly = workspaceTools().filter((t: Tool) => READ_ONLY_TOOLS.includes(t.def.name));
      let persona: DocPersona | null = null;
      let system: string;
      if (target === 'manager') {
        system = `${orchestratorSystemPrompt(await bundle.contextPack(), await bundle.team(), await planningContext(bundle))}\n\n${CHAT_FRAMING}`;
      } else if (typeof target === 'string') {
        persona = target;
        system = docPersonaPrompt(target, await docPersonaContext(bundle, target));
      } else {
        system = [subagentSystemPrompt(target.role, [], target.instructions), ``, await employeeContext(bundle), ``, CHAT_FRAMING].join('\n');
      }

      // A document persona edits its own file — that is what the owner is talking to it for — so it
      // gets its write tools, and the writes commit under `owner:` because the owner drove them.
      const allowed = persona ? PERSONA_TOOLS[persona] : null;
      const tools = allowed ? [...readOnly, ...docTools('owner').filter((t) => allowed.includes(t.def.name))] : readOnly;

      // A chat is a turn's persona answering a question, so it runs on the same model the project's
      // policy gives the orchestrator tier.
      const route = routeFor((await bundle.manifest()).modelPolicy, 'orchestrator');
      const result = await this.deps.loop.run({
        kind: KIND, subject: subjectFor(slug, who), tier: 'orchestrator',
        system,
        history: this.turns(slug, who, HISTORY_TURNS, HISTORY_TURNS * 2),
        user: text,
        tools,
        ctx: { bundle },
        ...(route ? { route } : {}),
        maxToolCalls: persona ? DOC_TOOL_CALLS : MAX_TOOL_CALLS,
        ...(typeof target === 'string' ? {} : { memberId: target.id }),
        ...(opts.onToken ? { onToken: opts.onToken } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });

      const trimmed = result.text.trim();
      // A non-'stop' outcome with no text means the loop gave up mid-turn (budget, gateway error,
      // abort) — an empty reply would read as a silent hang in the chat window.
      return {
        text: trimmed || (result.outcome === 'stop'
          ? trimmed
          : `I hit a problem finishing that (${result.outcome}). Try again or rephrase.`),
        outcome: result.outcome,
      };
    });
  }

  /** The conversation as the UI renders it: plain user and assistant turns, oldest first. */
  messages(slug: string, who: ChatWho, limit = CHAT_HISTORY_LIMIT): ChatMessage[] {
    return this.turns(slug, who, limit, limit);
  }

  /**
   * The last `sessionLimit` turns of this chat, capped at `messageLimit` messages.
   *
   * Only plain user and assistant turns come back: a tool call and its result are one session's
   * internal working, and replaying half of that pair would leave a call no result answers.
   */
  private turns(slug: string, who: ChatWho, sessionLimit: number, messageLimit: number): ChatMessage[] {
    const { transcript } = this.deps;
    const sessions = transcript.sessions({ kind: KIND, subject: subjectFor(slug, who), limit: sessionLimit });
    const out: ChatMessage[] = [];
    for (const session of sessions) {
      for (const msg of transcript.messages(session.id)) {
        if (msg.role === 'user') out.push(msg);
        else if (msg.role === 'assistant' && !msg.tool_calls && msg.content?.trim()) {
          out.push({ role: 'assistant', content: msg.content });
        }
      }
    }
    return out.slice(-messageLimit);
  }

  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    // The stored tail swallows outcomes so one failed message doesn't reject the next one's wait.
    this.chains.set(key, next.then(() => undefined, () => undefined));
    return next;
  }
}

