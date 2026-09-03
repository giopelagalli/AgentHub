import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { ProjectBundle } from '../src/projects/bundle.js';
import { validateBriefing, type Briefing } from '../src/projects/schema.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agenthub-bundle-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const makeBriefing = (overrides: Partial<Briefing> = {}): Briefing => ({
  slug: 'demo-project',
  title: 'Demo Project',
  status: 'active',
  priority: 'project',
  summary: 'making progress',
  progress: { done: 1, total: 3 },
  blockers: [],
  nextSteps: ['ship it'],
  updatedAt: Date.now(),
  ...overrides,
});

describe('ProjectBundle.create', () => {
  it('scaffolds the exact file set and produces a single git commit', async () => {
    const bundle = await ProjectBundle.create(root, { slug: 'demo-project', title: 'Demo Project', intent: 'ship a demo' });

    const manifest = await bundle.manifest();
    expect(manifest).toMatchObject({
      schema: 1, slug: 'demo-project', title: 'Demo Project', status: 'active',
      priority: 'project', intent: 'ship a demo', links: [],
    });
    expect(manifest.index.sort()).toEqual(['decisions.log.md', 'manifest.yaml', 'project.md', 'tasks.yaml']);

    expect(await bundle.readProject()).toContain('ship a demo');
    expect(await bundle.tasks()).toEqual({ tasks: [] });
    expect(await bundle.skills()).toEqual([]);
    expect(await bundle.latestBriefing()).toBeNull();

    const git = simpleGit(bundle.dir);
    const log = await git.log();
    expect(log.total).toBe(1);
  });

  it('rejects an invalid slug', async () => {
    await expect(ProjectBundle.create(root, { slug: 'Not Valid!', title: 'x', intent: 'x' })).rejects.toThrow();
  });
});

describe('ProjectBundle decisions', () => {
  it('appends decisions with a dated markdown header', async () => {
    const bundle = await ProjectBundle.create(root, { slug: 'demo', title: 'Demo', intent: 'demo' });
    await bundle.appendDecision({ title: 'Pick a DB', rationale: 'sqlite is simplest', by: 'orchestrator' });

    const raw = await bundle.contextPack();
    expect(raw).toMatch(/## \d{4}-\d{2}-\d{2}T.*— Pick a DB/);
    expect(raw).toContain('sqlite is simplest');
    expect(raw).toContain('_by: orchestrator_');
  });
});

describe('ProjectBundle tasks', () => {
  it('round-trips tasks.yaml', async () => {
    const bundle = await ProjectBundle.create(root, { slug: 'demo', title: 'Demo', intent: 'demo' });
    await bundle.writeTasks({ tasks: [{ id: 't1', title: 'Do the thing', status: 'in-progress', owner: 'sub-1' }] });
    expect(await bundle.tasks()).toEqual({ tasks: [{ id: 't1', title: 'Do the thing', status: 'in-progress', owner: 'sub-1' }] });
  });
});

describe('ProjectBundle briefings', () => {
  it('publishes timestamped + latest json/md and validates schema', async () => {
    const bundle = await ProjectBundle.create(root, { slug: 'demo-project', title: 'Demo Project', intent: 'demo' });
    const briefing = makeBriefing();
    await bundle.publishBriefing(briefing);

    expect(await bundle.latestBriefing()).toEqual(briefing);

    const files = await import('node:fs/promises').then((fs) => fs.readdir(join(bundle.dir, 'briefings')));
    expect(files).toContain('latest.json');
    expect(files).toContain('latest.md');
    expect(files.some((f) => /^\d+\.json$/.test(f))).toBe(true);
    expect(files.some((f) => /^\d+\.md$/.test(f))).toBe(true);
  });

  it('rejects a briefing with a summary over 600 chars', () => {
    const briefing = makeBriefing({ summary: 'x'.repeat(700) });
    expect(() => validateBriefing(briefing)).toThrow();
  });
});

describe('ProjectBundle.open', () => {
  it('rehydrates an identical manifest in a fresh instance', async () => {
    const created = await ProjectBundle.create(root, { slug: 'demo-project', title: 'Demo Project', intent: 'ship it' });
    await created.setStatus('paused');

    const reopened = await ProjectBundle.open(root, 'demo-project');
    expect(await reopened.manifest()).toEqual(await created.manifest());
  });

  it('throws when the manifest is missing', async () => {
    await expect(ProjectBundle.open(root, 'nope')).rejects.toThrow();
  });
});

describe('ProjectBundle.list', () => {
  it('returns manifests sorted by updatedAt desc', async () => {
    const a = await ProjectBundle.create(root, { slug: 'aaa', title: 'A', intent: 'a' });
    await new Promise((r) => setTimeout(r, 5));
    await ProjectBundle.create(root, { slug: 'bbb', title: 'B', intent: 'b' });
    await new Promise((r) => setTimeout(r, 5));
    await a.setStatus('paused'); // bumps a's updatedAt above b's

    const list = await ProjectBundle.list(root);
    expect(list.map((m) => m.slug)).toEqual(['aaa', 'bbb']);
  });
});

describe('ProjectBundle.commit', () => {
  it('is a no-op when the working tree is clean', async () => {
    const bundle = await ProjectBundle.create(root, { slug: 'demo', title: 'Demo', intent: 'demo' });
    const git = simpleGit(bundle.dir);
    const before = (await git.log()).total;
    await bundle.commit('agent: nothing changed');
    expect((await git.log()).total).toBe(before);
  });

  it('commits and refreshes the manifest index', async () => {
    const bundle = await ProjectBundle.create(root, { slug: 'demo', title: 'Demo', intent: 'demo' });
    await bundle.writeSkill('research', '# Research skill\n');
    await bundle.commit('agent: add research skill');

    const manifest = await bundle.manifest();
    expect(manifest.index).toContain('skills/research.md');

    const git = simpleGit(bundle.dir);
    expect((await git.log()).total).toBe(2);
  });
});

describe('ProjectBundle.contextPack', () => {
  it('truncates to at most 12k chars with a trailing marker', async () => {
    const bundle = await ProjectBundle.create(root, { slug: 'demo', title: 'Demo', intent: 'demo' });
    await writeFile(join(bundle.dir, 'project.md'), 'x'.repeat(20000), 'utf8');

    const pack = await bundle.contextPack();
    expect(pack.length).toBeLessThanOrEqual(12000);
    expect(pack.endsWith('[truncated]')).toBe(true);
  });

  it('stays untruncated for small bundles', async () => {
    const bundle = await ProjectBundle.create(root, { slug: 'demo', title: 'Demo', intent: 'demo' });
    const pack = await bundle.contextPack();
    expect(pack.length).toBeLessThanOrEqual(12000);
    expect(pack.endsWith('[truncated]')).toBe(false);
  });
});
