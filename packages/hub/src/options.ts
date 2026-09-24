import { join } from 'node:path';
import type { AuthOptions } from './auth.js';
import { SEARCH_PROVIDERS, type ExternalOptions, type SearchProvider } from './external/index.js';
import type { AssistantOptions, HubOptions } from './server.js';

/** Where the hub listens when `HUB_HOST` says nothing. */
export const DEFAULT_HUB_HOST = '0.0.0.0';
export const DEFAULT_PORT = 4000;

/** The pieces `main.ts` needs that aren't `HubOptions`: the socket, and the Telegram credentials. */
export interface HubEnvConfig {
  options: HubOptions;
  port: number;
  host: string;
  /** Present only when both halves are set and the chat id is a user id; `main.ts` builds the port. */
  telegram: { token: string; ownerChatId: string } | null;
}

/**
 * `TRUST_PROXY=1` trusts any proxy, which is only right when nothing but the DO droplet's Caddy can
 * reach this port; anything else is taken as the proxy's address (an IP, a CIDR, or a
 * comma-separated list) and is the safer form. Unset, `X-Forwarded-*` headers are ignored.
 */
function parseTrustProxy(raw: string | undefined): boolean | string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (['1', 'true', 'yes'].includes(raw.toLowerCase())) return true;
  if (['0', 'false', 'no'].includes(raw.toLowerCase())) return false;
  return raw;
}

/**
 * The whole environment → `createHub` mapping, as a pure function of `env` so it can be tested
 * without starting a hub. `main.ts` is then just the process wiring around it.
 *
 * `DATA_ROOT` is the hub's own directory — the one a control-node switch copies — so everything the
 * hub writes has to live under it when it is set. The three roots the daemon passes explicitly
 * (`HUB_DB`, `PROJECTS_ROOT`, `MEMORY_ROOT`) already do; browser recordings are derived here so a
 * switched hub doesn't leave the owner's screenshot timelines behind on the old machine.
 */
export function optionsFromEnv(env: NodeJS.ProcessEnv, log: (line: string) => void = console.log): HubEnvConfig {
  const dataRoot = env.DATA_ROOT;
  const controlNodeName = env.CONTROL_NODE_NAME;
  if (!dataRoot) log('[hub] DATA_ROOT not set; control-node switching is disabled');

  const checkinTimes = (env.CHECKIN_TIMES ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  const assistant: AssistantOptions = {
    memoryRoot: env.MEMORY_ROOT ?? (dataRoot ? join(dataRoot, 'memory') : 'data/memory'),
    schedule: {
      ...(env.BRIEFING_TIME ? { briefingTime: env.BRIEFING_TIME } : {}),
      ...(checkinTimes.length ? { checkinTimes } : {}),
    },
  };

  // The bot needs both halves: a token to talk to Telegram and the owner's Telegram *user* id to
  // know whose messages count. With either missing the hub still runs — assistant over HTTP, no
  // Telegram. A negative id is a group/channel id, which the allowlist can never match (every
  // update reports the sender's user id), so it is rejected loudly rather than silently ignoring
  // the owner forever.
  const token = env.TELEGRAM_BOT_TOKEN;
  const ownerChatId = env.TELEGRAM_OWNER_CHAT_ID;
  let telegram: { token: string; ownerChatId: string } | null = null;
  if (token && ownerChatId && ownerChatId.startsWith('-')) {
    log(`[hub] TELEGRAM_OWNER_CHAT_ID=${ownerChatId} is a group id; it must be your own Telegram user id (see deploy/telegram.md) — telegram bot disabled`);
  } else if (token && ownerChatId) {
    telegram = { token, ownerChatId };
  } else {
    log('[hub] TELEGRAM_BOT_TOKEN/TELEGRAM_OWNER_CHAT_ID not set; telegram bot disabled');
  }

  // No password, no auth: the hub answers everyone, which is only safe on a machine nothing else
  // can reach. That is a deliberate local-dev mode, so it costs a log line rather than a refusal.
  const password = env.HUB_PASSWORD;
  const sessionSecret = env.HUB_SESSION_SECRET;
  const daemonToken = env.DAEMON_TOKEN;
  const trustProxy = parseTrustProxy(env.TRUST_PROXY);
  let auth: AuthOptions | undefined;
  if (password) {
    auth = {
      password,
      ...(sessionSecret ? { sessionSecret } : {}),
      ...(daemonToken ? { daemonToken } : {}),
      ...(trustProxy !== undefined ? { trustProxy } : {}),
    };
    if (!sessionSecret) log('[hub] HUB_SESSION_SECRET not set; sessions are signed with a random key and drop on every restart');
    if (!daemonToken) log('[hub] DAEMON_TOKEN not set; no daemon can register or claim jobs against this hub');
  } else {
    log('[hub] HUB_PASSWORD not set; auth is disabled and every route is open');
  }

  // The three sanctioned outbound tools (PRD §12). A key that isn't set removes its tool and costs
  // a single log line from `externalTools` — the hub still starts.
  const searchKey = env.SEARCH_API_KEY;
  const searchProvider = (env.SEARCH_PROVIDER ?? 'brave').toLowerCase();
  let search: { provider: SearchProvider; key: string } | undefined;
  if (searchKey && SEARCH_PROVIDERS.includes(searchProvider as SearchProvider)) {
    search = { provider: searchProvider as SearchProvider, key: searchKey };
  } else if (searchKey) {
    log(`[external] SEARCH_PROVIDER=${searchProvider} is not one of ${SEARCH_PROVIDERS.join(', ')}`);
  }
  const external: ExternalOptions = {
    ...(env.XAI_API_KEY ? { xaiKey: env.XAI_API_KEY } : {}),
    ...(env.GEMINI_API_KEY ? { geminiKey: env.GEMINI_API_KEY } : {}),
    ...(env.X_API_KEY ? { xPostKey: env.X_API_KEY } : {}),
    ...(search ? { search } : {}),
    ...(env.XAI_MODEL || env.GEMINI_MODEL
      ? { models: {
          ...(env.XAI_MODEL ? { xai: env.XAI_MODEL } : {}),
          ...(env.GEMINI_MODEL ? { gemini: env.GEMINI_MODEL } : {}),
        } }
      : {}),
  };

  // No local GPU? Each configured cloud provider gives the hub an always-online node for the
  // orchestrator and worker tiers. The Anthropic SDK resolves its own credentials (ANTHROPIC_API_KEY,
  // or an `ant auth login` profile); Fireworks' key is read from the environment per request by the
  // gateway. Neither secret is read here — only the names and the model overrides.
  const anthropicCloud = env.CLOUD_ANTHROPIC === '1'
    ? {
        ...(env.CLOUD_ORCHESTRATOR_MODEL ? { orchestratorModel: env.CLOUD_ORCHESTRATOR_MODEL } : {}),
        ...(env.CLOUD_WORKER_MODEL ? { workerModel: env.CLOUD_WORKER_MODEL } : {}),
      }
    : undefined;
  // Fireworks needs a key to be reachable at all, so having one *is* the switch; CLOUD_FIREWORKS=1
  // registers the node anyway (the gateway then parks it with one log line until the key shows up).
  const fireworksCloud = env.FIREWORKS_API_KEY || env.CLOUD_FIREWORKS === '1'
    ? {
        ...(env.FIREWORKS_ORCHESTRATOR_MODEL ? { orchestratorModel: env.FIREWORKS_ORCHESTRATOR_MODEL } : {}),
        ...(env.FIREWORKS_WORKER_MODEL ? { workerModel: env.FIREWORKS_WORKER_MODEL } : {}),
        ...(env.FIREWORKS_HARD_MODELS === '1' ? { hardModels: true } : {}),
      }
    : undefined;
  const cloud = anthropicCloud || fireworksCloud
    ? {
        ...(anthropicCloud ? { anthropic: anthropicCloud } : {}),
        ...(fireworksCloud ? { fireworks: fireworksCloud } : {}),
      }
    : undefined;

  // The one credential for imported projects: cloning a private repository and pushing the agents'
  // branch back. Only its presence is ever reported (`GET /api/github/status`); the value is read
  // here and handed to the git and REST calls, and is never logged or sent to the UI.
  const githubToken = env.GITHUB_TOKEN;
  if (!githubToken) log('[hub] GITHUB_TOKEN not set; only public repositories can be imported, and nothing can be pushed back');

  // A turn is the hub's most expensive unit, so the scheduler has a kill switch and a hub-wide cap.
  // `AUTO_TURNS=0` is the only value that disables it; a bad cap is dropped with one log line.
  const autoTurns = env.AUTO_TURNS === '0' ? false : undefined;
  let maxTurnsPerDay: number | undefined;
  if (env.MAX_TURNS_PER_DAY !== undefined) {
    const n = Number(env.MAX_TURNS_PER_DAY);
    if (Number.isInteger(n) && n >= 1) maxTurnsPerDay = n;
    else log(`[hub] MAX_TURNS_PER_DAY=${env.MAX_TURNS_PER_DAY} is not a whole number of at least 1; ignored`);
  }
  // The cloud's own kill switch: once the trailing 24h costs this much, cloud endpoints go out of
  // rotation and local serving carries on. Decimals allowed — a cap is dollars, not turns. `0` is a
  // real setting, not a missing one: it means spend nothing in the cloud at all. A bad value must
  // never read as "no cap", so it is dropped loudly rather than failing open.
  let maxCloudUsdPerDay: number | undefined;
  if (env.MAX_CLOUD_USD_PER_DAY !== undefined && env.MAX_CLOUD_USD_PER_DAY !== '') {
    const n = Number(env.MAX_CLOUD_USD_PER_DAY);
    if (Number.isFinite(n) && n >= 0) maxCloudUsdPerDay = n;
    else log(`[hub] MAX_CLOUD_USD_PER_DAY=${env.MAX_CLOUD_USD_PER_DAY} is not a number of dollars of at least 0; ignored`);
  }
  // Local models are slower per step than the default assumes; a bad value is dropped the same way.
  let turnTimeoutMs: number | undefined;
  if (env.TURN_TIMEOUT_MINUTES !== undefined) {
    const n = Number(env.TURN_TIMEOUT_MINUTES);
    if (Number.isInteger(n) && n >= 1) turnTimeoutMs = n * 60_000;
    else log(`[hub] TURN_TIMEOUT_MINUTES=${env.TURN_TIMEOUT_MINUTES} is not a whole number of at least 1; ignored`);
  }

  const options: HubOptions = {
    dbPath: env.HUB_DB ?? (dataRoot ? join(dataRoot, 'hub.db') : 'data/hub.db'),
    projectsRoot: env.PROJECTS_ROOT ?? (dataRoot ? join(dataRoot, 'projects') : 'data/projects'),
    assistant,
    external,
    ...(dataRoot ? { browser: { recordingsRoot: join(dataRoot, 'media', 'browser') } } : {}),
    ...(auth ? { auth } : {}),
    ...(dataRoot ? { controlNode: { dataRoot, ...(controlNodeName ? { name: controlNodeName } : {}) } } : {}),
    ...(cloud ? { cloud } : {}),
    ...(githubToken ? { github: { token: githubToken } } : {}),
    ...(autoTurns !== undefined ? { autoTurns } : {}),
    ...(maxTurnsPerDay !== undefined ? { maxTurnsPerDay } : {}),
    ...(maxCloudUsdPerDay !== undefined ? { maxCloudUsdPerDay } : {}),
    ...(turnTimeoutMs !== undefined ? { turnTimeoutMs } : {}),
  };

  return {
    options,
    port: Number(env.PORT ?? DEFAULT_PORT),
    // The tailnet address on a deployed control node, so the hub is not on every interface the
    // machine happens to have; `0.0.0.0` stays the default for local dev.
    host: env.HUB_HOST || DEFAULT_HUB_HOST,
    telegram,
  };
}
