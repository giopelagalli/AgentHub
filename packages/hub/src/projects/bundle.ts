import { existsSync, type Dirent } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { dump, load } from 'js-yaml';
import { simpleGit, type SimpleGit } from 'simple-git';
import type { Priority } from '@agenthub/shared';
import { validateBriefing, validateSlug, type Briefing, type Manifest, type ProjectStatus, type TaskItem, type Tasks } from './schema.js';

const CONTEXT_PACK_LIMIT = 12000;
const CONTEXT_PACK_MARKER = '\n[truncated]';

/** Sub-directories that always exist in a bundle, even a freshly cloned one that lost empty dirs. */
const SCAFFOLD_DIRS = ['skills', 'briefings', 'workspace'];

/** Only these paths are "knowledge" the manifest index (and the model's context pack) cares about. */
const KNOWLEDGE_FILES = ['manifest.yaml', 'project.md', 'decisions.log.md', 'tasks.yaml'];
const KNOWLEDGE_DIRS = ['skills', 'briefings'];

const BUNDLE_GITIGNORE = [
  '# Nested checkouts under workspace/ belong to their own repos and are not versioned by this bundle.',
  'workspace/**/node_modules/',
  'workspace/**/.git/',
  '',
].join('\n');

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

  static async create(root: string, init: { slug: string; title: string; intent: string; priority?: Priority }): Promise<ProjectBundle> {
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
    };
    await writeFile(join(dir, 'manifest.yaml'), dump(manifest), 'utf8');
    await writeFile(join(dir, 'project.md'), projectTemplate(init.title, init.intent), 'utf8');
    await writeFile(join(dir, 'decisions.log.md'), '# Decisions\n', 'utf8');
    await writeFile(join(dir, 'tasks.yaml'), dump({ tasks: [] } satisfies Tasks), 'utf8');

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

  async readProject(): Promise<string> {
    return readFile(join(this.dir, 'project.md'), 'utf8');
  }

  async writeProject(md: string): Promise<void> {
    await writeFile(join(this.dir, 'project.md'), md, 'utf8');
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

  async tasks(): Promise<Tasks> {
    const raw = await readFile(join(this.dir, 'tasks.yaml'), 'utf8').catch(() => 'tasks: []\n');
    const data = load(raw) as Partial<Tasks> | undefined;
    return { tasks: data?.tasks ?? [] };
  }

  async writeTasks(t: Tasks): Promise<void> {
    await writeFile(join(this.dir, 'tasks.yaml'), dump(t), 'utf8');
    await this.touch();
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
