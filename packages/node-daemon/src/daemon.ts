import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataStamp } from '@agenthub/shared/data-stamp';
import Fastify, { type FastifyInstance } from 'fastify';
import type { NodeRegistration } from '@agenthub/shared';
import { offeredJobTypes, workflowPaths, type BrowserConfig, type DaemonConfig, type VideoConfig } from './config.js';
import type { BrowserDriver } from './browser/driver.js';
import { createBrowserServer } from './browser/server.js';
import { createPlaywrightDriver } from './browser/playwright-driver.js';
import { Supervisor, entryName } from './supervisor.js';
import { JobRunner } from './job-runner.js';
import { HubBusyError, HubProcess } from './hub-process.js';
import { safeEqual } from './shell-task.js';

// Bounds Daemon.stop()'s wait for the runner's in-flight execution to actually settle, so a real
// shell-task's SIGKILL escalation (shell-task.ts's KILL_ESCALATION_MS, 5s after SIGTERM) has time to
// fire before this process exits.
const RUNNER_STOP_WAIT_MS = 6000;

const DEFAULT_BROWSER_PORT = 8130;
const DEFAULT_CONTROL_PORT = 8131;

/** Bounds each browser teardown call so a hung close() can't block the runner/supervisor shutdown below. */
const BROWSER_CLOSE_TIMEOUT_MS = 5000;

/** Consecutive failed heartbeats before the daemon goes looking for the hub somewhere else. */
const REDISCOVER_AFTER_FAILURES = 3;
/** Bounds the health probe each rediscovery candidate gets. */
const REDISCOVER_PROBE_MS = 3000;

/** Total time start() may spend retrying hub registration before giving up on it. */
const REGISTER_RETRY_MS = 60_000;
/** Backoff between registration attempts: the first four gaps, then a steady cadence until the budget above runs out. */
const REGISTER_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
const REGISTER_RETRY_STEADY_MS = 10_000;

/**
 * Reads (and so releases) a response nobody cares about. Undici keeps the connection — and the
 * socket behind it — alive until a body is consumed or cancelled, which is what used to leave the
 * daemon's fire-and-forget calls holding a keep-alive socket open through teardown.
 */
async function drain(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch { /* already consumed or aborted */ }
}

export interface DaemonDeps {
  /** Swapped for a `FakeDriver` in tests, so no test ever launches a real browser. */
  createBrowserDriver?: (cfg: BrowserConfig) => Promise<BrowserDriver>;
  /** Called instead of `process.exit(0)` when the hub reports this node was removed (heartbeat 410). */
  onRemoved?: () => void;
  /** Overrides the real timer behind registration retry backoff, so a test can run it in milliseconds. */
  sleep?: (ms: number) => Promise<void>;
}

export class Daemon {
  private supervisor: Supervisor;
  private runner?: JobRunner;
  private timer?: NodeJS.Timeout;
  private reregistering = false;
  private browserApp?: FastifyInstance;
  private browserDriver?: BrowserDriver;
  /** The port the browser server actually bound, which differs from config when it asked for 0. */
  private browserPort?: number;
  /** Owned only when the control server isn't sharing the browser app. */
  private controlApp?: FastifyInstance;
  private controlPort?: number;
  /** Serializes profile switches so two overlapping calls can't interleave start/stop of one entry. */
  private profileSwitch: Promise<unknown> = Promise.resolve();
  private activeProfile?: string;
  /** Sent on every hub call once the hub has auth enabled; empty when this node has no token. */
  private readonly authHeaders: Record<string, string>;
  /** The same secret the hub uses for daemon calls; also guards this daemon's control endpoints. */
  private readonly token?: string;
  /** Present only on a hub candidate: the hub this node can be asked to run (spec §4.2). */
  private readonly hubProcess?: HubProcess;
  /**
   * Where the hub is *now*. It starts at `cfg.hub` and moves when a control-node switch takes the
   * hub to another machine (see `rediscoverHub`), which is why nothing else reads `cfg.hub`.
   */
  private hubUrl: string;
  private hubFailures = 0;
  private rediscovering = false;
  constructor(private cfg: DaemonConfig, private deps: DaemonDeps = {}) {
    const token = cfg.hubToken ?? process.env.DAEMON_TOKEN;
    this.token = token || undefined;
    this.authHeaders = token ? { authorization: `Bearer ${token}` } : {};
    this.hubUrl = cfg.hub;
    if (cfg.controlNode) {
      this.hubProcess = new HubProcess(cfg.controlNode, cfg.advertiseHost ?? '127.0.0.1', { nodeName: cfg.node.name });
    }
    this.supervisor = new Supervisor(cfg.serving ?? [], (s) => {
      console.error(`[daemon] serving process for ${s.tier}:${s.model} on port ${s.port} exited unexpectedly`);
      void this.stop().then(() => process.exit(1));
    });
  }

  registration(): NodeRegistration {
    const host = this.cfg.advertiseHost ?? '127.0.0.1';
    return {
      name: this.cfg.node.name, arch: this.cfg.node.arch,
      endpoints: (this.cfg.serving ?? []).map((s) => ({ tier: s.tier, url: `http://${host}:${s.port}`, model: s.model, maxStreams: s.maxStreams, ...(s.priority != null ? { priority: s.priority } : {}), ...(s.requestExtras ? { requestExtras: s.requestExtras } : {}) })),
      jobTypes: offeredJobTypes(this.cfg),
      ...(this.cfg.browser?.enabled ? { browser: { url: `http://${host}:${this.browserPort ?? this.cfg.browser.port ?? DEFAULT_BROWSER_PORT}` } } : {}),
      profiles: Object.keys(this.cfg.profiles ?? {}),
      video: this.cfg.video !== undefined,
      ...(this.controlPort !== undefined ? { control: { url: `http://${host}:${this.controlPort}` } } : {}),
      ...(this.cfg.controlNode ? { controlNode: true } : {}),
    };
  }

  // Binds loopback unless the node advertises a tailnet address — the hub is the only client, and
  // the browser server itself has no auth of its own yet.
  private async startBrowserServer(cfg: BrowserConfig): Promise<void> {
    const create = this.deps.createBrowserDriver ?? ((c) => createPlaywrightDriver({ headless: c.headless ?? true, ...(c.display ? { display: c.display } : {}) }));
    this.browserDriver = await create(cfg);
    this.browserApp = createBrowserServer(this.browserDriver);
    const host = this.cfg.advertiseHost ?? '127.0.0.1';
    await this.browserApp.listen({ port: cfg.port ?? DEFAULT_BROWSER_PORT, host });
    this.browserPort = (this.browserApp.server.address() as { port: number }).port;
  }

  /**
   * The daemon's local control API. It exists when the node declares `profiles` — the hub drives the
   * Spark exclusivity swap (spec §4.3) through it — or `controlNode`, which adds the hub start/stop
   * endpoints a control-node switch needs (spec §4.2). It reuses the browser server's app
   * when that one is running, so a node binds at most one extra port. Every route requires the same
   * bearer token the daemon uses towards the hub; with no token configured the endpoint refuses
   * everything rather than serving an unauthenticated switch.
   */
  private checkBearer(authorization: string | undefined): boolean {
    return !!this.token && typeof authorization === 'string' && safeEqual(authorization, `Bearer ${this.token}`);
  }

  private registerControlRoutes(app: FastifyInstance): void {
    const profiles = this.cfg.profiles ?? {};
    app.post('/control/profile', async (req, reply) => {
      if (!this.checkBearer(req.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
      const { name } = (req.body ?? {}) as { name?: unknown };
      if (typeof name !== 'string' || !Object.hasOwn(profiles, name)) return reply.code(404).send({ error: 'unknown profile' });
      try {
        await this.applyProfile(name);
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message, profile: this.activeProfile ?? null, entries: this.supervisor.activeEntries() });
      }
      return { profile: this.activeProfile, entries: this.supervisor.activeEntries() };
    });
    // Lets the hub learn the node's live profile after its own restart, when it no longer remembers
    // which switch it last requested.
    app.get('/control/profile', async (req, reply) => {
      if (!this.checkBearer(req.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
      return { profile: this.activeProfile ?? null, entries: this.supervisor.activeEntries() };
    });
    if (this.hubProcess) this.registerHubRoutes(app, this.hubProcess, this.cfg.controlNode!.dataRoot);
  }

  /**
   * The control-node half of the switch (spec §4.2). The hub that is handing over syncs its data
   * root here, compares `data-stamp` against its own to prove the copy arrived intact, and only then
   * asks this node to start the hub; `start` does not answer until the new hub is actually healthy.
   */
  private registerHubRoutes(app: FastifyInstance, hub: HubProcess, dataRoot: string): void {
    app.get('/control/hub', async (req, reply) => {
      if (!this.checkBearer(req.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
      return hub.status();
    });
    app.get('/control/hub/data-stamp', async (req, reply) => {
      if (!this.checkBearer(req.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
      return { stamp: await dataStamp(dataRoot), dataRoot };
    });
    app.post('/control/hub/start', async (req, reply) => {
      if (!this.checkBearer(req.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
      try {
        return await hub.start();
      } catch (err) {
        const status = err instanceof HubBusyError ? 409 : 502;
        return reply.code(status).send({ error: (err as Error).message, ...hub.status() });
      }
    });
    app.post('/control/hub/stop', async (req, reply) => {
      if (!this.checkBearer(req.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
      return hub.stop();
    });
  }

  /** Stops every entry outside the profile, then starts the ones it names. Both halves are idempotent. */
  private applyProfile(name: string): Promise<void> {
    const wanted = this.cfg.profiles?.[name] ?? [];
    const run = this.profileSwitch.then(async () => {
      const drop = (this.cfg.serving ?? []).map(entryName).filter((e) => !wanted.includes(e));
      try {
        await this.supervisor.stopEntries(drop);
        await this.supervisor.startEntries(wanted);
        this.activeProfile = name;
      } catch (err) {
        // A partial switch leaves neither profile fully served — don't misreport the stale one.
        this.activeProfile = undefined;
        throw err;
      }
    });
    // Keep the chain alive for the next caller even when this switch failed.
    this.profileSwitch = run.catch(() => undefined);
    return run;
  }

  private async startControlServer(): Promise<void> {
    if (this.browserApp) {
      this.registerControlRoutes(this.browserApp);
      this.controlPort = this.browserPort;
      return;
    }
    // A control call the hub abandoned (a timed-out switch probe) must not keep its socket — and so
    // `close()` — alive: the daemon's shutdown is what the hub's own teardown waits behind.
    this.controlApp = Fastify({ forceCloseConnections: true });
    this.registerControlRoutes(this.controlApp);
    const host = this.cfg.advertiseHost ?? '127.0.0.1';
    await this.controlApp.listen({ port: this.cfg.controlPort ?? DEFAULT_CONTROL_PORT, host });
    this.controlPort = (this.controlApp.server.address() as { port: number }).port;
  }

  /**
   * Reads the ComfyUI workflow templates once at start-up (a missing or unreadable file should stop
   * the daemon, not surface one job at a time); `workflowPaths` picks which file per job type.
   */
  private loadWorkflowTemplates(video: VideoConfig): { comfyUrl: string; workflowTemplate: string; imageTemplate?: string } {
    const paths = workflowPaths(video);
    return {
      comfyUrl: video.comfyUrl,
      workflowTemplate: readFileSync(paths.video, 'utf8'),
      ...(paths.image ? { imageTemplate: readFileSync(paths.image, 'utf8') } : {}),
    };
  }

  /** One registration attempt: ok, or a failure carrying both a short reason (for the retry log) and the error to throw if this was the last try. */
  private async attemptRegister(): Promise<{ ok: true } | { ok: false; status?: number; reason: string; error: Error }> {
    try {
      const res = await fetch(`${this.hubUrl}/api/nodes/register`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...this.authHeaders }, body: JSON.stringify(this.registration()),
      });
      await drain(res);
      if (res.ok) return { ok: true };
      return { ok: false, status: res.status, reason: `${res.status}`, error: new Error(`hub registration failed: ${res.status}`) };
    } catch (err) {
      return { ok: false, reason: (err as Error).message, error: err as Error };
    }
  }

  /**
   * Registers with the hub, retrying with backoff (1s, 2s, 4s, 8s, then every 10s) for up to
   * REGISTER_RETRY_MS total — covers systemd starting this daemon a second or two before the hub
   * itself is listening, which used to exit the daemon and force a 15s systemd restart. A 410 (this
   * node was removed) or a 401/403 (bad token) is final and thrown immediately, never retried.
   */
  private async registerWithRetry(): Promise<void> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let elapsed = 0;
    for (let attempt = 0; ; attempt++) {
      const result = await this.attemptRegister();
      if (result.ok) return;
      if (result.status === 410 || result.status === 401 || result.status === 403) throw result.error;
      const delay = REGISTER_RETRY_DELAYS_MS[attempt] ?? REGISTER_RETRY_STEADY_MS;
      if (elapsed + delay > REGISTER_RETRY_MS) throw result.error;
      console.error(`[daemon] hub not reachable yet (${result.reason}); retrying in ${delay / 1000}s`);
      await sleep(delay);
      elapsed += delay;
    }
  }

  async start(): Promise<void> {
    await this.supervisor.startAll();
    if (this.cfg.browser?.enabled) await this.startBrowserServer(this.cfg.browser);
    if (this.cfg.profiles || this.cfg.controlNode) await this.startControlServer();
    await this.registerWithRetry();
    const interval = this.cfg.heartbeatMs ?? 5000;
    this.timer = setInterval(() => {
      fetch(`${this.hubUrl}/api/nodes/${this.cfg.node.name}/heartbeat`, { method: 'POST', headers: this.authHeaders })
        .then(async (res) => {
          await drain(res);
          if (res.status === 410) {
            console.error('[daemon] this node was removed from the hub; exiting');
            await this.stop();
            if (this.deps.onRemoved) this.deps.onRemoved(); else process.exit(0);
            return;
          }
          if (res.status === 404) { this.hubFailures = 0; void this.reregister('heartbeat'); return; }
          // 503 is the hub telling us it is handing itself over; anything else that isn't a 2xx is
          // a hub that can't serve this node either way.
          if (res.ok) this.hubFailures = 0; else this.noteHubFailure();
        })
        .catch(() => { this.noteHubFailure(); });
    }, interval);

    const jobTypes = offeredJobTypes(this.cfg);
    if ((this.cfg.jobTypes ?? []).includes('image-gen') && !jobTypes.includes('image-gen')) {
      console.warn('[daemon] image-gen listed but video.workflows.image is not set; not offering it (deploy/amd/comfy/README.md)');
    }
    if (jobTypes.length > 0) {
      this.runner = new JobRunner({
        hub: this.hubUrl,
        node: this.cfg.node.name,
        types: jobTypes,
        workspaceRoot: this.cfg.workspaceRoot ?? join(process.cwd(), 'workspace'),
        claimIntervalMs: this.cfg.claimIntervalMs ?? 1000,
        authHeaders: this.authHeaders,
        ...(this.cfg.video ? { video: this.loadWorkflowTemplates(this.cfg.video) } : {}),
        onNodeNotFound: () => { void this.reregister('claim'); },
      });
      this.runner.start();
    }
  }

  /**
   * A heartbeat that didn't land. A run of them means the hub is no longer where this daemon last
   * saw it — most often because it was handed to the other control node — so after
   * `REDISCOVER_AFTER_FAILURES` in a row the daemon goes looking for it.
   */
  private noteHubFailure(): void {
    this.hubFailures++;
    if (this.hubFailures >= REDISCOVER_AFTER_FAILURES) void this.rediscoverHub();
  }

  /**
   * Follows the hub. The configured `hub` is re-probed first — a tailnet alias (`hub.internal`) is
   * repointed at the new control node and needs nothing else — and only if that is still down are
   * `hubCandidates` tried in order. The first one that answers `/api/health` becomes this daemon's
   * hub, for the heartbeat and for the job runner alike, and the move is logged once.
   */
  private async rediscoverHub(): Promise<void> {
    if (this.rediscovering) return;
    this.rediscovering = true;
    try {
      for (const candidate of [this.hubUrl, this.cfg.hub, ...(this.cfg.hubCandidates ?? [])]) {
        if (!(await this.hubAlive(candidate))) continue;
        this.hubFailures = 0;
        if (candidate === this.hubUrl) return;
        console.error(`[daemon] hub moved: following it from ${this.hubUrl} to ${candidate}`);
        this.hubUrl = candidate;
        this.runner?.setHub(candidate);
        await this.reregister('rediscovery');
        return;
      }
    } finally {
      this.rediscovering = false;
    }
  }

  private async hubAlive(url: string): Promise<boolean> {
    try {
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(REDISCOVER_PROBE_MS) });
      await drain(res);
      return res.ok;
    } catch {
      return false;
    }
  }

  // Re-registers with the hub after it stops recognizing this node — most notably a hub restart
  // (fresh in-memory registry), surfaced as a 404 from heartbeat or claim. Guarded against overlap
  // (a heartbeat tick and a claim tick can both notice this around the same time); register itself
  // is idempotent (NodeRegistry.register upserts by name), so a skipped, overlapping occurrence is
  // covered by the in-flight call.
  private async reregister(reason: 'heartbeat' | 'claim' | 'rediscovery'): Promise<void> {
    if (this.reregistering) return;
    this.reregistering = true;
    console.error(`[daemon] hub doesn't know node ${this.cfg.node.name} (${reason} 404) — re-registering`);
    try {
      const res = await fetch(`${this.hubUrl}/api/nodes/register`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...this.authHeaders }, body: JSON.stringify(this.registration()),
      });
      await drain(res);
      if (!res.ok) console.error(`[daemon] re-registration failed: ${res.status}`);
    } catch (err) {
      console.error('[daemon] re-registration failed:', err);
    } finally {
      this.reregistering = false;
    }
  }

  // A wedged browser (a hung Chromium, an app or driver whose close() never resolves) must not stop
  // the runner and supervisor from shutting down — those own real child processes. Each close gets
  // its own try/catch, so a throw from the app doesn't skip the driver, and its own timeout, so a
  // hang in either can't block the rest of stop().
  private async closeWithTimeout(label: string, close: () => Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<true>((resolve) => {
      timer = setTimeout(() => resolve(true), BROWSER_CLOSE_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      if (await Promise.race([close().then(() => false), timedOut])) {
        console.error(`[daemon] ${label} close timed out after ${BROWSER_CLOSE_TIMEOUT_MS}ms`);
      }
    } catch (err) {
      console.error(`[daemon] ${label} close failed:`, err);
    } finally {
      clearTimeout(timer);
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.hubProcess) await this.closeWithTimeout('hub process', async () => { await this.hubProcess!.stop(); });
    if (this.controlApp) await this.closeWithTimeout('control app', () => this.controlApp!.close());
    if (this.browserApp) await this.closeWithTimeout('browser app', () => this.browserApp!.close());
    if (this.browserDriver) await this.closeWithTimeout('browser driver', () => this.browserDriver!.close());
    if (this.runner) {
      await this.runner.stop();
      await this.runner.waitForIdle(RUNNER_STOP_WAIT_MS);
    }
    await this.supervisor.stopAll();
  }
}
