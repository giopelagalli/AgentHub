import type { Assistant } from '../assistant/assistant.js';
import type { ConfirmationGate } from '../assistant/confirm.js';
import type { Planner, PlannerList } from '../assistant/planner.js';
import type { NodeRegistry } from '../node-registry.js';
import type { MasterOrchestrator } from '../projects/master.js';
import type { ProjectService } from '../projects/service.js';
import { formatBriefing, formatNodes, formatPlanner, formatProjects, splitMessage } from './format.js';
import type { OutgoingMessage, TelegramPort } from './port.js';

const PLANNER_COMMANDS = new Set(['/goals', '/todo', '/backlog']);
const HANDLER_ERROR_TEXT = 'Something went wrong handling that — see hub logs.';

const HELP_TEXT = [
  'Commands:',
  '/brief — daily briefing',
  '/projects — project status, with pause/resume/run-turn buttons',
  '/goals, /todo, /backlog [add <text> | done <n>] — view or edit a planner list',
  '/new <title>: <intent> — start a new project',
  '/nodes — cluster health',
  '/video, /controlnode — coming in Phase 6',
  '/help — this message',
  '',
  'Anything else is sent to the assistant.',
].join('\n');

/** Turns a project title into a `[a-z0-9-]{1,40}` slug, falling back to a generic one if it empties out. */
function kebab(title: string): string {
  const slug = title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug || 'project';
}

export interface CommandRouterDeps {
  port: TelegramPort;
  ownerChatId: string;
  assistant: Assistant;
  service: ProjectService;
  master: MasterOrchestrator;
  planner: Planner;
  registry: NodeRegistry;
  gate: ConfirmationGate;
}

/**
 * Maps the owner's Telegram messages and button presses to hub calls and back to
 * `OutgoingMessage`s. `handle` is pure-ish (it only reaches out through `deps`, never through
 * `port.onMessage`/`onCallback` itself) so tests can drive it directly; `start()` is the thin wiring
 * that reads real updates off the port, drops anything not from the owner, and sends the replies.
 */
export class CommandRouter {
  constructor(private deps: CommandRouterDeps) {}

  start(): void {
    const { port, ownerChatId } = this.deps;
    // One bad command (a throwing service call, a malformed callback) must not take the whole
    // bot down or leave the owner without a reply — log it and tell them, then keep serving.
    port.onMessage(async (m) => {
      if (m.chatId !== ownerChatId) return;
      try {
        for (const msg of await this.handle(m.text)) await port.send(m.chatId, msg);
      } catch (err) {
        console.error('[telegram] message handler error', err);
        await port.send(m.chatId, { text: HANDLER_ERROR_TEXT });
      }
    });
    port.onCallback(async (c) => {
      if (c.chatId !== ownerChatId) return;
      try {
        const msgs = await this.handleCallback(c.data);
        await port.answerCallback(c.callbackId);
        for (const msg of msgs) await port.send(c.chatId, msg);
      } catch (err) {
        console.error('[telegram] callback handler error', err);
        await port.send(c.chatId, { text: HANDLER_ERROR_TEXT });
      }
    });
  }

  /** Routes one incoming text message to its command (or the assistant) and returns the reply/replies. */
  async handle(text: string): Promise<OutgoingMessage[]> {
    const trimmed = text.trim();
    if (trimmed.startsWith('/')) return this.handleCommand(trimmed);
    return this.handleFreeform(trimmed);
  }

  private async handleCommand(text: string): Promise<OutgoingMessage[]> {
    const spaceIdx = text.indexOf(' ');
    const cmd = (spaceIdx === -1 ? text : text.slice(0, spaceIdx)).toLowerCase();
    const rest = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

    if (cmd === '/help') return [{ text: HELP_TEXT }];
    if (cmd === '/brief') {
      const { text: briefText, briefings } = await this.deps.master.dailyBriefing();
      return [formatBriefing(briefText, briefings)];
    }
    if (cmd === '/projects') return [formatProjects(await this.deps.service.briefings())];
    if (PLANNER_COMMANDS.has(cmd)) return this.handlePlanner(cmd.slice(1) as PlannerList, rest);
    if (cmd === '/new') return this.handleNew(rest);
    if (cmd === '/nodes') return [formatNodes(this.deps.registry.all(), {})];
    if (cmd === '/video' || cmd === '/controlnode') return [{ text: 'coming in Phase 6' }];
    return [{ text: HELP_TEXT }];
  }

  private async handlePlanner(which: PlannerList, rest: string): Promise<OutgoingMessage[]> {
    const addMatch = rest.match(/^add\s+(.+)$/is);
    const doneMatch = rest.match(/^done\s+(\d+)$/i);
    if (addMatch) await this.deps.planner.add(which, addMatch[1].trim());
    else if (doneMatch) await this.deps.planner.complete(which, Number(doneMatch[1]));
    return [formatPlanner(which, await this.deps.planner.list(which))];
  }

  /**
   * Creates the project and replies with the slug immediately — before the first turn has run.
   * The turn itself is kicked off in the background: `handle()` (and so the message handler)
   * returns as soon as the project exists, and the second reply, with the turn's outcome, arrives
   * whenever that (potentially slow) turn actually finishes.
   */
  private async handleNew(rest: string): Promise<OutgoingMessage[]> {
    const m = rest.match(/^(.+?):\s*(.+)$/s);
    const title = m?.[1].trim();
    const intent = m?.[2].trim();
    if (!title || !intent) return [{ text: 'usage: /new <title>: <intent>' }];

    const manifest = await this.deps.service.create({ slug: kebab(title), title, intent });
    const { service, port, ownerChatId } = this.deps;
    void service.runTurn(manifest.slug)
      .then((briefing) => port.send(ownerChatId, { text: `First turn for ${briefing.slug} done: ${briefing.summary}` }))
      .catch((err) => port.send(ownerChatId, { text: `First turn failed: ${(err as Error).message}` }));
    return [{ text: `Created ${manifest.slug}. Running the first turn…` }];
  }

  private async handleFreeform(text: string): Promise<OutgoingMessage[]> {
    const result = await this.deps.assistant.reply(text);
    const msgs: OutgoingMessage[] = splitMessage(result.text || '(no reply)').map((t) => ({ text: t }));
    if (result.pending.length) {
      const last = msgs[msgs.length - 1]!;
      last.buttons = result.pending.map((p) => [
        { text: 'Confirm', data: `confirm:${p.id}` },
        { text: 'Cancel', data: `cancel:${p.id}` },
      ]);
    }
    return msgs;
  }

  private async handleCallback(data: string): Promise<OutgoingMessage[]> {
    const project = data.match(/^proj:(pause|resume|turn):(.+)$/);
    if (project) {
      const [, action, slug] = project as [string, 'pause' | 'resume' | 'turn', string];
      if (action === 'pause') await this.deps.service.pause(slug);
      else if (action === 'resume') await this.deps.service.resume(slug);
      else await this.deps.service.runTurn(slug);
      return [formatProjects(await this.deps.service.briefings())];
    }
    if (data.startsWith('confirm:')) {
      const id = data.slice('confirm:'.length);
      try {
        return [{ text: await this.deps.gate.confirm(id) }];
      } catch (err) {
        return [{ text: `error: ${(err as Error).message}` }];
      }
    }
    if (data.startsWith('cancel:')) {
      const id = data.slice('cancel:'.length);
      return [{ text: this.deps.gate.cancel(id) ? 'Cancelled.' : 'That action is already gone.' }];
    }
    return [];
  }
}
