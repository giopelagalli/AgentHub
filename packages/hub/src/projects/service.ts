import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PRIORITY_RANK, type Priority } from '@agenthub/shared';
import type { ModelGateway } from '../gateway.js';
import type { JobQueue } from '../queue.js';
import type { NodeRegistry } from '../node-registry.js';
import type { AgentLoop } from '../agents/loop.js';
import type { Transcript } from '../agents/transcript.js';
import { ProjectBundle } from './bundle.js';
import { ProjectOrchestrator } from './orchestrator.js';
import { validateSlug, type Briefing, type Manifest, type ProjectStatus, type TaskItem } from './schema.js';

const DEFAULT_TICK_MS = 15 * 60_000;

export interface ProjectServiceDeps {
  root: string;
  loop: AgentLoop;
  gateway: ModelGateway;
  queue: JobQueue;
  registry: NodeRegistry;
  transcript: Transcript;
  tickIntervalMs?: number;
}

export interface ProjectInit {
  slug: string;
  title: string;
  intent: string;
  priority?: Priority;
}

/** A project's latest briefing together with the prose the master is allowed to read. */
export interface BriefingDoc {
  briefing: Briefing;
  md: string;
}

export type BriefingListener = (briefing: Briefing) => void;

/**
 * Owns the live set of projects: one open bundle and one orchestrator per slug, the per-slug turn
 * queue, and the tick that gives every active project a turn.
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
  private listeners: BriefingListener[] = [];
  private timer: NodeJS.Timeout | undefined;
  private tickInFlight: Promise<void> = Promise.resolve();
  private ticking = false;
  private stopped = false;
  private readonly tickIntervalMs: number;

  constructor(private deps: ProjectServiceDeps) {
    this.tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_MS;
  }

  /** Notified whenever a turn lands a briefing. Phase 4 hangs owner alerts off this. */
  onBriefing(listener: BriefingListener): void {
    this.listeners.push(listener);
  }

  async create(init: ProjectInit): Promise<Manifest> {
    const bundle = await ProjectBundle.create(this.deps.root, init);
    this.bundles.set(init.slug, bundle);
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

  private async setStatus(slug: string, status: ProjectStatus, summary: string): Promise<Manifest> {
    const bundle = await this.get(slug);
    await bundle.setStatus(status);
    await bundle.commit(`agent: ${summary}`);
    return bundle.manifest();
  }

  async tasks(slug: string): Promise<TaskItem[]> {
    return (await this.get(slug)).tasks().then((t) => t.tasks);
  }

  /**
   * Runs one orchestrator turn. Turns for one project are serialized — a second caller (the owner
   * while the scheduler is mid-tick, say) queues behind the first rather than racing it through the
   * same bundle and git index.
   */
  runTurn(slug: string, instruction?: string, signal?: AbortSignal): Promise<Briefing> {
    return this.serialize(slug, async () => {
      const orchestrator = await this.orchestratorFor(slug);
      const briefing = await orchestrator.turn({
        ...(instruction ? { instruction } : {}),
        ...(signal ? { signal } : {}),
      });
      for (const listener of this.listeners) listener(briefing);
      return briefing;
    });
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
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.tick(); }, this.tickIntervalMs);
    // The scheduler must never be the reason the process stays alive.
    this.timer.unref();
  }

  /** Stops scheduling and waits for the in-flight tick and every queued turn to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    await this.tickInFlight;
    await Promise.all([...this.chains.values()]);
  }

  private async tick(): Promise<void> {
    // Ticks never overlap: a tick still running when the next one fires simply skips it.
    if (this.ticking) return;
    this.ticking = true;
    this.tickInFlight = (async () => {
      try {
        const active = (await this.list())
          .filter((m) => m.status === 'active')
          .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
        for (const manifest of active) {
          if (this.stopped) break;
          try {
            await this.runTurn(manifest.slug);
          } catch (err) {
            // Model and tool failures are already recorded in the session transcript; what reaches
            // here is a bundle or git failure, and one bad project must not stall the others.
            console.error(`[projects] scheduled turn failed for ${manifest.slug}:`, err);
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
    const { loop, gateway, queue, registry, transcript } = this.deps;
    const orchestrator = new ProjectOrchestrator({
      bundle: await this.get(slug), loop, gateway, queue, registry, transcript,
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
