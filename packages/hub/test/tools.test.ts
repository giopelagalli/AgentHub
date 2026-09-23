import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { openDb } from '../src/db.js';
import { JobQueue } from '../src/queue.js';
import { NodeRegistry } from '../src/node-registry.js';
import { ProjectBundle } from '../src/projects/bundle.js';
import { bundleTools, hubTools, runToolCall, workspaceTools, type Tool, type ToolContext } from '../src/agents/tools.js';
import type { Briefing } from '../src/projects/schema.js';

let root: string;
let bundle: ProjectBundle;
let queue: JobQueue;
let registry: NodeRegistry;
let ctx: ToolContext;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agenthub-tools-'));
  bundle = await ProjectBundle.create(root, { slug: 'demo', title: 'Demo', intent: 'ship a demo' });
  const db = openDb(':memory:');
  queue = new JobQueue(db);
  registry = new NodeRegistry(db);
  ctx = { bundle, hub: { queue, nodes: registry }, sessionId: 1, log: () => {} };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const call = (tools: Tool[], name: string, args: object): Promise<string> =>
  runToolCall(tools, { id: 'call_0', name, arguments: JSON.stringify(args) }, ctx);

/** Polls until the process group is gone (the SIGKILL escalation is asynchronous). */
async function groupGone(pgid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(-pgid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 400 lines of exactly 99 characters each — 39,999 characters total, past READ_FILE_LIMIT (32,000),
 *  so a plain read pages at line 320 and a second call with the reported fromLine finishes the file. */
const bigLines = (): string[] => Array.from({ length: 400 }, (_, i) => `L${i + 1}`.padEnd(99, '.'));

const briefing = (overrides: Partial<Briefing> = {}): Briefing => ({
  slug: 'demo',
  title: 'Demo',
  status: 'active',
  priority: 'project',
  summary: 'going well',
  progress: { done: 1, total: 2 },
  blockers: [],
  nextSteps: ['next'],
  updatedAt: Date.now(),
  ...overrides,
});

describe('workspaceTools', () => {
  it('writes, reads and lists files inside the workspace', async () => {
    const tools = workspaceTools();

    expect(await call(tools, 'write_file', { path: 'notes/todo.md', content: 'hello' })).toContain('notes/todo.md');
    expect(await readFile(join(bundle.workspace, 'notes/todo.md'), 'utf8')).toBe('hello');
    expect(await call(tools, 'read_file', { path: 'notes/todo.md' })).toBe('hello');

    const listing = await call(tools, 'list_dir', { path: '.' });
    expect(listing).toContain('notes/');
  });

  it('returns an error result for a missing file', async () => {
    const out = await call(workspaceTools(), 'read_file', { path: 'nope.txt' });
    expect(out.startsWith('error:')).toBe(true);
  });

  it('refuses paths escaping the workspace', async () => {
    const out = await call(workspaceTools(), 'read_file', { path: '../../etc/passwd' });
    expect(out).toBe('error: cwd escapes workspace');
  });

  it('runs a shell command in the workspace', async () => {
    const out = await call(workspaceTools(), 'run_shell', { cmd: ['echo', 'hello'] });
    expect(out).toContain('exit: 0');
    expect(out).toContain('hello');
  });

  it('reports a non-zero exit without throwing', async () => {
    const out = await call(workspaceTools(), 'run_shell', { cmd: ['sh', '-c', 'exit 3'] });
    expect(out).toContain('exit: 3');
  });

  it('times out a command that leaves a backgrounded grandchild, and kills the group', async () => {
    const started = Date.now();
    // `sleep 60 &` inherits the child's stdio, so waiting on pipe close would hang forever.
    const out = await call(workspaceTools(), 'run_shell', {
      cmd: ['sh', '-c', 'echo $$ > pid.txt; sleep 60 & sleep 30'],
      timeoutMs: 1500,
    });

    expect(out).toMatch(/^error: timed out after 1500ms/);
    expect(Date.now() - started).toBeLessThan(6000);

    const pgid = Number((await readFile(join(bundle.workspace, 'pid.txt'), 'utf8')).trim());
    expect(await groupGone(pgid)).toBe(true);
  });

  it('refuses a cwd escaping the workspace', async () => {
    const out = await call(workspaceTools(), 'run_shell', { cmd: ['pwd'], cwd: '../../..' });
    expect(out).toBe('error: cwd escapes workspace');
  });

  it('refuses a path argument that escapes the workspace', async () => {
    const out = await call(workspaceTools(), 'run_shell', { cmd: ['cat', '../prd.md'] });
    expect(out).toBe('error: path argument escapes workspace: ../prd.md');
  });

  it('errors when the session has no bundle', async () => {
    ctx = { hub: ctx.hub, sessionId: 1, log: () => {} };
    const out = await call(workspaceTools(), 'read_file', { path: 'x' });
    expect(out.startsWith('error:')).toBe(true);
  });

  it('pages a long file at a line boundary, with a marker naming the fromLine to continue from', async () => {
    const lines = bigLines();
    await writeFile(join(bundle.workspace, 'big.txt'), lines.join('\n'), 'utf8');

    const first = await call(workspaceTools(), 'read_file', { path: 'big.txt' });
    expect(first).toBe(
      `${lines.slice(0, 320).join('\n')}\n` +
      `[showing lines 1–320 of 400 (31,999 of 39,999 characters); call read_file again with fromLine: 321 for the rest]`,
    );

    const second = await call(workspaceTools(), 'read_file', { path: 'big.txt', fromLine: 321 });
    expect(second).toBe(lines.slice(320, 400).join('\n'));
  });

  it('slices a file by fromLine and maxLines', async () => {
    const content = ['one', 'two', 'three', 'four', 'five'].join('\n');
    await writeFile(join(bundle.workspace, 'lines.txt'), content, 'utf8');

    // fromLine alone reaches the end of the file, so there is nothing to continue and no marker.
    expect(await call(workspaceTools(), 'read_file', { path: 'lines.txt', fromLine: 2 })).toBe('two\nthree\nfour\nfive');
    // maxLines cutting short of the end is exactly what the marker exists for, even well under the
    // character cap.
    expect(await call(workspaceTools(), 'read_file', { path: 'lines.txt', fromLine: 2, maxLines: 2 })).toBe(
      'two\nthree\n[showing lines 2–3 of 5 (9 of 23 characters); call read_file again with fromLine: 4 for the rest]',
    );
    expect(await call(workspaceTools(), 'read_file', { path: 'lines.txt', maxLines: 1 })).toBe(
      'one\n[showing lines 1–1 of 5 (3 of 23 characters); call read_file again with fromLine: 2 for the rest]',
    );
  });

  it('emits the continuation marker when maxLines cuts the file, not just the character cap', async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `L${i + 1}`);
    await writeFile(join(bundle.workspace, 'many.txt'), lines.join('\n'), 'utf8');

    const shown = lines.slice(0, 100).join('\n');
    const out = await call(workspaceTools(), 'read_file', { path: 'many.txt', maxLines: 100 });
    expect(out).toBe(
      `${shown}\n[showing lines 1–100 of 300 (${shown.length.toLocaleString('en-US')} of ` +
      `${lines.join('\n').length.toLocaleString('en-US')} characters); call read_file again with fromLine: 101 for the rest]`,
    );
  });

  it('errors when fromLine is past the end of the file', async () => {
    await writeFile(join(bundle.workspace, 'short.txt'), ['one', 'two', 'three'].join('\n'), 'utf8');

    const out = await call(workspaceTools(), 'read_file', { path: 'short.txt', fromLine: 400 });
    expect(out).toBe('error: fromLine 400 is past the end (3 lines)');
  });

  it('errors when maxLines is less than 1', async () => {
    await writeFile(join(bundle.workspace, 'short.txt'), ['one', 'two', 'three'].join('\n'), 'utf8');

    const out = await call(workspaceTools(), 'read_file', { path: 'short.txt', maxLines: 0 });
    expect(out).toBe('error: maxLines must be at least 1');
  });
});

describe('bundleTools', () => {
  it('updates project.md and commits', async () => {
    const before = (await simpleGit(bundle.dir).log()).total;
    const out = await call(bundleTools(), 'update_project_md', { content: '# Demo\n\nrewritten\n' });

    expect(out.startsWith('error:')).toBe(false);
    expect(await bundle.readProject()).toContain('rewritten');
    expect((await simpleGit(bundle.dir).log()).total).toBe(before + 1);
  });

  it('appends a decision', async () => {
    await call(bundleTools(), 'add_decision', { title: 'use sqlite', rationale: 'simple', by: 'orchestrator' });
    const log = await readFile(join(bundle.dir, 'decisions.log.md'), 'utf8');
    expect(log).toContain('use sqlite');
    expect(log).toContain('simple');
  });

  it('rewrites the task list', async () => {
    await call(bundleTools(), 'update_tasks', { tasks: [{ id: 't1', title: 'do it', status: 'in-progress' }] });
    expect(await bundle.tasks()).toEqual({ tasks: [{ id: 't1', title: 'do it', status: 'in-progress' }] });
  });

  it('writes a skill', async () => {
    await call(bundleTools(), 'write_skill', { name: 'deploy', body: '# Deploy\n' });
    expect(await bundle.skills()).toEqual([{ name: 'deploy', body: '# Deploy\n' }]);
  });

  it('publishes a valid briefing under the bundle slug, ignoring the model-supplied one', async () => {
    const out = await call(bundleTools(), 'publish_briefing', { ...briefing({ slug: 'other-project' }), bogus: 'ignored' });
    expect(out.startsWith('error:')).toBe(false);
    const published = await bundle.latestBriefing();
    expect(published).toMatchObject({ slug: 'demo', summary: 'going well' });
    expect(published && 'bogus' in published).toBe(false);
  });

  it('rejects an invalid briefing', async () => {
    const out = await call(bundleTools(), 'publish_briefing', briefing({ status: 'nonsense' as Briefing['status'] }));
    expect(out.startsWith('error:')).toBe(true);
    expect(await bundle.latestBriefing()).toBeNull();
  });

  it('reads a bundle file with read_bundle and refuses paths outside it', async () => {
    const out = await call(bundleTools(), 'read_bundle', { path: 'prd.md' });
    expect(out).toBe(await bundle.prd());

    expect(await call(bundleTools(), 'read_bundle', { path: '../../etc/passwd' })).toMatch(/^error:/);
    expect(await call(bundleTools(), 'read_bundle', { path: 'workspace/x' })).toMatch(/^error:/);
  });

  it('lists the bundle files read_bundle can open, and never workspace/', async () => {
    const out = await call(bundleTools(), 'list_bundle', {});
    expect(out).toContain('prd.md');
    expect(out).not.toContain('workspace');
  });

  it('pages a long bundle file the same way read_file does', async () => {
    const lines = bigLines();
    await writeFile(join(bundle.dir, 'prd.md'), lines.join('\n'), 'utf8');

    const first = await call(bundleTools(), 'read_bundle', { path: 'prd.md' });
    expect(first).toBe(
      `${lines.slice(0, 320).join('\n')}\n` +
      `[showing lines 1–320 of 400 (31,999 of 39,999 characters); call read_bundle again with fromLine: 321 for the rest]`,
    );

    const second = await call(bundleTools(), 'read_bundle', { path: 'prd.md', fromLine: 321 });
    expect(second).toBe(lines.slice(320, 400).join('\n'));
  });
});

describe('hubTools', () => {
  it('submits a job to the queue', async () => {
    const out = await call(hubTools(), 'submit_job', {
      type: 'shell-task', tier: 'worker', priority: 'batch', payload: { cmd: ['echo', 'hi'] },
    });
    const jobs = queue.list('queued');
    expect(jobs).toHaveLength(1);
    expect(out).toContain(String(jobs[0].id));
    expect(jobs[0]).toMatchObject({ type: 'shell-task', tier: 'worker', priority: 'batch' });
  });

  it('lists online nodes', async () => {
    registry.register({ name: 'spark', arch: 'arm64', endpoints: [{ tier: 'worker', url: 'http://x', model: 'm', maxStreams: 1 }] });
    const out = await call(hubTools(), 'list_nodes', {});
    expect(out).toContain('spark');
  });
});

describe('runToolCall', () => {
  it('reports unknown tools and malformed arguments as error results', async () => {
    const tools = workspaceTools();
    expect(await runToolCall(tools, { id: 'c', name: 'nope', arguments: '{}' }, ctx)).toContain('unknown tool');
    expect(await runToolCall(tools, { id: 'c', name: 'read_file', arguments: '{oops' }, ctx)).toMatch(/^error:/);
  });

  it('head-keeps a long result and names what it cut', async () => {
    // read_file/read_bundle are selfCapped (they page themselves); any other tool still gets the
    // generic cut, so a neutral fixture tool stands in for one here.
    const longTool: Tool = {
      def: { type: 'tool', name: 'long', description: 'test fixture', parameters: { type: 'object', properties: {}, required: [] } },
      run: async () => `${'x'.repeat(9000)}TAIL`,
    };
    const out = await runToolCall([longTool], { id: 'c', name: 'long', arguments: '{}' }, ctx);
    expect(out.startsWith('x'.repeat(100))).toBe(true);
    expect(out).not.toContain('TAIL');
    expect(out.endsWith('[truncated: showing first 8000 of 9004 characters]')).toBe(true);
  });
});
