import { existsSync, type Dirent } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { dump, load } from 'js-yaml';
import { simpleGit, type SimpleGit } from 'simple-git';
import type { DocPage, Milestone, ModelPolicy, Priority, ProjectIntake, TeamMember } from '@agenthub/shared';
import { auditPrd, prdScaffold } from './prd.js';
import { newTeamMember, validateBriefing, validateDocSlug, validateSlug, type Briefing, type Manifest, type NewMemberResult, type ProjectStatus, type TaskItem, type Tasks } from './schema.js';

const CONTEXT_PACK_LIMIT = 12000;
const CONTEXT_PACK_MARKER = '\n[truncated]';

/** Sub-directories that always exist in a bundle, even a freshly cloned one that lost empty dirs. */
const SCAFFOLD_DIRS = ['skills', 'briefings', 'workspace'];

/** Only these paths are "knowledge" the manifest index (and the model's context pack) cares about. */
const KNOWLEDGE_FILES = ['manifest.yaml', 'project.md', 'prd.md', 'roadmap.yaml', 'decisions.log.md', 'tasks.yaml', 'team.yaml'];
const KNOWLEDGE_DIRS = ['skills', 'briefings', 'docs'];

/** The bundle sub-directories read_bundle may open a file in; `workspace/` is read_file's job. */
const READABLE_DIRS = ['docs', 'skills'];

/**
 * The bundle-relative path a read_bundle call is allowed to open: one of the knowledge files, or a
 * file under docs/ or skills/. Lexical, like the workspace tools' own check — `workspace/` is
 * refused because read_file already covers it, and everything else because it is not the bundle.
 */
export function bundleReadPath(path: string): string {
  const rel = path.trim().replace(/^\.\//, '');
  const segments = rel.split('/');
  if (!rel || isAbsolute(path) || segments.includes('..')) throw new Error(`not a bundle path: ${path}`);
  if (!KNOWLEDGE_FILES.includes(rel) && !READABLE_DIRS.includes(segments[0])) {
    throw new Error(`read_bundle reads the bundle's own files only: ${[...KNOWLEDGE_FILES, ...READABLE_DIRS.map((d) => `${d}/`)].join(', ')}`);
  }
  return rel;
}

/** The one-line intro a fresh `docs/index.md` carries above its (still empty) page list. */
const DOCS_INDEX_TEMPLATE = (title: string): string =>
  [`# ${title} — Docs`, ``, `How this project works and why it was built this way. One page per topic.`, ``].join('\n');

const BUNDLE_GITIGNORE = [
  '# Nested checkouts under workspace/ belong to their own repos and are not versioned by this bundle.',
  'workspace/**/node_modules/',
  'workspace/**/.git/',
  '',
].join('\n');

/**
 * The roster a new project starts with. The manager is the orchestrator itself and is deliberately
 * not a member: the roster is who the manager delegates to.
 */
function defaultTeam(now: number): TeamMember[] {
  return [
    { id: 'coder-1', name: 'Ada', role: 'coder', avatar: 'robot-cyan', createdAt: now },
    { id: 'researcher-1', name: 'Sol', role: 'researcher', avatar: 'robot-magenta', createdAt: now },
    { id: 'reviewer-1', name: 'Vex', role: 'reviewer', avatar: 'robot-amber', createdAt: now },
  ];
}

/** The hire counter a fresh roster starts at, one past the three default members' `-1` ids. */
const DEFAULT_TEAM_NEXT_ID = 4;

/** Computes a safe hire counter for a team.yaml written before `nextId` existed. */
function fallbackNextId(members: TeamMember[]): number {
  let max = 0;
  for (const m of members) {
    const n = Number(m.id.slice(m.id.lastIndexOf('-') + 1));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

function projectTemplate(title: string, intent: string): string {
  return [`# ${title}`, ``, `## Goal`, ``, intent, ``, `## Current State`, ``, `## Constraints`, ``].join('\n');
}

function renderBriefingMd(b: Briefing): string {
  return [
    `# ${b.title}`,
    ``,
    `- status: ${b.status}`,
    `- priority: ${b.priority}`,
    `- progress: ${b.progress.done}/${b.progress.total}`,
    `- updated: ${new Date(b.updatedAt).toISOString()}`,
    ``,
    b.summary,
    ``,
    `## Blockers`,
    ...(b.blockers.length ? b.blockers.map((x) => `- ${x}`) : ['- none']),
    ``,
    `## Next Steps`,
    ...(b.nextSteps.length ? b.nextSteps.map((x) => `- ${x}`) : ['- none']),
    ``,
  ].join('\n');
}

// Splits decisions.log.md into its dated `## <iso> — <title>` blocks, in file order.
function parseDecisionBlocks(content: string): string[] {
  return content
    .split(/(?=^## )/m)
    .map((s) => s.trim())
    .filter((s) => s.startsWith('## '));
}

/**
 * Writes the plan files (PRD scaffold, empty roadmap, docs index) that a bundle must always have,
 * skipping any that already exist. `create()` calls it to scaffold them and `open()` to backfill a
 * bundle made before they existed — so no reader has to treat a missing plan file as a special case.
 */
async function scaffoldPlan(dir: string, title: string): Promise<void> {
  await mkdir(join(dir, 'docs'), { recursive: true });
  const files: [string, string][] = [
    ['prd.md', prdScaffold(title)],
    ['roadmap.yaml', dump({ milestones: [] satisfies Milestone[] })],
    [join('docs', 'index.md'), DOCS_INDEX_TEMPLATE(title)],
  ];
  for (const [path, content] of files) {
    if (!existsSync(join(dir, path))) await writeFile(join(dir, path), content, 'utf8');
  }
}

/** A docs page's title: its first `# ` heading, or the slug when it has none. */
function docTitle(markdown: string, slug: string): string {
  const heading = markdown.split('\n').find((l) => l.startsWith('# '));
  return heading ? heading.slice(2).trim() || slug : slug;
}

async function walkDir(root: string, dir: string, acc: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walkDir(root, full, acc);
    else if (e.isFile()) acc.push(relative(root, full));
  }
}

/**
 * Indexes only the bundle's own knowledge files — manifest.yaml, project.md, decisions.log.md,
 * tasks.yaml, plus everything under skills/ and briefings/. `workspace/` is the project's actual
 * checkout (arbitrary code, node_modules, nested repos) and is never part of the model's context.
 */
async function walkFiles(root: string): Promise<string[]> {
  const acc: string[] = [];
  for (const f of KNOWLEDGE_FILES) {
    if (existsSync(join(root, f))) acc.push(f);
  }
  for (const d of KNOWLEDGE_DIRS) await walkDir(root, join(root, d), acc);
  return acc;
}

/**
 * Finds directories under `workspace/` that are themselves git checkouts (contain a `.git` entry).
 * `git add -A` would otherwise record these as dangling gitlinks (mode 160000) instead of descending
 * into them — the fix is to keep the whole directory out of the bundle's git index via .gitignore,
 * not just its `.git` folder. Does not recurse into a repo it finds (nested-within-nested is that
 * repo's own business).
 */
async function findNestedRepos(dir: string, acc: string[] = []): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = join(dir, e.name);
    if (existsSync(join(full, '.git'))) acc.push(full);
    else await findNestedRepos(full, acc);
  }
  return acc;
}

export class ProjectBundle {
  readonly workspace: string;

  private constructor(readonly dir: string, private readonly git: SimpleGit) {
    this.workspace = join(dir, 'workspace');
  }

  static async create(root: string, init: { slug: string; title: string; intent: string; priority?: Priority; intake?: ProjectIntake }): Promise<ProjectBundle> {
    validateSlug(init.slug);
    const dir = join(root, init.slug);
    if (existsSync(dir)) throw new Error(`project bundle already exists: ${init.slug}`);

    for (const sub of SCAFFOLD_DIRS) {
      await mkdir(join(dir, sub), { recursive: true });
      // git tracks no empty directories, so a clone of a bundle with nothing in skills/briefings/
      // workspace yet would otherwise come back without them.
      await writeFile(join(dir, sub, '.gitkeep'), '', 'utf8');
    }
    await writeFile(join(dir, '.gitignore'), BUNDLE_GITIGNORE, 'utf8');

    const now = Date.now();
    const manifest: Manifest = {
      schema: 1,
      slug: init.slug,
      title: init.title,
      status: 'active',
      priority: init.priority ?? 'project',
      intent: init.intent,
      links: [],
      createdAt: now,
      updatedAt: now,
      index: [],
      ...(init.intake && (init.intake.idea || init.intake.prd) ? { intake: init.intake } : {}),
      prdScore: 0,
    };
    await writeFile(join(dir, 'manifest.yaml'), dump(manifest), 'utf8');
    await writeFile(join(dir, 'project.md'), projectTemplate(init.title, init.intent), 'utf8');
    // Empty but scaffolded: every project starts from a PRD, so the file the owner (or the drafter)
    // fills in exists from the first commit rather than appearing later.
    await scaffoldPlan(dir, init.title);
    await writeFile(join(dir, 'decisions.log.md'), '# Decisions\n', 'utf8');
    await writeFile(join(dir, 'tasks.yaml'), dump({ tasks: [] } satisfies Tasks), 'utf8');
    await writeFile(join(dir, 'team.yaml'), dump({ nextId: DEFAULT_TEAM_NEXT_ID, members: defaultTeam(now) }), 'utf8');

    const git = simpleGit(dir);
    await git.init();
    // Local (not global) committer identity so commits work on machines without a global git config.
    await git.addConfig('user.name', 'AgentHub Bot');
    await git.addConfig('user.email', 'agent@agenthub.local');

    const bundle = new ProjectBundle(dir, git);
    await bundle.commit('chore: scaffold project bundle');
    return bundle;
  }

  static async open(root: string, slug: string): Promise<ProjectBundle> {
    const dir = join(root, slug);
    let raw: string;
    try {
      raw = await readFile(join(dir, 'manifest.yaml'), 'utf8');
    } catch {
      throw new Error(`project bundle not found: ${slug}`);
    }
    const m = load(raw) as Partial<Manifest> | undefined;
    if (!m || m.schema !== 1 || typeof m.slug !== 'string' || typeof m.title !== 'string' || !Array.isArray(m.index)) {
      throw new Error(`invalid manifest for project: ${slug}`);
    }
    // A clone (or an older bundle predating these scaffolds) may be missing empty directories or the
    // gitignore; put them back rather than have every bundle method guard against ENOENT.
    for (const sub of SCAFFOLD_DIRS) await mkdir(join(dir, sub), { recursive: true });
    if (!existsSync(join(dir, '.gitignore'))) await writeFile(join(dir, '.gitignore'), BUNDLE_GITIGNORE, 'utf8');
    // A project bundle from before team.yaml existed gets the default roster once, the same one a
    // freshly created project starts with — otherwise its org chart would stay empty forever.
    if (!existsSync(join(dir, 'team.yaml'))) {
      await writeFile(join(dir, 'team.yaml'), dump({ nextId: DEFAULT_TEAM_NEXT_ID, members: defaultTeam(Date.now()) }), 'utf8');
    }
    // Same reasoning for the plan files: a bundle created before prd.md/roadmap.yaml/docs existed
    // gets the scaffolds once, so every reader below can assume they are there.
    await scaffoldPlan(dir, m.title);
    return new ProjectBundle(dir, simpleGit(dir));
  }

  static async list(root: string): Promise<Manifest[]> {
    let entries: string[] = [];
    try {
      entries = await readdir(root);
    } catch {
      return [];
    }
    const manifests: Manifest[] = [];
    for (const slug of entries) {
      try {
        const raw = await readFile(join(root, slug, 'manifest.yaml'), 'utf8');
        manifests.push(load(raw) as Manifest);
      } catch {
        // not a bundle directory; skip
      }
    }
    return manifests.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async manifest(): Promise<Manifest> {
    const raw = await readFile(join(this.dir, 'manifest.yaml'), 'utf8');
    return load(raw) as Manifest;
  }

  private async writeManifest(m: Manifest): Promise<void> {
    await writeFile(join(this.dir, 'manifest.yaml'), dump(m), 'utf8');
  }

  private async touch(): Promise<void> {
    const m = await this.manifest();
    m.updatedAt = Date.now();
    await this.writeManifest(m);
  }

  async setStatus(status: ProjectStatus): Promise<void> {
    const m = await this.manifest();
    m.status = status;
    m.updatedAt = Date.now();
    await this.writeManifest(m);
  }

  async setPriority(priority: Priority): Promise<void> {
    const m = await this.manifest();
    m.priority = priority;
    m.updatedAt = Date.now();
    await this.writeManifest(m);
  }

  /** The owner's model choice for this project; `undefined` clears it back to the hub default. */
  async setModelPolicy(policy: ModelPolicy | undefined): Promise<void> {
    const m = await this.manifest();
    if (policy) m.modelPolicy = policy;
    else delete m.modelPolicy;
    m.updatedAt = Date.now();
    await this.writeManifest(m);
  }

  async readProject(): Promise<string> {
    return readFile(join(this.dir, 'project.md'), 'utf8');
  }

  async writeProject(md: string): Promise<void> {
    await writeFile(join(this.dir, 'project.md'), md, 'utf8');
    await this.touch();
  }

  /** The PRD as it stands; a bundle always has one, scaffolded if nobody has drafted it yet. */
  async prd(): Promise<string> {
    return readFile(join(this.dir, 'prd.md'), 'utf8').catch(() => '');
  }

  /** When prd.md last changed on disk — what the PRD view stamps its "updated" line with. */
  async prdUpdatedAt(): Promise<number> {
    return stat(join(this.dir, 'prd.md')).then((s) => s.mtimeMs).catch(() => 0);
  }

  /** Replaces prd.md and refreshes the manifest's cached audit score in the same write. */
  async writePrd(markdown: string): Promise<void> {
    await writeFile(join(this.dir, 'prd.md'), markdown, 'utf8');
    const m = await this.manifest();
    m.prdScore = auditPrd(markdown).score;
    m.updatedAt = Date.now();
    await this.writeManifest(m);
  }

  async roadmap(): Promise<Milestone[]> {
    const raw = await readFile(join(this.dir, 'roadmap.yaml'), 'utf8').catch(() => 'milestones: []\n');
    const data = load(raw) as { milestones?: Milestone[] } | undefined;
    return data?.milestones ?? [];
  }

  async writeRoadmap(milestones: Milestone[]): Promise<void> {
    await writeFile(join(this.dir, 'roadmap.yaml'), dump({ milestones }), 'utf8');
    await this.touch();
  }

  /** The docs index plus one entry per page, newest-written first is not assumed — pages sort by slug. */
  async docs(): Promise<{ index: string; pages: DocPage[] }> {
    const dir = join(this.dir, 'docs');
    const index = await readFile(join(dir, 'index.md'), 'utf8').catch(() => '');
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      return { index, pages: [] };
    }
    const slugs = entries.filter((f) => f.endsWith('.md') && f !== 'index.md').map((f) => f.slice(0, -3)).sort();
    const pages = await Promise.all(slugs.map(async (slug): Promise<DocPage> => {
      const markdown = await readFile(join(dir, `${slug}.md`), 'utf8');
      const updatedAt = await stat(join(dir, `${slug}.md`)).then((s) => s.mtimeMs).catch(() => 0);
      return { slug, title: docTitle(markdown, slug), updatedAt };
    }));
    return { index, pages };
  }

  /** One docs page's markdown, or null when there is no such page. */
  async doc(slug: string): Promise<string | null> {
    validateDocSlug(slug);
    return readFile(join(this.dir, 'docs', `${slug}.md`), 'utf8').catch(() => null);
  }

  /**
   * Writes a docs page and links it from docs/index.md when it isn't linked yet. The index is the
   * table of contents a reader (and the next turn's model) navigates by, so a page that never
   * reaches it is a page nobody finds.
   */
  async writeDoc(slug: string, markdown: string): Promise<void> {
    validateDocSlug(slug);
    const dir = join(this.dir, 'docs');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${slug}.md`), markdown, 'utf8');
    if (slug !== 'index') {
      const indexPath = join(dir, 'index.md');
      const index = await readFile(indexPath, 'utf8').catch(async () => DOCS_INDEX_TEMPLATE((await this.manifest()).title));
      if (!index.includes(`(${slug}.md)`)) {
        const body = `${index.trimEnd()}\n- [${docTitle(markdown, slug)}](${slug}.md)\n`;
        await writeFile(indexPath, body, 'utf8');
      }
    }
    await this.touch();
  }

  async appendDecision(entry: { title: string; rationale: string; by: string }): Promise<void> {
    const filePath = join(this.dir, 'decisions.log.md');
    const existing = await readFile(filePath, 'utf8').catch(() => '');
    const date = new Date().toISOString();
    const block = `## ${date} — ${entry.title}\n\n${entry.rationale}\n\n_by: ${entry.by}_\n`;
    const body = existing.trim().length ? `${existing.trim()}\n\n${block}` : block;
    await writeFile(filePath, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
    await this.touch();
  }

  /** The whole decision log as markdown; empty when nothing has been decided yet. */
  async decisions(): Promise<string> {
    return readFile(join(this.dir, 'decisions.log.md'), 'utf8').catch(() => '');
  }

  async tasks(): Promise<Tasks> {
    const raw = await readFile(join(this.dir, 'tasks.yaml'), 'utf8').catch(() => 'tasks: []\n');
    const data = load(raw) as Partial<Tasks> | undefined;
    return { tasks: data?.tasks ?? [] };
  }

  async writeTasks(t: Tasks): Promise<void> {
    await writeFile(join(this.dir, 'tasks.yaml'), dump(t), 'utf8');
    await this.touch();
  }

  /**
   * team.yaml's roster plus its hire counter. A bundle created before team.yaml existed (or before
   * `nextId` did) has no counter on disk — that falls back to one derived from whoever is currently
   * on the roster, since no history of earlier, now-removed members is available to do better.
   */
  private async teamState(): Promise<{ nextId: number; members: TeamMember[] }> {
    const raw = await readFile(join(this.dir, 'team.yaml'), 'utf8').catch(() => null);
    if (raw === null) return { nextId: DEFAULT_TEAM_NEXT_ID, members: [] };
    const data = load(raw) as { nextId?: number; members?: TeamMember[] } | undefined;
    const members = data?.members ?? [];
    return { nextId: typeof data?.nextId === 'number' ? data.nextId : fallbackNextId(members), members };
  }

  private async writeTeamState(state: { nextId: number; members: TeamMember[] }): Promise<void> {
    await writeFile(join(this.dir, 'team.yaml'), dump(state), 'utf8');
    await this.touch();
  }

  /**
   * The project's roster. `open()` backfills team.yaml the moment it's missing, so in practice this
   * only reads an empty roster if the file vanished from under an already-open bundle — that still
   * reads as empty rather than an error, exactly as it did before the backfill existed.
   */
  async team(): Promise<TeamMember[]> {
    return (await this.teamState()).members;
  }

  /** Overwrites the roster, preserving the persisted hire counter untouched (removal doesn't reuse ids). */
  async writeTeam(members: TeamMember[]): Promise<void> {
    const { nextId } = await this.teamState();
    await this.writeTeamState({ nextId, members });
  }

  /**
   * Validates and appends an owner-supplied hire, assigning its id from the persisted counter and
   * advancing it in the same write — so an id is never handed out twice, even across a member who was
   * later removed.
   */
  async hireMember(body: unknown, now = Date.now()): Promise<NewMemberResult> {
    const { nextId, members } = await this.teamState();
    const result = newTeamMember(body, members, nextId, now);
    if ('error' in result) return result;
    await this.writeTeamState({ nextId: result.nextId, members: [...members, result.member] });
    return result;
  }

  async skills(): Promise<{ name: string; body: string }[]> {
    const dir = join(this.dir, 'skills');
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }
    const mdFiles = entries.filter((f) => f.endsWith('.md')).sort();
    return Promise.all(mdFiles.map(async (f) => ({ name: f.slice(0, -3), body: await readFile(join(dir, f), 'utf8') })));
  }

  async writeSkill(name: string, body: string): Promise<void> {
    await writeFile(join(this.dir, 'skills', `${name}.md`), body, 'utf8');
    await this.touch();
  }

  async publishBriefing(b: Briefing): Promise<void> {
    validateBriefing(b);
    const dir = join(this.dir, 'briefings');
    await mkdir(dir, { recursive: true });
    const json = JSON.stringify(b, null, 2);
    const md = renderBriefingMd(b);
    const ts = Date.now();
    await writeFile(join(dir, `${ts}.json`), json, 'utf8');
    await writeFile(join(dir, `${ts}.md`), md, 'utf8');
    await writeFile(join(dir, 'latest.json'), json, 'utf8');
    await writeFile(join(dir, 'latest.md'), md, 'utf8');
    await this.touch();
  }

  /**
   * The bundle's own knowledge files as bundle-relative paths — what a turn's prompt talks about.
   * `workspace/` is deliberately absent: it is arbitrary project code, and read_file covers it.
   */
  async bundleFiles(): Promise<string[]> {
    const acc: string[] = [];
    for (const f of KNOWLEDGE_FILES) {
      if (existsSync(join(this.dir, f))) acc.push(f);
    }
    for (const d of READABLE_DIRS) await walkDir(this.dir, join(this.dir, d), acc);
    return acc.map((p) => p.split(sep).join('/')).sort();
  }

  /** Reads one of `bundleFiles()`; anything else is refused rather than read. */
  async readBundleFile(path: string): Promise<string> {
    const rel = bundleReadPath(path);
    return readFile(join(this.dir, ...rel.split('/')), 'utf8')
      .catch(() => { throw new Error(`no such bundle file: ${rel}`); });
  }

  async latestBriefing(): Promise<Briefing | null> {
    try {
      const raw = await readFile(join(this.dir, 'briefings', 'latest.json'), 'utf8');
      return JSON.parse(raw) as Briefing;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  /**
   * Nested checkouts under workspace/ (a project the model `git clone`d, say) aren't covered by the
   * static .gitignore — their names aren't known ahead of time — so each one found gets its own
   * `workspace/<name>/` line. Without this, `git add -A` would record the checkout as a dangling
   * gitlink (mode 160000) rather than leaving it alone. Nested checkouts are not versioned by this
   * bundle; they belong to their own repos.
   */
  private async excludeNestedRepos(): Promise<void> {
    const nested = await findNestedRepos(this.workspace);
    if (nested.length === 0) return;
    const gitignorePath = join(this.dir, '.gitignore');
    const existing = await readFile(gitignorePath, 'utf8').catch(() => '');
    const lines = existing.split('\n');
    let changed = false;
    for (const dir of nested) {
      const entry = `${relative(this.dir, dir).split(sep).join('/')}/`;
      if (!lines.includes(entry)) {
        lines.push(entry);
        changed = true;
      }
    }
    if (changed) await writeFile(gitignorePath, lines.join('\n'), 'utf8');
  }

  async commit(message: string): Promise<void> {
    await this.excludeNestedRepos();

    const index = await walkFiles(this.dir);
    const m = await this.manifest();
    m.index = index.sort();
    await this.writeManifest(m);

    await this.git.add(['-A']);
    const status = await this.git.status();
    if (status.staged.length === 0) return;
    await this.git.commit(message);
  }

  async contextPack(): Promise<string> {
    const m = await this.manifest();
    const project = await this.readProject().catch(() => '');
    const { tasks } = await this.tasks();
    const openTasks = tasks.filter((t: TaskItem) => t.status !== 'done');
    const decisionsRaw = await readFile(join(this.dir, 'decisions.log.md'), 'utf8').catch(() => '');
    const decisions = parseDecisionBlocks(decisionsRaw).slice(-5);
    const skillNames = (await this.skills()).map((s) => s.name);

    const full = [
      `# Manifest`,
      `slug: ${m.slug}`,
      `title: ${m.title}`,
      `status: ${m.status}`,
      `priority: ${m.priority}`,
      `intent: ${m.intent}`,
      `links: ${m.links.join(', ')}`,
      ``,
      `# Project`,
      project.trim(),
      ``,
      `# Open Tasks`,
      ...(openTasks.length ? openTasks.map((t) => `- [${t.status}] ${t.id} ${t.title}`) : ['(none)']),
      ``,
      `# Recent Decisions`,
      ...(decisions.length ? decisions : ['(none)']),
      ``,
      `# Skills`,
      ...(skillNames.length ? skillNames.map((n) => `- ${n}`) : ['(none)']),
    ].join('\n');

    if (full.length <= CONTEXT_PACK_LIMIT) return full;
    return full.slice(0, CONTEXT_PACK_LIMIT - CONTEXT_PACK_MARKER.length) + CONTEXT_PACK_MARKER;
  }
}
