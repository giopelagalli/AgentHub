import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { dump, load } from 'js-yaml';
import { simpleGit, type SimpleGit } from 'simple-git';
import type { Priority } from '@agenthub/shared';
import { validateBriefing, validateSlug, type Briefing, type Manifest, type ProjectStatus, type TaskItem, type Tasks } from './schema.js';

const CONTEXT_PACK_LIMIT = 12000;
const CONTEXT_PACK_MARKER = '\n[truncated]';

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

async function walkFiles(root: string, dir = root, acc: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === '.git') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walkFiles(root, full, acc);
    else if (e.isFile()) acc.push(relative(root, full));
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

    await mkdir(join(dir, 'briefings'), { recursive: true });
    await mkdir(join(dir, 'skills'), { recursive: true });
    await mkdir(join(dir, 'workspace'), { recursive: true });

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

  async commit(message: string): Promise<void> {
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
