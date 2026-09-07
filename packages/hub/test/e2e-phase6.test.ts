import { describe, it, expect, afterEach } from 'vitest';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { dataStamp } from '@agenthub/shared/data-stamp';
import { createComfyMock, type MockComfy } from '@agenthub/mocks/comfy';
import { createMockOpenAI, type MockOpenAI, type ScriptStep } from '@agenthub/mocks';
import { Daemon } from '../../node-daemon/src/daemon.js';
import { loadConfig } from '../../node-daemon/src/config.js';
import { createHub, type Hub } from '../src/server.js';
import { FakeTelegramPort } from '../src/telegram/port.js';
import type { Clock } from '../src/telegram/scheduler.js';

/**
 * Phase 6 acceptance test (PRD §14): with auth switched on, the whole phase runs end to end against
 * one real daemon and local fakes — no network beyond loopback, no real Telegram, no real ComfyUI.
 *
 * `/video` from Telegram becomes a job, the daemon claims it, the hub swaps the node to its `video`
 * profile for the duration (the LLM entry really stops and comes back), the rendered clip is
 * uploaded and delivered to the owner's chat as bytes; a scripted `web_search` through the
 * assistant leaves an audit row the owner can read; `/controlnode` moves the hub to the other
 * candidate after an explicit Confirm; and an unauthenticated `/api/state` is 401 throughout.
 */

const OWNER = 'owner-chat';
const PASSWORD = 'correct horse battery staple';
const DAEMON_TOKEN = 'daemon-tok';
const SEARCH_KEY = 'search-key';

/** A clock that never advances: the scheduler's briefing must not fire inside this test. */
class FrozenClock implements Clock {
  now(): number { return Date.UTC(2026, 0, 1, 9, 0, 0); }
  setTimeout(): { clear(): void } { return { clear: () => {} }; }
}

/**
 * The other control node's daemon, reduced to the endpoints the switch drives (same shape as
 * control-switch.test.ts). Its data root is a temp dir, so the stamp it reports is computed over
 * the bytes the injected sync actually copied.
 */
class FakeControlNode {
  readonly app: FastifyInstance = Fastify();
  readonly calls: string[] = [];
  readonly tokens: (string | undefined)[] = [];
  running = false;
  private port = 0;

  constructor(readonly dataRoot: string, readonly hubUrl: string) {
    const record = (req: { method: string; url: string; headers: Record<string, unknown> }) => {
      this.calls.push(`${req.method} ${req.url}`);
      this.tokens.push(req.headers.authorization as string | undefined);
    };
    this.app.get('/control/hub', async (req) => {
      record(req as never);
      return { running: this.running, dataRoot: this.dataRoot, hubUrl: this.hubUrl };
    });
    this.app.get('/control/hub/data-stamp', async (req) => {
      record(req as never);
      return { stamp: await dataStamp(this.dataRoot), dataRoot: this.dataRoot };
    });
    this.app.post('/control/hub/start', async (req) => {
      record(req as never);
      this.running = true;
      return { running: true, pid: 4242, hubUrl: this.hubUrl, dataRoot: this.dataRoot };
    });
  }

  async listen(): Promise<void> {
    await this.app.listen({ port: 0, host: '127.0.0.1' });
    this.port = (this.app.server.address() as { port: number }).port;
  }

  get url(): string { return `http://127.0.0.1:${this.port}`; }
}

const dirs: string[] = [];
const servers: FastifyInstance[] = [];
let hub: Hub | undefined;
let daemon: Daemon | undefined;
let comfy: MockComfy | undefined;
let model: MockOpenAI | undefined;

async function tmpDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `agenthub-p6-${name}-`));
  dirs.push(dir);
  return dir;
}

function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

const addressOf = (app: { server: { address(): unknown } }): string =>
  `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

/** Polls a condition on a real interval — never a fixed sleep — and fails loudly on a hang. */
async function waitFor(what: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** True while the dummy serving process for `port` is up — how a profile switch is observed. */
async function serving(port: number): Promise<boolean> {
  try { return (await fetch(`http://127.0.0.1:${port}/v1/models`)).ok; } catch { return false; }
}

afterEach(async () => {
  await daemon?.stop(); daemon = undefined;
  await hub?.stop(); hub = undefined;
  await comfy?.close(); comfy = undefined;
  await model?.close(); model = undefined;
  for (const s of servers) await s.close();
  servers.length = 0;
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe('phase 6 acceptance: video, external tools and the control-node switch, all behind auth', () => {
  it('runs /video to a delivered clip, audits an external call and moves the hub on /controlnode', async () => {
    // --- fakes: ComfyUI, the search provider and the orchestrator model -----------------------
    comfy = createComfyMock({ pollsUntilDone: 1 });
    await comfy.listen({ port: 0, host: '127.0.0.1' });

    const search = Fastify();
    const searchCalls: string[] = [];
    search.get('/search', async (req) => {
      searchCalls.push(req.url);
      return { web: { results: [{ title: 'MiniMax H3', url: 'https://example.invalid/h3', description: 'a video model' }] } };
    });
    await search.listen({ port: 0, host: '127.0.0.1' });
    servers.push(search);

    const script: ScriptStep[] = [
      { toolCalls: [{ name: 'web_search', arguments: { query: 'minimax h3 release notes', n: 1 } }] },
      { content: 'MiniMax H3 is a video model.' },
    ];
    model = createMockOpenAI({ script });
    await model.listen({ port: 0, host: '127.0.0.1' });

    // --- the hub, with auth on and the control-node capability enabled -------------------------
    const dataRoot = await tmpDir('data');
    const remoteRoot = join(await tmpDir('remote'), 'data');
    const spareRoot = join(await tmpDir('spare'), 'data');
    const memoryRoot = join(dataRoot, 'memory');
    const port = new FakeTelegramPort();

    const target = new FakeControlNode(remoteRoot, 'http://strix.tailnet.ts.net:4000');
    const spare = new FakeControlNode(spareRoot, 'http://shed.tailnet.ts.net:4000');
    await target.listen();
    await spare.listen();

    const synced: string[] = [];
    hub = createHub({
      dbPath: join(dataRoot, 'hub.db'),
      projectsRoot: join(dataRoot, 'projects'),
      staleMs: 60_000,
      auth: { password: PASSWORD, daemonToken: DAEMON_TOKEN, sessionSecret: 'phase6-secret' },
      external: { search: { provider: 'brave', key: SEARCH_KEY }, baseUrls: { search: `${addressOf(search)}/search` } },
      assistant: { memoryRoot, telegram: { port, ownerChatId: OWNER }, clock: new FrozenClock() },
      controlNode: {
        dataRoot, name: 'mini', stopDelayMs: 60_000,
        sync: async (from, node) => {
          synced.push(node.node);
          await rm(node.dataRoot, { recursive: true, force: true });
          await cp(from, node.dataRoot, { recursive: true });
        },
      },
    });
    // The project fleet's own ticker would only race this test's teardown; nothing here runs a turn.
    await hub.projects.stop();
    // Awaited before anything is delivered: the Telegram router only exists once this resolves, and
    // a message that arrives first is simply dropped.
    const handle = await hub.assistant();
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const hubUrl = addressOf(hub.app);

    // --- auth is on: no cookie, no state ------------------------------------------------------
    expect((await hub.app.inject({ method: 'GET', url: '/api/state' })).statusCode).toBe(401);
    const loggedIn = await hub.app.inject({ method: 'POST', url: '/api/login', payload: { password: PASSWORD } });
    expect(loggedIn.statusCode).toBe(200);
    const cookie = loggedIn.headers['set-cookie'] as string;
    const owner = { cookie };
    expect((await hub.app.inject({ method: 'GET', url: '/api/state', headers: owner })).statusCode).toBe(200);

    // The orchestrator model the assistant talks to, and the two control-node candidates. The
    // registration route takes the owner's session as well as a daemon bearer.
    const register = (payload: Record<string, unknown>) =>
      hub!.app.inject({ method: 'POST', url: '/api/nodes/register', headers: owner, payload });
    expect((await register({
      name: 'macbook', arch: 'arm64', jobTypes: [],
      endpoints: [{ tier: 'orchestrator', url: addressOf(model!), model: 'mock-model', maxStreams: 4 }],
    })).statusCode).toBe(200);
    for (const [name, node] of [['strix', target], ['shed', spare]] as const) {
      expect((await register({
        name, arch: 'x86_64', jobTypes: [], endpoints: [],
        controlNode: true, control: { url: node.url },
      })).statusCode).toBe(200);
    }

    // --- the real daemon: two dummy serving entries, profiles, a control server and ComfyUI ----
    const workerPort = await ephemeralPort();
    const visionPort = await ephemeralPort();
    const workspaceRoot = await tmpDir('workspace');
    const cfgPath = join(await tmpDir('cfg'), 'daemon.yaml');
    const stub = (p: number) => `require('http').createServer((q,r)=>{r.end('{}')}).listen(${p},'127.0.0.1')`;
    writeFileSync(cfgPath, [
      'node:', '  name: spark', '  arch: arm64',
      `hub: ${hubUrl}`,
      `hubToken: ${DAEMON_TOKEN}`,
      'heartbeatMs: 500',
      'claimIntervalMs: 150',
      'controlPort: 0',
      `workspaceRoot: ${workspaceRoot}`,
      'jobTypes: [video-gen]',
      'video:', `  comfyUrl: ${addressOf(comfy!)}`,
      'serving:',
      '  - name: worker-vllm',
      '    tier: worker', '    model: mock-model', `    port: ${workerPort}`, '    maxStreams: 4',
      `    cmd: ["node", "-e", "${stub(workerPort)}"]`,
      '  - name: vision-vllm',
      '    tier: vision', '    model: mock-vision', `    port: ${visionPort}`, '    maxStreams: 2',
      `    cmd: ["node", "-e", "${stub(visionPort)}"]`,
      'profiles:',
      '  llm: [worker-vllm, vision-vllm]',
      '  video: [vision-vllm]',
    ].join('\n'));

    daemon = new Daemon(loadConfig(cfgPath));
    await daemon.start();
    expect(hub.registry.byName('spark')?.status).toBe('online');
    expect(daemon.registration().profiles).toEqual(['llm', 'video']);
    expect(await serving(workerPort)).toBe(true);

    // --- /video from Telegram: job → swap → render → upload → clip in the owner's chat ---------
    await port.simulateMessage(OWNER, '/video a lighthouse in a storm');
    await handle.router!.idle();
    expect(port.sent).toHaveLength(1);
    const queued = port.sent[0]!.msg.text!;
    expect(queued).toMatch(/^Queued video job #\d+/);
    const jobId = Number(queued.match(/#(\d+)/)![1]);

    // The hub parks the node's LLM tier and drives it onto the `video` profile before handing the
    // job over: the worker entry really stops, the vision entry the profile keeps really doesn't.
    await waitFor('the worker entry to stop for the video profile', async () => !(await serving(workerPort)));
    expect(await serving(visionPort)).toBe(true);

    await waitFor('the video job to finish', () => hub!.queue.get(jobId)?.status === 'done');
    // ...and the LLM profile comes back once the slot is released.
    await waitFor('the worker entry to come back on the llm profile', () => serving(workerPort));

    await waitFor('the clip to reach the owner', () => port.sent.some((s) => s.msg.video !== undefined));
    const clip = port.sent.find((s) => s.msg.video !== undefined)!;
    expect(clip.chatId).toBe(OWNER);
    expect(clip.msg.text).toContain(`video job #${jobId}`);
    expect(clip.msg.video!.equals(comfy!.videoBytes)).toBe(true);

    const done = hub.queue.get(jobId)!;
    expect(done.status).toBe('done');
    expect((done.result?.data as { path?: string }).path).toMatch(/\.mp4$/);

    // --- an external tool call through the assistant leaves an audit row -----------------------
    await port.simulateMessage(OWNER, 'what shipped in the minimax h3 release?');
    await handle.router!.idle();
    expect(port.sent.at(-1)!.msg.text).toContain('MiniMax H3 is a video model.');
    expect(searchCalls[0]).toContain('minimax');

    const audit = await hub.app.inject({ method: 'GET', url: '/api/audit', headers: owner });
    expect(audit.statusCode).toBe(200);
    expect((audit.json() as { tool: string; ok: boolean }[])[0]).toMatchObject({ tool: 'web_search', ok: true });
    expect((await hub.app.inject({ method: 'GET', url: '/api/audit' })).statusCode).toBe(401);

    // --- /controlnode strix: listed, confirmed, then actually switched -------------------------
    await port.simulateMessage(OWNER, '/controlnode');
    await handle.router!.idle();
    const listing = port.sent.at(-1)!.msg.text!;
    expect(listing).toContain('strix');
    expect(listing).toContain('shed');

    await port.simulateMessage(OWNER, '/controlnode strix');
    await handle.router!.idle();
    const confirm = port.sent.at(-1)!.msg.buttons!.flat().find((b) => b.data === 'cn:go:strix');
    expect(confirm).toBeTruthy();
    // Nothing has moved on the button alone.
    expect(target.calls).toHaveLength(0);

    await port.simulateCallback(OWNER, confirm!.data);
    await handle.router!.idle();
    expect(port.sent.at(-1)!.msg.text).toBe(`Hub moved to strix: ${target.hubUrl}`);
    expect(synced).toEqual(['strix']);
    expect(target.calls).toContain('POST /control/hub/start');
    expect(target.tokens.every((t) => t === `Bearer ${DAEMON_TOKEN}`)).toBe(true);
    // The node that was not chosen was never touched.
    expect(spare.calls).toHaveLength(0);
    expect(spare.running).toBe(false);

    // --- and the door was shut the whole way through ------------------------------------------
    expect((await hub.app.inject({ method: 'GET', url: '/api/state' })).statusCode).toBe(401);
  }, 60_000);
});
