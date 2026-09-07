import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { dataStamp } from '@agenthub/shared/data-stamp';
import type { NodeInfo } from '@agenthub/shared';
import type { Db } from './db.js';
import type { NodeRegistry } from './node-registry.js';

/** Where the data root is going: the node's name, the host to reach it at, and its own data root. */
export interface SyncTarget { node: string; host: string; dataRoot: string }

/** Copies `fromDir` onto the target. Replaced in tests with a local copy so nothing shells out to ssh. */
export type SyncFn = (fromDir: string, target: SyncTarget) => Promise<void>;

/** Placeholders substituted into the configured sync argv. */
const DEFAULT_RSYNC = ['rsync', '-a', '--delete', '{from}/', '{host}:{dataRoot}/'];

/**
 * The consistent copy of the database the target actually opens. `VACUUM INTO` writes a complete,
 * self-contained snapshot while this hub keeps running, so the live `hub.db` — which the sync reads
 * while it is still being written — never has to be trusted (`HubProcess.adoptCheckpoint` renames
 * this one over it on the far side).
 */
export const CHECKPOINT_DB = 'checkpoint.db';

const DEFAULT_CONTROL_TIMEOUT_MS = 30_000;
/** Starting a hub includes its own health probe on the far side, so this window is the generous one. */
const DEFAULT_START_TIMEOUT_MS = 120_000;

/** Carries the HTTP status the route should answer with, so the switch owns its own refusal policy. */
export class SwitchError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'SwitchError';
  }
}

export interface ControlSwitchDeps {
  db: Db;
  registry: NodeRegistry;
  /** This hub's data root — the SQLite file, the projects and the memory bundle all live under it. */
  dataRoot: string;
  /** The node this hub runs on; it can never be its own switch target. */
  self?: string;
  /** Bearer the target daemon's control server expects. */
  daemonToken?: string;
  fetchImpl?: typeof fetch;
  /** Default is `rsync -a --delete` over ssh; tests inject a local copy. */
  sync?: SyncFn;
  /** The rsync argv template, with `{from}`, `{host}` and `{dataRoot}` placeholders. */
  rsyncCmd?: string[];
  /** True while a video job is running — the switch refuses rather than stranding it on a node. */
  videoRunning?: () => boolean;
  /**
   * True when *this* hub has auth on. A target whose daemon reports `authConfigured: false` would
   * bring the hub back up open to the tailnet, so the switch refuses rather than doing that quietly.
   */
  authConfigured?: boolean;
  /**
   * Stops everything that writes without an HTTP request behind it — the project ticker, the
   * assistant scheduler, the Telegram port — for the switch window. The 503 hook covers the API;
   * this covers the rest, so the snapshot is taken of a database nothing is still changing.
   * `resume` undoes it on every path that leaves this hub serving.
   */
  quiesce?: () => Promise<void>;
  resume?: () => void;
  controlTimeoutMs?: number;
  startTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface SwitchResult { switchedTo: string; hubUrl: string }

export interface CandidateInfo { name: string; status: 'online' | 'offline'; current: boolean }

/** The default sync: one `rsync -a --delete` over ssh, whose argv the deployment can override. */
export function rsyncSync(cmd: string[] = DEFAULT_RSYNC): SyncFn {
  return (fromDir, target) => new Promise<void>((resolve, reject) => {
    const argv = cmd.map((part) => part
      .replaceAll('{from}', fromDir)
      .replaceAll('{host}', target.host)
      .replaceAll('{dataRoot}', target.dataRoot));
    const [bin, ...args] = argv as [string, ...string[]];
    const child = spawn(bin, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${bin} exited with ${code}`))));
  });
}

/**
 * The control-node switch (PRD §4.2). The hub's whole state is its data root, so moving the hub is:
 * freeze writes, checkpoint the WAL so the database file is the state, copy the root to the other
 * control node, prove the copy matches, start the hub there, and only then let this one stop.
 *
 * The order is what makes it safe. Nothing is started on the target until the stamps agree — a stale
 * or truncated sync fails the switch (412) with both hubs untouched, this one still serving — and
 * this hub is only stopped after the new one has answered its own health probe, which is the
 * caller's job (`switching` stays set on success, so nothing mutates state on the way out).
 */
export class ControlSwitch {
  /** Set for the whole procedure; the server turns state-mutating routes into 503s while it is. */
  private inProgress = false;
  /** Set only once `quiesce()` has actually run for the current attempt; guards `resume()` on failure. */
  private quiesced = false;
  private readonly fetchImpl: typeof fetch;
  private readonly sync: SyncFn;
  private readonly log: (line: string) => void;

  constructor(private deps: ControlSwitchDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.sync = deps.sync ?? rsyncSync(deps.rsyncCmd);
    this.log = deps.log ?? ((line) => console.error(line));
  }

  get switching(): boolean {
    return this.inProgress;
  }

  /** Every node that could host the hub, plus which one is hosting it now. */
  candidates(): { current: string | null; candidates: CandidateInfo[] } {
    return {
      current: this.deps.self ?? null,
      candidates: this.deps.registry.all()
        .filter((n) => n.controlNode)
        .map((n) => ({ name: n.name, status: n.status, current: n.name === this.deps.self })),
    };
  }

  async switchTo(nodeName: string): Promise<SwitchResult> {
    if (this.inProgress) throw new SwitchError(409, 'a control-node switch is already in progress');
    // Checked before the registry: this hub's own node is a candidate like any other, it just
    // happens to be the one already hosting.
    if (nodeName === this.deps.self) throw new SwitchError(400, `${nodeName} already runs this hub`);
    const node = this.deps.registry.byName(nodeName);
    if (!node || !node.controlNode || !node.control?.url) {
      throw new SwitchError(400, `${nodeName} is not a control-node candidate`);
    }
    if (node.status !== 'online') throw new SwitchError(400, `${nodeName} is offline`);
    if (this.deps.videoRunning?.()) throw new SwitchError(409, 'a video job is running; try again when it finishes');

    this.inProgress = true;
    try {
      const target = await this.hubStatus(node);
      if (target.running) throw new SwitchError(409, `${nodeName} is already running a hub`);
      // A hub with a password must not come back up without one. The daemon derives this from the
      // environment it would actually hand the hub, so this is the real answer and not a promise.
      if (this.deps.authConfigured && target.authConfigured === false) {
        throw new SwitchError(412, `${nodeName} would start the hub with no HUB_PASSWORD; set the hub's environment there first (deploy/controlnode.md)`);
      }

      // Everything that writes stops here — the API is already 503ing, this is the rest — so the
      // snapshot below is of a database nobody is still changing. Telegram's long poll is part of
      // it: two hubs polling one bot token would both consume the owner's updates.
      await this.deps.quiesce?.();
      this.quiesced = true;
      // The WAL is the part of the state that isn't in the file yet; folding it in makes the data
      // root, and only the data root, the thing worth copying. The snapshot beside it is what the
      // target opens: the live file is read by the sync while the process still holds it open.
      this.deps.db.pragma('wal_checkpoint(TRUNCATE)');
      await this.snapshot();
      await this.sync(this.deps.dataRoot, { node: nodeName, host: hostOf(node.control.url), dataRoot: target.dataRoot });

      const local = await dataStamp(this.deps.dataRoot);
      const remote = await this.remoteStamp(node);
      if (local !== remote) {
        throw new SwitchError(412, `data sync to ${nodeName} is stale (${local.slice(0, 12)} != ${remote.slice(0, 12)})`);
      }

      const started = await this.startHub(node);
      this.log(`[controlnode] handed the hub to ${nodeName} at ${started.hubUrl}`);
      return { switchedTo: nodeName, hubUrl: started.hubUrl };
    } catch (err) {
      // Nothing was started on the target on any of these paths, so this hub simply goes back to
      // serving — the flag has to come off, and the paused writers have to come back, or it would
      // 503 every write and schedule nothing from here on. But resume() only undoes a quiesce that
      // actually ran: a refusal before it (offline, already running, no auth) never stopped anything.
      this.inProgress = false;
      if (this.quiesced) {
        this.quiesced = false;
        try {
          this.deps.resume?.();
        } catch (resumeErr) {
          this.log(`[controlnode] resuming after a failed switch: ${(resumeErr as Error).message}`);
        }
      }
      throw err;
    }
  }

  /**
   * Writes the database snapshot the target will adopt. `VACUUM INTO` refuses an existing file, so
   * a leftover from an earlier switch goes first.
   */
  private async snapshot(): Promise<void> {
    const path = join(this.deps.dataRoot, CHECKPOINT_DB);
    await rm(path, { force: true });
    this.deps.db.prepare(`VACUUM INTO ?`).run(path);
  }

  private async hubStatus(node: NodeInfo): Promise<{ running: boolean; dataRoot: string; hubUrl: string; authConfigured?: boolean }> {
    const body = await this.call(node, 'GET', '/control/hub', this.deps.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS) as
      Partial<{ running: boolean; dataRoot: string; hubUrl: string; authConfigured: boolean }>;
    if (typeof body.dataRoot !== 'string' || typeof body.hubUrl !== 'string') {
      throw new SwitchError(502, `${node.name} returned no hub status`);
    }
    return {
      running: body.running === true, dataRoot: body.dataRoot, hubUrl: body.hubUrl,
      // Left undefined by a daemon too old to report it; only an explicit `false` refuses a switch.
      ...(typeof body.authConfigured === 'boolean' ? { authConfigured: body.authConfigured } : {}),
    };
  }

  private async remoteStamp(node: NodeInfo): Promise<string> {
    const body = await this.call(node, 'GET', '/control/hub/data-stamp', this.deps.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS) as
      Partial<{ stamp: string }>;
    if (typeof body.stamp !== 'string') throw new SwitchError(502, `${node.name} returned no data stamp`);
    return body.stamp;
  }

  private async startHub(node: NodeInfo): Promise<{ hubUrl: string }> {
    const body = await this.call(node, 'POST', '/control/hub/start', this.deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS) as
      Partial<{ hubUrl: string }>;
    if (typeof body.hubUrl !== 'string') throw new SwitchError(502, `${node.name} started no hub`);
    return { hubUrl: body.hubUrl };
  }

  private async call(node: NodeInfo, method: 'GET' | 'POST', path: string, timeoutMs: number): Promise<unknown> {
    const url = `${node.control!.url.replace(/\/$/, '')}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: this.deps.daemonToken ? { authorization: `Bearer ${this.deps.daemonToken}` } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new SwitchError(502, `${method} ${path} on ${node.name} failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      // Undici holds the socket until the body is read or cancelled; an error reply nobody reads
      // would otherwise keep a keep-alive connection open past this hub's own shutdown.
      await res.body?.cancel().catch(() => {});
      throw new SwitchError(502, `${method} ${path} on ${node.name} failed: ${res.status}`);
    }
    return res.json();
  }
}

/** The tailnet host to rsync to, taken from the control URL the node registered. */
function hostOf(controlUrl: string): string {
  try {
    return new URL(controlUrl).hostname;
  } catch {
    throw new SwitchError(502, `unusable control url ${controlUrl}`);
  }
}
