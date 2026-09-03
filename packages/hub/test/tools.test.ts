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

  it('refuses a cwd escaping the workspace', async () => {
    const out = await call(workspaceTools(), 'run_shell', { cmd: ['pwd'], cwd: '../../..' });
    expect(out).toBe('error: cwd escapes workspace');
  });

  it('errors when the session has no bundle', async () => {
    ctx = { hub: ctx.hub, sessionId: 1, log: () => {} };
    const out = await call(workspaceTools(), 'read_file', { path: 'x' });
    expect(out.startsWith('error:')).toBe(true);
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

  it('publishes a valid briefing', async () => {
    const out = await call(bundleTools(), 'publish_briefing', briefing());
    expect(out.startsWith('error:')).toBe(false);
    expect(await bundle.latestBriefing()).toMatchObject({ slug: 'demo', summary: 'going well' });
  });

  it('rejects an invalid briefing', async () => {
    const out = await call(bundleTools(), 'publish_briefing', briefing({ status: 'nonsense' as Briefing['status'] }));
    expect(out.startsWith('error:')).toBe(true);
    expect(await bundle.latestBriefing()).toBeNull();
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

  it('truncates long results to 8k chars', async () => {
    await writeFile(join(bundle.workspace, 'big.txt'), 'x'.repeat(20000), 'utf8');
    const out = await call(workspaceTools(), 'read_file', { path: 'big.txt' });
    expect(out.length).toBe(8000);
    expect(out.endsWith('[truncated]')).toBe(true);
  });
});
