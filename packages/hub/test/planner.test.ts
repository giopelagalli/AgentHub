import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Planner } from '../src/assistant/planner.js';

let root: string;
let commits: string[];
const commit = async (msg: string): Promise<void> => {
  commits.push(msg);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agenthub-planner-'));
  commits = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('Planner.add / list', () => {
  it('adds items and returns 1-based n; list reflects insertion order', async () => {
    const planner = new Planner(root, commit);

    expect(await planner.add('todo', 'Buy milk')).toBe(1);
    expect(await planner.add('todo', 'Walk dog')).toBe(2);

    const items = await planner.list('todo');
    expect(items).toEqual([
      { n: 1, text: 'Buy milk', done: false },
      { n: 2, text: 'Walk dog', done: false },
    ]);
    expect(commits.length).toBe(2);
  });

  it('keeps lists independent per PlannerList', async () => {
    const planner = new Planner(root, commit);
    await planner.add('goals', 'Ship phase 4');
    await planner.add('backlog', 'Refactor scheduler');

    expect(await planner.list('goals')).toEqual([{ n: 1, text: 'Ship phase 4', done: false }]);
    expect(await planner.list('backlog')).toEqual([{ n: 1, text: 'Refactor scheduler', done: false }]);
    expect(await planner.list('todo')).toEqual([]);
  });
});

describe('Planner.complete / remove', () => {
  it('completes an item, persists [x] to disk, and renumbers correctly after remove', async () => {
    const planner = new Planner(root, commit);
    await planner.add('todo', 'A');
    await planner.add('todo', 'B');
    await planner.add('todo', 'C');

    expect(await planner.complete('todo', 2)).toBe(true);
    expect(await planner.list('todo')).toEqual([
      { n: 1, text: 'A', done: false },
      { n: 2, text: 'B', done: true },
      { n: 3, text: 'C', done: false },
    ]);

    const raw = await readFile(join(root, 'todo.md'), 'utf8');
    expect(raw).toContain('- [x] B');

    expect(await planner.remove('todo', 1)).toBe(true);
    expect(await planner.list('todo')).toEqual([
      { n: 1, text: 'B', done: true },
      { n: 2, text: 'C', done: false },
    ]);
  });

  it('returns false for out-of-range n', async () => {
    const planner = new Planner(root, commit);
    await planner.add('todo', 'A');

    expect(await planner.complete('todo', 5)).toBe(false);
    expect(await planner.remove('todo', 0)).toBe(false);
    expect(await planner.remove('todo', 99)).toBe(false);
  });
});

describe('Planner.snapshot', () => {
  it('includes only open items across all three lists, within the length budget', async () => {
    const planner = new Planner(root, commit);
    await planner.add('goals', 'Goal one');
    await planner.add('todo', 'Todo one');
    await planner.add('todo', 'Todo two');
    await planner.complete('todo', 2);
    await planner.add('backlog', 'Backlog one');

    const snapshot = await planner.snapshot();
    expect(snapshot).toContain('Goal one');
    expect(snapshot).toContain('Todo one');
    expect(snapshot).toContain('Backlog one');
    expect(snapshot).not.toContain('Todo two');
    expect(snapshot.length).toBeLessThanOrEqual(2000);
  });
});
