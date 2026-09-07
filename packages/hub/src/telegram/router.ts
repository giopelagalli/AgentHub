import { videoPayloadFrom, type Job, type VideoPayload } from '@agenthub/shared';
import type { Assistant } from '../assistant/assistant.js';
import { ConfirmationGate } from '../assistant/confirm.js';
import type { Planner, PlannerList } from '../assistant/planner.js';
import type { NodeRegistry } from '../node-registry.js';
import type { MasterOrchestrator } from '../projects/master.js';
import type { ProjectService } from '../projects/service.js';
import { formatBriefing, formatNodes, formatPlanner, formatProjects, splitMessage } from './format.js';
import type { OutgoingMessage, TelegramPort } from './port.js';

const PLANNER_COMMANDS = new Set(['/goals', '/todo', '/backlog']);

/**
 * How long a `/controlnode <name>` confirmation button stays live. The buttons sit in the owner's
 * chat history forever, so without an expiry a tap on last week's message would move the hub.
 */
const CONTROL_NODE_CONFIRM_TTL_MS = 10 * 60_000;
const HANDLER_ERROR_TEXT = 'Something went wrong handling that — see hub logs.';

const HELP_TEXT = [
  'Commands:',
  '/brief — daily briefing',
  '/projects — project status, with pause/resume/run-turn buttons',
  '/goals, /todo, /backlog [add <text> | done <n>] — view or edit a planner list',
  '/new <title>: <intent> — start a new project',
  '/nodes — cluster health',
  '/video <prompt> — queue a video generation job; the clip arrives when it is done',
  '/controlnode [name] — list the control nodes, or move the hub to one',
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
  /** Enqueues a `video-gen` job for `/video`; absent, the command says video isn't configured. */
  enqueueVideo?: (payload: VideoPayload) => Job;
  /** Drives `/controlnode`; absent, the command says switching isn't configured on this hub. */
  controlNodes?: ControlNodeDeps;
  /** Injected in tests so a confirmation can be aged past its expiry without waiting. */
  now?: () => number;
}

export interface ControlNodeDeps {
  list: () => { current: string | null; candidates: { name: string; status: 'online' | 'offline'; current: boolean }[] };
  switchTo: (node: string) => Promise<{ switchedTo: string; hubUrl: string }>;
}

/**
 * Maps the owner's Telegram messages and button presses to hub calls and back to
 * `OutgoingMessage`s. `handle` is pure-ish (it only reaches out through `deps`, never through
 * `port.onMessage`/`onCallback` itself) so tests can drive it directly; `start()` is the thin wiring
 * that reads real updates off the port, drops anything not from the owner, and sends the replies.
 */
export class CommandRouter {
  /** One promise chain per chat: see `dispatch`. */
  private chains = new Map<string, Promise<void>>();
  /**
   * Nonces for the `/controlnode` confirmation buttons — the same gate the outward tools use, held
   * separately because a hub move gets a much shorter window than a tweet does. A confirmation is
   * single-use (the nonce is spent when it is taken) and dies with the window, so an old button and
   * a double tap both land on the same "expired" reply rather than on a second switch.
   */
  private readonly cnConfirmations: ConfirmationGate;

  constructor(private deps: CommandRouterDeps) {
    this.cnConfirmations = new ConfirmationGate({
      ttlMs: CONTROL_NODE_CONFIRM_TTL_MS,
      ...(deps.now ? { now: deps.now } : {}),
    });
  }

  start(): void {
    const { port, ownerChatId } = this.deps;
    // One bad command (a throwing service call, a malformed callback) must not take the whole
    // bot down or leave the owner without a reply — log it and tell them, then keep serving.
    port.onMessage(async (m) => {
      if (m.chatId !== ownerChatId) return;
      this.dispatch(m.chatId, async () => {
        try {
          for (const msg of await this.handle(m.text)) await port.send(m.chatId, msg);
        } catch (err) {
          console.error('[telegram] message handler error', err);
          await port.send(m.chatId, { text: HANDLER_ERROR_TEXT });
        }
      });
    });
    port.onCallback(async (c) => {
      if (c.chatId !== ownerChatId) return;
      this.dispatch(c.chatId, async () => {
        try {
          // Answered before the work it acknowledges: Telegram gives a callback query a few seconds
          // before it expires, and the owner's button spins until then — but the work behind a
          // `proj:turn` is a whole project turn, far longer than that window.
          await port.answerCallback(c.callbackId);
          for (const msg of await this.handleCallback(c.data)) await port.send(c.chatId, msg);
        } catch (err) {
          console.error('[telegram] callback handler error', err);
          await port.send(c.chatId, { text: HANDLER_ERROR_TEXT });
        }
      });
    });
  }

  /**
   * Resolves once every dispatched handler has finished. Tests use it to observe the replies a
   * handler chain produced; nothing in production waits on it.
   */
  async idle(): Promise<void> {
    while (this.chains.size) await Promise.all([...this.chains.values()]);
  }

  /**
   * Runs `work` detached from the update that triggered it, but after everything already queued
   * for that chat.
   *
   * grammY delivers updates sequentially: it does not fetch the next one until the handler for the
   * current one has resolved. A `/brief`, an assistant reply or a `proj:turn` is a whole model
   * session, so awaiting it inline left the bot deaf for as long as that took. Returning
   * immediately and queueing the work keeps the transport responsive while preserving the order
   * the owner sent things in — their second message still runs after their first, and its reply
   * still arrives second.
   */
  private dispatch(chatId: string, work: () => Promise<void>): void {
    const prev = this.chains.get(chatId) ?? Promise.resolve();
    // Nothing awaits this chain, so it must never reject: a failing error-reply send (the one case
    // `work`'s own try/catch cannot cover) ends here as a log line.
    const next: Promise<void> = prev
      .then(work)
      .catch((err) => console.error('[telegram] dispatch failed', err))
      .then(() => { if (this.chains.get(chatId) === next) this.chains.delete(chatId); });
    this.chains.set(chatId, next);
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
    if (cmd === '/video') return [this.handleVideo(rest)];
    if (cmd === '/controlnode') return [this.handleControlNode(rest)];
    return [{ text: HELP_TEXT }];
  }

  /**
   * Queues the job and returns immediately — a clip is minutes of GPU time, far past any sane reply
   * window. The mp4 itself is sent by `Alerts` when the job completes.
   */
  private handleVideo(rest: string): OutgoingMessage {
    const prompt = rest.trim();
    if (!prompt) return { text: 'usage: /video <prompt>' };
    if (!this.deps.enqueueVideo) return { text: 'Video generation is not configured on this hub.' };
    const payload = videoPayloadFrom({ prompt });
    if (!payload) return { text: 'usage: /video <prompt>' };
    const job = this.deps.enqueueVideo(payload);
    return { text: `Queued video job #${job.id}: ${payload.prompt}` };
  }

  /**
   * Listing is harmless; switching is not — it moves the hub to another machine and takes this
   * process down with it — so a named node only produces the confirmation buttons, and the switch
   * itself runs from the callback.
   */
  private handleControlNode(rest: string): OutgoingMessage {
    const deps = this.deps.controlNodes;
    if (!deps) return { text: 'Control-node switching is not configured on this hub.' };
    const { current, candidates } = deps.list();
    const wanted = rest.trim();
    if (!wanted) {
      const lines = candidates.length
        ? candidates.map((c) => `${c.current ? '*' : '-'} ${c.name} (${c.status})`)
        : ['(no control-node candidates registered)'];
      return { text: [`Control node: ${current ?? 'unknown'}`, ...lines, '', 'Switch with /controlnode <name>'].join('\n') };
    }
    if (!candidates.some((c) => c.name === wanted)) {
      return { text: `${wanted} is not a control-node candidate.` };
    }
    const nonce = this.cnConfirmations.propose(`move the hub to ${wanted}`, async () => wanted).id;
    return {
      text: `Move the hub to ${wanted}? This stops the hub here once the new one is up.`,
      buttons: [[{ text: 'Confirm', data: `cn:go:${wanted}:${nonce}` }, { text: 'Cancel', data: 'cn:cancel' }]],
    };
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
    // Nothing awaits this chain, so its last link must not be able to reject: a `port.send` that
    // fails here (Telegram down) would otherwise surface as an unhandled rejection.
    const notify = (text: string): void => {
      port.send(ownerChatId, { text }).catch((err) => console.error('[telegram] /new follow-up send failed', err));
    };
    void service.runTurn(manifest.slug)
      .then((briefing) => notify(`First turn for ${briefing.slug} done: ${briefing.summary}`))
      .catch((err) => notify(`First turn failed: ${(err as Error).message}`));
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
    if (data === 'cn:cancel') return [{ text: 'Cancelled.' }];
    if (data.startsWith('cn:go:')) {
      // `cn:go:<node>:<nonce>`; the node name can't contain a colon, but splitting from the right
      // is what makes that a property of this format rather than an assumption about node names.
      const rest = data.slice('cn:go:'.length);
      const split = rest.lastIndexOf(':');
      const node = split > 0 ? rest.slice(0, split) : rest;
      const nonce = split > 0 ? rest.slice(split + 1) : '';
      if (!this.deps.controlNodes) return [{ text: 'Control-node switching is not configured on this hub.' }];
      // Spending the nonce is what makes this the one confirmation that counts: a second tap, or a
      // button older than the window, finds nothing left to spend.
      if (!this.cnConfirmations.cancel(nonce)) {
        return [{ text: `That confirmation has expired — run /controlnode ${node} again.` }];
      }
      try {
        const { switchedTo, hubUrl } = await this.deps.controlNodes.switchTo(node);
        return [{ text: `Hub moved to ${switchedTo}: ${hubUrl}` }];
      } catch (err) {
        return [{ text: `Switch to ${node} failed: ${(err as Error).message}` }];
      }
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
