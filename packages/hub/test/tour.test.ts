import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { createMockOpenAI, type MockOpenAI } from '@agenthub/mocks';
import { routeAccess } from '../src/auth.js';
import { ProjectBundle } from '../src/projects/bundle.js';
import { TOUR_DIR, tourPageName } from '../src/projects/tour.js';
import { createHub, type Hub } from '../src/server.js';

const MAP = [
  '# Code map',
  '',
  '## Entry points',
  '',
  '- `src/main.ts:3` — where the process starts.',
  '- `src/util.ts:1` — the helper it leans on.',
  '',
].join('\n');

const MAIN = "import { help } from './util.js';\n\nexport function go(): number {\n  return help();\n}\n";

let root: string;
let bundle: ProjectBundle;
let mock: MockOpenAI;
let hub: Hub;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agenthub-tour-'));
  bundle = await ProjectBundle.create(root, { slug: 'demo', title: 'Demo', intent: 'ship the demo' });
  await mkdir(join(bundle.workspace, 'src'), { recursive: true });
  await writeFile(join(bundle.workspace, 'src', 'main.ts'), MAIN, 'utf8');
  await writeFile(join(bundle.workspace, 'src', 'util.ts'), 'export const help = (): number => 1;\n', 'utf8');
  await bundle.writeDoc('code-map', MAP);
  await bundle.commit('seed');

  // Every reply is an explanation: no tool calls, so one model request is one explanation.
  mock = createMockOpenAI({ respond: () => ({ content: '## What it does\n\n`src/main.ts:3` starts it.\n\n## Why\n\nno recorded reason' }) });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`;
  hub = createHub({ projectsRoot: root });
  await hub.app.inject({
    method: 'POST', url: '/api/nodes/register',
    payload: {
      name: 'spark', arch: 'arm64',
      endpoints: [
        { tier: 'orchestrator', url, model: 'mock-model', maxStreams: 2 },
        { tier: 'worker', url, model: 'mock-model', maxStreams: 2 },
      ],
    },
  });
});

afterEach(async () => {
  await hub.stop();
  await mock.close();
  await rm(root, { recursive: true, force: true });
});

const step = (index: number) => hub.app.inject({ method: 'GET', url: `/api/projects/demo/tour/${index}` });

describe('the tour route', () => {
  it('explains a step once, caches it as a committed docs page, and serves it from there after', async () => {
    const first = await step(0);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      index: 0, total: 2, cached: false,
      step: { path: 'src/main.ts', line: 3, title: 'where the process starts.' },
      snippet: { from: 3, to: 5 },
    });
    expect(first.json().explanation).toContain('no recorded reason');
    expect(mock.requests).toHaveLength(1);
    // The guide's own system prompt, on the worker tier, with the snippet numbered in the question.
    expect(mock.lastRequest().messages[0].content).toContain('You are read-only');
    expect(mock.lastRequest().messages[1].content).toContain('3 | export function go(): number {');

    const page = await readFile(join(bundle.dir, TOUR_DIR, tourPageName(0, 'where the process starts.')), 'utf8');
    expect(page).toMatch(/^# Step 1 — where the process starts\.\n\n`src\/main\.ts:3` · lines 3–5 · snippet [0-9a-f]{12}\n/);
    expect((await simpleGit(bundle.dir).log()).latest?.message).toBe('owner: tour step 1 explained');

    const second = await step(0);
    expect(second.json()).toMatchObject({ cached: true, explanation: first.json().explanation });
    expect(mock.requests).toHaveLength(1);
  });

  it('explains a step again once its snippet has changed', async () => {
    await step(0);
    await writeFile(join(bundle.workspace, 'src', 'main.ts'), MAIN.replace('help()', 'help() + 1'), 'utf8');
    const again = await step(0);
    expect(again.json().cached).toBe(false);
    expect(mock.requests).toHaveLength(2);
    // Still one page for the step, rewritten in place.
    expect((await readdir(join(bundle.dir, TOUR_DIR))).filter((n) => n.startsWith('01-'))).toHaveLength(1);
  });

  it('404s past the last step and when there is no map', async () => {
    expect((await step(2)).statusCode).toBe(404);
    await rm(join(bundle.dir, 'docs', 'code-map.md'));
    expect((await step(0)).statusCode).toBe(404);
    expect(mock.requests).toHaveLength(0);
  });

  it('404s a step whose line is no longer in the file, and 400s a step that is not a number', async () => {
    await writeFile(join(bundle.workspace, 'src', 'main.ts'), 'export {};\n', 'utf8');
    const stale = await step(0);
    expect(stale.statusCode).toBe(404);
    expect(stale.json().error).toMatch(/out of date/);
    expect((await hub.app.inject({ method: 'GET', url: '/api/projects/demo/tour/one' })).statusCode).toBe(400);
  });

  it('is the owner\'s alone', () => {
    expect(routeAccess('GET', '/api/projects/:slug/tour/:index')).toBe('owner');
  });
});
