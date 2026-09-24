import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { dump, load } from 'js-yaml';
import { simpleGit } from 'simple-git';
import type { ProjectSource, TurnEvent } from '@agenthub/shared';
import { createMockOpenAI, type MockOpenAI, type ScriptStep } from '@agenthub/mocks';
import { openDb } from '../src/db.js';
import { NodeRegistry } from '../src/node-registry.js';
import { ModelGateway } from '../src/gateway.js';
import { AgentLoop } from '../src/agents/loop.js';
import { Transcript } from '../src/agents/transcript.js';
import type { ToolContext } from '../src/agents/tools.js';
import { completeMilestoneTool } from '../src/agents/verify.js';
import type { ProjectBundle } from '../src/projects/bundle.js';
import { assertPushable, Github, PatCredentials } from '../src/projects/github.js';
import { createHub, type Hub } from '../src/server.js';

/**
 * "GitHub" here is a bare repository on disk, reached through the `cloneBase` seam — so the import,
 * the push and the guardrail are exercised against real git, offline. The REST half (the pull
 * request) is a stubbed `fetch`. Only the private-repo case needs a server: an HTTP remote that
 * answers 401 is the one way to make git fail for the reason the 400 is about.
 */

const OWNER = 'acme';
const REPO = 'portal';
const README = '# Portal\n\nThe Acme customer portal: invoices, seats and SSO.\n';

let root: string;
let origin: string;
let bare: string;
let mocks: MockOpenAI[];
let servers: FastifyInstance[];
let hub: Hub | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agenthub-import-projects-'));
  origin = await mkdtemp(join(tmpdir(), 'agenthub-import-origin-'));
  bare = await seedRepo();
  mocks = [];
  servers = [];
});

afterEach(async () => {
  await hub?.stop();
  for (const m of mocks) await m.close();
  for (const s of servers) await s.close();
  await rm(root, { recursive: true, force: true });
  await rm(origin, { recursive: true, force: true });
  hub = undefined;
});

/** A bare `acme/portal.git` on `main`, with a README, a package.json and one commit. */
async function seedRepo(): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), 'agenthub-import-seed-'));
  await writeFile(join(work, 'README.md'), README, 'utf8');
  await writeFile(join(work, 'package.json'), `${JSON.stringify({ name: 'portal', version: '1.0.0' }, null, 2)}\n`, 'utf8');
  await writeFile(join(work, 'index.js'), '// the portal entry point\n', 'utf8');
  const git = simpleGit(work);
  await git.init();
  await git.raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await git.addConfig('user.name', 'Seed');
  await git.addConfig('user.email', 'seed@example.com');
  await git.add(['-A']);
  await git.commit('initial');
  const path = join(origin, OWNER, `${REPO}.git`);
  await mkdir(join(origin, OWNER), { recursive: true });
  await simpleGit().clone(work, path, ['--bare']);
  await rm(work, { recursive: true, force: true });
  return path;
}

interface HubOver { token?: string; fetch?: typeof fetch; apiBase?: string; cloneBase?: string }

function makeHub(over: HubOver = {}): Hub {
  const { token = 'ghp_test', cloneBase = `file://${origin}`, ...rest } = over;
  hub = createHub({
    projectsRoot: root,
    github: { cloneBase, ...(token ? { token } : {}), ...rest },
  });
  return hub;
}

const app = (): Hub['app'] => {
  if (!hub) throw new Error('makeHub() not called');
  return hub.app;
};

/** Creates project `portal` from `url`, and answers with the route's own reply. */
async function importProject(url: string, branch?: string, slug = 'portal') {
  return app().inject({
    method: 'POST', url: '/api/projects',
    payload: {
      slug, title: 'Portal', intent: 'add SSO to the portal',
      source: { url, ...(branch !== undefined ? { branch } : {}) },
    },
  });
}

/** The imported project's bundle, prepared so `complete_milestone` can only come back done. */
async function readyForMilestone(slug = 'portal'): Promise<ProjectBundle> {
  const bundle = await hub!.projects.get(slug);
  await bundle.writeRoadmap([
    { id: 'm1', title: 'SSO', summary: 'Owners sign in with SSO.', status: 'planned' },
    { id: 'm2', title: 'Seats', summary: 'Seats can be assigned.', status: 'planned' },
  ]);
  // No reviewer on the roster and a test command that passes: the verdict is tests-pass, and the
  // milestone is done without a model being involved at all.
  await bundle.writeTeam([]);
  const manifestPath = join(bundle.dir, 'manifest.yaml');
  const manifest = load(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  await writeFile(manifestPath, dump({ ...manifest, verifyCmd: 'true' }), 'utf8');
  await bundle.commit('test: prepare milestone');
  return bundle;
}

interface Completion { result: string; events: TurnEvent[] }

/** Runs `complete_milestone` against a bundle with the given GitHub client. */
async function complete(bundle: ProjectBundle, github: Github, id = 'm1'): Promise<Completion> {
  const db = openDb(':memory:');
  const transcript = new Transcript(db);
  const loop = new AgentLoop({ gateway: new ModelGateway(new NodeRegistry(db)), transcript });
  const events: TurnEvent[] = [];
  const ctx: ToolContext = { bundle, sessionId: 0, log: () => {}, onEvent: (e) => events.push(e) };
  const tool = completeMilestoneTool({ loop, subject: 'portal' }, github);
  return { result: await tool.run({ id }, ctx), events };
}

const localGithub = (): Github => new Github({ credentials: new PatCredentials('ghp_test'), cloneBase: `file://${origin}` });

const sourceOf = async (bundle: ProjectBundle): Promise<ProjectSource> => {
  const source = (await bundle.manifest()).source;
  if (!source) throw new Error('no source on the manifest');
  return source;
};

describe('importing a repository', () => {
  it('clones it into workspace/, records the source, and leaves the checkout out of the bundle', async () => {
    makeHub();
    const created = await importProject('https://github.com/acme/portal.git');
    expect(created.statusCode).toBe(201);
    expect(created.json().source).toMatchObject({
      kind: 'github', owner: 'acme', repo: 'portal', branch: 'main', pushBranch: 'agenthub/portal',
    });
    expect(created.json().source.importedCommit).toMatch(/^[0-9a-f]{40}$/);

    const workspace = join(root, 'portal', 'workspace');
    expect(await readFile(join(workspace, 'README.md'), 'utf8')).toBe(README);
    expect(existsSync(join(workspace, '.git'))).toBe(true);

    // The workspace is its own repo, so the bundle ignores the whole directory rather than record
    // it as a dangling gitlink — the same treatment a nested checkout has always had.
    expect(await readFile(join(root, 'portal', '.gitignore'), 'utf8')).toContain('workspace/');
    const tracked = (await simpleGit(join(root, 'portal')).raw(['ls-files'])).split('\n');
    expect(tracked.some((p) => p.startsWith('workspace/'))).toBe(false);
    expect(tracked).toContain('manifest.yaml');
  });

  it('takes every spelling of a repository, and a branch', async () => {
    makeHub();
    expect((await importProject('acme/portal', undefined, 'short')).json().source)
      .toMatchObject({ owner: 'acme', repo: 'portal' });
    expect((await importProject('git@github.com:acme/portal.git', undefined, 'ssh')).json().source)
      .toMatchObject({ owner: 'acme', repo: 'portal' });
    expect((await importProject('https://github.com/acme/portal/', 'main', 'branch')).json().source)
      .toMatchObject({ branch: 'main' });
  });

  it('refuses anything that is not a GitHub repository, or a branch that reads as an option', async () => {
    makeHub();
    for (const url of ['https://gitlab.com/acme/portal', 'acme/portal/extra', 'not a repo', '']) {
      const res = await importProject(url);
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error, url).toMatch(/not a GitHub repository|invalid source/);
    }
    const bad = await importProject('acme/portal', '--upload-pack=touch /tmp/x');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid branch');
    // Nothing was created for any of them.
    expect((await app().inject({ method: 'GET', url: '/api/projects' })).json()).toHaveLength(0);
  });

  it('answers 502 with git\'s own first line when the clone fails, and frees the slug again', async () => {
    makeHub();
    const res = await app().inject({
      method: 'POST', url: '/api/projects',
      payload: { slug: 'gone', title: 'Gone', intent: 'x', source: { url: 'acme/missing' } },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/missing\.git/);
    expect(existsSync(join(root, 'gone'))).toBe(false);
    expect((await app().inject({ method: 'GET', url: '/api/projects' })).json()).toHaveLength(0);
  });

  it('asks for a token when the repository will not let us in without one', async () => {
    // An HTTP remote that demands Basic auth: the one way, offline, to make git fail the way a
    // private repository does. GIT_TERMINAL_PROMPT=0 means it fails rather than waits.
    const server = Fastify();
    servers.push(server);
    server.all('/*', async (_req, reply) => reply.code(401).header('www-authenticate', 'Basic realm="github"').send('no'));
    await server.listen({ port: 0, host: '127.0.0.1' });
    const port = (server.server.address() as { port: number }).port;

    makeHub({ token: '', cloneBase: `http://127.0.0.1:${port}` });
    const res = await importProject('acme/portal');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('private repository: set GITHUB_TOKEN on the hub');
  });

  it('reports whether a token is configured, and never the token', async () => {
    makeHub();
    expect((await app().inject({ method: 'GET', url: '/api/github/status' })).json())
      .toEqual({ configured: true, method: 'token' });

    await hub!.stop();
    makeHub({ token: '' });
    expect((await app().inject({ method: 'GET', url: '/api/github/status' })).json())
      .toEqual({ configured: false, method: 'none' });
  });
});

describe('drafting a PRD from the code', () => {
  it('puts the README, the manifests and the file list in front of the drafter', async () => {
    const mock = createMockOpenAI({ script: [{ content: '# Portal — PRD\n\n## Overview & problem\n\nIt exists.\n' }] satisfies ScriptStep[] });
    await mock.listen({ port: 0, host: '127.0.0.1' });
    mocks.push(mock);
    const url = `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`;

    makeHub();
    await app().inject({
      method: 'POST', url: '/api/nodes/register',
      payload: { name: 'spark', arch: 'arm64', endpoints: [{ tier: 'orchestrator', url, model: 'mock-model', maxStreams: 2 }] },
    });
    expect((await importProject('acme/portal')).statusCode).toBe(201);

    await app().listen({ port: 0, host: '127.0.0.1' });
    const hubPort = (app().server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${hubPort}/api/projects/portal/prd/draft`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    await res.text();

    const messages = mock.lastRequest().messages as { role: string; content: string }[];
    const user = messages[messages.length - 1].content;
    expect(user).toContain('# The existing codebase');
    expect(user).toContain('The Acme customer portal');
    expect(user).toContain('"name": "portal"');
    expect(user).toContain('index.js');
    // And the drafter is told the product already exists rather than told to invent one.
    expect(messages[0].content).toContain('imported from an existing repository');
  });
});

describe('writing a verified milestone back', () => {
  it('pushes agenthub/<slug> into the repository and records that it landed', async () => {
    makeHub();
    expect((await importProject('acme/portal')).statusCode).toBe(201);
    const bundle = await readyForMilestone();
    await writeFile(join(bundle.workspace, 'sso.js'), '// single sign-on\n', 'utf8');

    const { result, events } = await complete(bundle, localGithub());
    expect(result).toContain('is now done');

    const branches = await simpleGit(bare).raw(['branch', '--list']);
    expect(branches).toContain('agenthub/portal');
    // What the milestone produced is on that branch, and the repository's own branch is untouched.
    expect(await simpleGit(bare).raw(['show', '--name-only', '--format=', 'agenthub/portal'])).toContain('sso.js');
    expect(await simpleGit(bare).raw(['show', '--name-only', '--format=', 'main'])).not.toContain('sso.js');

    expect((await sourceOf(bundle)).pushedAt).toBeGreaterThan(0);
    expect(events.some((e) => e.kind === 'text' && e.text.includes('pushed agenthub/portal'))).toBe(true);
  });

  it('keeps the milestone done when the push fails, and says where it failed', async () => {
    makeHub();
    expect((await importProject('acme/portal')).statusCode).toBe(201);
    const bundle = await readyForMilestone();
    await writeFile(join(bundle.workspace, 'sso.js'), '// single sign-on\n', 'utf8');
    await rm(bare, { recursive: true, force: true });

    const { result, events } = await complete(bundle, localGithub());
    expect(result).toContain('is now done');
    expect((await bundle.roadmap()).find((m) => m.id === 'm1')?.status).toBe('done');
    expect((await sourceOf(bundle)).pushedAt).toBeUndefined();

    expect(await bundle.decisions()).toContain('Push of agenthub/portal failed after m1');
    expect(events.some((e) => e.kind === 'text' && e.text.includes('could not push agenthub/portal'))).toBe(true);
  });

  it('refuses to push when the branch to push is the repository\'s own', async () => {
    makeHub();
    expect((await importProject('acme/portal')).statusCode).toBe(201);
    const bundle = await hub!.projects.get('portal');
    const source = await sourceOf(bundle);
    const trunk = { ...source, pushBranch: source.branch };

    expect(() => assertPushable(trunk)).toThrow(/refusing to push: main is the repository's own branch/);
    await expect(localGithub().pushWorkspace(bundle.workspace, trunk, 'nope')).rejects.toThrow(/refusing to push/);
    // main still points where it did: nothing reached it.
    expect(await simpleGit(bare).raw(['show', '--name-only', '--format=%s', 'main'])).toContain('initial');
  });
});

describe('the pull request', () => {
  /** A GitHub REST stub: one open pull request per head, created once and found thereafter. */
  function stubApi(): { fetch: typeof fetch; calls: { method: string; url: string; body?: unknown }[] } {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    let open: unknown[] = [];
    const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? 'GET';
      calls.push({
        method, url: String(input),
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
      });
      if (method === 'GET') return new Response(JSON.stringify(open), { status: 200 });
      open = [{ html_url: 'https://github.com/acme/portal/pull/7' }];
      return new Response(JSON.stringify(open[0]), { status: 201 });
    };
    return { fetch: impl as typeof fetch, calls };
  }

  it('opens one, stores it on the manifest, and finds the same one next time', async () => {
    const api = stubApi();
    makeHub({ fetch: api.fetch, apiBase: 'https://api.test' });
    expect((await importProject('acme/portal')).statusCode).toBe(201);
    const bundle = await readyForMilestone();
    await writeFile(join(bundle.workspace, 'sso.js'), '// single sign-on\n', 'utf8');
    await complete(bundle, localGithub());

    const first = await app().inject({ method: 'POST', url: '/api/projects/portal/pr' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ url: 'https://github.com/acme/portal/pull/7' });
    expect((await sourceOf(bundle)).prUrl).toBe('https://github.com/acme/portal/pull/7');

    const created = api.calls.find((c) => c.method === 'POST');
    expect(created?.url).toBe('https://api.test/repos/acme/portal/pulls');
    expect(created?.body).toMatchObject({ head: 'agenthub/portal', base: 'main' });
    expect((created?.body as { title: string }).title).toBe('Portal — SSO');

    const again = await app().inject({ method: 'POST', url: '/api/projects/portal/pr' });
    expect(again.json()).toEqual({ url: 'https://github.com/acme/portal/pull/7' });
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('refuses without a token, without a source, and before anything is pushed', async () => {
    const api = stubApi();
    makeHub({ fetch: api.fetch, apiBase: 'https://api.test' });
    expect((await importProject('acme/portal')).statusCode).toBe(201);
    await app().inject({
      method: 'POST', url: '/api/projects',
      payload: { slug: 'plain', title: 'Plain', intent: 'no repo here' },
    });

    const plain = await app().inject({ method: 'POST', url: '/api/projects/plain/pr' });
    expect(plain.statusCode).toBe(400);
    expect(plain.json().error).toMatch(/not imported/);

    const unpushed = await app().inject({ method: 'POST', url: '/api/projects/portal/pr' });
    expect(unpushed.statusCode).toBe(400);
    expect(unpushed.json().error).toMatch(/nothing has been pushed/);
    expect(api.calls).toHaveLength(0);

    // The same project on a hub with no token: the push branch exists, the credential does not.
    const bundle = await hub!.projects.get('portal');
    await bundle.setSource({ ...(await sourceOf(bundle)), pushedAt: Date.now() });
    await hub!.stop();
    makeHub({ token: '', fetch: api.fetch, apiBase: 'https://api.test' });
    const noToken = await app().inject({ method: 'POST', url: '/api/projects/portal/pr' });
    expect(noToken.statusCode).toBe(400);
    expect(noToken.json().error).toMatch(/no GitHub token/);
  });
});
