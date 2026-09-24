import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { createMockOpenAI, type MockOpenAI, type ScriptStep } from '@agenthub/mocks';
import { routeAccess } from '../src/auth.js';
import { openDb } from '../src/db.js';
import { NodeRegistry } from '../src/node-registry.js';
import { ModelGateway } from '../src/gateway.js';
import { AgentLoop } from '../src/agents/loop.js';
import { bundleTools, docTools } from '../src/agents/tools.js';
import { Transcript } from '../src/agents/transcript.js';
import { ProjectBundle } from '../src/projects/bundle.js';
import { ProjectChat } from '../src/projects/chat.js';
import { FILE_MAX_BYTES, readCodeFile, workspaceTree, writeCodeFile } from '../src/projects/code.js';
import { createHub, type Hub } from '../src/server.js';

const MAP = '# Code map\n\n## Entry points\n\n- `src/main.ts:1` — the process starts here.\n';

let root: string;
let bundle: ProjectBundle;
let mocks: MockOpenAI[];
let hub: Hub | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agenthub-code-'));
  bundle = await ProjectBundle.create(root, { slug: 'demo', title: 'Demo', intent: 'ship the demo' });
  mocks = [];
});

afterEach(async () => {
  await hub?.stop();
  for (const m of mocks) await m.close();
  await rm(root, { recursive: true, force: true });
  hub = undefined;
});

async function serve(script: ScriptStep[] = []): Promise<{ mock: MockOpenAI; url: string }> {
  const mock = createMockOpenAI({ script });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  mocks.push(mock);
  return { mock, url: `http://127.0.0.1:${(mock.server.address() as { port: number }).port}` };
}

async function chatFor(script: ScriptStep[]): Promise<{ chat: ProjectChat; mock: MockOpenAI }> {
  const { mock, url } = await serve(script);
  const db = openDb(':memory:');
  const registry = new NodeRegistry(db);
  registry.register({ name: 'spark', arch: 'arm64', endpoints: [{ tier: 'orchestrator', url, model: 'mock-model', maxStreams: 2 }] });
  const transcript = new Transcript(db);
  const loop = new AgentLoop({ gateway: new ModelGateway(registry), transcript });
  return { chat: new ProjectChat({ loop, transcript, bundleFor: async () => bundle }), mock };
}

/** A small workspace: one module, one nested source file, and the two trees nobody wants listed. */
async function fillWorkspace(): Promise<void> {
  const ws = bundle.workspace;
  await mkdir(join(ws, 'src'), { recursive: true });
  await mkdir(join(ws, 'node_modules', 'left-pad'), { recursive: true });
  await mkdir(join(ws, '.git', 'refs'), { recursive: true });
  await writeFile(join(ws, 'package.json'), '{ "name": "demo" }\n', 'utf8');
  await writeFile(join(ws, 'src', 'main.ts'), 'export const go = 1;\n', 'utf8');
  await writeFile(join(ws, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n', 'utf8');
  await writeFile(join(ws, '.git', 'refs', 'head'), 'ref\n', 'utf8');
}

describe('the workspace tree', () => {
  it('lists directories and files and leaves the dependency trees out', async () => {
    await fillWorkspace();
    const { entries, truncated } = await workspaceTree(bundle.workspace);
    expect(truncated).toBe(false);
    expect(entries.map((e) => e.path)).toEqual(['package.json', 'src', 'src/main.ts']);
    expect(entries.find((e) => e.path === 'src')).toMatchObject({ dir: true, openable: false });
    expect(entries.find((e) => e.path === 'package.json')).toMatchObject({ dir: false, openable: true });
  });

  it('marks a binary file and an oversized one as unopenable', async () => {
    await writeFile(join(bundle.workspace, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(bundle.workspace, 'huge.txt'), 'x'.repeat(FILE_MAX_BYTES + 1), 'utf8');
    const { entries } = await workspaceTree(bundle.workspace);
    expect(entries.find((e) => e.path === 'logo.png')?.openable).toBe(false);
    expect(entries.find((e) => e.path === 'huge.txt')?.openable).toBe(false);
  });

  it('stops at the cap and says so', async () => {
    await fillWorkspace();
    const { entries, truncated } = await workspaceTree(bundle.workspace, 2);
    expect(entries).toHaveLength(2);
    expect(truncated).toBe(true);
  });
});

describe('reading one file', () => {
  it('returns the text and its line count', async () => {
    await writeFile(join(bundle.workspace, 'a.ts'), 'one\ntwo\nthree\n', 'utf8');
    expect(await readCodeFile(bundle.workspace, 'a.ts')).toEqual({ path: 'a.ts', text: 'one\ntwo\nthree\n', lines: 4 });
  });

  it('refuses a missing file, a binary one and one over the size limit', async () => {
    await writeFile(join(bundle.workspace, 'logo.bin'), Buffer.from([0x01, 0x00, 0x02]));
    await writeFile(join(bundle.workspace, 'huge.txt'), 'x'.repeat(FILE_MAX_BYTES + 1), 'utf8');
    expect(await readCodeFile(bundle.workspace, 'ghost.ts')).toMatchObject({ status: 404 });
    expect(await readCodeFile(bundle.workspace, 'logo.bin')).toMatchObject({ status: 415, error: 'binary file' });
    expect(await readCodeFile(bundle.workspace, 'huge.txt')).toMatchObject({ status: 415 });
  });

  it('refuses a path that leaves the workspace', async () => {
    await expect(readCodeFile(bundle.workspace, '../manifest.yaml')).rejects.toThrow(/escapes workspace/);
  });
});

describe('writing one file', () => {
  it('commits the bundle when the workspace is not its own checkout', async () => {
    await writeCodeFile(bundle, 'src/main.ts', 'export const go = 2;\n');
    expect(await readCodeFile(bundle.workspace, 'src/main.ts')).toMatchObject({ text: 'export const go = 2;\n' });
    expect((await simpleGit(bundle.dir).log()).latest?.message).toBe('Owner edit: src/main.ts');
  });

  it('commits the workspace repository when there is one', async () => {
    const ws = bundle.workspace;
    await writeFile(join(ws, 'seed.txt'), 'seed\n', 'utf8');
    const git = simpleGit(ws);
    await git.init();
    await git.addConfig('user.name', 'Test');
    await git.addConfig('user.email', 'test@example.com');
    await git.add(['-A']);
    await git.commit('seed');

    await writeCodeFile(bundle, 'seed.txt', 'edited\n');

    expect((await simpleGit(ws).log()).latest?.message).toBe('Owner edit: seed.txt');
    // The bundle's own log is untouched: the clone is where that edit belongs.
    expect((await simpleGit(bundle.dir).log()).latest?.message).toBe('chore: scaffold project bundle');
  });

  it('refuses a path that leaves the workspace', async () => {
    await expect(writeCodeFile(bundle, '../prd.md', 'nope')).rejects.toThrow(/escapes workspace/);
  });
});

describe('the guide persona', () => {
  it('answers with read-only tools and nothing that writes', async () => {
    await fillWorkspace();
    await bundle.appendDecision({ title: 'One file per route group', rationale: 'the server file was already too long', by: 'manager' });
    const { chat, mock } = await chatFor([
      { toolCalls: [{ name: 'read_file', arguments: { path: 'src/main.ts' } }] },
      { content: 'It exports `go`, see `src/main.ts:1`.' },
    ]);

    const reply = await chat.reply('demo', 'guide', 'What does main.ts do?');
    expect(reply.text).toContain('src/main.ts:1');

    const names = mock.lastRequest().tools.map((t: { function: { name: string } }) => t.function.name).sort();
    expect(names).toEqual(['list_dir', 'read_bundle', 'read_file']);
    expect(names.some((n: string) => n.startsWith('write_'))).toBe(false);

    const system = mock.lastRequest().messages[0].content as string;
    expect(system).toContain('You are read-only');
    expect(system).toContain('`path:line`');
    expect(system).toContain('One file per route group');
  });
});

describe('the code map', () => {
  it('write_code_map writes the page, links it from the index and commits', async () => {
    const tool = docTools('agent').find((t) => t.def.name === 'write_code_map')!;
    const result = await tool.run({ markdown: MAP }, { bundle, sessionId: 1, log: () => {} });

    expect(result).toContain('docs/code-map.md written');
    expect(await bundle.doc('code-map')).toBe(MAP);
    expect((await bundle.docs()).index).toContain('(code-map.md)');
    expect((await simpleGit(bundle.dir).log()).latest?.message).toBe('agent: write code map');
  });

  it('is on the belt an orchestrator turn carries', () => {
    expect(bundleTools().map((t) => t.def.name)).toContain('write_code_map');
  });
});

describe('the code routes', () => {
  beforeEach(async () => {
    const { url } = await serve([
      { toolCalls: [{ name: 'write_code_map', arguments: { markdown: MAP } }] },
      { content: 'Map refreshed.' },
    ]);
    hub = createHub({ projectsRoot: root });
    await hub.app.inject({
      method: 'POST', url: '/api/nodes/register',
      payload: { name: 'spark', arch: 'arm64', endpoints: [{ tier: 'orchestrator', url, model: 'mock-model', maxStreams: 2 }] },
    });
  });

  it('serves the tree, one file and the summary', async () => {
    await fillWorkspace();
    const target = hub!;

    const tree = await target.app.inject({ method: 'GET', url: '/api/projects/demo/code/tree' });
    expect(tree.statusCode).toBe(200);
    expect(tree.json().entries.map((e: { path: string }) => e.path)).toEqual(['package.json', 'src', 'src/main.ts']);

    const file = await target.app.inject({ method: 'GET', url: '/api/projects/demo/code/file?path=src/main.ts' });
    expect(file.statusCode).toBe(200);
    expect(file.json()).toMatchObject({ path: 'src/main.ts', text: 'export const go = 1;\n', lines: 2 });

    const summary = await target.app.inject({ method: 'GET', url: '/api/projects/demo/code' });
    expect(summary.json()).toMatchObject({ files: 2, truncated: false, map: null });
  });

  it('404s a missing file and 400s one that climbs out of the workspace', async () => {
    const target = hub!;
    expect((await target.app.inject({ method: 'GET', url: '/api/projects/demo/code/file?path=ghost.ts' })).statusCode).toBe(404);
    const escape = await target.app.inject({ method: 'GET', url: '/api/projects/demo/code/file?path=../prd.md' });
    expect(escape.statusCode).toBe(400);
    expect(escape.json().error).toMatch(/escapes workspace/);
  });

  it('saves an edit and refuses one aimed outside the project\'s own code', async () => {
    const target = hub!;
    const ok = await target.app.inject({
      method: 'PUT', url: '/api/projects/demo/code/file', payload: { path: 'src/main.ts', text: 'export const go = 3;\n' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ path: 'src/main.ts', committed: 'bundle' });
    expect((await simpleGit(bundle.dir).log()).latest?.message).toBe('Owner edit: src/main.ts');

    for (const path of ['../prd.md', '.git/config', 'node_modules/left-pad/index.js']) {
      const bad = await target.app.inject({ method: 'PUT', url: '/api/projects/demo/code/file', payload: { path, text: 'x' } });
      expect(bad.statusCode, path).toBe(400);
    }
  });

  it('refreshes the map through a one-off task', async () => {
    const target = hub!;
    const done = await target.app.inject({ method: 'POST', url: '/api/projects/demo/code/map' });
    expect(done.statusCode).toBe(200);
    expect(done.json().markdown).toBe(MAP);
    expect(await bundle.doc('code-map')).toBe(MAP);
  });

  it('keeps every code route to the owner', () => {
    expect(routeAccess('GET', '/api/projects/:slug/code')).toBe('owner');
    expect(routeAccess('GET', '/api/projects/:slug/code/tree')).toBe('owner');
    expect(routeAccess('GET', '/api/projects/:slug/code/file')).toBe('owner');
    expect(routeAccess('PUT', '/api/projects/:slug/code/file')).toBe('owner');
    expect(routeAccess('POST', '/api/projects/:slug/code/map')).toBe('owner');
  });
});
