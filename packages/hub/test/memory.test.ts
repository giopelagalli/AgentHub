import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { MemoryStore } from '../src/assistant/memory.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agenthub-memory-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('MemoryStore.open', () => {
  it('scaffolds MEMORY.md, notes/, planner/ and makes an initial commit', async () => {
    await MemoryStore.open(root);

    expect(await readFile(join(root, 'MEMORY.md'), 'utf8')).toContain('Memory Index');

    const git = simpleGit(root);
    expect(await git.checkIsRepo()).toBe(true);
    const log = await git.log();
    expect(log.total).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent — reopening an existing store does not fail or duplicate the initial commit', async () => {
    await MemoryStore.open(root);
    await MemoryStore.open(root);

    const git = simpleGit(root);
    const log = await git.log();
    expect(log.total).toBe(1);
  });
});

describe('MemoryStore.remember / index / read', () => {
  it('creates a note with frontmatter that round-trips and adds an index line', async () => {
    const store = await MemoryStore.open(root);

    const meta = await store.remember({
      name: 'Owner Timezone',
      description: 'Owner lives in PST',
      type: 'fact',
      body: 'The owner is based in San Francisco and works PST hours.',
    });

    expect(meta.name).toBe('Owner Timezone');
    expect(meta.description).toBe('Owner lives in PST');
    expect(meta.type).toBe('fact');
    expect(meta.created).toBe(meta.updated);

    const index = await store.index();
    expect(index).toHaveLength(1);
    expect(index[0]).toMatchObject({ name: 'Owner Timezone', description: 'Owner lives in PST', file: 'notes/owner-timezone.md' });

    const note = await store.read('Owner Timezone');
    expect(note).not.toBeNull();
    expect(note?.meta).toEqual(meta);
    expect(note?.body).toContain('San Francisco');

    const indexText = await store.indexText();
    expect(indexText).toContain('[Owner Timezone](notes/owner-timezone.md)');
  });

  it('updating an existing name replaces the index line (no duplicates) and bumps updated, not created', async () => {
    const store = await MemoryStore.open(root);

    const first = await store.remember({ name: 'Coffee', description: 'Likes black coffee', type: 'preference', body: 'No sugar.' });
    await new Promise((r) => setTimeout(r, 5));
    const second = await store.remember({ name: 'Coffee', description: 'Likes black coffee, no sugar', type: 'preference', body: 'No sugar, ever.' });

    expect(second.created).toBe(first.created);
    expect(second.updated).toBeGreaterThan(first.updated);

    const index = await store.index();
    expect(index).toHaveLength(1);
    expect(index[0].description).toBe('Likes black coffee, no sugar');

    const note = await store.read('Coffee');
    expect(note?.body).toContain('No sugar, ever.');
  });

  it('flattens a multi-line description so the index line still parses back', async () => {
    const store = await MemoryStore.open(root);
    await store.remember({
      name: 'Standup', description: 'Daily at 9\nBring the notes', type: 'routine', body: 'Standup is daily.',
    });
    await store.remember({ name: 'Coffee', description: 'oat milk', type: 'preference', body: 'Oat milk.' });

    // A newline in a description used to write a second line the line-anchored index regex could
    // not match, silently dropping that note — and every note after it — on the next write.
    const raw = await readFile(join(root, 'MEMORY.md'), 'utf8');
    expect(raw).toContain('- [Standup](notes/standup.md) — Daily at 9 Bring the notes');
    expect(await store.index()).toEqual([
      { name: 'Standup', description: 'Daily at 9 Bring the notes', file: 'notes/standup.md' },
      { name: 'Coffee', description: 'oat milk', file: 'notes/coffee.md' },
    ]);
  });

  it('read returns null for an unknown note', async () => {
    const store = await MemoryStore.open(root);
    expect(await store.read('Nope')).toBeNull();
  });
});

describe('MemoryStore.forget', () => {
  it('removes the note file and its index line, returns true; false when not found', async () => {
    const store = await MemoryStore.open(root);
    await store.remember({ name: 'Temp Fact', description: 'transient', type: 'fact', body: 'delete me' });

    expect(await store.forget('Temp Fact')).toBe(true);
    expect(await store.index()).toEqual([]);
    expect(await store.read('Temp Fact')).toBeNull();

    expect(await store.forget('Temp Fact')).toBe(false);
  });
});

describe('MemoryStore.recall', () => {
  it('ranks notes by hit count, case-insensitively, over description + body', async () => {
    const store = await MemoryStore.open(root);
    await store.remember({
      name: 'Pizza Night',
      description: 'Owner likes pizza on Fridays',
      type: 'routine',
      body: 'Pizza is the go-to Friday dinner. Pizza place: Tony\'s.',
    });
    await store.remember({
      name: 'Snack',
      description: 'Owner sometimes eats pizza as a snack',
      type: 'preference',
      body: 'Nothing else notable.',
    });
    await store.remember({
      name: 'Unrelated',
      description: 'Owner likes hiking',
      type: 'preference',
      body: 'Weekend trails.',
    });

    const results = await store.recall('PIZZA');
    expect(results.length).toBe(2);
    expect(results[0].name).toBe('Pizza Night');
    expect(results.some((r) => r.name === 'Unrelated')).toBe(false);
  });

  it('respects the limit', async () => {
    const store = await MemoryStore.open(root);
    for (let i = 0; i < 8; i++) {
      await store.remember({ name: `Note ${i}`, description: 'matchme', type: 'fact', body: 'body' });
    }
    const results = await store.recall('matchme', 3);
    expect(results).toHaveLength(3);
  });
});
