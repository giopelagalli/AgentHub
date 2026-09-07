import { spawn, type ChildProcess } from 'node:child_process';
import { rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ControlNodeConfig } from './config.js';

/** How long a started hub gets to answer `/api/health` before the start is called a failure. */
const DEFAULT_HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 250;
/** SIGTERM first, then SIGKILL this long after, so a wedged hub can still be taken off the node. */
const KILL_ESCALATION_MS = 10_000;

/**
 * The snapshot the handing-over hub leaves in the data root (`VACUUM INTO`, see the hub's
 * `ControlSwitch`). It — and not the live `hub.db` that was copied alongside it, which may well be
 * a torn read — is the database this node opens, so `start()` renames it into place first.
 */
export const CHECKPOINT_DB = 'checkpoint.db';

/**
 * Everything the hub reads out of its environment beyond the data roots. Without this list a hub
 * started here would inherit only the daemon's own variables, so a hub with `HUB_PASSWORD` set
 * would come back up with auth silently *off* after a control-node switch. Each name is resolved
 * from `controlNode.env` first and the daemon's own environment second.
 */
export const HUB_ENV_KEYS = [
  'HUB_PASSWORD',
  'HUB_SESSION_SECRET',
  'DAEMON_TOKEN',
  'TRUST_PROXY',
  'CONTROL_NODE_NAME',
  'HUB_HOST',
  'PORT',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_OWNER_CHAT_ID',
  'BRIEFING_TIME',
  'CHECKIN_TIMES',
  'XAI_API_KEY',
  'XAI_MODEL',
  'X_API_KEY',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'SEARCH_API_KEY',
  'SEARCH_PROVIDER',
] as const;

export interface HubStatus {
  running: boolean;
  pid?: number;
  hubUrl: string;
  dataRoot: string;
  /**
   * Whether a hub started here would have auth on. The switch refuses to hand an authenticated hub
   * to a node that would bring it back up open to the tailnet.
   */
  authConfigured: boolean;
}

/** A start that was refused because a hub is already up here; the route answers 409. */
export class HubBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HubBusyError';
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The hub, supervised as a child of this daemon (spec §4.2: the target node's daemon starts the hub
 * after the data sync). It is deliberately a child and not a detached service handle: the daemon is
 * the thing systemd/launchd keeps alive on each control node, so the hub's lifetime is tied to it
 * — stopping the daemon stops the hub it started.
 *
 * The data root reaches the hub as the `DATA_ROOT` variable plus the three roots the hub's `main.ts`
 * actually reads, so a hub started here uses the freshly synced copy and nothing else; every other
 * variable the hub needs comes from `HUB_ENV_KEYS`.
 */
export class HubProcess {
  private child?: ChildProcess;
  private readonly healthTimeoutMs: number;
  /** The node this daemon runs on; passed to the hub so it can't offer itself as a switch target. */
  private readonly nodeName: string | undefined;

  constructor(
    private cfg: ControlNodeConfig,
    private advertiseHost: string,
    opts: { healthTimeoutMs?: number; nodeName?: string } = {},
  ) {
    this.healthTimeoutMs = opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.nodeName = opts.nodeName;
  }

  get hubUrl(): string {
    return this.cfg.hubUrl ?? `http://${this.advertiseHost}:4000`;
  }

  /** The value an allowlisted variable would be given, config first and this process second. */
  private resolve(key: string): string | undefined {
    const fromConfig = this.cfg.env?.[key];
    return fromConfig !== undefined ? fromConfig : process.env[key];
  }

  /** True when a hub started here would come up with auth on — see `HubStatus.authConfigured`. */
  get authConfigured(): boolean {
    return !!this.resolve('HUB_PASSWORD');
  }

  /** The environment a hub started here is given: this process's, plus the allowlist, plus the roots. */
  env(): NodeJS.ProcessEnv {
    const passed: Record<string, string> = {};
    for (const key of HUB_ENV_KEYS) {
      const value = this.resolve(key);
      if (value !== undefined) passed[key] = value;
    }
    // The node's own name wins over anything inherited: this hub runs *here*, and it must not offer
    // this node as its own switch target.
    if (this.nodeName) passed['CONTROL_NODE_NAME'] = this.nodeName;
    return {
      ...process.env,
      ...passed,
      DATA_ROOT: this.cfg.dataRoot,
      HUB_DB: join(this.cfg.dataRoot, 'hub.db'),
      PROJECTS_ROOT: join(this.cfg.dataRoot, 'projects'),
      MEMORY_ROOT: join(this.cfg.dataRoot, 'memory'),
    };
  }

  status(): HubStatus {
    return {
      running: this.child !== undefined,
      ...(this.child?.pid !== undefined ? { pid: this.child.pid } : {}),
      hubUrl: this.hubUrl,
      dataRoot: this.cfg.dataRoot,
      authConfigured: this.authConfigured,
    };
  }

  /**
   * Puts the synced snapshot in place of the database file that was copied alongside it. The live
   * `hub.db` in a sync is written to while it is read, so it can arrive torn; `checkpoint.db` is a
   * consistent `VACUUM INTO` of the same state. The sidecars go with it — a `-wal` left over from
   * this node's own previous life would otherwise be replayed onto a database it knows nothing about.
   */
  private async adoptCheckpoint(): Promise<void> {
    const checkpoint = join(this.cfg.dataRoot, CHECKPOINT_DB);
    try {
      await stat(checkpoint);
    } catch {
      return; // no snapshot came with this sync; whatever is here is what runs
    }
    const db = join(this.cfg.dataRoot, 'hub.db');
    await rm(`${db}-wal`, { force: true });
    await rm(`${db}-shm`, { force: true });
    await rename(checkpoint, db);
    console.error(`[daemon] adopted ${CHECKPOINT_DB} as the hub database`);
  }

  /** Spawns the hub and resolves once it answers `/api/health`; throws (having killed it) if it doesn't. */
  async start(): Promise<HubStatus> {
    // Two hubs on one data root would corrupt it, so a start that would race one is refused rather
    // than silently reported as a success.
    if (this.child) throw new HubBusyError('this daemon already supervises a hub');
    if (await this.healthy()) throw new HubBusyError(`something is already answering ${this.hubUrl}/api/health`);
    await this.adoptCheckpoint();
    const [cmd, ...args] = this.cfg.hubCmd as [string, ...string[]];
    const child = spawn(cmd, args, { env: this.env(), stdio: 'inherit' });
    this.child = child;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    child.on('error', (err) => { console.error('[daemon] hub process failed to spawn:', err); });
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      if (this.child === child) this.child = undefined;
    });

    const deadline = Date.now() + this.healthTimeoutMs;
    while (Date.now() < deadline) {
      if (exited) throw new Error(`hub exited during start-up (code ${exited.code}, signal ${exited.signal})`);
      if (await this.healthy()) return this.status();
      await sleep(HEALTH_POLL_MS);
    }
    await this.stop();
    throw new Error(`hub did not answer ${this.hubUrl}/api/health within ${this.healthTimeoutMs}ms`);
  }

  /** SIGTERM, escalating to SIGKILL; resolves once the child is actually gone. */
  async stop(): Promise<HubStatus> {
    const child = this.child;
    if (!child) return this.status();
    const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), KILL_ESCALATION_MS);
    kill.unref?.();
    try {
      await gone;
    } finally {
      clearTimeout(kill);
    }
    if (this.child === child) this.child = undefined;
    return this.status();
  }

  private async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.hubUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
      await res.arrayBuffer();
      return res.ok;
    } catch {
      return false;
    }
  }
}
