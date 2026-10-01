import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PRD_SECTIONS, type Milestone, type PrdAudit } from '@agenthub/shared';
import type { AgentLoop } from '../agents/loop.js';
import type { Transcript } from '../agents/transcript.js';
import { routeFor, type ModelGateway } from '../gateway.js';
import { byline, type ProjectBundle } from './bundle.js';
import { workspaceDigest } from './digest.js';
import type { PlanningContext } from './prompts.js';
import { currentMilestoneId, normalizeMilestones } from './roadmap.js';

/** The line every scaffolded section carries until somebody writes the section. */
export const PRD_PLACEHOLDER = '_Not drafted yet._';

/** A section body shorter than this reads as a heading with a sentence under it, not a section. */
const THIN_SECTION_CHARS = 200;

/**
 * Above this, the orchestrator's prompt carries the PRD's shape instead of the whole document. The
 * orchestrator models have 256K–1M context, so a normal PRD belongs in the prompt whole; this is the
 * fallback for a genuinely huge document.
 */
const PRD_BRIEF_LIMIT = 30000;

/** Where the drafter puts the questions it wants the owner to answer; stripped out of prd.md. */
export const QUESTIONS_HEADING = '## Questions for the owner';
const MAX_QUESTIONS = 5;

/** The PRD every new project starts with: the full section skeleton, nothing filled in. */
export function prdScaffold(title: string): string {
  return [
    `# ${title} — PRD`,
    ``,
    PRD_PLACEHOLDER,
    ``,
    ...PRD_SECTIONS.flatMap((s) => [`## ${s.title}`, ``, PRD_PLACEHOLDER, ``]),
  ].join('\n');
}

/** Each `## ` section's body, keyed by its lower-cased heading text. */
function sectionBodies(markdown: string): Map<string, string> {
  const bodies = new Map<string, string>();
  let heading: string | null = null;
  let buffer: string[] = [];
  const flush = (): void => { if (heading !== null) bodies.set(heading, buffer.join('\n').trim()); };
  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ')) {
      flush();
      heading = line.slice(3).trim().toLowerCase();
      buffer = [];
    } else if (heading !== null) {
      buffer.push(line);
    }
  }
  flush();
  return bodies;
}

/**
 * Scores a PRD against `PRD_SECTIONS`: a section counts only when its heading is there *and* it says
 * something. The score is what the UI badges and what tells a turn whether there is a product to
 * build from at all.
 */
export function auditPrd(markdown: string): PrdAudit {
  const bodies = sectionBodies(markdown);
  const sections = PRD_SECTIONS.map((s) => {
    const body = bodies.get(s.title.toLowerCase());
    const present = body !== undefined;
    const filled = body === undefined || body === PRD_PLACEHOLDER ? '' : body;
    return { key: s.key, title: s.title, present, thin: filled.length < THIN_SECTION_CHARS };
  });
  const done = sections.filter((s) => s.present && !s.thin);
  return {
    sections,
    score: Math.round((100 * done.length) / PRD_SECTIONS.length),
    missing: sections.filter((s) => !s.present || s.thin).map((s) => s.title),
  };
}

/**
 * Whether prd.md is still the untouched scaffold — headings and placeholders and nothing else. This
 * is the gate on generating a roadmap and on a turn doing any work: there is no product yet.
 */
export function isPrdScaffold(markdown: string): boolean {
  return markdown
    .replace(/^#.*$/gm, '')
    .split(PRD_PLACEHOLDER).join('')
    .trim().length === 0;
}

/** Thrown when something needs a real PRD and finds the scaffold; routes answer 400. */
export class PrdNotDraftedError extends Error {
  constructor() {
    super('the PRD has not been drafted yet');
    this.name = 'PrdNotDraftedError';
  }
}

/**
 * The PRD as a prompt carries it: whole when it is small enough, otherwise its headings with the
 * first paragraph of each section — enough to know what the product is without spending the turn's
 * context on the whole document.
 */
export function prdBrief(markdown: string): string {
  if (markdown.length <= PRD_BRIEF_LIMIT) return markdown.trim();
  const bodies = sectionBodies(markdown);
  return PRD_SECTIONS.flatMap((s) => {
    const body = bodies.get(s.title.toLowerCase()) ?? '';
    const first = body.split(/\n\s*\n/)[0]?.trim() ?? '';
    return [`## ${s.title}`, first || PRD_PLACEHOLDER, ''];
  }).join('\n').trim();
}

/**
 * Everything the orchestrator's prompt needs about the plan and where it stands, read from the
 * bundle in one place: the PRD, the roadmap, what the last turn reported, and what the workspace
 * holds — so a turn starts from what is known instead of rediscovering it.
 */
export async function planningContext(bundle: ProjectBundle): Promise<PlanningContext> {
  const prd = await bundle.prd();
  const milestones = await bundle.roadmap();
  return {
    prd: prdBrief(prd),
    prdComplete: prd.length <= PRD_BRIEF_LIMIT,
    scaffoldOnly: isPrdScaffold(prd),
    milestones,
    currentId: currentMilestoneId(milestones),
    lastTurn: await bundle.latestBriefing(),
    digest: await workspaceDigest(bundle.workspace),
  };
}

// --- drafting ---------------------------------------------------------------

const SECTION_LIST = PRD_SECTIONS.map((s) => `- ## ${s.title} — ${s.hint}`).join('\n');

const DRAFT_SYSTEM = [
  `You are a product lead writing the PRD for one project in AgentHub.`,
  ``,
  `Write the whole document as markdown with exactly these \`## \` sections, in this order:`,
  SECTION_LIST,
  ``,
  `Rules:`,
  `- Every section is filled with concrete content: name the real technologies, the limits, the`,
  `  threat cases, the acceptance criteria. No TODOs and no "to be decided".`,
  `- Where something genuinely isn't decided, make a reasonable assumption, write it as an`,
  `  assumption in that section, and raise it as a question at the end.`,
  `- Start with a single \`# \` title line, then the sections. No preamble, no code fence around the`,
  `  document.`,
  `- End with a \`${QUESTIONS_HEADING}\` heading and at most ${MAX_QUESTIONS} \`- \` bullets: the`,
  `  decisions you most need from the owner. Nothing after them.`,
].join('\n');

/**
 * What the drafter is told when the project came from a repository. The default prompt writes a
 * product that does not exist yet; here one does, and a PRD that describes the owner's wish as if
 * from scratch would send every later turn rebuilding what is already there.
 */
const IMPORT_RULES = [
  ``,
  `This project was imported from an existing repository, and the code below is what it is today.`,
  `Write the PRD for *this* product, not for a new one:`,
  `- Describe the system as it exists — its real modules, technologies, data and operations — in the`,
  `  present tense. The code is the source of truth where it and the owner's words disagree.`,
  `- Put what the owner asked for on top of that: a requirement they named is a change to this`,
  `  product, and the sections say what it is today and what it becomes.`,
  `- Do not invent components the repository does not have, and do not describe existing behaviour as`,
  `  something still to be built.`,
].join('\n');

/**
 * The roadmap's counterpart. Milestones that are already delivered lead the list and are marked
 * done, so the first *planned* milestone is the first thing that still has to be built.
 */
const IMPORT_ROADMAP_RULES = [
  ``,
  `This project was imported from an existing repository — the code below already runs. Begin the`,
  `array with what the codebase already delivers, one milestone per capability that is genuinely`,
  `there, in the order it was built, each with \`"status": "done"\`. Every milestone after those is`,
  `new work and carries no "status". The first milestone without a status is therefore the first`,
  `thing still to build.`,
].join('\n');

/** Top-level manifests worth showing the drafter; whichever of them the repository has. */
const MANIFEST_FILES = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'];
const README_LIMIT = 6000;
const MANIFEST_LIMIT = 2000;

/** Reads a workspace file, capped, or null when it isn't there. */
async function capped(path: string, limit: number): Promise<string | null> {
  const text = await readFile(path, 'utf8').catch(() => null);
  if (text === null) return null;
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated]`;
}

/**
 * The existing product as the drafter reads it: the README (what the authors say it is), the
 * top-level manifests (what it is built out of) and the workspace digest (what is actually there).
 * Bounded on purpose — this is orientation, not the repository.
 */
export async function codebaseContext(workspace: string): Promise<string> {
  const names = await readdir(workspace).catch((): string[] => []);
  const readmeName = names.find((n) => /^readme(\.|$)/i.test(n));
  const readme = readmeName ? await capped(join(workspace, readmeName), README_LIMIT) : null;
  const manifests: string[] = [];
  for (const name of MANIFEST_FILES) {
    const body = names.includes(name) ? await capped(join(workspace, name), MANIFEST_LIMIT) : null;
    if (body) manifests.push(`### ${name}\n\`\`\`\n${body}\n\`\`\``);
  }
  return [
    `# The existing codebase`,
    ``,
    `## ${readmeName ?? 'README'}`,
    readme ?? '(the repository has no README)',
    ``,
    `## Manifests`,
    ...(manifests.length ? manifests : ['(no top-level manifest found)']),
    ``,
    `## Files`,
    await workspaceDigest(workspace),
  ].join('\n');
}

const REVISE_RULES = [
  ``,
  `This PRD already has the owner's material in it. Keep their content and their voice: fill the`,
  `gaps, add the missing sections, and flag contradictions in "Risks & open questions" rather than`,
  `resolving them silently. Never delete something they wrote.`,
].join('\n');

const ROADMAP_SYSTEM = [
  `You are a delivery lead sequencing one project's PRD into an implementation roadmap.`,
  ``,
  `Answer with a JSON array and nothing else. Each element:`,
  `{ "title": string, "summary": string, "estimate"?: string, "dependsOn"?: string[] }`,
  ``,
  `Rules:`,
  `- Order matters: each milestone ends in something demonstrable, and earlier ones unblock later`,
  `  ones. Nothing depends on work that comes after it.`,
  `- Between 3 and 12 milestones. Summaries are one or two sentences of what is built and what is`,
  `  demonstrable at the end of it.`,
  `- Estimates are coarse ("half a day", "2 days") and optional — leave the field out when unsure.`,
  `- "dependsOn" refers to milestones by their 1-based position as "m1", "m2", …`,
].join('\n');

export interface PrdDrafterDeps {
  loop: AgentLoop;
  gateway: ModelGateway;
  transcript: Transcript;
  /** Resolves a slug to its bundle per call, so the service stays the only owner of open bundles. */
  bundleFor(slug: string): Promise<ProjectBundle>;
}

export interface DraftInput {
  /** A few sentences of what the owner wants; drafted into a complete first-pass PRD. */
  idea?: string;
  /** A PRD the owner already wrote; kept and completed rather than replaced. */
  prd?: string;
}

export interface DraftResult {
  markdown: string;
  questions: string[];
  audit: PrdAudit;
}

export interface DraftOptions {
  onToken?: (t: string) => void;
  signal?: AbortSignal;
  /** The API token label that asked for the run, for its commit (0067); absent for the owner. */
  by?: string;
}

/** Drops a ``` fence the model wrapped the whole answer in. */
function stripFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed.replace(/^```[a-z]*\n/, '').replace(/\n?```$/, '').trim();
}

/** Splits the model's answer into the PRD itself and the questions it appended. */
function splitQuestions(text: string): { markdown: string; questions: string[] } {
  const at = text.indexOf(QUESTIONS_HEADING);
  if (at < 0) return { markdown: text.trim(), questions: [] };
  const questions = text.slice(at + QUESTIONS_HEADING.length)
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').trim())
    .filter((l) => l.length > 0)
    .slice(0, MAX_QUESTIONS);
  return { markdown: text.slice(0, at).trim(), questions };
}

/** Pulls the first JSON array out of a model answer that may have wrapped it in prose or a fence. */
function parseJsonArray(text: string): unknown {
  const body = stripFence(text);
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('the model did not return a JSON array');
  return JSON.parse(body.slice(start, end + 1));
}

/**
 * Writes a project's PRD and turns it into a roadmap.
 *
 * Both calls are one-shot model runs with no tools — the drafter does the persisting itself, so a
 * run that ends early can never leave a half-written plan file behind — and both are serialized per
 * slug, because they write the same bundle and git index the project's turns do.
 */
export class PrdDrafter {
  private chains = new Map<string, Promise<unknown>>();

  constructor(private deps: PrdDrafterDeps) {}

  /**
   * Drafts prd.md from the owner's idea, or completes the PRD they pasted in. Ends by writing the
   * file, so what the owner reads back is exactly what was persisted.
   */
  async draft(slug: string, input: DraftInput, opts: DraftOptions = {}): Promise<DraftResult> {
    return this.serialize(slug, async () => {
      const bundle = await this.deps.bundleFor(slug);
      const manifest = await bundle.manifest();
      const existing = input.prd?.trim();
      // An imported project's PRD is drafted from the owner's intent *and* the code as it stands,
      // so the document describes the product that exists and what the owner wants done to it.
      const code = manifest.source ? await codebaseContext(bundle.workspace) : null;
      const user = [
        existing
          ? [`# ${manifest.title}`, `Owner intent: ${manifest.intent}`, ``, `The PRD so far:`, ``, existing].join('\n')
          : [
            `# ${manifest.title}`,
            `Owner intent: ${manifest.intent}`,
            ``,
            `The idea, in the owner's words:`,
            ``,
            input.idea?.trim() || manifest.intent,
          ].join('\n'),
        ...(code ? [``, code] : []),
      ].join('\n');

      const system = DRAFT_SYSTEM + (existing ? REVISE_RULES : '') + (code ? IMPORT_RULES : '');
      const text = await this.run(slug, 'prd', bundle, system, user, opts);
      const { markdown, questions } = splitQuestions(stripFence(text));
      if (!markdown) throw new Error('the model returned no PRD');

      await bundle.writePrd(`${markdown}\n`);
      await bundle.commit(`agent: draft prd${byline(opts.by)}`);
      return { markdown, questions, audit: auditPrd(markdown) };
    });
  }

  /** Sequences the PRD into ordered milestones and writes roadmap.yaml. */
  async generateRoadmap(slug: string, opts: DraftOptions = {}): Promise<Milestone[]> {
    return this.serialize(slug, async () => {
      const bundle = await this.deps.bundleFor(slug);
      const prd = await bundle.prd();
      if (isPrdScaffold(prd)) throw new PrdNotDraftedError();

      // Same reason as the draft: what is already built has to lead the roadmap as done, and only
      // the code says what that is — the PRD describes the product, not how far along it is.
      const code = (await bundle.manifest()).source ? await codebaseContext(bundle.workspace) : null;
      const system = ROADMAP_SYSTEM + (code ? IMPORT_ROADMAP_RULES : '');
      const text = await this.run(slug, 'roadmap', bundle, system, code ? `${prd}\n\n${code}` : prd, opts);
      const milestones = normalizeMilestones(parseJsonArray(text));
      await bundle.writeRoadmap(milestones);
      await bundle.commit(`agent: generate roadmap${byline(opts.by)}`);
      return milestones;
    });
  }

  /** One tool-less run on the project's orchestrator-tier model, recorded under its own subject. */
  private async run(
    slug: string, kind: 'prd' | 'roadmap', bundle: ProjectBundle, system: string, user: string, opts: DraftOptions,
  ): Promise<string> {
    const route = routeFor((await bundle.manifest()).modelPolicy, 'orchestrator');
    const result = await this.deps.loop.run({
      kind: 'chat', subject: `${slug}:${kind}`, tier: 'orchestrator',
      // A `chat` session, but planning spend rather than conversation — the ledger says so.
      usageKind: 'prd',
      system, user,
      tools: [],
      ctx: { bundle },
      ...(route ? { route } : {}),
      maxToolCalls: 0,
      ...(opts.onToken ? { onToken: opts.onToken } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const text = result.text.trim();
    if (!text) throw new Error(`the model ended ${result.outcome} without an answer`);
    return text;
  }

  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    // The stored tail swallows outcomes so one failed draft doesn't reject the next one's wait.
    this.chains.set(key, next.then(() => undefined, () => undefined));
    return next;
  }
}
