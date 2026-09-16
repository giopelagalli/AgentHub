import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { PRD_SECTIONS } from '@agenthub/shared';
import { createMockOpenAI, type MockOpenAI, type ScriptStep } from '@agenthub/mocks';
import { openDb } from '../src/db.js';
import { NodeRegistry } from '../src/node-registry.js';
import { ModelGateway } from '../src/gateway.js';
import { AgentLoop } from '../src/agents/loop.js';
import { Transcript } from '../src/agents/transcript.js';
import { ProjectBundle } from '../src/projects/bundle.js';
import { auditPrd, isPrdScaffold, prdScaffold, PrdDrafter, PrdNotDraftedError } from '../src/projects/prd.js';
import { createHub, type Hub } from '../src/server.js';

let root: string;
let bundle: ProjectBundle;
let mocks: MockOpenAI[];
let hub: Hub | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agenthub-prd-'));
  bundle = await ProjectBundle.create(root, { slug: 'demo', title: 'Demo', intent: 'ship the demo' });
  mocks = [];
});

afterEach(async () => {
  await hub?.stop();
  for (const m of mocks) await m.close();
  await rm(root, { recursive: true, force: true });
  hub = undefined;
});

/** A section body long enough not to read as thin. */
const body = (title: string): string => `${title}: `.padEnd(240, 'concrete detail, named technology, a real limit. ');

/** A PRD with every section filled in; `overrides` replaces one section's body. */
function fullPrd(overrides: Record<string, string> = {}): string {
  return [
    `# Demo — PRD`,
    ``,
    ...PRD_SECTIONS.flatMap((s) => [`## ${s.title}`, ``, overrides[s.key] ?? body(s.title), ``]),
  ].join('\n');
}

async function serve(script: ScriptStep[]): Promise<{ mock: MockOpenAI; url: string }> {
  const mock = createMockOpenAI({ script });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  mocks.push(mock);
  return { mock, url: `http://127.0.0.1:${(mock.server.address() as { port: number }).port}` };
}

interface Harness { drafter: PrdDrafter; mock: MockOpenAI; transcript: Transcript }

async function setup(script: ScriptStep[]): Promise<Harness> {
  const { mock, url } = await serve(script);
  const db = openDb(':memory:');
  const registry = new NodeRegistry(db);
  registry.register({
    name: 'spark', arch: 'arm64',
    endpoints: [{ tier: 'orchestrator', url, model: 'mock-model', maxStreams: 2 }],
  });
  const transcript = new Transcript(db);
  const gateway = new ModelGateway(registry);
  const loop = new AgentLoop({ gateway, transcript });
  return { drafter: new PrdDrafter({ loop, gateway, transcript, bundleFor: async () => bundle }), mock, transcript };
}

/** A hub on a real socket, one mock serving the orchestrator tier, with project `demo` created. */
async function hubHarness(script: ScriptStep[] = []): Promise<{ hub: Hub; port: number }> {
  const { url } = await serve(script);
  hub = createHub({ projectsRoot: root });
  await hub.app.inject({
    method: 'POST', url: '/api/nodes/register',
    payload: { name: 'spark', arch: 'arm64', endpoints: [{ tier: 'orchestrator', url, model: 'mock-model', maxStreams: 2 }] },
  });
  await hub.app.listen({ port: 0, host: '127.0.0.1' });
  return { hub, port: (hub.app.server.address() as { port: number }).port };
}

describe('auditPrd', () => {
  it('scores a complete PRD at 100 and reports nothing missing', () => {
    const audit = auditPrd(fullPrd());
    expect(audit.score).toBe(100);
    expect(audit.missing).toEqual([]);
    expect(audit.sections).toHaveLength(PRD_SECTIONS.length);
    expect(audit.sections.every((s) => s.present && !s.thin)).toBe(true);
  });

  it('counts a present-but-thin section against the score', () => {
    const audit = auditPrd(fullPrd({ security: 'We will use auth.' }));
    const security = audit.sections.find((s) => s.key === 'security');
    expect(security).toMatchObject({ present: true, thin: true });
    expect(audit.missing).toEqual(['Security & privacy']);
    expect(audit.score).toBe(Math.round((100 * (PRD_SECTIONS.length - 1)) / PRD_SECTIONS.length));
  });

  it('marks a dropped section absent and matches headings case-insensitively', () => {
    const without = fullPrd().split('## Data model')[0];
    const audit = auditPrd(without);
    expect(audit.sections.find((s) => s.key === 'data')).toMatchObject({ present: false, thin: true });

    const shouted = fullPrd().replace('## Overview & problem', '## OVERVIEW & PROBLEM');
    expect(auditPrd(shouted).score).toBe(100);
  });
});

describe('the PRD scaffold', () => {
  it('is every section, empty, and reads as undrafted', () => {
    const scaffold = prdScaffold('Demo');
    for (const section of PRD_SECTIONS) expect(scaffold).toContain(`## ${section.title}`);
    expect(isPrdScaffold(scaffold)).toBe(true);
    expect(auditPrd(scaffold).score).toBe(0);
  });

  it('stops reading as a scaffold once one section says something', () => {
    expect(isPrdScaffold(prdScaffold('Demo').replace('## Overview & problem', '## Overview & problem\n\nA real sentence.'))).toBe(false);
    expect(isPrdScaffold(fullPrd())).toBe(false);
  });

  it('is what a new bundle starts with', async () => {
    expect(isPrdScaffold(await bundle.prd())).toBe(true);
    expect((await bundle.manifest()).prdScore).toBe(0);
    expect(await bundle.roadmap()).toEqual([]);
    expect((await bundle.docs()).pages).toEqual([]);
  });
});

describe('PrdDrafter.draft', () => {
  it('drafts from an idea, writes prd.md and hands back the questions', async () => {
    const { drafter, mock, transcript } = await setup([{
      content: `${fullPrd()}\n## Questions for the owner\n- Which database?\n- Which auth provider?\n`,
    }]);

    const result = await drafter.draft('demo', { idea: 'a todo app for one owner' });

    expect(result.audit.score).toBe(100);
    expect(result.questions).toEqual(['Which database?', 'Which auth provider?']);
    expect(result.markdown).not.toContain('Questions for the owner');

    const written = await bundle.prd();
    for (const section of PRD_SECTIONS) expect(written).toContain(`## ${section.title}`);
    expect(written).not.toContain('Questions for the owner');
    expect((await bundle.manifest()).prdScore).toBe(100);

    // The idea reaches the model, and the work is visible as its own chat session.
    expect(mock.lastRequest().messages.at(-1).content).toContain('a todo app for one owner');
    expect(transcript.sessions({ kind: 'chat', subject: 'demo:prd' })).toHaveLength(1);

    const log = await simpleGit(bundle.dir).log();
    expect(log.latest?.message).toBe('agent: draft prd');
  });

  it('keeps the owner\'s own PRD when completing a pasted one', async () => {
    const sentence = 'The frobnicator must never be switched off during a render.';
    const { drafter, mock } = await setup([{ content: fullPrd({ overview: `${sentence} ${body('Overview & problem')}` }) }]);

    const result = await drafter.draft('demo', { prd: `# Demo\n\n## Overview & problem\n\n${sentence}\n` });

    const request = mock.lastRequest();
    expect(request.messages[0].content).toContain('Never delete something they wrote');
    expect(request.messages.at(-1).content).toContain(sentence);
    expect(result.markdown).toContain(sentence);
    expect(await bundle.prd()).toContain(sentence);
  });

  it('refuses to generate a roadmap while the PRD is still the scaffold', async () => {
    const { drafter } = await setup([]);
    await expect(drafter.generateRoadmap('demo')).rejects.toBeInstanceOf(PrdNotDraftedError);
  });
});

describe('PRD routes', () => {
  it('serves the PRD with its audit and takes an owner hand-edit', async () => {
    const { hub: target } = await hubHarness();

    const before = await target.app.inject({ method: 'GET', url: '/api/projects/demo/prd' });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({ drafted: false, audit: { score: 0 } });
    expect(before.json().updatedAt).toBeGreaterThan(0);

    const put = await target.app.inject({ method: 'PUT', url: '/api/projects/demo/prd', payload: { markdown: fullPrd() } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ audit: auditPrd(fullPrd()) });

    const after = await target.app.inject({ method: 'GET', url: '/api/projects/demo/prd' });
    expect(after.json()).toMatchObject({ drafted: true, audit: { score: 100 } });
    // The score is cached on the manifest so the project list can badge it.
    expect((await target.app.inject({ method: 'GET', url: '/api/projects' })).json()[0].prdScore).toBe(100);

    const log = await simpleGit(join(root, 'demo')).log();
    expect(log.latest?.message).toBe('owner: edit prd');
  });

  it('rejects a malformed edit and an unknown project', async () => {
    const { hub: target } = await hubHarness();
    expect((await target.app.inject({ method: 'PUT', url: '/api/projects/demo/prd', payload: {} })).statusCode).toBe(400);
    expect((await target.app.inject({ method: 'GET', url: '/api/projects/nope/prd' })).statusCode).toBe(404);
  });

  it('streams a draft and ends with the full PRD, its questions and its audit', async () => {
    const { port } = await hubHarness([{ content: `${fullPrd()}\n## Questions for the owner\n- Which database?\n` }]);

    const res = await fetch(`http://127.0.0.1:${port}/api/projects/demo/prd/draft`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idea: 'a todo app' }),
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const frames = [...(await res.text()).matchAll(/data: (\{.*\})/g)]
      .map((m) => JSON.parse(m[1]) as { token?: string; done?: boolean; full?: string; questions?: string[]; audit?: { score: number } });

    expect(frames.filter((f) => f.token).length).toBeGreaterThan(0);
    const done = frames[frames.length - 1];
    expect(done.done).toBe(true);
    expect(done.questions).toEqual(['Which database?']);
    expect(done.audit?.score).toBe(100);
    expect(done.full).toContain('## Functional requirements');
    expect(done.full).not.toContain('Questions for the owner');
  });

  it('drafts from the idea the project was created with', async () => {
    const { hub: target, port } = await hubHarness([{ content: fullPrd() }]);
    await target.app.inject({
      method: 'POST', url: '/api/projects',
      payload: { slug: 'seeded', title: 'Seeded', intent: 'ship it', idea: 'a kanban board for one team' },
    });

    const created = await target.app.inject({ method: 'GET', url: '/api/projects/seeded' });
    expect(created.json().manifest.intake).toEqual({ idea: 'a kanban board for one team' });

    const res = await fetch(`http://127.0.0.1:${port}/api/projects/seeded/prd/draft`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    await res.text();
    expect((await target.app.inject({ method: 'GET', url: '/api/projects/seeded/prd' })).json().drafted).toBe(true);
    expect(mocks[0].requests.at(-1).messages.at(-1).content).toContain('a kanban board for one team');
  });
});
