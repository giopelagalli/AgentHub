import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { tourSnippet, tourSteps, type TourSnippet, type TourStep } from '@agenthub/shared/tour';
import { TOUR_TOOL_CALLS } from '../agents/budgets.js';
import type { AgentLoop } from '../agents/loop.js';
import { workspaceTools } from '../agents/tools.js';
import { routeFor } from '../gateway.js';
import type { ProjectBundle } from './bundle.js';
import { guideContext, readBundleTool } from './chat.js';
import { isProtectedPath, readCodeFile, type CodeRouteDeps } from './code.js';
import { isCommitExcluded } from './github.js';
import { CODE_MAP_PAGE, guidePrompt, tourInstruction } from './prompts.js';

/**
 * The tour (FR-B6): the code map's `path:line` links, one at a time, each with the guide's
 * explanation of what the lines do and why.
 *
 * An explanation is a model run, so it is made once and kept: the first reader of a step pays for
 * it and everyone after reads a docs page (decision 0057). The page is keyed by what was explained —
 * the path, the line and a hash of the snippet — so a file edited since is explained afresh rather
 * than described from memory.
 */

/** Where the explanations live in the bundle: one committed page per step. */
export const TOUR_DIR = 'docs/tour';

/** What `GET /api/projects/:slug/tour/:index` returns. */
export interface TourStepResult {
  /** 0-based position in the tour, and how many steps there are. */
  index: number;
  total: number;
  step: TourStep;
  snippet: TourSnippet;
  /** Markdown, as the guide wrote it. */
  explanation: string;
  /** True when it came off the page in `docs/tour/` and no model ran. */
  cached: boolean;
}

/** The first 12 hex of the snippet's sha256: enough to notice an edit, short enough to read. */
export const snippetHash = (snippet: TourSnippet): string =>
  createHash('sha256').update(snippet.text).digest('hex').slice(0, 12);

/** `03-` for step index 2: the page names sort in tour order. */
const prefixOf = (index: number): string => `${String(index + 1).padStart(2, '0')}-`;

/** `03-the-process-starts-here.md`. */
export function tourPageName(index: number, title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '');
  return `${prefixOf(index)}${slug || 'step'}.md`;
}

/**
 * The page's third line, and the cache key: what was explained, readable by a person and compared
 * byte for byte by the route. Anything that changes it — the map pointing elsewhere, the block
 * growing, one character of it edited — makes the page stale.
 */
const keyLine = (step: TourStep, snippet: TourSnippet): string =>
  `\`${step.path}:${step.line}\` · lines ${snippet.from}–${snippet.to} · snippet ${snippetHash(snippet)}`;

const pageFor = (index: number, step: TourStep, snippet: TourSnippet, explanation: string): string =>
  `# Step ${index + 1} — ${step.title}\n\n${keyLine(step, snippet)}\n\n${explanation.trim()}\n`;

/** The explanation on this step's page, or null when there is no page or it explains something else. */
async function cachedExplanation(bundle: ProjectBundle, index: number, step: TourStep, snippet: TourSnippet): Promise<string | null> {
  const dir = join(bundle.dir, TOUR_DIR);
  const names = await readdir(dir).catch(() => [] as string[]);
  const name = names.find((n) => n.startsWith(prefixOf(index)) && n.endsWith('.md'));
  if (!name) return null;
  // Removed between the listing and the read (another step's write clears its position): no page.
  const page = await readFile(join(dir, name), 'utf8').catch(() => null);
  if (page === null) return null;
  const lines = page.split('\n');
  if (lines[2] !== keyLine(step, snippet)) return null;
  return lines.slice(4).join('\n').trim();
}

/**
 * Writes the step's page and commits it. Any other page holding this position — an older map's
 * step 3, under its own title — is removed in the same commit, so `docs/tour/` never holds two
 * answers for one step.
 */
async function storeExplanation(
  bundle: ProjectBundle, index: number, step: TourStep, snippet: TourSnippet, explanation: string,
): Promise<void> {
  const dir = join(bundle.dir, TOUR_DIR);
  await mkdir(dir, { recursive: true });
  const name = tourPageName(index, step.title);
  for (const other of await readdir(dir)) {
    if (other !== name && other.startsWith(prefixOf(index))) await rm(join(dir, other), { force: true });
  }
  await writeFile(join(dir, name), pageFor(index, step, snippet, explanation), 'utf8');
  await bundle.commit(`owner: tour step ${index + 1} explained`);
}

/**
 * Asks the guide about one snippet. Its system prompt and its read-only belt are the guide's own
 * (decision 0045); what differs is the question and the tier — an explanation of a few lines is
 * worker work, not a conversation with the manager's model.
 */
export async function explainStep(
  loop: AgentLoop, bundle: ProjectBundle, slug: string,
  at: { index: number; total: number; step: TourStep; snippet: TourSnippet },
  signal?: AbortSignal,
): Promise<string> {
  const route = routeFor((await bundle.manifest()).modelPolicy, 'worker');
  const tools = [...workspaceTools().filter((t) => ['read_file', 'list_dir'].includes(t.def.name)), ...readBundleTool()];
  const result = await loop.run({
    kind: 'chat', subject: `${slug}:tour`, tier: 'worker',
    system: guidePrompt(await guideContext(bundle)),
    user: tourInstruction(at.step, at.snippet, at),
    tools,
    ctx: { bundle },
    maxToolCalls: TOUR_TOOL_CALLS,
    ...(route ? { route } : {}),
    ...(signal ? { signal } : {}),
  });
  const text = result.text.trim();
  if (result.outcome !== 'stop' || !text) throw new Error(`the guide did not finish an explanation (${result.outcome})`);
  return text;
}

/** A refusal the route sends as it is. */
class TourError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** The step at `index` and the lines it shows, or the reason there is none. */
async function locate(bundle: ProjectBundle, index: number): Promise<{ total: number; step: TourStep; snippet: TourSnippet }> {
  const map = await bundle.doc(CODE_MAP_PAGE);
  if (map === null) throw new TourError(404, 'there is no code map yet');
  const steps = tourSteps(map);
  if (index >= steps.length) throw new TourError(404, `the tour has ${steps.length} steps`);
  const step = steps[index];
  const where = `${step.path}:${step.line}`;
  if (isProtectedPath(step.path)) throw new TourError(404, `${where} is not the project's own code`);
  // A credential file by convention is never sent to a model to be explained, nor quoted into a
  // committed page — the same files a milestone push holds back.
  if (isCommitExcluded(step.path)) throw new TourError(404, `${where} is a credentials file the tour does not show`);
  let file;
  try {
    file = await readCodeFile(bundle.workspace, step.path);
  } catch (err) {
    throw new TourError(404, `${where}: ${(err as Error).message}`);
  }
  if ('status' in file) throw new TourError(404, `${where}: ${file.error} — the map may be out of date`);
  const snippet = tourSnippet(file.text, step.line);
  if (!snippet) throw new TourError(404, `${where} is past the end of the file — the map may be out of date`);
  return { total: steps.length, step, snippet };
}

/** The tour's one route. Owner-only like every Code route: nothing under `/api/` is a daemon route unless named. */
export function tourRoutes(app: FastifyInstance, deps: CodeRouteDeps): void {
  /**
   * One explanation per project at a time, queued rather than refused: the reader who pressed Next
   * twice wants both, and the second one often finds the first already cached once it gets its turn.
   */
  const chains = new Map<string, Promise<unknown>>();
  const serialize = <T>(slug: string, fn: () => Promise<T>): Promise<T> => {
    const next = (chains.get(slug) ?? Promise.resolve()).then(fn, fn);
    chains.set(slug, next.then(() => undefined, () => undefined));
    return next;
  };

  app.get('/api/projects/:slug/tour/:index', async (req, reply) => {
    const { slug, index: raw } = req.params as { slug: string; index: string };
    if (!/^\d{1,4}$/.test(raw)) return reply.code(400).send({ error: 'invalid step' });
    const index = Number(raw);
    const bundle = await deps.resolveProject(slug, reply);
    if (!bundle) return reply;

    // A reader who moves on, or closes the tab, should not leave a model run finishing for nobody.
    const ac = new AbortController();
    reply.raw.on('close', () => ac.abort());
    try {
      const found = await locate(bundle, index);
      const hit = await cachedExplanation(bundle, index, found.step, found.snippet);
      if (hit !== null) return { index, ...found, explanation: hit, cached: true } satisfies TourStepResult;
      return await serialize(slug, async (): Promise<TourStepResult> => {
        // Whoever held the queue before us may have been explaining this very step.
        const now = await cachedExplanation(bundle, index, found.step, found.snippet);
        if (now !== null) return { index, ...found, explanation: now, cached: true };
        if (ac.signal.aborted) throw new TourError(499, 'the reader left');
        const explanation = await explainStep(deps.loop, bundle, slug, { index, ...found }, ac.signal);
        await storeExplanation(bundle, index, found.step, found.snippet, explanation);
        return { index, ...found, explanation, cached: false };
      });
    } catch (err) {
      if (err instanceof TourError) return reply.code(err.status).send({ error: err.message });
      return reply.code(502).send({ error: (err as Error).message });
    }
  });
}
