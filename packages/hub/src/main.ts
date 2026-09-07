import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHub, type AssistantOptions } from './server.js';
import { GrammyPort } from './telegram/grammy-port.js';

// Backstop, not a strategy: every fire-and-forget path is meant to catch its own failures, but the
// hub is a long-running personal service — one missed `.catch` should cost a log line, not the
// process (Node's default for an unhandled rejection is to exit).
process.on('unhandledRejection', (err) => console.error('[hub] unhandled rejection', err));

const uiDist = fileURLToPath(new URL('../../ui/dist', import.meta.url));
if (!existsSync(uiDist)) console.log(`[hub] no UI build at ${uiDist}; serving API only`);

const token = process.env.TELEGRAM_BOT_TOKEN;
const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID;
const checkinTimes = (process.env.CHECKIN_TIMES ?? '').split(',').map((t) => t.trim()).filter(Boolean);

const assistant: AssistantOptions = {
  memoryRoot: process.env.MEMORY_ROOT ?? 'data/memory',
  schedule: {
    ...(process.env.BRIEFING_TIME ? { briefingTime: process.env.BRIEFING_TIME } : {}),
    ...(checkinTimes.length ? { checkinTimes } : {}),
  },
};
// The bot needs both halves: a token to talk to Telegram and the owner's chat id to know whose
// messages count. With either missing the hub still runs — assistant over HTTP, no Telegram.
if (token && ownerChatId) assistant.telegram = { port: new GrammyPort(token), ownerChatId };
else console.log('[hub] TELEGRAM_BOT_TOKEN/TELEGRAM_OWNER_CHAT_ID not set; telegram bot disabled');

const hub = createHub({
  dbPath: process.env.HUB_DB ?? 'data/hub.db',
  projectsRoot: process.env.PROJECTS_ROOT ?? 'data/projects',
  uiDist,
  assistant,
});
const port = Number(process.env.PORT ?? 4000);
hub.app.listen({ port, host: '0.0.0.0' }).then((addr) => console.log(`[hub] listening at ${addr}`)).catch((err) => {
  console.error('[hub] failed to start:', err);
  process.exit(1);
});
const FORCE_EXIT_MS = 10_000;

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    // Safety net, not the happy path: unref'd so a clean, timely stop() lets the process exit on its
    // own; if stop() hangs (a turn that won't unwind), this fires and forces the exit anyway.
    const forceExit = setTimeout(() => {
      console.error(`[hub] stop() did not finish within ${FORCE_EXIT_MS}ms; forcing exit`);
      process.exit(1);
    }, FORCE_EXIT_MS);
    forceExit.unref();
    hub.stop().then(() => process.exit(0)).catch((err) => {
      console.error('[hub] stop() failed:', err);
      process.exit(1);
    });
  });
}
