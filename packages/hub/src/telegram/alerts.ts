import type { Job, NodeInfo } from '@agenthub/shared';
import type { NodeRegistry } from '../node-registry.js';
import type { Briefing } from '../projects/schema.js';
import type { ProjectService } from '../projects/service.js';
import type { Clock } from './scheduler.js';
import type { TelegramPort } from './port.js';

const DEDUPE_MS = 30 * 60_000;

/**
 * Telegram's bot API caps an upload at 50MB. Anything close to it is reported by path instead of
 * being pushed at the API and failing where nobody sees it.
 */
export const MAX_VIDEO_BYTES = 48 * 1024 * 1024;

/** The pseudo-project `/video` jobs are filed under, so their clips go back to the owner's chat. */
export const TELEGRAM_PROJECT = '_telegram';

/**
 * The event sources `attach` wires up. `onBriefing` matches `ProjectService.onBriefing` exactly, so
 * the hub can pass it straight through; `onNodeOffline` carries the node plus how many of its jobs
 * were re-queued, which a hub-level `nodeOffline` event supplies alongside the `NodeInfo`.
 */
export interface AlertEvents {
  onNodeOffline(cb: (node: NodeInfo, requeued: number) => void): void;
  onBriefing(cb: (briefing: Briefing) => void): void;
  /** Every job that reached `done` or `failed`; only the owner's own video jobs are reported on. */
  onJobSettled(cb: (job: Job) => void): void;
}

/** A stored clip: where it is, how big, and how to read it — the size decides whether it is sent. */
export interface VideoArtifact {
  path: string;
  size: number;
  read(): Promise<Buffer>;
}

export interface AlertsDeps {
  port: TelegramPort;
  ownerChatId: string;
  registry: NodeRegistry;
  service: ProjectService;
  clock: Clock;
  /** Locates a finished video job's mp4 where the hub stored it; null when it isn't there. */
  videoArtifact: (job: Job) => Promise<VideoArtifact | null>;
}

/**
 * Sends the owner a Telegram alert when a node goes offline or a project's latest briefing lands
 * `blocked`. Each alert has a dedupe key (`node:<name>`, `blocked:<slug>`) that won't fire again
 * within 30 minutes, so a flapping node or a project stuck blocked across several turns doesn't spam
 * the owner with the same alert every time the underlying event repeats.
 */
export class Alerts {
  private lastSent = new Map<string, number>();

  constructor(private deps: AlertsDeps) {}

  // Both listeners are synchronous callbacks on hub events, so the send can only be fire-and-forget.
  // A failing send (Telegram down, bot blocked) must therefore be caught here: an unhandled
  // rejection escaping a node-offline sweep would take the whole hub process down.
  attach(events: AlertEvents): void {
    events.onNodeOffline((node, requeued) => {
      this.send(`node:${node.name}`, `⚠️ node ${node.name} went offline; ${requeued} jobs re-queued`)
        .catch((err) => console.error('[alerts] send failed', err));
    });
    events.onJobSettled((job) => {
      if (job.type !== 'video-gen' || job.project !== TELEGRAM_PROJECT) return;
      this.sendVideo(job).catch((err) => console.error('[alerts] video send failed', err));
    });
    events.onBriefing((briefing) => {
      if (briefing.status !== 'blocked') return;
      const blockers = briefing.blockers.length ? briefing.blockers.join('; ') : 'no reason given';
      this.send(`blocked:${briefing.slug}`, `⛔ ${briefing.title} is blocked: ${blockers}`)
        .catch((err) => console.error('[alerts] send failed', err));
    });
  }

  /**
   * Delivers a `/video` job's clip to the owner. Only jobs the Telegram surface itself queued
   * (`project: TELEGRAM_PROJECT`) are sent — a video started from the UI or an agent belongs to
   * whoever asked for it, not to the owner's chat.
   */
  private async sendVideo(job: Job): Promise<void> {
    if (job.status === 'failed') {
      await this.send(`video:${job.id}`, `🎬 video job #${job.id} failed: ${job.error ?? 'unknown error'}`);
      return;
    }
    const artifact = await this.deps.videoArtifact(job);
    const key = `video:${job.id}`;
    if (!artifact) {
      await this.send(key, `🎬 video job #${job.id} finished but its file is missing`);
      return;
    }
    if (artifact.size > MAX_VIDEO_BYTES) {
      const mb = Math.round(artifact.size / (1024 * 1024));
      await this.send(key, `🎬 video job #${job.id} finished but is too large to send (${mb}MB); it's at ${artifact.path}`);
      return;
    }
    const now = this.deps.clock.now();
    this.lastSent.set(key, now);
    const prompt = (job.payload as { prompt?: string } | undefined)?.prompt ?? '';
    await this.deps.port.send(this.deps.ownerChatId, { text: `🎬 video job #${job.id}: ${prompt}`, video: await artifact.read() });
  }

  private async send(key: string, text: string): Promise<void> {
    const now = this.deps.clock.now();
    const last = this.lastSent.get(key);
    if (last !== undefined && now - last < DEDUPE_MS) return;
    this.lastSent.set(key, now);
    await this.deps.port.send(this.deps.ownerChatId, { text });
  }
}
