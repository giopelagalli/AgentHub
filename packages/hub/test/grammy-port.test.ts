import { describe, it, expect } from 'vitest';
import type { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { GrammyPort } from '../src/telegram/grammy-port.js';
import type { IncomingCallback, IncomingMessage } from '../src/telegram/port.js';

/**
 * Drives `GrammyPort` by handing grammY updates straight to its bot — no token is ever used and no
 * request leaves the process, because nothing here calls the Telegram API. What matters is the
 * mapping from an update to the port's plain types, and in particular that both kinds of update
 * report the same identity: the *sender's* user id, which is what `CommandRouter` allowlists.
 */
// Only `id`/`is_bot`/`first_name` are ever read here; the rest of `UserFromGetMe` is capability
// flags grammY never consults on this path, so the fixture is cast rather than spelled out in full.
const BOT_INFO = {
  id: 1, is_bot: true, first_name: 'Test', username: 'testbot',
} as unknown as UserFromGetMe;

const OWNER_USER_ID = 4242;
const GROUP_CHAT_ID = -100777;

function port(): { port: GrammyPort; bot: Bot } {
  const p = new GrammyPort('123:fake-token');
  const bot = (p as unknown as { bot: Bot }).bot;
  bot.botInfo = BOT_INFO;
  return { port: p, bot };
}

const user = (id: number) => ({ id, is_bot: false, first_name: 'Someone' });

function messageUpdate(fromId: number, chatId: number, text: string): Update {
  return {
    update_id: 1,
    message: {
      message_id: 7, date: 0, text,
      from: user(fromId),
      chat: { id: chatId, type: chatId < 0 ? 'group' : 'private', ...(chatId < 0 ? { title: 'g' } : { first_name: 'Someone' }) },
    },
  } as Update;
}

function callbackUpdate(fromId: number, chatId: number, data: string): Update {
  return {
    update_id: 2,
    callback_query: {
      id: 'cb1', chat_instance: 'ci', data,
      from: user(fromId),
      message: {
        message_id: 8, date: 0, text: 'x',
        from: { ...BOT_INFO, is_bot: true },
        chat: { id: chatId, type: chatId < 0 ? 'group' : 'private', ...(chatId < 0 ? { title: 'g' } : { first_name: 'Someone' }) },
      },
    },
  } as Update;
}

describe('GrammyPort update mapping', () => {
  it('reports the sender user id for a message, not the chat it arrived in', async () => {
    const { port: p, bot } = port();
    const seen: IncomingMessage[] = [];
    p.onMessage(async (m) => { seen.push(m); });

    await bot.handleUpdate(messageUpdate(OWNER_USER_ID, GROUP_CHAT_ID, '/help'));

    expect(seen).toEqual([{ chatId: String(OWNER_USER_ID), text: '/help', messageId: 7 }]);
  });

  it('reports the sender user id for a callback, so both update kinds allowlist on one value', async () => {
    const { port: p, bot } = port();
    const messages: IncomingMessage[] = [];
    const callbacks: IncomingCallback[] = [];
    p.onMessage(async (m) => { messages.push(m); });
    p.onCallback(async (c) => { callbacks.push(c); });

    // Same person, same private chat: the message and the button press must key on the same id.
    await bot.handleUpdate(messageUpdate(OWNER_USER_ID, OWNER_USER_ID, '/projects'));
    await bot.handleUpdate(callbackUpdate(OWNER_USER_ID, OWNER_USER_ID, 'proj:pause:demo'));
    // A stranger pressing a button someone forwarded them reports *their* id, so the router drops it.
    await bot.handleUpdate(callbackUpdate(99, OWNER_USER_ID, 'proj:pause:demo'));

    expect(callbacks.map((c) => c.chatId)).toEqual([String(OWNER_USER_ID), '99']);
    expect(callbacks[0]!.chatId).toBe(messages[0]!.chatId);
    expect(callbacks[0]!.callbackId).toBe('cb1');
  });
});
