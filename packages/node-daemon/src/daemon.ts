import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { NodeRegistration } from '@agenthub/shared';
import type { BrowserConfig, DaemonConfig } from './config.js';
import type { BrowserDriver } from './browser/driver.js';
import { createBrowserServer } from './browser/server.js';
import { createPlaywrightDriver } from './browser/playwright-driver.js';
import { Supervisor } from './supervisor.js';
import { JobRunner } from './job-runner.js';

// Bounds Daemon.stop()'s wait for the runner's in-flight execution to actually settle, so a real
// shell-task's SIGKILL escalation (shell-task.ts's KILL_ESCALATION_MS, 5s after SIGTERM) has time to
// fire before this process exits.
const RUNNER_STOP_WAIT_MS = 6000;

const DEFAULT_BROWSER_PORT = 8130;

/** Bounds each browser teardown call so a hung close() can't block the runner/supervisor shutdown below. */
const BROWSER_CLOSE_TIMEOUT_MS = 5000;

export interface DaemonDeps {
  /** Swapped for a `FakeDriver` in tests, so no test ever launches a real browser. */
  createBrowserDriver?: (cfg: BrowserConfig) => Promise<BrowserDriver>;
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
  /** Sent on every hub call once the hub has auth enabled; empty when this node has no token. */
  private readonly authHeaders: Record<string, string>;
  constructor(private cfg: DaemonConfig, private deps: DaemonDeps = {}) {
    const token = cfg.hubToken ?? process.env.DAEMON_TOKEN;
    this.authHeaders = token ? { authorization: `Bearer ${token}` } : {};
    this.supervisor = new Supervisor(cfg.serving ?? [], (s) => {
      console.error(`[daemon] serving process for ${s.tier}:${s.model} on port ${s.port} exited unexpectedly`);
      void this.stop().then(() => process.exit(1));
    });
  }

  registration(): NodeRegistration {
    const host = this.cfg.advertiseHost ?? '127.0.0.1';
    return {
      name: this.cfg.node.name, arch: this.cfg.node.arch,
      endpoints: (this.cfg.serving ?? []).map((s) => ({ tier: s.tier, url: `http://${host}:${s.port}`, model: s.model, maxStreams: s.maxStreams })),
      jobTypes: this.cfg.jobTypes ?? [],
      ...(this.cfg.browser?.enabled ? { browser: { url: `http://${host}:${this.browserPort ?? this.cfg.browser.port ?? DEFAULT_BROWSER_PORT}` } } : {}),
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

  async start(): Promise<void> {
    await this.supervisor.startAll();
    if (this.cfg.browser?.enabled) await this.startBrowserServer(this.cfg.browser);
    const res = await fetch(`${this.cfg.hub}/api/nodes/register`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...this.authHeaders }, body: JSON.stringify(this.registration()),
    });
    if (!res.ok) throw new Error(`hub registration failed: ${res.status}`);
    const interval = this.cfg.heartbeatMs ?? 5000;
    this.timer = setInterval(() => {
      fetch(`${this.cfg.hub}/api/nodes/${this.cfg.node.name}/heartbeat`, { method: 'POST', headers: this.authHeaders })
        .then((res) => { if (res.status === 404) void this.reregister('heartbeat'); })
        .catch(() => { /* hub temporarily unreachable; keep beating */ });
    }, interval);

    const jobTypes = this.cfg.jobTypes ?? [];
    if (jobTypes.length > 0) {
      this.runner = new JobRunner({
        hub: this.cfg.hub,
        node: this.cfg.node.name,
        types: jobTypes,
        workspaceRoot: this.cfg.workspaceRoot ?? join(process.cwd(), 'workspace'),
        claimIntervalMs: this.cfg.claimIntervalMs ?? 1000,
        authHeaders: this.authHeaders,
        onNodeNotFound: () => { void this.reregister('claim'); },
      });
      this.runner.start();
    }
  }

  // Re-registers with the hub after it stops recognizing this node — most notably a hub restart
  // (fresh in-memory registry), surfaced as a 404 from heartbeat or claim. Guarded against overlap
  // (a heartbeat tick and a claim tick can both notice this around the same time); register itself
  // is idempotent (NodeRegistry.register upserts by name), so a skipped, overlapping occurrence is
  // covered by the in-flight call.
  private async reregister(reason: 'heartbeat' | 'claim'): Promise<void> {
    if (this.reregistering) return;
    this.reregistering = true;
    console.error(`[daemon] hub doesn't know node ${this.cfg.node.name} (${reason} 404) — re-registering`);
    try {
      const res = await fetch(`${this.cfg.hub}/api/nodes/register`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...this.authHeaders }, body: JSON.stringify(this.registration()),
      });
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
    if (this.browserApp) await this.closeWithTimeout('browser app', () => this.browserApp!.close());
    if (this.browserDriver) await this.closeWithTimeout('browser driver', () => this.browserDriver!.close());
    if (this.runner) {
      await this.runner.stop();
      await this.runner.waitForIdle(RUNNER_STOP_WAIT_MS);
    }
    await this.supervisor.stopAll();
  }
}
