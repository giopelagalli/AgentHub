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

  constructor(token: string) {
    this.bot = new Bot(token);

    this.bot.on('message:text', async (ctx) => {
      const message: IncomingMessage = {
        chatId: String(ctx.chat.id), text: ctx.message.text, messageId: ctx.message.message_id,
      };
      for (const handler of this.messageHandlers) await handler(message);
    });

    this.bot.on('callback_query:data', async (ctx) => {
      const callback: IncomingCallback = {
        chatId: String(ctx.callbackQuery.from.id), data: ctx.callbackQuery.data, callbackId: ctx.callbackQuery.id,
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
      this.bot.start({ drop_pending_updates: true, onStart: () => resolve() }).catch(reject);
    });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }
}
