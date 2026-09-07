import { Bot, InlineKeyboard, InputFile } from 'grammy';
import type { CallbackHandler, IncomingCallback, IncomingMessage, MessageHandler, OutgoingMessage, TelegramPort } from './port.js';
import { splitMessage } from './format.js';

const MAX_MESSAGE_CHARS = 3500;

/**
 * The real `TelegramPort`: long polling via grammY, everything mapped to/from the port's plain
 * types. Owner filtering is `CommandRouter`'s job, not this transport's — it forwards every update
 * it receives.
 */
export class GrammyPort implements TelegramPort {
  private bot: Bot;
  private messageHandlers: MessageHandler[] = [];
  private callbackHandlers: CallbackHandler[] = [];
  // Flips false if polling ever dies (bot.start()'s promise rejecting after onStart already
  // resolved it, or bot.catch failing to recover) — see isRunning().
  private alive = false;

  constructor(token: string) {
    this.bot = new Bot(token);

    // grammY's default error handler logs and rethrows, which stops polling — a single handler
    // throwing (a bad command, a downstream service down) would otherwise take Telegram out
    // permanently and silently, since start() has already resolved by the time that happens.
    this.bot.catch((err) => console.error('[telegram] handler error', err.error ?? err));

    // Both paths report the *sender's* user id, never the chat's. `CommandRouter` compares this
    // against one allowlisted id and also sends replies back to it, and only the user id is the
    // same value on both kinds of update — a callback query carries no chat of its own, so keying
    // messages on `chat.id` would have left the two halves comparing different numbers. In the
    // owner's private chat with the bot, which is the only place this bot is meant to be used, the
    // user id and the chat id are the same number anyway, so replies land where they should.
    this.bot.on('message:text', async (ctx) => {
      if (!ctx.from) return;
      const message: IncomingMessage = {
        chatId: String(ctx.from.id), text: ctx.message.text, messageId: ctx.message.message_id,
      };
      for (const handler of this.messageHandlers) await handler(message);
    });

    this.bot.on('callback_query:data', async (ctx) => {
      if (!ctx.from) return;
      const callback: IncomingCallback = {
        chatId: String(ctx.from.id), data: ctx.callbackQuery.data, callbackId: ctx.callbackQuery.id,
      };
      for (const handler of this.callbackHandlers) await handler(callback);
    });
  }

  async send(chatId: string, msg: OutgoingMessage): Promise<void> {
    const parts = splitMessage(msg.text, MAX_MESSAGE_CHARS);
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      await this.bot.api.sendMessage(chatId, parts[i]!, {
        ...(msg.parseMode ? { parse_mode: msg.parseMode } : {}),
        ...(isLast && msg.buttons?.length
          ? { reply_markup: new InlineKeyboard(msg.buttons.map((row) => row.map((b) => InlineKeyboard.text(b.text, b.data)))) }
          : {}),
      });
    }
    if (msg.voice) await this.bot.api.sendVoice(chatId, new InputFile(msg.voice));
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onCallback(handler: CallbackHandler): void {
    this.callbackHandlers.push(handler);
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    await this.bot.api.answerCallbackQuery(callbackId, text ? { text } : undefined);
  }

  /** Resolves once long polling has actually started, not when it stops (which is what `bot.start()`'s own promise waits for). */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const run = this.bot.start({ drop_pending_updates: true, onStart: () => { this.alive = true; resolve(); } });
      // The promise above only settles once polling *stops* — after onStart it's a long-running
      // tail, not a rejection this caller should await. Log it here so a later failure isn't
      // swallowed, and clear `alive` so isRunning() reflects reality.
      run.then(() => { this.alive = false; })
        .catch((err) => { this.alive = false; console.error('[telegram] polling stopped', err); reject(err); });
    });
  }

  /** Whether long polling is currently believed to be running; flips false once `start()`'s underlying promise settles. */
  isRunning(): boolean {
    return this.alive;
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }
}
