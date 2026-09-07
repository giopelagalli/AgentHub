import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dump, load } from 'js-yaml';
import { simpleGit, type SimpleGit } from 'simple-git';

export type NoteType = 'person' | 'preference' | 'routine' | 'goal' | 'fact' | 'reference';

export interface NoteMeta {
  name: string;
  description: string;
  type: NoteType;
  created: number;
  updated: number;
}

interface IndexEntry {
  name: string;
  description: string;
  file: string; // e.g. notes/<slug>.md
}

const MEMORY_HEADER = '# Memory Index\n\nOne line per note. Edit by hand or via the assistant.\n\n';
const INDEX_LINE_RE = /^- \[(.+?)\]\((notes\/[^)]+\.md)\) — (.*)$/;

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'note';
}

function parseNote(raw: string): { meta: NoteMeta; body: string } | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const meta = load(m[1]) as NoteMeta;
  return { meta, body: m[2].replace(/^\n+/, '') };
}

function renderNote(meta: NoteMeta, body: string): string {
  return `---\n${dump(meta)}---\n\n${body.trim()}\n`;
}

export class MemoryStore {
  private constructor(readonly root: string, private readonly git: SimpleGit) {}

  static async open(root: string): Promise<MemoryStore> {
    await mkdir(join(root, 'notes'), { recursive: true });
    await mkdir(join(root, 'planner'), { recursive: true });
    const memoryPath = join(root, 'MEMORY.md');
    if (!existsSync(memoryPath)) await writeFile(memoryPath, MEMORY_HEADER, 'utf8');

    const isNewRepo = !existsSync(join(root, '.git'));
    const git = simpleGit(root);
    if (isNewRepo) {
      await git.init();
      // Local (not global) committer identity so commits work on machines without a global git config.
      await git.addConfig('user.name', 'AgentHub Bot');
      await git.addConfig('user.email', 'agent@agenthub.local');
    }

    const store = new MemoryStore(root, git);
    await store.commit('assistant: scaffold memory store');
    return store;
  }

  /** Stages everything under the memory root and commits, or no-ops when there is nothing staged. */
  async commit(message: string): Promise<void> {
    await this.git.add(['-A']);
    const status = await this.git.status();
    if (status.staged.length === 0) return;
    await this.git.commit(message);
  }

  private async readIndexEntries(): Promise<IndexEntry[]> {
    const raw = await readFile(join(this.root, 'MEMORY.md'), 'utf8').catch(() => MEMORY_HEADER);
    const entries: IndexEntry[] = [];
    for (const line of raw.split('\n')) {
      const m = line.match(INDEX_LINE_RE);
      if (m) entries.push({ name: m[1], file: m[2], description: m[3] });
    }
    return entries;
  }

  private async writeIndexEntries(entries: IndexEntry[]): Promise<void> {
    const lines = entries.map((e) => `- [${e.name}](${e.file}) — ${e.description}`);
    await writeFile(join(this.root, 'MEMORY.md'), MEMORY_HEADER + lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
  }

  async index(): Promise<{ name: string; description: string; file: string }[]> {
    return this.readIndexEntries();
  }

  async indexText(): Promise<string> {
    return readFile(join(this.root, 'MEMORY.md'), 'utf8');
  }

  async read(name: string): Promise<{ meta: NoteMeta; body: string } | null> {
    const slug = slugify(name);
    const raw = await readFile(join(this.root, 'notes', `${slug}.md`), 'utf8').catch(() => null);
    if (raw === null) return null;
    return parseNote(raw);
  }

  async remember(input: { name: string; description: string; type: NoteType; body: string }): Promise<NoteMeta> {
    const slug = slugify(input.name);
    const file = `notes/${slug}.md`;
    const existing = await this.read(input.name);
    const now = Date.now();
    const meta: NoteMeta = {
      name: input.name,
      description: input.description,
      type: input.type,
      created: existing?.meta.created ?? now,
      updated: now,
    };
    await writeFile(join(this.root, file), renderNote(meta, input.body), 'utf8');

    const entries = (await this.readIndexEntries()).filter((e) => e.file !== file);
    entries.push({ name: meta.name, description: meta.description, file });
    await this.writeIndexEntries(entries);

    await this.commit(`assistant: remember ${input.name}`);
    return meta;
  }

  async forget(name: string): Promise<boolean> {
    const slug = slugify(name);
    const file = `notes/${slug}.md`;
    const filePath = join(this.root, file);
    if (!existsSync(filePath)) return false;
    await rm(filePath);

    const entries = (await this.readIndexEntries()).filter((e) => e.file !== file);
    await this.writeIndexEntries(entries);

    await this.commit(`assistant: forget ${name}`);
    return true;
  }

  async recall(query: string, limit = 5): Promise<{ name: string; description: string; snippet: string }[]> {
    const q = query.toLowerCase();
    if (!q) return [];
    const entries = await this.readIndexEntries();
    const scored: { name: string; description: string; snippet: string; hits: number }[] = [];
    for (const e of entries) {
      const note = await this.read(e.name);
      const body = note?.body ?? '';
      const haystack = `${e.description}\n${body}`;
      const lower = haystack.toLowerCase();
      const hits = lower.split(q).length - 1;
      if (hits === 0) continue;
      const idx = lower.indexOf(q);
      const start = Math.max(0, idx - 40);
      const snippet = haystack.slice(start, idx + q.length + 40).trim();
      scored.push({ name: e.name, description: e.description, snippet, hits });
    }
    scored.sort((a, b) => b.hits - a.hits);
    return scored.slice(0, limit).map(({ name, description, snippet }) => ({ name, description, snippet }));
  }
}
