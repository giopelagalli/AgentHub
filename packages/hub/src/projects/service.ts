import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PRIORITY_RANK, type AutoRun, type GithubRepoRef, type ModelPolicy, type Priority, type ProjectIntake, type TurnBudget, type TurnEvent } from '@agenthub/shared';
import type { ModelGateway } from '../gateway.js';
import type { JobQueue } from '../queue.js';
import type { NodeRegistry } from '../node-registry.js';
import type { AgentLoop } from '../agents/loop.js';
import type { Transcript } from '../agents/transcript.js';
import type { Tool } from '../agents/tools.js';
import type { LeaseManager } from '../browser/lease.js';
import type { BrowserProxy } from '../browser/proxy.js';
import { ProjectBundle } from './bundle.js';
import { pushBranchFor, type Github } from './github.js';
import { ProjectOrchestrator } from './orchestrator.js';
import { isPrdScaffold } from './prd.js';
import { validateSlug, type Briefing, type Manifest, type ProjectStatus, type TaskItem } from './schema.js';

const DEFAULT_TICK_MS = 15 * 60_000;
const DEFAULT_TURN_TIMEOUT_MS = 45 * 60_000;
const DEFAULT_STOP_GRACE_MS = 5000;
/** The hub-wide turn cap, across every project and whoever triggers the turn. */
export const DEFAULT_MAX_TURNS_PER_DAY = 24;
/** The trailing window `maxTurnsPerDay` counts turns in. */
export const TURN_BUDGET_WINDOW_MS = 24 * 60 * 60_000;
/** How many consecutive failed turns with the same gateway error suspend a project's auto-run. */
const SUSPEND_AFTER_ERRORS = 3;
const ERROR_CLASS_LIMIT = 80;
const GATEWAY_ERROR_PREFIX = 'gateway error: ';

export interface ProjectServiceDeps {
  root: string;
  loop: AgentLoop;
  gateway: ModelGateway;
  queue: JobQueue;
  registry: NodeRegistry;
  transcript: Transcript;
  /** Clones an imported project's repository, and pushes what its verified milestones produce. */
  github?: Github;
  /** Present once the hub wires the shared browser; absent, orchestrators get no browser tools. */
  leases?: LeaseManager;
  browser?: BrowserProxy;
  /** The configured external tools (grok/gemini/search), minus anything outward. */
  external?: Tool[];
  /** Notified with (slug, memberId, busy) whenever a project's delegated subagent run starts or ends. */
  onBusy?: (slug: string, memberId: string, busy: boolean) => void;
  /** Receives every live event of every project's turns, keyed by slug and orchestrator session. */
  onEvent?: (slug: string, sessionId: number, e: TurnEvent, at: number) => void;
  tickIntervalMs?: number;
  /** Aborts a turn that runs longer than this. Defaults to 45 minutes. */
  turnTimeoutMs?: number;
  /** The scheduler's kill switch: `false` and `start()` never sets its timer. Defaults to true. */
  autoTurns?: boolean;
  /** The hub-wide cap on turns in the trailing 24h, manual ones included. Defaults to 24. */
  maxTurnsPerDay?: number;
  /** The clock every interval and budget check reads; tests inject one. Defaults to `Date.now`. */
  now?: () => number;
  /** Notified whenever a turn is refused for budget reasons, after the warning is logged. */
  onTurnRefused?: (slug: string, reason: string) => void;
}

export interface StopOptions {
  /** How long to let in-flight turns finish on their own before aborting them. Defaults to 5s. */
  graceMs?: number;
}

export interface ProjectInit {
  slug: string;
  title: string;
  intent: string;
  priority?: Priority;
  /** The owner's idea or pasted PRD, kept on the manifest for the drafter to work from later. */
  intake?: ProjectIntake;
  /** Import: the repository to clone into `workspace/`, and the branch to clone (else the default). */
  source?: { ref: GithubRepoRef; branch?: string };
}

/** A project's latest briefing together with the prose the master is allowed to read. */
export interface BriefingDoc {
  briefing: Briefing;
  md: string;
}

export type BriefingListener = (briefing: Briefing) => void;
export type AutoRunSuspendedListener = (slug: string, reason: string) => void;

/** Thrown by `runTurn` when a cap is reached; the route answers 409 with the reason. */
export class TurnRefusedError extends Error {
  constructor(public slug: string, public reason: string) {
    super(reason);
    this.name = 'TurnRefusedError';
  }
}

/**
 * The class of the gateway error a session ended on — `endpoint error 412` out of
 * `gateway error: endpoint error 412 from https://api…: {detail}` — so consecutive failures can be
 * compared without the endpoint URL or the response body getting in the way. Null when the session
 * recorded no gateway error.
 */
export function gatewayErrorClass(events: { content: string }[]): string | null {
  const event = events.find((e) => e.content.startsWith(GATEWAY_ERROR_PREFIX));
  if (!event) return null;
  const message = event.content.slice(GATEWAY_ERROR_PREFIX.length);
  // The body is cut first: the URL runs straight into the `: ` that introduces it.
  const detailAt = message.indexOf(': ');
  const head = detailAt === -1 ? message : message.slice(0, detailAt);
  return head.replace(/\s+from\s+\S+/, '').trim().slice(0, ERROR_CLASS_LIMIT);
}

/**
 * Owns the live set of projects: one open bundle and one orchestrator per slug, the per-slug turn
 * queue, and the tick that gives every opted-in (`autoRun.enabled`) active project a turn.
 *
 * Orchestrators are cached because the turn counter is per-process state; bundles are cached because
 * a bundle handle is just a directory plus a git client. Everything else is read from disk per call,
 * so a restarted hub sees exactly what a running one does.
 */
export class ProjectService {
  private bundles = new Map<string, ProjectBundle>();
  private orchestrators = new Map<string, ProjectOrchestrator>();
  /** Per-slug promise chain: the tail each new turn for that slug waits behind. */
  private chains = new Map<string, Promise<unknown>>();
  /** One controller per in-flight turn, keyed by slug — `stop()` aborts whatever's still running. */
  private turnControllers = new Map<string, AbortController>();
  /** The orchestrator session each in-flight turn is running as, once its `turn-start` has fired. */
  private runningTurns = new Map<string, { sessionId: number; startedAt: number }>();
  private listeners: BriefingListener[] = [];
  private suspendedListeners: AutoRunSuspendedListener[] = [];
  /** Slugs already told their PRD is still the scaffold, so the tick doesn't say so every 15 minutes. */
  private scaffoldSkipped = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private tickInFlight: Promise<void> = Promise.resolve();
  private ticking = false;
  private stopped = false;
  /**
   * Set once a `stop()` call gives up waiting for `graceMs` and starts aborting in-flight turns. A
   * turn queued behind one of those (same slug, serialized chain) only starts running afterwards —
   * with a fresh, unaborted controller — so it needs its own pre-abort here or it would run to
   * completion unbounded by `stop()`.
   */
  private forceAborting = false;
  private readonly tickIntervalMs: number;
  private readonly turnTimeoutMs: number;
  private readonly autoTurns: boolean;
  private readonly maxTurnsPerDay: number;
  private readonly now: () => number;

  constructor(private deps: ProjectServiceDeps) {
    this.tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_MS;
    this.turnTimeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.autoTurns = deps.autoTurns ?? true;
    this.maxTurnsPerDay = deps.maxTurnsPerDay ?? DEFAULT_MAX_TURNS_PER_DAY;
    this.now = deps.now ?? Date.now;
  }

  /** Notified whenever a turn lands a briefing. Phase 4 hangs owner alerts off this. */
  onBriefing(listener: BriefingListener): void {
    this.listeners.push(listener);
  }

  /** Notified with (slug, reason) whenever repeated failures switch a project's auto-run off. */
  onAutoRunSuspended(listener: AutoRunSuspendedListener): void {
    this.suspendedListeners.push(listener);
  }

  /**
   * Creates the bundle and, for an imported project, clones the repository into its `workspace/`
   * before the project exists as far as anyone else is concerned. The clone is on the request's
   * critical path deliberately: a project whose code has not landed yet has nothing to say, and a
   * failed clone leaves nothing behind — the half-made bundle is removed so the slug is free again.
   */
  async create(init: ProjectInit): Promise<Manifest> {
    const bundle = await ProjectBundle.create(this.deps.root, init);
    this.bundles.set(init.slug, bundle);
    if (!init.source) return bundle.manifest();

    const { github } = this.deps;
    if (!github) throw new Error('this hub cannot import repositories');
    const { ref } = init.source;
    try {
      await bundle.clearWorkspaceScaffold();
      const { branch, commit } = await github.clone(ref, init.source.branch, bundle.workspace);
      await bundle.setSource({
        kind: 'github', owner: ref.owner, repo: ref.repo, branch,
        importedCommit: commit, pushBranch: pushBranchFor(init.slug),
      });
      await bundle.commit(`chore: import ${ref.owner}/${ref.repo}@${branch}`);
    } catch (err) {
      this.bundles.delete(init.slug);
      await rm(bundle.dir, { recursive: true, force: true });
      throw err;
    }
    return bundle.manifest();
  }

  list(): Promise<Manifest[]> {
    return ProjectBundle.list(this.deps.root);
  }

  /**
   * The single gate between a caller-supplied slug and the filesystem: the slug becomes a path
   * segment in `ProjectBundle.open`, so an unvalidated one (`..%2Fetc%2Fx` off an HTTP route) would
   * read and write bundles outside the projects root.
   */
  async get(slug: string): Promise<ProjectBundle> {
    validateSlug(slug);
    const cached = this.bundles.get(slug);
    if (cached) return cached;
    const bundle = await ProjectBundle.open(this.deps.root, slug);
    this.bundles.set(slug, bundle);
    return bundle;
  }

  pause(slug: string): Promise<Manifest> {
    return this.setStatus(slug, 'paused', 'pause project');
  }

  resume(slug: string): Promise<Manifest> {
    return this.setStatus(slug, 'active', 'resume project');
  }

  /** Archiving is a terminal status, not a deletion: the bundle stays on disk and stops being scheduled. */
  archive(slug: string): Promise<Manifest> {
    return this.setStatus(slug, 'done', 'archive project');
  }

  async setPriority(slug: string, priority: Priority): Promise<Manifest> {
    const bundle = await this.get(slug);
    await bundle.setPriority(priority);
    await bundle.commit(`agent: set priority ${priority}`);
    return bundle.manifest();
  }

  async setModelPolicy(slug: string, policy: ModelPolicy | undefined): Promise<Manifest> {
    const bundle = await this.get(slug);
    await bundle.setModelPolicy(policy);
    await bundle.commit('owner: set model policy');
    return bundle.manifest();
  }

  async setAutoRun(slug: string, autoRun: AutoRun | undefined): Promise<Manifest> {
    const bundle = await this.get(slug);
    await bundle.setAutoRun(autoRun);
    await bundle.commit('owner: set auto-run');
    return bundle.manifest();
  }

  /**
   * Turns spent in the trailing 24h, by this project and by the whole hub. The project cap holds
   * whenever the owner has set one — enabled or not — because it is a number they chose.
   */
  async budget(slug: string): Promise<TurnBudget> {
    const manifest = await (await this.get(slug)).manifest();
    const since = this.now() - TURN_BUDGET_WINDOW_MS;
    return {
      usedToday: this.deps.transcript.sessions({ kind: 'orchestrator', subject: slug, since }).length,
      maxPerDay: manifest.autoRun?.maxTurnsPerDay ?? null,
      hubUsedToday: this.deps.transcript.sessions({ kind: 'orchestrator', since }).length,
      hubMaxPerDay: this.maxTurnsPerDay,
    };
  }

  private async setStatus(slug: string, status: ProjectStatus, summary: string): Promise<Manifest> {
    const bundle = await this.get(slug);
    await bundle.setStatus(status);
    await bundle.commit(`agent: ${summary}`);
    return bundle.manifest();
  }

  async tasks(slug: string): Promise<TaskItem[]> {
    return (await this.get(slug)).tasks().then((t) => t.tasks);
  }

  /** The turn in flight for `slug`, once it has a session; null between turns. */
  runningTurn(slug: string): { sessionId: number; startedAt: number } | null {
    return this.runningTurns.get(slug) ?? null;
  }

  /**
   * Runs one orchestrator turn. Turns for one project are serialized — a second caller (the owner
   * while the scheduler is mid-tick, say) queues behind the first rather than racing it through the
   * same bundle and git index.
   *
   * The turn owns an AbortController for its whole lifetime: `stop()` can abort it on shutdown, and
   * it self-aborts if it outruns `turnTimeoutMs`. A caller-supplied `signal` is merged in — aborting
   * either one aborts the turn.
   *
   * The budget is checked inside the serialized section, so a turn queued behind another counts it.
   * A manual turn is never blocked by the interval or the enabled flag — only by the caps.
   */
  runTurn(slug: string, instruction?: string, signal?: AbortSignal): Promise<Briefing> {
    return this.serialize(slug, async () => {
      const { usedToday, maxPerDay, hubUsedToday, hubMaxPerDay } = await this.budget(slug);
      if (hubUsedToday >= hubMaxPerDay) this.refuse(slug, `hub-wide cap of ${hubMaxPerDay} turns per day reached`);
      if (maxPerDay !== null && usedToday >= maxPerDay) this.refuse(slug, `project cap of ${maxPerDay} turns per day reached`);
      const controller = new AbortController();
      // A turn queued behind an aborted one (same slug, serialized chain) can start running after
      // stop() has already given up waiting and started aborting — abort it immediately too, so it
      // exits without doing new work instead of running unbounded by stop()'s grace period.
      if (this.forceAborting) controller.abort();
      this.turnControllers.set(slug, controller);
      const onCallerAbort = () => controller.abort();
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', onCallerAbort);
      }
      const deadline = setTimeout(() => controller.abort(), this.turnTimeoutMs);
      deadline.unref?.();
      try {
        const orchestrator = await this.orchestratorFor(slug);
        const briefing = await orchestrator.turn({
          ...(instruction ? { instruction } : {}),
          signal: controller.signal,
        });
        for (const listener of this.listeners) listener(briefing);
        await this.suspendIfFailing(slug);
        return briefing;
      } finally {
        clearTimeout(deadline);
        signal?.removeEventListener('abort', onCallerAbort);
        if (this.turnControllers.get(slug) === controller) this.turnControllers.delete(slug);
        this.runningTurns.delete(slug);
      }
    });
  }

  private refuse(slug: string, reason: string): never {
    console.warn(`[projects] turn refused for ${slug}: ${reason}`);
    this.deps.onTurnRefused?.(slug, reason);
    throw new TurnRefusedError(slug, reason);
  }

  /**
   * Switches auto-run off once the last `SUSPEND_AFTER_ERRORS` turns all died on the same gateway
   * error class: a wrong model id or a spent key will not fix itself, and every retry costs a turn.
   * Manual turns keep working, and the decision log says what happened.
   */
  private async suspendIfFailing(slug: string): Promise<void> {
    const bundle = await this.get(slug);
    const autoRun = (await bundle.manifest()).autoRun;
    if (!autoRun?.enabled) return;
    const recent = this.deps.transcript.sessions({ kind: 'orchestrator', subject: slug, limit: SUSPEND_AFTER_ERRORS });
    if (recent.length < SUSPEND_AFTER_ERRORS || !recent.every((s) => s.outcome === 'error')) return;
    const classes = recent.map((s) => gatewayErrorClass(this.deps.transcript.events(s.id)));
    const cls = classes[0];
    if (cls === null || !classes.every((c) => c === cls)) return;
    const reason = `auto-run suspended: ${SUSPEND_AFTER_ERRORS} consecutive turns failed with "${cls}"`;
    await bundle.setAutoRun({ ...autoRun, enabled: false });
    await bundle.appendDecision({ title: 'auto-run suspended', rationale: reason, by: 'hub' });
    await bundle.commit('hub: suspend auto-run');
    console.warn(`[projects] ${slug}: ${reason}`);
    for (const listener of this.suspendedListeners) listener(slug, reason);
  }

  async briefingDocs(): Promise<BriefingDoc[]> {
    const docs: BriefingDoc[] = [];
    for (const manifest of await this.list()) {
      const bundle = await this.get(manifest.slug);
      const briefing = await bundle.latestBriefing();
      if (!briefing) continue;
      const md = await readFile(join(bundle.dir, 'briefings', 'latest.md'), 'utf8').catch(() => '');
      docs.push({ briefing, md });
    }
    return docs;
  }

  async briefings(): Promise<Briefing[]> {
    return (await this.briefingDocs()).map((d) => d.briefing);
  }

  start(): void {
    if (this.timer || !this.autoTurns) return;
    this.stopped = false;
    this.forceAborting = false;
    this.timer = setInterval(() => { void this.tick(); }, this.tickIntervalMs);
    // The scheduler must never be the reason the process stays alive.
    this.timer.unref();
  }

  /**
   * Stops scheduling and waits for the in-flight tick and every queued turn to finish. Turns get
   * `graceMs` (default 5s) to end on their own before their controllers are aborted — at which point
   * `stop()` still waits for the aborted turns to actually unwind (tool calls to notice the signal,
   * child processes to die) rather than returning out from under them.
   */
  async stop(opts: StopOptions = {}): Promise<void> {
    const graceMs = opts.graceMs ?? DEFAULT_STOP_GRACE_MS;
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    await this.tickInFlight;

    const pending = Promise.all([...this.chains.values()]);
    const timedOut = Symbol('grace-timeout');
    const graceTimer = new Promise<typeof timedOut>((resolve) => {
      const t = setTimeout(() => resolve(timedOut), graceMs);
      t.unref?.();
    });
    if ((await Promise.race([pending.then(() => undefined), graceTimer])) === timedOut) {
      this.forceAborting = true;
      for (const controller of this.turnControllers.values()) controller.abort();
      await pending;
    }
  }

  /** One scheduler pass, on demand: what the timer fires, without waiting on it. */
  tickNow(): Promise<void> {
    return this.tick();
  }

  private async tick(): Promise<void> {
    // Ticks never overlap: a tick still running when the next one fires simply skips it.
    if (this.ticking) return;
    this.ticking = true;
    this.tickInFlight = (async () => {
      try {
        const candidates = (await this.list())
          .filter((m) => m.status === 'active' && m.autoRun?.enabled)
          .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
        for (const manifest of candidates) {
          if (this.stopped) break;
          const { slug, autoRun, lastAutoTurnAt } = manifest;
          const now = this.now();
          if (lastAutoTurnAt !== undefined && now - lastAutoTurnAt < autoRun!.everyMinutes * 60_000) continue;
          const bundle = await this.get(slug);
          if (isPrdScaffold(await bundle.prd())) {
            if (!this.scaffoldSkipped.has(slug)) console.log(`[projects] auto-run skipped for ${slug}: PRD not drafted`);
            this.scaffoldSkipped.add(slug);
            continue;
          }
          this.scaffoldSkipped.delete(slug);
          try {
            // Stamped before the turn, so a hub restarted mid-turn doesn't fire it again early.
            await bundle.setLastAutoTurnAt(now);
            await this.runTurn(slug);
          } catch (err) {
            // A refused turn has already been logged; model and tool failures are recorded in the
            // session transcript. What else reaches here is a bundle or git failure, and one bad
            // project must not stall the others.
            if (err instanceof TurnRefusedError) continue;
            console.error(`[projects] scheduled turn failed for ${slug}:`, err);
          }
        }
      } finally {
        this.ticking = false;
      }
      // Nothing awaits a timer-fired tick, and `stop()` must never reject on its behalf.
    })().catch((err) => { console.error('[projects] scheduler tick failed:', err); });
    await this.tickInFlight;
  }

  private async orchestratorFor(slug: string): Promise<ProjectOrchestrator> {
    const cached = this.orchestrators.get(slug);
    if (cached) return cached;
    const { loop, gateway, queue, registry, transcript, github, leases, browser, external, onBusy, onEvent } = this.deps;
    const orchestrator = new ProjectOrchestrator({
      bundle: await this.get(slug), loop, gateway, queue, registry, transcript, github, leases, browser, external,
      ...(onBusy ? { onBusy: (memberId: string, busy: boolean) => onBusy(slug, memberId, busy) } : {}),
      onEvent: (sessionId, e, at) => {
        // Turns are serialized per slug, so the session a turn-start names is the one running now.
        if (e.kind === 'turn-start') this.runningTurns.set(slug, { sessionId, startedAt: at });
        onEvent?.(slug, sessionId, e, at);
      },
    });
    this.orchestrators.set(slug, orchestrator);
    return orchestrator;
  }

  private serialize<T>(slug: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(slug) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    // The stored tail swallows outcomes so one failed turn doesn't reject the next one's wait.
    this.chains.set(slug, next.then(() => undefined, () => undefined));
    return next;
  }
}
