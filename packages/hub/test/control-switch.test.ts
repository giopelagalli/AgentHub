import { describe, it, expect, afterEach, vi } from 'vitest';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { dataStamp } from '@agenthub/shared/data-stamp';
import type { NodeInfo } from '@agenthub/shared';
import type { AuthOptions } from '../src/auth.js';
import { openDb, type Db } from '../src/db.js';
import { createHub, type Hub } from '../src/server.js';
import { ControlSwitch } from '../src/control-switch.js';
import { CommandRouter, type ControlNodeDeps } from '../src/telegram/router.js';
import { FakeTelegramPort } from '../src/telegram/port.js';
import type { Assistant } from '../src/assistant/assistant.js';
import type { ConfirmationGate } from '../src/assistant/confirm.js';
import type { Planner } from '../src/assistant/planner.js';
import type { MasterOrchestrator } from '../src/projects/master.js';
import type { ProjectService } from '../src/projects/service.js';
import type { NodeRegistry } from '../src/node-registry.js';

const OWNER = 'owner-chat';

/**
 * The other control node's daemon, reduced to the four endpoints the switch actually drives. Its
 * data root is a temp dir, so the injected sync is a plain directory copy and the data stamp it
 * reports is computed over the real bytes that landed.
 */
class FakeControlNode {
  readonly app: FastifyInstance = Fastify();
  readonly calls: string[] = [];
  running = false;
  /** Set to make the node report a stamp the hub's own data root can never match. */
  stampOverride?: string;
  /** What the node says about the environment it would hand a hub; undefined = an older daemon. */
  authConfigured?: boolean;
  private port = 0;

  constructor(readonly dataRoot: string, readonly hubUrl = 'http://fake-node:4000') {
    this.app.get('/control/hub', async () => {
      this.calls.push('GET /control/hub');
      return {
        running: this.running, dataRoot: this.dataRoot, hubUrl: this.hubUrl,
        ...(this.authConfigured === undefined ? {} : { authConfigured: this.authConfigured }),
      };
    });
    this.app.get('/control/hub/data-stamp', async () => {
      this.calls.push('GET /control/hub/data-stamp');
      return { stamp: this.stampOverride ?? await dataStamp(this.dataRoot), dataRoot: this.dataRoot };
    });
    this.app.post('/control/hub/start', async () => {
      this.calls.push('POST /control/hub/start');
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
let hub: Hub | undefined;
let node: FakeControlNode | undefined;

async function tmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

interface Harness { hub: Hub; node: FakeControlNode; dataRoot: string; synced: { from: string; to: string }[] }

async function setup(opts: { sync?: (from: string, to: string) => Promise<void>; stopDelayMs?: number; auth?: AuthOptions } = {}): Promise<Harness> {
  const dataRoot = await tmpDir('agenthub-cn-local-');
  const remoteRoot = join(await tmpDir('agenthub-cn-remote-'), 'data');
  node = new FakeControlNode(remoteRoot);
  await node.listen();

  const synced: { from: string; to: string }[] = [];
  hub = createHub({
    dbPath: join(dataRoot, 'hub.db'),
    projectsRoot: join(dataRoot, 'projects'),
    ...(opts.auth ? { auth: opts.auth } : {}),
    controlNode: {
      dataRoot, name: 'mini',
      stopDelayMs: opts.stopDelayMs ?? 60_000,
      sync: async (from, target) => {
        synced.push({ from, to: target.dataRoot });
        if (opts.sync) return opts.sync(from, target.dataRoot);
        await rm(target.dataRoot, { recursive: true, force: true });
        await cp(from, target.dataRoot, { recursive: true });
      },
    },
  });
  // Nothing in these tests runs a project turn; the ticker would only race the teardown.
  await hub.projects.stop();
  // Listening for real, so a test can watch this hub actually go away after a switch.
  await hub.app.listen({ port: 0, host: '127.0.0.1' });
  hub.registry.register({
    name: 'strix', arch: 'x86_64', endpoints: [], jobTypes: [],
    controlNode: true, control: { url: node.url },
  });
  return { hub, node, dataRoot, synced };
}

afterEach(async () => {
  await hub?.stop(); hub = undefined;
  await node?.app.close(); node = undefined;
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe('control-node switch', () => {
  it('checkpoints, syncs, verifies the stamp, starts the hub there and stops itself', async () => {
    const h = await setup({ stopDelayMs: 50 });
    await writeFile(join(h.dataRoot, 'memory.md'), 'owner memory');

    const res = await h.hub.app.inject({ method: 'POST', url: '/api/controlnode', payload: { node: 'strix' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ switchedTo: 'strix', hubUrl: 'http://fake-node:4000' });

    // status → stamp → start, and the data root really was copied across
    expect(h.node.calls).toEqual(['GET /control/hub', 'GET /control/hub/data-stamp', 'POST /control/hub/start']);
    expect(h.synced).toEqual([{ from: h.dataRoot, to: h.node.dataRoot }]);
    expect(await dataStamp(h.node.dataRoot)).toBe(await dataStamp(h.dataRoot));

    // and this hub hands over: it stops itself once the new one is up
    const deadline = Date.now() + 5000;
    while (h.hub.app.server.listening && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(h.hub.app.server.listening).toBe(false);
  });

  it('turns state-mutating routes into 503 while the switch runs, and leaves reads alone', async () => {
    let release = () => {};
    const held = new Promise<void>((r) => { release = r; });
    const h = await setup({ sync: async (from, to) => { await held; await rm(to, { recursive: true, force: true }); await cp(from, to, { recursive: true }); } });

    const switching = h.hub.app.inject({ method: 'POST', url: '/api/controlnode', payload: { node: 'strix' } });
    // the sync is in flight by the time the hub answers a read
    await new Promise((r) => setTimeout(r, 50));
    const write = await h.hub.app.inject({
      method: 'POST', url: '/api/jobs',
      payload: { type: 'shell-task', tier: 'worker', priority: 'batch', payload: { cmd: ['true'] } },
    });
    expect(write.statusCode).toBe(503);
    expect((await h.hub.app.inject({ method: 'GET', url: '/api/state' })).statusCode).toBe(200);

    release();
    expect((await switching).statusCode).toBe(200);
  });

  it('refuses with 412 when the stamp on the target does not match, and starts nothing', async () => {
    const h = await setup();
    h.node.stampOverride = 'deadbeef';

    const res = await h.hub.app.inject({ method: 'POST', url: '/api/controlnode', payload: { node: 'strix' } });
    expect(res.statusCode).toBe(412);
    expect(res.json().error).toMatch(/stale/);
    expect(h.node.calls).not.toContain('POST /control/hub/start');
    expect(h.node.running).toBe(false);

    // the failed switch released the hub: it is still serving and still writable
    expect(h.hub.app.server.listening).toBe(true);
    expect((await h.hub.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    const write = await h.hub.app.inject({
      method: 'POST', url: '/api/jobs',
      payload: { type: 'shell-task', tier: 'worker', priority: 'batch', payload: { cmd: ['true'] } },
    });
    expect(write.statusCode).toBe(201);
  });

  it('hands over a consistent snapshot even while something keeps writing during the sync', async () => {
    let stopWriting = false;
    const h = await setup({
      sync: async (from, to) => {
        // A writer the 503 hook can't reach: it holds the database directly, the way the project
        // ticker or a scheduled turn does, and it runs for the whole copy.
        const writing = (async () => {
          while (!stopWriting) {
            hub!.queue.enqueue({ type: 'shell-task', tier: 'worker', priority: 'batch', payload: { cmd: ['true'] } });
            await new Promise((r) => setTimeout(r, 1));
          }
        })();
        await rm(to, { recursive: true, force: true });
        await cp(from, to, { recursive: true });
        stopWriting = true;
        await writing;
      },
    });
    const before = h.hub.queue.enqueue({ type: 'shell-task', tier: 'worker', priority: 'batch', payload: { cmd: ['before'] } });

    const res = await h.hub.app.inject({ method: 'POST', url: '/api/controlnode', payload: { node: 'strix' } });
    expect(res.statusCode).toBe(200);

    // The database the target adopts is the snapshot, not the live file the copy read underneath a
    // writer: it opens clean and holds exactly the state as of the checkpoint.
    const snapshot = openDb(join(h.node.dataRoot, 'checkpoint.db'));
    try {
      expect(snapshot.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      const ids = (snapshot.prepare('SELECT id FROM jobs ORDER BY id').all() as { id: number }[]).map((r) => r.id);
      expect(ids).toEqual([before.id]);
    } finally {
      snapshot.close();
    }
    // ...while the live file did keep taking writes right through the switch.
    expect(h.hub.queue.list().length).toBeGreaterThan(1);
  });

  it('refuses with 412 when a single byte of the snapshot did not survive the copy', async () => {
    const h = await setup({
      sync: async (from, to) => {
        await rm(to, { recursive: true, force: true });
        await cp(from, to, { recursive: true });
        // The size stays identical, so only a content check can see this.
        const path = join(to, 'checkpoint.db');
        const bytes = await readFile(path);
        bytes[bytes.length - 1] ^= 0xff;
        await writeFile(path, bytes);
      },
    });

    const res = await h.hub.app.inject({ method: 'POST', url: '/api/controlnode', payload: { node: 'strix' } });
    expect(res.statusCode).toBe(412);
    expect(res.json().error).toMatch(/stale/);
    expect(h.node.calls).not.toContain('POST /control/hub/start');
  });

  it('refuses a target that would bring an authenticated hub back up with no password', async () => {
    const h = await setup({ auth: { password: 'hunter2', daemonToken: 'daemon-tok', sessionSecret: 'secret' } });
    h.node.authConfigured = false;
    const login = await h.hub.app.inject({ method: 'POST', url: '/api/login', payload: { password: 'hunter2' } });
    const headers = { cookie: login.headers['set-cookie'] as string };

    const res = await h.hub.app.inject({ method: 'POST', url: '/api/controlnode', payload: { node: 'strix' }, headers });
    expect(res.statusCode).toBe(412);
    expect(res.json().error).toMatch(/HUB_PASSWORD/);
    expect(h.synced).toEqual([]);
    expect(h.node.calls).toEqual(['GET /control/hub']);

    // ...and the same hub hands over happily once the target reports a configured environment.
    h.node.authConfigured = true;
    expect((await h.hub.app.inject({ method: 'POST', url: '/api/controlnode', payload: { node: 'strix' }, headers })).statusCode).toBe(200);
  });

  it('refuses with 409 while a video job is running', async () => {
    const h = await setup();
    const job = h.hub.queue.enqueue({ type: 'video-gen', tier: 'video-gen', priority: 'batch', payload: { prompt: 'x' } });
    h.hub.queue.claim(['video-gen'], h.hub.registry.byName('strix')!.id);

    const res = await h.hub.app.inject({ method: 'POST', url: '/api/controlnode', payload: { node: 'strix' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/video job/);
    expect(h.hub.queue.get(job.id)!.status).toBe('running');
    expect(h.node.calls).toEqual([]);
  });

  it('refuses a node that is not a control-node candidate, and itself', async () => {
    const h = await setup();
    h.hub.registry.register({ name: 'plain', arch: 'arm64', endpoints: [], jobTypes: [] });

    for (const [name, pattern] of [['plain', /not a control-node candidate/], ['nope', /not a control-node candidate/], ['mini', /already runs this hub/]] as const) {
      const res = await h.hub.app.inject({ method: 'POST', url: '/api/controlnode', payload: { node: name } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(pattern);
    }
    expect(h.node.calls).toEqual([]);

    // a candidate whose heartbeat has gone stale is refused too
    h.hub.registry.register({ name: 'strix', arch: 'x86_64', endpoints: [], jobTypes: [], controlNode: true, control: { url: h.node.url } },
      Date.now() - 60_000);
    h.hub.registry.sweep();
    const offline = await h.hub.app.inject({ method: 'POST', url: '/api/controlnode', payload: { node: 'strix' } });
    expect(offline.statusCode).toBe(400);
    expect(offline.json().error).toMatch(/offline/);
  });

  it('lists the candidates and the current node', async () => {
    const h = await setup();
    const res = await h.hub.app.inject({ method: 'GET', url: '/api/controlnode' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      current: 'mini',
      candidates: [{ name: 'strix', status: 'online', current: false }],
    });
  });

  it('answers 501 on a hub that was not told where its data root is', async () => {
    const local = createHub({ projectsRoot: join(await tmpDir('agenthub-cn-plain-'), 'projects') });
    await local.projects.stop();
    try {
      expect((await local.app.inject({ method: 'GET', url: '/api/controlnode' })).statusCode).toBe(501);
      const res = await local.app.inject({ method: 'POST', url: '/api/controlnode', payload: { node: 'strix' } });
      expect(res.statusCode).toBe(501);
    } finally {
      await local.stop();
    }
  });
});

describe('/controlnode over Telegram', () => {
  /**
   * Only the control-node deps matter here, so the rest of the router's collaborators are stubs:
   * `/controlnode` never reaches them.
   */
  function router(port: FakeTelegramPort, controlNodes: ControlNodeDeps): CommandRouter {
    const r = new CommandRouter({
      port, ownerChatId: OWNER,
      assistant: {} as unknown as Assistant,
      service: {} as unknown as ProjectService,
      master: {} as unknown as MasterOrchestrator,
      planner: {} as unknown as Planner,
      gate: {} as unknown as ConfirmationGate,
      registry: {} as unknown as NodeRegistry,
      controlNodes,
    });
    r.start();
    return r;
  }

  it('lists, asks for confirmation and switches on the button', async () => {
    const port = new FakeTelegramPort();
    const switched: string[] = [];
    const r = router(port, {
      list: () => ({ current: 'mini', candidates: [
        { name: 'mini', status: 'online', current: true },
        { name: 'strix', status: 'online', current: false },
      ] }),
      switchTo: async (node) => { switched.push(node); return { switchedTo: node, hubUrl: 'http://strix:4000' }; },
    });

    await port.simulateMessage(OWNER, '/controlnode');
    await r.idle();
    expect(port.sent[0]!.msg.text).toContain('Control node: mini');
    expect(port.sent[0]!.msg.text).toContain('* mini (online)');
    expect(port.sent[0]!.msg.text).toContain('- strix (online)');

    // naming a node only asks — a switch is disruptive enough to need the button
    await port.simulateMessage(OWNER, '/controlnode strix');
    await r.idle();
    expect(port.sent[1]!.msg.text).toMatch(/Move the hub to strix\?/);
    // The confirm button carries a one-shot nonce, so the buttons are matched by shape.
    const confirm = port.sent[1]!.msg.buttons!.flat()[0]!;
    const cancel = port.sent[1]!.msg.buttons!.flat()[1]!;
    expect(confirm.text).toBe('Confirm');
    expect(confirm.data).toMatch(/^cn:go:strix:(\w+)$/);
    expect(cancel).toEqual({ text: 'Cancel', data: `cn:cancel:${/^cn:go:strix:(\w+)$/.exec(confirm.data)![1]}` });
    expect(switched).toEqual([]);

    // Cancel spends the same nonce the Confirm button carries, so a stale Confirm tap after it
    // finds nothing left to spend.
    await port.simulateCallback(OWNER, cancel.data);
    await r.idle();
    expect(port.sent[2]!.msg.text).toBe('Cancelled.');
    expect(switched).toEqual([]);

    await port.simulateCallback(OWNER, confirm.data);
    await r.idle();
    expect(switched).toEqual([]);
    expect(port.sent[3]!.msg.text).toBe('That confirmation has expired — run /controlnode strix again.');

    // A fresh confirmation still switches normally.
    await port.simulateMessage(OWNER, '/controlnode strix');
    await r.idle();
    const secondConfirm = port.sent[4]!.msg.buttons!.flat()[0]!;
    await port.simulateCallback(OWNER, secondConfirm.data);
    await r.idle();
    expect(switched).toEqual(['strix']);
    expect(port.sent[5]!.msg.text).toBe('Hub moved to strix: http://strix:4000');

    // The nonce is spent: tapping the same button again moves nothing.
    await port.simulateCallback(OWNER, secondConfirm.data);
    await r.idle();
    expect(switched).toEqual(['strix']);
    expect(port.sent[6]!.msg.text).toBe('That confirmation has expired — run /controlnode strix again.');
  });

  it('expires a confirmation button after ten minutes', async () => {
    const port = new FakeTelegramPort();
    const switched: string[] = [];
    let now = Date.UTC(2026, 0, 1, 9, 0, 0);
    const r = new CommandRouter({
      port, ownerChatId: OWNER,
      assistant: {} as unknown as Assistant,
      service: {} as unknown as ProjectService,
      master: {} as unknown as MasterOrchestrator,
      planner: {} as unknown as Planner,
      gate: {} as unknown as ConfirmationGate,
      registry: {} as unknown as NodeRegistry,
      now: () => now,
      controlNodes: {
        list: () => ({ current: 'mini', candidates: [{ name: 'strix', status: 'online', current: false }] }),
        switchTo: async (node) => { switched.push(node); return { switchedTo: node, hubUrl: 'http://strix:4000' }; },
      },
    });
    r.start();

    await port.simulateMessage(OWNER, '/controlnode strix');
    await r.idle();
    const stale = port.sent[0]!.msg.buttons!.flat()[0]!.data;

    now += 11 * 60_000;
    await port.simulateCallback(OWNER, stale);
    await r.idle();
    expect(switched).toEqual([]);
    expect(port.sent[1]!.msg.text).toBe('That confirmation has expired — run /controlnode strix again.');
  });

  it('refuses a node that is not a candidate, and reports a failed switch', async () => {
    const port = new FakeTelegramPort();
    const r = router(port, {
      list: () => ({ current: 'mini', candidates: [{ name: 'strix', status: 'online', current: false }] }),
      switchTo: async () => { throw new Error('a video job is running'); },
    });

    await port.simulateMessage(OWNER, '/controlnode elsewhere');
    await r.idle();
    expect(port.sent[0]!.msg.text).toBe('elsewhere is not a control-node candidate.');

    await port.simulateMessage(OWNER, '/controlnode strix');
    await r.idle();
    await port.simulateCallback(OWNER, port.sent[1]!.msg.buttons!.flat()[0]!.data);
    await r.idle();
    expect(port.sent[2]!.msg.text).toBe('Switch to strix failed: a video job is running');
  });
});

describe('resume() only follows a quiesce that actually ran', () => {
  const target: NodeInfo = {
    id: 2, name: 'strix', arch: 'x86_64', status: 'online', lastHeartbeat: Date.now(),
    endpoints: [], jobTypes: [], profiles: [], video: false,
    controlNode: true, control: { url: 'http://fake-strix' },
  };
  const fakeDb = { pragma: () => {}, prepare: () => ({ run: () => {} }) } as unknown as Db;
  const fakeRegistry = { byName: () => target, all: () => [target] } as unknown as NodeRegistry;

  function makeSwitch(fetchImpl: typeof fetch, extra: { authConfigured?: boolean } = {}) {
    const quiesce = vi.fn(async () => {});
    const resume = vi.fn();
    const sw = new ControlSwitch({
      db: fakeDb, registry: fakeRegistry, dataRoot: '/tmp/agenthub-cn-fake', self: 'mini',
      quiesce, resume, fetchImpl, ...extra,
    });
    return { sw, quiesce, resume };
  }

  it('a 502 (the daemon unreachable) never runs quiesce or resume', async () => {
    const { sw, quiesce, resume } = makeSwitch(async () => { throw new Error('connection refused'); });
    await expect(sw.switchTo('strix')).rejects.toThrow(/failed/);
    expect(quiesce).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it('a 409 (the target already running a hub) never runs quiesce or resume', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      running: true, dataRoot: '/remote', hubUrl: 'http://strix:4000',
    }))) as typeof fetch;
    const { sw, quiesce, resume } = makeSwitch(fetchImpl);
    await expect(sw.switchTo('strix')).rejects.toThrow(/already running a hub/);
    expect(quiesce).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it('a 412 (the target would come up with no HUB_PASSWORD) never runs quiesce or resume', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      running: false, dataRoot: '/remote', hubUrl: 'http://strix:4000', authConfigured: false,
    }))) as typeof fetch;
    const { sw, quiesce, resume } = makeSwitch(fetchImpl, { authConfigured: true });
    await expect(sw.switchTo('strix')).rejects.toThrow(/HUB_PASSWORD/);
    expect(quiesce).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });
});
