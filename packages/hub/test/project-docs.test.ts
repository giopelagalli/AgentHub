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
import { ProjectChat } from '../src/projects/chat.js';
import { createHub, type Hub } from '../src/server.js';

const PAGE = '# How the queue works\n\nJobs are claimed by node daemons, oldest first.\n';

let root: string;
let bundle: ProjectBundle;
let mocks: MockOpenAI[];
let hub: Hub | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agenthub-docs-'));
  bundle = await ProjectBundle.create(root, { slug: 'demo', title: 'Demo', intent: 'ship the demo' });
  mocks = [];
});

afterEach(async () => {
  await hub?.stop();
  for (const m of mocks) await m.close();
  await rm(root, { recursive: true, force: true });
  hub = undefined;
});

async function serve(script: ScriptStep[]): Promise<{ mock: MockOpenAI; url: string }> {
  const mock = createMockOpenAI({ script });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  mocks.push(mock);
  return { mock, url: `http://127.0.0.1:${(mock.server.address() as { port: number }).port}` };
}

async function setup(script: ScriptStep[]): Promise<{ chat: ProjectChat; mock: MockOpenAI }> {
  const { mock, url } = await serve(script);
  const db = openDb(':memory:');
  const registry = new NodeRegistry(db);
  registry.register({ name: 'spark', arch: 'arm64', endpoints: [{ tier: 'orchestrator', url, model: 'mock-model', maxStreams: 2 }] });
  const transcript = new Transcript(db);
  const loop = new AgentLoop({ gateway: new ModelGateway(registry), transcript });
  return { chat: new ProjectChat({ loop, transcript, bundleFor: async () => bundle }), mock };
}

const lastSystem = (mock: MockOpenAI): string => mock.lastRequest().messages[0].content as string;

describe('the docs persona', () => {
  it('writes a page, links it from the index and commits as the owner', async () => {
    const { chat, mock } = await setup([
      { toolCalls: [{ name: 'write_doc', arguments: { page: 'queue', markdown: PAGE } }] },
      { content: 'Added a page on the queue.' },
    ]);

    const reply = await chat.reply('demo', 'docs', 'Write down how the queue works.');
    expect(reply.text).toBe('Added a page on the queue.');

    expect(await bundle.doc('queue')).toBe(PAGE);
    const { index, pages } = await bundle.docs();
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ slug: 'queue', title: 'How the queue works' });
    expect(index).toContain('[How the queue works](queue.md)');
    expect((await simpleGit(bundle.dir).log()).latest?.message).toBe('owner: write doc queue');

    // The persona is the docs one, with its own purpose and its own tools.
    const system = lastSystem(mock);
    expect(system).toContain("maintain this project's living documentation");
    expect(system).toContain('supersede it with a dated note');
    expect(mock.lastRequest().tools.map((t: { function: { name: string } }) => t.function.name).sort())
      .toEqual(['list_dir', 'list_docs', 'read_doc', 'read_file', 'write_doc']);
  });

  it('does not link the same page twice', async () => {
    const { chat } = await setup([
      { toolCalls: [{ name: 'write_doc', arguments: { page: 'queue', markdown: PAGE } }] },
      { content: 'done' },
      { toolCalls: [{ name: 'write_doc', arguments: { page: 'queue', markdown: `${PAGE}\nAnd retried on failure.\n` } }] },
      { content: 'updated' },
    ]);

    await chat.reply('demo', 'docs', 'Write it.');
    await chat.reply('demo', 'docs', 'Add the retry note.');

    const { index } = await bundle.docs();
    expect(index.match(/\(queue\.md\)/g)).toHaveLength(1);
    expect(await bundle.doc('queue')).toContain('And retried on failure.');
  });

  it('gives the PRD persona write_prd over the whole document', async () => {
    const prd = ['# Demo — PRD', '', ...PRD_SECTIONS.flatMap((s) => [`## ${s.title}`, '', `${s.title}: `.padEnd(240, 'detail. '), ''])].join('\n');
    const { chat, mock } = await setup([
      { toolCalls: [{ name: 'write_prd', arguments: { markdown: prd } }] },
      { content: 'Filled in every section.' },
    ]);

    await chat.reply('demo', 'prd', 'Draft the PRD.');

    expect((await bundle.manifest()).prdScore).toBe(100);
    expect(await bundle.prd()).toContain('## Data model');
    expect((await simpleGit(bundle.dir).log()).latest?.message).toBe('owner: update prd');
    expect(lastSystem(mock)).toContain('at most 3 sharp questions');
  });

  it('refuses a PRD write that dropped a section', async () => {
    const { chat, mock } = await setup([
      { toolCalls: [{ name: 'write_prd', arguments: { markdown: '# Demo\n\n## Overview & problem\n\nJust this one.\n' } }] },
      { content: 'I could not write that.' },
    ]);

    await chat.reply('demo', 'prd', 'Trim it down.');

    const toolResult = mock.lastRequest().messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolResult.content).toContain('must keep every section heading');
    expect((await bundle.manifest()).prdScore).toBe(0);
  });

  it('lets the roadmap persona rewrite the milestone list', async () => {
    const { chat } = await setup([
      {
        toolCalls: [{
          name: 'write_roadmap',
          arguments: { milestones: [{ title: 'Skeleton', summary: 'It boots.' }, { title: 'Auth', summary: 'Login works.', estimate: '2 days' }] },
        }],
      },
      { content: 'Two milestones, skeleton first.' },
    ]);

    await chat.reply('demo', 'roadmap', 'Sequence it.');

    expect(await bundle.roadmap()).toEqual([
      { id: 'm1', title: 'Skeleton', summary: 'It boots.', status: 'planned' },
      { id: 'm2', title: 'Auth', summary: 'Login works.', status: 'planned', estimate: '2 days' },
    ]);
  });
});

describe('docs routes', () => {
  beforeEach(async () => {
    const { url } = await serve([]);
    hub = createHub({ projectsRoot: root });
    await hub.app.inject({
      method: 'POST', url: '/api/nodes/register',
      payload: { name: 'spark', arch: 'arm64', endpoints: [{ tier: 'orchestrator', url, model: 'mock-model', maxStreams: 2 }] },
    });
  });

  it('lists the index, the pages and the decision log, and serves one page', async () => {
    const target = hub!;
    await bundle.writeDoc('queue', PAGE);
    await bundle.appendDecision({ title: 'Claim oldest first', rationale: 'fairness beats throughput here', by: 'manager' });

    const list = await target.app.inject({ method: 'GET', url: '/api/projects/demo/docs' });
    expect(list.statusCode).toBe(200);
    expect(list.json().index).toContain('[How the queue works](queue.md)');
    expect(list.json().pages).toEqual([expect.objectContaining({ slug: 'queue', title: 'How the queue works' })]);
    expect(list.json().decisions).toContain('Claim oldest first');

    const page = await target.app.inject({ method: 'GET', url: '/api/projects/demo/docs/queue' });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toEqual({ slug: 'queue', title: 'How the queue works', markdown: PAGE });
  });

  it('404s an unknown page and 400s a malformed one', async () => {
    const target = hub!;
    expect((await target.app.inject({ method: 'GET', url: '/api/projects/demo/docs/ghost' })).statusCode).toBe(404);
    expect((await target.app.inject({ method: 'GET', url: '/api/projects/demo/docs/Not Valid' })).statusCode).toBe(400);
  });
});
