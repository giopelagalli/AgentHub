import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AuthOptions } from './auth.js';
import { SEARCH_PROVIDERS, type ExternalOptions, type SearchProvider } from './external/index.js';
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
// The bot needs both halves: a token to talk to Telegram and the owner's Telegram *user* id to know
// whose messages count. With either missing the hub still runs — assistant over HTTP, no Telegram.
// A negative id is a group/channel id, which this allowlist can never match (every update reports
// the sender's user id), so it is rejected loudly rather than silently ignoring the owner forever.
if (token && ownerChatId && ownerChatId.startsWith('-')) {
  console.error(`[hub] TELEGRAM_OWNER_CHAT_ID=${ownerChatId} is a group id; it must be your own Telegram user id (see deploy/telegram.md) — telegram bot disabled`);
} else if (token && ownerChatId) {
  assistant.telegram = { port: new GrammyPort(token), ownerChatId };
} else {
  console.log('[hub] TELEGRAM_BOT_TOKEN/TELEGRAM_OWNER_CHAT_ID not set; telegram bot disabled');
}

// No password, no auth: the hub answers everyone, which is only safe on a machine nothing else can
// reach. That is a deliberate local-dev mode, so it costs a log line rather than a refusal to start.
const password = process.env.HUB_PASSWORD;
const sessionSecret = process.env.HUB_SESSION_SECRET;
const daemonToken = process.env.DAEMON_TOKEN;
let auth: AuthOptions | undefined;
if (password) {
  auth = { password, ...(sessionSecret ? { sessionSecret } : {}), ...(daemonToken ? { daemonToken } : {}) };
  if (!sessionSecret) console.log('[hub] HUB_SESSION_SECRET not set; sessions are signed with a random key and drop on every restart');
  if (!daemonToken) console.log('[hub] DAEMON_TOKEN not set; no daemon can register or claim jobs against this hub');
} else {
  console.log('[hub] HUB_PASSWORD not set; auth is disabled and every route is open');
}

// The three sanctioned outbound tools (PRD §12). A key that isn't set removes its tool and costs a
// single log line from `externalTools` — the hub still starts.
const searchKey = process.env.SEARCH_API_KEY;
const searchProvider = (process.env.SEARCH_PROVIDER ?? 'brave').toLowerCase();
let search: { provider: SearchProvider; key: string } | undefined;
if (searchKey && SEARCH_PROVIDERS.includes(searchProvider as SearchProvider)) {
  search = { provider: searchProvider as SearchProvider, key: searchKey };
} else if (searchKey) {
  console.log(`[external] SEARCH_PROVIDER=${searchProvider} is not one of ${SEARCH_PROVIDERS.join(', ')}`);
}
const external: ExternalOptions = {
  ...(process.env.XAI_API_KEY ? { xaiKey: process.env.XAI_API_KEY } : {}),
  ...(process.env.GEMINI_API_KEY ? { geminiKey: process.env.GEMINI_API_KEY } : {}),
  ...(process.env.X_API_KEY ? { xPostKey: process.env.X_API_KEY } : {}),
  ...(search ? { search } : {}),
  ...(process.env.XAI_MODEL || process.env.GEMINI_MODEL
    ? { models: {
        ...(process.env.XAI_MODEL ? { xai: process.env.XAI_MODEL } : {}),
        ...(process.env.GEMINI_MODEL ? { gemini: process.env.GEMINI_MODEL } : {}),
      } }
    : {}),
};

// The control-node switch needs to know what to copy and who this node is; without `DATA_ROOT` the
// hub still runs, it just can't hand itself over (`/api/controlnode` answers 501).
const dataRoot = process.env.DATA_ROOT;
const controlNodeName = process.env.CONTROL_NODE_NAME;
if (!dataRoot) console.log('[hub] DATA_ROOT not set; control-node switching is disabled');

const hub = createHub({
  dbPath: process.env.HUB_DB ?? 'data/hub.db',
  projectsRoot: process.env.PROJECTS_ROOT ?? 'data/projects',
  uiDist,
  assistant,
  external,
  ...(auth ? { auth } : {}),
  ...(dataRoot ? { controlNode: { dataRoot, ...(controlNodeName ? { name: controlNodeName } : {}) } } : {}),
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
