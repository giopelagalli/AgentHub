import { describe, it, expect, afterEach } from 'vitest';
import { connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import type { TurnRecord } from '@agenthub/shared';
import { PRD_SECTIONS } from '@agenthub/shared';
import { createMockOpenAI, type MockOpenAI, type ScriptStep } from '@agenthub/mocks';
import { LOGIN_MAX_FAILURES } from '../src/auth.js';
import { byline } from '../src/projects/bundle.js';
import type { MintedApiToken, TokenKind } from '../src/door.js';
import { createHub, type Hub } from '../src/server.js';

/**
 * The assistant scope (0065–0067): an `assistant`-kind user API token opens exactly the allow-listed
 * `/api/*` routes, an `agent` token opens none of them, and what a token asks for is attributed to it.
 */

const PASSWORD = 'let-me-in';
const DAEMON_TOKEN = 'daemon-token-abc';

let hub: Hub | undefined;
let mock: MockOpenAI | undefined;
let dir: string | undefined;

afterEach(async () => {
  await hub?.stop();
  await mock?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
  hub = undefined; mock = undefined; dir = undefined;
});

interface Harness { hub: Hub; cookie: string; jd: string; agent: string; root: string }

/** An authenticated hub with one node served by the strict mock, a `demo` project, and both kinds of token. */
async function harness(script: ScriptStep[] = []): Promise<Harness> {
  dir = await mkdtemp(join(tmpdir(), 'agenthub-assistant-'));
  mock = createMockOpenAI({ script });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`;
  const root = join(dir, 'projects');
  hub = createHub({ projectsRoot: root, auth: { password: PASSWORD, daemonToken: DAEMON_TOKEN, sessionSecret: 'test-secret' } });
  const registered = await hub.app.inject({
    method: 'POST', url: '/api/nodes/register', headers: { authorization: `Bearer ${DAEMON_TOKEN}` },
    payload: {
      name: 'spark', arch: 'arm64',
      endpoints: [
        { tier: 'orchestrator', url, model: 'mock-model', maxStreams: 2 },
        { tier: 'worker', url, model: 'mock-model', maxStreams: 2 },
      ],
    },
  });
  expect(registered.statusCode).toBe(200);
  const login = await hub.app.inject({ method: 'POST', url: '/api/login', payload: { password: PASSWORD } });
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  const mint = async (kind: TokenKind, label: string): Promise<string> => {
    const res = await hub!.app.inject({ method: 'POST', url: '/api/tokens', headers: { cookie }, payload: { kind, label } });
    expect(res.statusCode).toBe(201);
    return (res.json() as MintedApiToken).token;
  };
  const created = await hub.app.inject({
    method: 'POST', url: '/api/projects', headers: { cookie }, payload: { slug: 'demo', title: 'Demo', intent: 'ship the demo' },
  });
  expect(created.statusCode).toBe(201);
  return { hub, cookie, jd: await mint('assistant', 'JD'), agent: await mint('agent', 'some-agent'), root };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Every allow-listed route that answers without a model, with a request its handler accepts. */
const NO_MODEL_ROUTES: { method: 'GET' | 'POST'; url: string; payload?: Record<string, unknown> }[] = [
  { method: 'GET', url: '/api/state' },
  { method: 'GET', url: '/api/briefings' },
  { method: 'GET', url: '/api/projects' },
  { method: 'GET', url: '/api/projects/demo/turns' },
  { method: 'POST', url: '/api/projects/demo/pause', payload: {} },
  { method: 'POST', url: '/api/projects/demo/resume', payload: {} },
  { method: 'POST', url: '/api/projects/demo/priority', payload: { priority: 'interactive' } },
];

/** The model-backed ones, asked for something their handler refuses before any model runs. */
const MODEL_ROUTES: { method: 'POST'; url: string; payload: Record<string, unknown>; reached: number }[] = [
  // The PRD is still the scaffold, so the handler answers 400 — it was reached, which is the point.
  { method: 'POST', url: '/api/projects/demo/roadmap/generate', payload: {}, reached: 400 },
  { method: 'POST', url: '/api/projects/demo/prd/draft', payload: { idea: 42 }, reached: 400 },
  { method: 'POST', url: '/api/projects/demo/turn', payload: { instruction: 42 }, reached: 400 },
];

describe('the assistant scope', () => {
  it('lets an assistant token and the owner session through every allow-listed route', async () => {
    const h = await harness();
    for (const creds of [bearer(h.jd), { cookie: h.cookie }]) {
      for (const r of NO_MODEL_ROUTES) {
        const res = await h.hub.app.inject({ ...r, headers: creds });
        expect(res.statusCode, `${r.method} ${r.url}`).toBe(200);
      }
      for (const r of MODEL_ROUTES) {
        const res = await h.hub.app.inject({ ...r, headers: creds });
        expect(res.statusCode, `${r.method} ${r.url}`).toBe(r.reached);
      }
    }
    const slug = (n: number) => `made-${n}`;
    expect((await h.hub.app.inject({
      method: 'POST', url: '/api/projects', headers: bearer(h.jd), payload: { slug: slug(1), title: 'One', intent: 'x' },
    })).statusCode).toBe(201);
    expect((await h.hub.app.inject({
      method: 'POST', url: '/api/projects', headers: { cookie: h.cookie }, payload: { slug: slug(2), title: 'Two', intent: 'x' },
    })).statusCode).toBe(201);
  });

  it('refuses an agent token on every allow-listed route with 403', async () => {
    const h = await harness();
    const all = [...NO_MODEL_ROUTES, ...MODEL_ROUTES, { method: 'POST' as const, url: '/api/projects', payload: { slug: 'nope', title: 'N', intent: 'x' } }];
    for (const r of all) {
      const res = await h.hub.app.inject({ ...r, headers: bearer(h.agent) });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
    }
    expect((await h.hub.app.inject({ method: 'GET', url: '/api/projects/nope' })).statusCode).toBe(401);
  });

  it('keeps every other route the owner’s', async () => {
    const h = await harness();
    const refused = [
      { method: 'GET' as const, url: '/api/tokens' },
      { method: 'POST' as const, url: '/api/tokens', payload: { kind: 'assistant', label: 'more' } },
      { method: 'POST' as const, url: '/api/nodes/enrollment-tokens', payload: {} },
      { method: 'PUT' as const, url: '/api/projects/demo/code/file', payload: { path: 'a.txt', content: 'x' } },
      { method: 'GET' as const, url: '/api/projects/demo' },
      { method: 'POST' as const, url: '/api/projects/demo/archive', payload: {} },
      { method: 'POST' as const, url: '/api/projects/demo/harness', payload: { harness: 'builtin' } },
      // JD's own web door (0069) is the owner's: an assistant token must not talk to JD as the owner.
      { method: 'GET' as const, url: '/api/jd/status' },
      { method: 'POST' as const, url: '/api/jd/messages', payload: { text: 'hi' } },
    ];
    for (const r of refused) {
      const res = await h.hub.app.inject({ ...r, headers: bearer(h.jd) });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
    }

    // The terminal upgrade, over a real socket: refused before the handshake completes.
    await h.hub.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (h.hub.app.server.address() as { port: number }).port;
    const status = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write([
          'GET /api/projects/demo/terminal HTTP/1.1', 'Host: 127.0.0.1', 'Connection: Upgrade', 'Upgrade: websocket',
          'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', `Authorization: Bearer ${h.jd}`, '', '',
        ].join('\r\n'));
      });
      let buf = '';
      socket.on('data', (chunk) => {
        buf += String(chunk);
        const end = buf.indexOf('\r\n');
        if (end < 0) return;
        socket.destroy();
        resolve(buf.slice(0, end));
      });
      socket.on('error', reject);
      socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('handshake timed out')); });
    });
    expect(status).toContain('401');
  });

  it("keeps the project's harness the owner's, from the hub's own origin only", async () => {
    const h = await harness();
    const set = (headers: Record<string, string>) => h.hub.app.inject({
      method: 'POST', url: '/api/projects/demo/harness', headers: { host: 'hub.local:4000', ...headers }, payload: { harness: 'builtin' },
    });
    expect((await set({ cookie: h.cookie, origin: 'http://hub.local:4000' })).statusCode).toBe(200);
    expect((await set({ cookie: h.cookie, origin: 'http://hub.local:4010' })).statusCode).toBe(403);
    expect((await set({})).statusCode).toBe(401);
    // Not on the assistant's allow-list: its token is no credential here, the same 401 as none.
    expect((await set(bearer(h.jd))).statusCode).toBe(401);
    expect((await set(bearer(h.agent))).statusCode).toBe(401);
  });

  it('answers a bad bearer 401 and locks the address out on the door’s counter', async () => {
    const h = await harness();
    // No bearer at all is a lapsed session, not a guess: refused, never counted.
    for (let i = 0; i < LOGIN_MAX_FAILURES + 2; i++) {
      expect((await h.hub.app.inject({ method: 'GET', url: '/api/state' })).statusCode).toBe(401);
    }
    expect((await h.hub.app.inject({ method: 'GET', url: '/api/state', headers: bearer(h.jd) })).statusCode).toBe(200);

    // One guess at the door, the rest here: it is one counter.
    const door = await h.hub.app.inject({ method: 'GET', url: '/v1/models', headers: bearer('ah_wrong') });
    expect(door.statusCode).toBe(401);
    for (let i = 1; i < LOGIN_MAX_FAILURES; i++) {
      const res = await h.hub.app.inject({ method: 'GET', url: '/api/state', headers: bearer('ah_wrong') });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'invalid api token' });
    }
    expect((await h.hub.app.inject({ method: 'GET', url: '/api/state', headers: bearer('ah_wrong') })).statusCode).toBe(429);
    expect((await h.hub.app.inject({ method: 'GET', url: '/v1/models', headers: bearer('ah_wrong') })).statusCode).toBe(429);
    // A token that verifies is not a guess: it still gets in from the locked-out address.
    expect((await h.hub.app.inject({ method: 'GET', url: '/api/state', headers: bearer(h.jd) })).statusCode).toBe(200);
  });

  it('answers another auth scheme a plain 401 and never counts it', async () => {
    const h = await harness();
    // The edge's basic auth rides every same-origin request; it is not a token guess.
    const basic = { authorization: `Basic ${Buffer.from('owner:pw').toString('base64')}` };
    for (let i = 0; i < LOGIN_MAX_FAILURES + 2; i++) {
      const res = await h.hub.app.inject({ method: 'GET', url: '/api/state', headers: basic });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthorized' });
    }
    // Not locked out: the first bad bearer after all that is a 401, not a 429.
    expect((await h.hub.app.inject({ method: 'GET', url: '/api/state', headers: bearer('ah_wrong') })).statusCode).toBe(401);
  });

  it('keeps importing a repository the owner’s', async () => {
    const h = await harness();
    const res = await h.hub.app.inject({
      method: 'POST', url: '/api/projects', headers: bearer(h.jd),
      payload: { slug: 'imported', title: 'Imported', intent: 'x', source: { url: 'octo/repo' } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'importing a repository is the owner\'s' });
    expect((await h.hub.app.inject({ method: 'GET', url: '/api/projects', headers: bearer(h.jd) })).json()
      .map((p: { slug: string }) => p.slug)).toEqual(['demo']);
  });

  it('keeps a byline on one line', () => {
    expect(byline('JD\n  the\tassistant ')).toBe(' (by JD the assistant)');
    expect(byline('   ')).toBe('');
    expect(byline(undefined)).toBe('');
  });

  it('marks a turn a token started with requestedBy, and filters turns by when they ended', async () => {
    const h = await harness([
      { content: 'owner turn, nothing to report' },
      // JD's turn publishes its own briefing, whose commit is signed too.
      {
        toolCalls: [{
          name: 'publish_briefing',
          arguments: {
            title: 'Demo', status: 'active', priority: 'project', summary: 'jd turn, wired the frobnicator',
            progress: { done: 1, total: 3 }, blockers: [], nextSteps: ['ship it'],
          },
        }],
      },
      { content: 'done' },
    ]);
    const owner = await h.hub.app.inject({ method: 'POST', url: '/api/projects/demo/turn', headers: { cookie: h.cookie }, payload: {} });
    expect(owner.statusCode).toBe(200);
    const between = Date.now();
    const jd = await h.hub.app.inject({ method: 'POST', url: '/api/projects/demo/turn', headers: bearer(h.jd), payload: {} });
    expect(jd.statusCode).toBe(200);

    const all = (await h.hub.app.inject({ method: 'GET', url: '/api/projects/demo/turns', headers: bearer(h.jd) })).json() as { turns: TurnRecord[] };
    expect(all.turns).toHaveLength(2);
    const [mine, theirs] = all.turns;
    expect(mine!.requestedBy).toBe('JD');
    expect(mine!.events[0]).toMatchObject({ kind: 'turn-start', requestedBy: 'JD' });
    expect(mine!.summary).toContain('jd turn');
    expect(theirs!.requestedBy).toBeUndefined();

    const since = (await h.hub.app.inject({ method: 'GET', url: `/api/projects/demo/turns?since=${between}`, headers: bearer(h.jd) })).json() as { turns: TurnRecord[] };
    expect(since.turns.map((t) => t.sessionId)).toEqual([mine!.sessionId]);
    expect((await h.hub.app.inject({ method: 'GET', url: '/api/projects/demo/turns?since=soon', headers: bearer(h.jd) })).statusCode).toBe(400);

    const log = await simpleGit(join(h.root, 'demo')).log();
    const subjects = log.all.map((c) => c.message);
    expect(subjects.filter((m) => m.startsWith('agent: turn') || m.startsWith('agent: publish briefing'))).toEqual([
      'agent: publish briefing (by JD)',
      expect.stringMatching(/^agent: turn \d+ — owner turn/),
    ]);
    expect(subjects.find((m) => m.startsWith('agent: turn'))).not.toContain('(by ');
  });

  it('attributes a token’s writes in the project’s commits', async () => {
    const h = await harness();
    await h.hub.app.inject({ method: 'POST', url: '/api/projects', headers: bearer(h.jd), payload: { slug: 'jds', title: 'JD’s', intent: 'x' } });
    await h.hub.app.inject({ method: 'POST', url: '/api/projects/jds/priority', headers: bearer(h.jd), payload: { priority: 'interactive' } });
    await h.hub.app.inject({ method: 'POST', url: '/api/projects/jds/pause', headers: bearer(h.jd), payload: {} });
    await h.hub.app.inject({ method: 'POST', url: '/api/projects/jds/resume', headers: { cookie: h.cookie }, payload: {} });
    const subjects = (await simpleGit(join(h.root, 'jds')).log()).all.map((c) => c.message);
    expect(subjects).toEqual([
      'agent: resume project',
      'agent: pause project (by JD)',
      'agent: set priority interactive (by JD)',
      'chore: scaffold project bundle (by JD)',
    ]);
  });

  it('drafts a PRD and its roadmap without a stream when asked to wait', async () => {
    const prd = [
      '# Demo — PRD', '',
      ...PRD_SECTIONS.flatMap((s) => [`## ${s.title}`, '', `${s.title}: `.padEnd(240, 'concrete detail, named technology, a real limit. '), '']),
    ].join('\n');
    const roadmap = JSON.stringify([{ title: 'First slice', summary: 'something that runs' }]);
    const h = await harness([{ content: prd }, { content: roadmap }]);
    await h.hub.app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(h.hub.app.server.address() as { port: number }).port}`;
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...bearer(h.jd) }, body: JSON.stringify(body),
    });

    const drafted = await post('/api/projects/demo/prd/draft?wait=1', { idea: 'a todo app' });
    expect(drafted.status).toBe(200);
    expect(drafted.headers.get('content-type')).toContain('application/json');
    const draft = await drafted.json() as { done: boolean; full: string; audit: { score: number } };
    expect(draft.done).toBe(true);
    expect(draft.full).toContain('## Functional requirements');
    expect(draft.audit.score).toBe(100);
    expect((await h.hub.app.inject({ method: 'GET', url: '/api/projects/demo/prd', headers: { cookie: h.cookie } })).json().drafted).toBe(true);

    const generated = await post('/api/projects/demo/roadmap/generate?wait=1', {});
    expect(generated.status).toBe(200);
    const plan = await generated.json() as { milestones: { title: string }[] };
    expect(plan.milestones.map((m) => m.title)).toEqual(['First slice']);

    const subjects = (await simpleGit(join(h.root, 'demo')).log()).all.map((c) => c.message);
    expect(subjects.slice(0, 2)).toEqual(['agent: generate roadmap (by JD)', 'agent: draft prd (by JD)']);
  });
});
