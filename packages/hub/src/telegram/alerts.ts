import type { NodeInfo } from '@agenthub/shared';
import type { NodeRegistry } from '../node-registry.js';
import type { Briefing } from '../projects/schema.js';
import type { ProjectService } from '../projects/service.js';
import type { Clock } from './scheduler.js';
import type { TelegramPort } from './port.js';

const DEDUPE_MS = 30 * 60_000;

/**
 * The event sources `attach` wires up. `onBriefing` matches `ProjectService.onBriefing` exactly, so
 * the hub can pass it straight through; `onNodeOffline` carries the node plus how many of its jobs
 * were re-queued, which a hub-level `nodeOffline` event supplies alongside the `NodeInfo`.
 */
export interface AlertEvents {
  onNodeOffline(cb: (node: NodeInfo, requeued: number) => void): void;
  onBriefing(cb: (briefing: Briefing) => void): void;
}

export interface AlertsDeps {
  port: TelegramPort;
  ownerChatId: string;
  registry: NodeRegistry;
  service: ProjectService;
  clock: Clock;
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

  attach(events: AlertEvents): void {
    events.onNodeOffline((node, requeued) => {
      void this.send(`node:${node.name}`, `⚠️ node ${node.name} went offline; ${requeued} jobs re-queued`);
    });
    events.onBriefing((briefing) => {
      if (briefing.status !== 'blocked') return;
      const blockers = briefing.blockers.length ? briefing.blockers.join('; ') : 'no reason given';
      void this.send(`blocked:${briefing.slug}`, `⛔ ${briefing.title} is blocked: ${blockers}`);
    });
  }

  private async send(key: string, text: string): Promise<void> {
    const now = this.deps.clock.now();
    const last = this.lastSent.get(key);
    if (last !== undefined && now - last < DEDUPE_MS) return;
    this.lastSent.set(key, now);
    await this.deps.port.send(this.deps.ownerChatId, { text });
  }
}
