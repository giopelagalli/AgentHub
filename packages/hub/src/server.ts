import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { AutoRun, BrowserRequesterKind, BrowserStatus, CloudProvider, HubState, Job, JobResult, JobSpec, JobType, MilestoneStatus, ModelCatalog, ModelPolicy, ModelPrice, NodeInfo, NodeRegistration, Priority, ProjectManifest, ServingEndpoint, TeamMember, TeamMemberView, TeamRoster, TeamSessionView, TeamStatus, Tier, TurnEvent, TurnRecord, UsageReport, VideoPayload } from '@agenthub/shared';
import { MILESTONE_STATUSES, PRIORITY_RANK, parseGithubSource, videoPayloadFrom } from '@agenthub/shared';
import { Auth, LoginThrottle, daemonRouteSubject, routeAccess, type AuthOptions, type NodeSubject } from './auth.js';
import { ControlSwitch, SwitchError, type SyncFn } from './control-switch.js';
import { openDb, type Db } from './db.js';
import {
  ADMIN_USER, EnrollmentTokens, NODE_NAME_RE, hashToken, hubUrlFrom, installCommand, newNodeToken,
} from './enrollment.js';
import { NodeRegistry } from './node-registry.js';
import { JobQueue } from './queue.js';
import { JobLogs } from './job-logs.js';
import { ModelGateway, isCloudEndpoint } from './gateway.js';
import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_ORCHESTRATOR_MODEL, DEFAULT_WORKER_MODEL, type AnthropicLike } from './providers/anthropic.js';
import {
  DEFAULT_FIREWORKS_ORCHESTRATOR_MODEL, DEFAULT_FIREWORKS_WORKER_MODEL,
  FIREWORKS_API_KEY_ENV, FIREWORKS_BASE_URL, fireworksModels, priceFor,
} from './providers/fireworks.js';
import { UsageStore } from './usage.js';
import { ResourceManager, sqliteSlotStore, VideoSlotBusyError } from './resources.js';
import { AgentRuntime } from './agents.js';
import { AgentLoop } from './agents/loop.js';
import { Transcript, type SessionRecord } from './agents/transcript.js';
import { ProjectService, TurnRefusedError, type StopOptions } from './projects/service.js';
import { MasterOrchestrator } from './projects/master.js';
import { ProjectChat, resolveWho } from './projects/chat.js';
import { Github, GithubError, PatCredentials, validBranch, type GithubOptions } from './projects/github.js';
import type { ProjectBundle } from './projects/bundle.js';
import { auditPrd, isPrdScaffold, PrdDrafter } from './projects/prd.js';
import { currentMilestoneId, moveMilestone, patchMilestone } from './projects/roadmap.js';
import { DOC_SLUG_RE, InvalidSlugError, SLUG_RE, type Briefing } from './projects/schema.js';
import { LeaseManager, type Requester } from './browser/lease.js';
import { BrowserError, BrowserProxy, BROWSER_OPS, type BrowserOp } from './browser/proxy.js';
import { LEASE_ID_RE, Recorder } from './browser/recorder.js';
import { Assistant } from './assistant/assistant.js';
import { ConfirmationGate } from './assistant/confirm.js';
import { MemoryStore } from './assistant/memory.js';
import { Planner, type PlannerList } from './assistant/planner.js';
import { assistantTools } from './assistant/tools.js';
import { externalTools, ToolAudit, AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT, type ExternalOptions } from './external/index.js';
import { Alerts, TELEGRAM_PROJECT, type AlertEvents, type VideoArtifact } from './telegram/alerts.js';
import type { TelegramPort } from './telegram/port.js';
import { CommandRouter } from './telegram/router.js';
import { Scheduler, SystemClock, type Clock } from './telegram/scheduler.js';
import { registerWs } from './ws.js';

/** Everything the assistant wiring builds, once `MemoryStore.open` has finished. */
export interface AssistantHandle {
  memory: MemoryStore;
  planner: Planner;
  gate: ConfirmationGate;
  assistant: Assistant;
  /** Telegram parts, present only when `assistant.telegram` was configured. */
  port: TelegramPort | null;
  router: CommandRouter | null;
  scheduler: Scheduler | null;
  alerts: Alerts | null;
}

export interface Hub {
  app: FastifyInstance; db: Db; registry: NodeRegistry; queue: JobQueue; gateway: ModelGateway;
  runtime: AgentRuntime; transcript: Transcript; usage: UsageStore; projects: ProjectService; master: MasterOrchestrator;
  leases: LeaseManager; browser: BrowserProxy; resources: ResourceManager;
  /** Resolves once the assistant is wired; rejects when no `assistant` option was given. */
  assistant(): Promise<AssistantHandle>;
  stop(opts?: StopOptions): Promise<void>;
}

const TIERS: Tier[] = ['orchestrator', 'worker', 'vision', 'video-gen'];
const JOB_TYPES: JobType[] = ['llm-session', 'video-gen', 'shell-task', 'browser-lease'];
const PRIORITIES: Priority[] = Object.keys(PRIORITY_RANK) as Priority[];
const PREFERENCES: ModelPolicy['prefer'][] = ['local', 'cloud', 'auto'];
const CLOUD_PROVIDERS: CloudProvider[] = ['anthropic', 'fireworks'];
const PLANNER_LISTS: PlannerList[] = ['goals', 'todo', 'backlog'];
const REQUESTER_KINDS: BrowserRequesterKind[] = ['owner', 'orchestrator', 'subagent'];
const DEFAULT_RECORDINGS_ROOT = 'data/media/browser';
const DEFAULT_MEMORY_ROOT = 'data/memory';
/** Cap on an uploaded clip. A 15s 1080p MiniMax-H3 render is a few tens of MB. */
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const DEFAULT_BRIEFING_TIME = '08:00';
/** How long the answered `/api/controlnode` waits before this hub stops itself. */
const DEFAULT_SWITCH_STOP_DELAY_MS = 2000;
const DEFAULT_CHECKIN_TIMES = ['13:00', '18:00'];
/** How long in-flight project turns get to end on their own when a switch pauses the fleet. */
const QUIESCE_GRACE_MS = 1000;
/**
 * How fresh a member's unfinished session must be for them to read as `working`. A session that was
 * never ended — a hub killed mid-turn — would otherwise leave that employee busy forever.
 */
const TEAM_WORKING_WINDOW_MS = 30 * 60_000;
/** How much of a session's last message the roster carries; the UI shows it as a one-liner. */
const TEAM_LAST_MESSAGE_LIMIT = 200;
/** How many past orchestrator turns `/turns` replays. */
const TURNS_LIMIT = 20;
/** The trailing window the cloud spend cap — and every "today" cost the UI shows — is measured over. */
export const CLOUD_SPEND_WINDOW_MS = 24 * 60 * 60_000;
/** What a project's auto-run starts as when the owner enables it without saying more. */
const DEFAULT_AUTO_RUN = { everyMinutes: 60, maxTurnsPerDay: 6 };
/** Cap on the messages `/team/:id/activity` returns — the tail, which is what "doing now" means. */
const TEAM_ACTIVITY_MESSAGE_LIMIT = 200;
/**
 * How long a removed node's name stays refused (410) on register, after `DELETE /api/nodes/:name`.
 * Long enough that a removed daemon's own restart loop can't resurrect the node before it has
 * actually exited; short enough that a deliberate re-install minutes later just works.
 */
const REMOVED_LOCKOUT_MS = 60_000;

/**
 * The repository this hub is running out of — the hub runs from source (`tsx packages/hub/src`), so
 * the package's own location fixes it, the same way `main.ts` resolves the UI build. Both installer
 * routes read from here: the script on disk, and an archive of this very checkout.
 */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * What goes into the source tarball a joining node downloads instead of cloning the repo. Every
 * workspace the root `package.json` globs has to be in it or `npm ci` refuses the lockfile as out of
 * sync — which is why packages nothing on a node imports (`ui`, `mocks`) are listed too.
 */
const SOURCE_ARCHIVE_PATHS = [
  'package.json', 'package-lock.json', 'tsconfig.base.json',
  'packages/shared', 'packages/node-daemon', 'packages/mocks', 'packages/hub', 'packages/ui',
  'configs/README.md', 'deploy',
];
/** The whole repository is a few MB; execFile's 1MB default would truncate the archive into garbage. */
const SOURCE_ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;

/**
 * The owner's model choice, checked against the curated catalog: a model id the hub doesn't know is
 * a 400 rather than a policy that fails on the next turn, and a hard model the hub knows but refuses
 * is a distinct 400 naming the switch. The provider's own configured ids always pass — they are what
 * the tier uses today. Shared by the project's own model route and a team member's override, so the
 * same model is refused (or accepted) the same way from either one.
 */
function validateModelPolicy(body: Partial<ModelPolicy>, catalog: ModelCatalog): { policy: ModelPolicy } | { error: string } {
  if (!PREFERENCES.includes(body.prefer as ModelPolicy['prefer'])) {
    return { error: 'invalid prefer' };
  }
  if (body.provider !== undefined && !CLOUD_PROVIDERS.includes(body.provider)) {
    return { error: 'invalid provider' };
  }
  for (const field of ['orchestratorModel', 'workerModel'] as const) {
    const value = body[field];
    if (value !== undefined && (typeof value !== 'string' || !value)) {
      return { error: `invalid ${field}` };
    }
  }
  if (body.provider) {
    const row = catalog.cloud.find((c) => c.provider === body.provider);
    if (!row) return { error: `provider not configured: ${body.provider}` };
    for (const field of ['orchestratorModel', 'workerModel'] as const) {
      const value = body[field];
      if (value && (row.disabled ?? []).includes(value)) {
        return { error: `model switched off: ${value} (set FIREWORKS_HARD_MODELS=1)` };
      }
    }
    const known = new Set([...row.models, row.configured.orchestrator, row.configured.worker]);
    for (const field of ['orchestratorModel', 'workerModel'] as const) {
      const value = body[field];
      if (value && !known.has(value)) return { error: `unknown model: ${value}` };
    }
  } else if (body.orchestratorModel || body.workerModel) {
    return { error: 'a model override needs a provider' };
  }
  return {
    policy: {
      prefer: body.prefer as ModelPolicy['prefer'],
      ...(body.provider ? { provider: body.provider } : {}),
      ...(body.orchestratorModel ? { orchestratorModel: body.orchestratorModel } : {}),
      ...(body.workerModel ? { workerModel: body.workerModel } : {}),
    },
  };
}

export interface AssistantOptions {
  /** Root of the git-versioned memory bundle (MEMORY.md, notes/, planner/). */
  memoryRoot: string;
  /** Telegram transport plus the one chat allowed to drive it; omitted, the bot never starts. */
  telegram?: { port: TelegramPort; ownerChatId: string };
  schedule?: { briefingTime?: string; checkinTimes?: string[]; tz?: string };
  /** Injected in tests so the scheduler and alert dedupe never wait on real time. */
  clock?: Clock;
}

export interface BrowserOptions {
  /** Lease lifetime; every action renews it. */
  ttlMs?: number;
  /** Where screenshot timelines land: `<root>/<leaseId>/`. */
  recordingsRoot?: string;
  /** Screencast poll interval; floored at 500ms (≤ 2 fps) by the proxy. */
  screencastIntervalMs?: number;
  /** Injected in tests so lease expiry can be driven without waiting on real time. */
  now?: () => number;
}

export interface HubOptions {
  dbPath?: string;
  staleMs?: number;
  sweepIntervalMs?: number;
  uiDist?: string;
  projectsRoot?: string;
  tickIntervalMs?: number;
  /** `false` never starts the turn scheduler (`AUTO_TURNS=0`); manual turns still run. */
  autoTurns?: boolean;
  /** The hub-wide cap on turns per trailing 24h (`MAX_TURNS_PER_DAY`); defaults to 24. */
  maxTurnsPerDay?: number;
  /**
   * Dollars of cloud spend allowed per trailing 24h (`MAX_CLOUD_USD_PER_DAY`). Once reached, the
   * gateway stops offering cloud endpoints until the window slides; local serving is unaffected.
   * Absent means no cap.
   */
  maxCloudUsdPerDay?: number;
  /** Aborts a turn that runs longer than this (`TURN_TIMEOUT_MINUTES`); defaults to 45 minutes. */
  turnTimeoutMs?: number;
  assistant?: AssistantOptions;
  browser?: BrowserOptions;
  /** Omitted, the hub is open — every route answers unauthenticated, as it did before Phase 6. */
  auth?: AuthOptions;
  /** Keys for the three sanctioned external tools; each one missing simply removes its tool. */
  external?: ExternalOptions;
  /**
   * How the hub reaches GitHub for imported projects. `token` is `GITHUB_TOKEN` from `hub.env` — the
   * one credential, never logged and never sent to the UI; only `GET /api/github/status` says
   * whether there is one. The rest are test seams (`cloneBase` points the clone at a bare repo on
   * disk; `fetch`/`apiBase` at a stubbed REST API), so production only ever reaches github.com.
   */
  github?: Omit<GithubOptions, 'credentials'> & { token?: string };
  /** Video slot knobs: how long a node is passed over after a failed swap, and the clock that times it. */
  video?: { cooldownMs?: number; now?: () => number };
  /**
   * Present when this hub runs on a control node, which is what enables `/api/controlnode` (PRD
   * §4.2). `dataRoot` is the directory holding everything the hub owns; `name` is the node this hub
   * is running on, so it can't be offered as its own switch target.
   */
  controlNode?: {
    dataRoot: string;
    name?: string;
    /** The rsync argv template (`{from}`, `{host}`, `{dataRoot}`). */
    rsync?: string[];
    /** Replaces rsync entirely; tests inject a local copy. */
    sync?: SyncFn;
    /** How long the answered switch waits before this hub stops itself. */
    stopDelayMs?: number;
  };
  /**
   * Serving that isn't a node: each provider present here registers a synthetic, always-online
   * `cloud-<provider>` node whose two tiers the hub answers itself, so the system runs with no local
   * GPU at all. Local nodes, when any are online, are still preferred (`ModelGateway.pick`) unless a
   * project's `modelPolicy` says otherwise.
   *
   * `anthropic` goes through the SDK (`client` is for tests; otherwise the SDK resolves its own
   * credentials). `fireworks` is OpenAI-compatible HTTP with a bearer read from `FIREWORKS_API_KEY`
   * at request time (`baseUrl` is for tests, which point it at a fake server).
   */
  cloud?: {
    anthropic?: {
      orchestratorModel?: string;
      workerModel?: string;
      maxStreams?: number;
      client?: AnthropicLike;
    };
    fireworks?: {
      orchestratorModel?: string;
      workerModel?: string;
      maxStreams?: number;
      baseUrl?: string;
      /** Enables the expensive tier (GLM 5.3, Kimi K3). */
      hardModels?: boolean;
    };
  };
}

/** The synthetic nodes' names — they are not machines, so nothing may claim jobs or a browser for them. */
export const CLOUD_NODE_NAME = 'cloud-anthropic';
export const CLOUD_FIREWORKS_NODE_NAME = 'cloud-fireworks';

export function createHub(opts: HubOptions = {}): Hub {
  const dbPath = opts.dbPath ?? ':memory:';
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  const registry = new NodeRegistry(db, { staleMs: opts.staleMs });
  const enrollmentTokens = new EnrollmentTokens(db);
  const queue = new JobQueue(db);
  const jobLogs = new JobLogs(db);
  // No serving process, no daemon, no heartbeat of its own: the cloud node exists only in the
  // registry, and `sweepAndRequeue` below keeps it online. It is deliberately given no `control`,
  // no `video` and no `browser` — none of those can be reached through an API key.
  const cloud = opts.cloud?.anthropic;
  const anthropic: AnthropicLike | undefined = cloud ? cloud.client ?? new Anthropic() : undefined;
  // Names the hub owns: a daemon may not register under one, and the sweep keeps them online.
  const cloudNodes: string[] = [];
  if (cloud) {
    cloudNodes.push(CLOUD_NODE_NAME);
    registry.register({
      name: CLOUD_NODE_NAME, arch: 'cloud',
      endpoints: [
        { tier: 'orchestrator', provider: 'anthropic', url: 'anthropic://', model: cloud.orchestratorModel ?? DEFAULT_ORCHESTRATOR_MODEL, maxStreams: cloud.maxStreams ?? 4 },
        { tier: 'worker', provider: 'anthropic', url: 'anthropic://', model: cloud.workerModel ?? DEFAULT_WORKER_MODEL, maxStreams: cloud.maxStreams ?? 8 },
      ],
    });
  }
  const fireworks = opts.cloud?.fireworks;
  const fireworksBase = fireworks?.baseUrl ?? FIREWORKS_BASE_URL;
  const fireworksModelSet = fireworks ? fireworksModels(fireworks.hardModels ?? false) : undefined;
  if (fireworks) {
    cloudNodes.push(CLOUD_FIREWORKS_NODE_NAME);
    registry.register({
      name: CLOUD_FIREWORKS_NODE_NAME, arch: 'cloud',
      endpoints: [
        { tier: 'orchestrator', provider: 'fireworks', url: fireworksBase, apiKeyEnv: FIREWORKS_API_KEY_ENV, model: fireworks.orchestratorModel ?? DEFAULT_FIREWORKS_ORCHESTRATOR_MODEL, maxStreams: fireworks.maxStreams ?? 4 },
        { tier: 'worker', provider: 'fireworks', url: fireworksBase, apiKeyEnv: FIREWORKS_API_KEY_ENV, model: fireworks.workerModel ?? DEFAULT_FIREWORKS_WORKER_MODEL, maxStreams: fireworks.maxStreams ?? 8 },
      ],
    });
  }
  // Names removed via DELETE /api/nodes/:name: register and heartbeat refuse them (410) for
  // REMOVED_LOCKOUT_MS, then forget them — a plain register after that re-creates the node fresh.
  const removed = new Map<string, number>();
  const isRemoved = (name: string | undefined): boolean => {
    if (!name) return false;
    const at = removed.get(name);
    if (at === undefined) return false;
    if (Date.now() - at >= REMOVED_LOCKOUT_MS) { removed.delete(name); return false; }
    return true;
  };
  const fireworksDisabled = new Set(fireworksModelSet?.disabled ?? []);
  // The cost ledger exists before the gateway, because the gateway's cloud cap reads from it.
  const usage = new UsageStore(db);
  const cloudCap = opts.maxCloudUsdPerDay;
  const cloudCapListeners: ((usd: number, cap: number) => void)[] = [];
  /** Whether the cap was already crossed last time we looked, so a crossing is announced once. */
  let cloudCapCrossed = false;
  const cloudAllowed = (): boolean => {
    if (cloudCap === undefined) return true;
    const spent = usage.cloudUsdSince(Date.now() - CLOUD_SPEND_WINDOW_MS);
    const reached = spent >= cloudCap;
    if (reached && !cloudCapCrossed) for (const listener of cloudCapListeners) listener(spent, cloudCap);
    cloudCapCrossed = reached;
    return !reached;
  };
  const gateway = new ModelGateway(registry, {
    ...(anthropic ? { anthropic } : {}),
    ...(fireworks
      ? { modelAllowed: (ep: ServingEndpoint, model: string) => ep.provider !== 'fireworks' || !fireworksDisabled.has(model) }
      : {}),
    ...(cloudCap !== undefined ? { cloudAllowed, cloudCapUsd: cloudCap } : {}),
  });
  const runtime = new AgentRuntime(db, gateway);
  const transcript = new Transcript(db);
  // A hub that died mid-turn never closed its orchestrator session: without this it stays open
  // forever, and `/turns` (and the roster's "working" status) would report a dead turn as running.
  transcript.endOpenSessions('orchestrator', 'aborted');
  // Every model call in the hub runs through this loop, so one hook fills the whole ledger. The
  // subject a run carries is `<slug>:<who>` for chats and the drafter; the ledger keeps the slug,
  // so a project's spend is one row group however it was spent.
  const loop = new AgentLoop({
    gateway, transcript,
    onUsage: (u) => usage.record({
      ...u.usage,
      subject: u.subject.split(':')[0],
      sessionId: u.sessionId,
      kind: u.kind,
      ...(u.memberId ? { memberId: u.memberId } : {}),
    }),
  });
  const browserNow = opts.browser?.now ? { now: opts.browser.now } : {};
  const leases = new LeaseManager({ ...(opts.browser?.ttlMs ? { ttlMs: opts.browser.ttlMs } : {}), ...browserNow });
  const recorder = new Recorder({ root: opts.browser?.recordingsRoot ?? DEFAULT_RECORDINGS_ROOT });
  const browser = new BrowserProxy({ registry, leases, recorder, ...browserNow });
  // The audit ledger and the confirmation gate exist before anything that can call out, so the one
  // external tool belt is built once and shared: the assistant gets all of it, project agents get
  // everything that is not outward (posting is the owner's own action, never a project's).
  const toolAudit = new ToolAudit(db);
  const gate = new ConfirmationGate();
  // The "disabled" lines are for the owner starting a real hub, which always passes an `external`
  // block (however empty); a hub constructed without one — every test — stays quiet.
  const external = externalTools({
    audit: toolAudit, gate,
    ...(opts.external ? { options: opts.external } : { log: () => {} }),
  });
  const projectExternal = external.filter((t) => !t.outward);
  // One GitHub client per hub: it holds the credential lookup and nothing else, so the token is read
  // in exactly one place and never travels further than a git environment or a REST header.
  const github = new Github({
    ...(opts.github ?? {}),
    ...(opts.github?.token ? { credentials: new PatCredentials(opts.github.token) } : {}),
  });
  const projects = new ProjectService({
    root: opts.projectsRoot ?? 'data/projects',
    loop, gateway, queue, registry, transcript, github, leases, browser, external: projectExternal,
    // `broadcast` isn't assigned until `registerWs` runs further down, but this only ever fires from
    // an orchestrator turn — always well after that — so the late-bound closure is safe.
    onBusy: (slug, who, busy) => broadcast({ type: 'project-busy', slug, who, busy }),
    onEvent: (slug, sessionId, event, at) => broadcast({ type: 'turn-event', slug, sessionId, at, event }),
    onTurnRefused: (slug, reason) => broadcast({ type: 'turn-refused', slug, reason }),
    ...(opts.tickIntervalMs ? { tickIntervalMs: opts.tickIntervalMs } : {}),
    ...(opts.autoTurns !== undefined ? { autoTurns: opts.autoTurns } : {}),
    ...(opts.maxTurnsPerDay !== undefined ? { maxTurnsPerDay: opts.maxTurnsPerDay } : {}),
    ...(opts.turnTimeoutMs !== undefined ? { turnTimeoutMs: opts.turnTimeoutMs } : {}),
  });
  const master = new MasterOrchestrator({ service: projects, loop });
  // One chat per hub; the bundle is resolved per message through the service's cache.
  const chat = new ProjectChat({ loop, transcript, bundleFor: (slug) => projects.get(slug) });
  // The PRD/roadmap drafter runs the same way: one per hub, bundles resolved per call.
  const drafter = new PrdDrafter({ loop, gateway, transcript, bundleFor: (slug) => projects.get(slug) });
  const resources = new ResourceManager({
    registry, gateway, store: sqliteSlotStore(db),
    ...(opts.auth?.daemonToken ? { daemonToken: opts.auth.daemonToken } : {}),
    ...(opts.video?.cooldownMs !== undefined ? { cooldownMs: opts.video.cooldownMs } : {}),
    ...(opts.video?.now ? { now: opts.video.now } : {}),
    // Same staleness window the registry itself uses, so `restore()`'s own staleness check agrees
    // with `NodeRegistry.sweep()`/`online()` without needing a sweep to have run first.
    ...(opts.staleMs !== undefined ? { staleMs: opts.staleMs } : {}),
  });
  // A hub that died mid-video comes back owing the node its serving: the slots it was holding are
  // read back here, and whatever the node's live profile turns out to be is reconciled on its next
  // registration or heartbeat.
  resources.restore((jobId) => {
    const job = queue.get(jobId);
    return job?.type === 'video-gen' && job.status === 'running';
  });
  // Only a hub told where its data root is can hand it over; without the option the switch routes
  // answer 501 and nothing else in the hub changes.
  /**
   * Everything that writes to the data root without an HTTP request behind it, stopped for the
   * switch window: the project ticker, the assistant's scheduled briefings, and the Telegram long
   * poll — that last one before the new hub starts, so the two never both consume the owner's
   * updates. `resumeWriters` puts them back on the paths where this hub keeps serving.
   */
  // Whether quiesceWriters actually stopped the port — a stop() call that itself failed left long
  // polling running, and resumeWriters must not start() a port that was never stopped.
  let portStoppedByQuiesce = false;
  const quiesceWriters = async (): Promise<void> => {
    await projects.stop({ graceMs: QUIESCE_GRACE_MS });
    const handle = await assistantReady?.catch(() => null);
    handle?.scheduler?.stop();
    if (handle?.port) {
      await handle.port.stop()
        .then(() => { portStoppedByQuiesce = true; })
        .catch((err: unknown) => app.log.error(`pausing telegram for the switch failed: ${(err as Error).message}`));
    }
  };
  const resumeWriters = (): void => {
    projects.start();
    void assistantReady?.then((handle) => {
      handle.scheduler?.start();
      if (!portStoppedByQuiesce) return;
      portStoppedByQuiesce = false;
      return handle.port?.start();
    }).catch((err: unknown) => app.log.error(`resuming after a failed switch: ${(err as Error).message}`));
  };
  const controlSwitch = opts.controlNode
    ? new ControlSwitch({
        db, registry, dataRoot: opts.controlNode.dataRoot,
        quiesce: quiesceWriters, resume: resumeWriters,
        ...(opts.controlNode.name ? { self: opts.controlNode.name } : {}),
        ...(opts.auth?.daemonToken ? { daemonToken: opts.auth.daemonToken } : {}),
        ...(opts.auth?.password ? { authConfigured: true } : {}),
        ...(opts.controlNode.sync ? { sync: opts.controlNode.sync } : {}),
        ...(opts.controlNode.rsync ? { rsyncCmd: opts.controlNode.rsync } : {}),
        // A clip in flight lives on a node's GPU and lands as an artifact on *this* hub's disk; a
        // switch mid-render would lose it, so the switch waits rather than racing the job.
        videoRunning: () => queue.list().some((j) => j.type === 'video-gen' && j.status === 'running'),
      })
    : null;
  // `trustProxy` off by default: `X-Forwarded-*` is attacker-controlled unless a proxy this hub
  // actually sits behind is the only thing that can reach it.
  const app = Fastify(opts.auth?.trustProxy !== undefined ? { trustProxy: opts.auth.trustProxy } : {});

  // Finished clips arrive as raw bytes on POST /api/jobs/:id/artifact; Fastify's 1MB default body
  // limit is per-parser, so this one carries its own.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_ARTIFACT_BYTES },
    (_req, body, done) => { done(null, body); });

  // Registered before any route or plugin so it also covers the static UI and the /ws upgrade —
  // @fastify/websocket runs the route's onRequest hooks, and a 401 sent here means the handshake
  // never completes. Without `auth` the hook does not exist at all and the hub stays open.
  const auth = opts.auth ? new Auth(opts.auth) : null;
  const loginThrottle = new LoginThrottle(opts.auth?.now);
  // Enrollment is guessable in exactly the way login is — a 32-hex token instead of a password — so
  // it gets the same per-client lockout, on its own counter: a machine fumbling its token must not
  // lock the owner out of the UI, or the reverse.
  const enrollThrottle = new LoginThrottle(opts.auth?.now);

  /** The node a `Bearer` names, when it is a per-node token rather than the shared daemon one. */
  const nodeByBearer = (authorization: string | undefined): NodeInfo | null => {
    if (!authorization?.startsWith('Bearer ')) return null;
    const token = authorization.slice('Bearer '.length);
    return token ? registry.byTokenHash(hashToken(token)) : null;
  };

  /**
   * Requests a per-node token got through `onRequest` on, still owing the second half of the check.
   * A WeakMap rather than a request decorator so the entry cannot outlive the request or need a
   * module augmentation to be typed.
   */
  const speakingFor = new WeakMap<FastifyRequest, NodeInfo>();

  /**
   * Whether the node holding the token is the node this request is about. Every daemon route names
   * its node somewhere (`auth.ts`'s `DAEMON_ROUTES`); `/api/jobs/:id/log` names none, so the job's
   * runner of record stands in — the same fencing `complete`, `fail` and `artifact` already apply.
   */
  const subjectIsHolder = (req: FastifyRequest, subject: NodeSubject, holder: NodeInfo): boolean => {
    if (subject.from === 'job') {
      const id = Number((req.params as Record<string, unknown>)[subject.key]);
      const job = Number.isInteger(id) ? queue.get(id) : null;
      return !!job && job.nodeId === holder.id;
    }
    const source = subject.from === 'param' ? req.params : subject.from === 'query' ? req.query : req.body;
    const named = (source as Record<string, unknown> | undefined)?.[subject.key];
    return typeof named === 'string' && named === holder.name;
  };

  if (auth) {
    app.addHook('onRequest', async (req, reply) => {
      // Two rejections that precede the policy: a path that is not valid percent-encoding, and one
      // that still carries traversal after decoding. Neither can name a legitimate route.
      const raw = req.url.split('?')[0]!;
      let pathname: string;
      try {
        pathname = decodeURIComponent(raw);
      } catch {
        return reply.code(400).send({ error: 'bad request' });
      }
      if (pathname.startsWith('//') || pathname.split('/').includes('..')) {
        return reply.code(400).send({ error: 'bad request' });
      }
      // Classified on the route the router matched, not on `req.url`: find-my-way percent-decodes
      // before matching, so `/%61pi/state` reaches `/api/state` while its raw path looks like
      // nothing at all. An unmatched request has no route and is denied.
      const route = req.routeOptions?.url;
      const access = routeAccess(req.method, route);
      if (access === 'none' || access === 'open') return;
      if (auth.ownerOk(req.headers.cookie)) return;
      if (access === 'daemon') {
        // The shared DAEMON_TOKEN stays the admin's break-glass: it speaks for every node, and for
        // the ones that registered before enrollment existed it is the only credential there is.
        if (auth.bearerOk(req.headers.authorization)) return;
        // A per-node token gets in here but is only half-checked: which node it may speak for
        // depends on the body, which Fastify has not parsed yet. The preHandler below finishes it.
        const holder = nodeByBearer(req.headers.authorization);
        if (holder) {
          speakingFor.set(req, holder);
          return;
        }
      }
      // A refused upgrade also has to close its connection by hand: @fastify/websocket has already
      // taken the socket off the HTTP server's hands, so nobody else ever will — it would linger
      // half-dead and hold `app.close()` open forever. Only the one route it owns, so an ordinary
      // request carrying an `Upgrade` header is not hung up on.
      if (route === '/ws' && req.headers.upgrade) reply.raw.on('finish', () => reply.raw.socket?.end());
      return reply.code(401).send({ error: 'unauthorized' });
    });

    // The second half of the per-node token check, here rather than in `onRequest` because it is the
    // first hook that runs with a parsed body. It fires only for a request a node token let through,
    // so nothing else pays for it: node A may heartbeat, register, claim and report as itself, and
    // is a plain 401 the moment it names node B.
    app.addHook('preHandler', async (req, reply) => {
      const holder = speakingFor.get(req);
      if (!holder) return;
      const subject = daemonRouteSubject(req.method, req.routeOptions?.url);
      if (!subject || !subjectIsHolder(req, subject, holder)) {
        console.warn(`[auth] node token for ${holder.name} refused on ${req.method} ${req.routeOptions?.url}`);
        return reply.code(401).send({ error: 'unauthorized' });
      }
    });
  }
  // Once a switch is under way this hub's data root is being copied elsewhere: anything that writes
  // now would land in a database the new hub will never see. Reads keep working (the UI stays up
  // until the process stops); every write, `POST /api/controlnode` included, answers 503 — so a
  // second switch request while one is running is refused here, before `ControlSwitch`'s own 409
  // ever sees it.
  if (controlSwitch) {
    app.addHook('onRequest', async (req, reply) => {
      if (!controlSwitch.switching || req.method === 'GET' || req.method === 'HEAD') return;
      const route = req.routeOptions?.url;
      if (route === '/api' || route?.startsWith('/api/')) {
        return reply.code(503).send({ error: 'control-node switch in progress' });
      }
      return;
    });
  }

  /** A cookie is only marked Secure when the request actually arrived over TLS, directly or via a proxy. */
  const isHttps = (req: FastifyRequest): boolean =>
    req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';

  if (opts.uiDist && existsSync(opts.uiDist)) {
    app.register(fastifyStatic, { root: opts.uiDist });
  }

  // `getState` is synchronous (the WS broadcast path), so the manifest list is cached and refreshed
  // whenever a project changes rather than read from disk per frame.
  let projectList: ProjectManifest[] = [];

  // `online()` and not `all()`: the proxy resolves the node it forwards to the same way, so a node
  // whose heartbeat went stale must disappear from the status too rather than be advertised as the
  // browser while every action against it 503s.
  const browserStatus = (): BrowserStatus => ({
    ...leases.status(),
    node: registry.online().find((n) => n.browser?.url)?.name ?? null,
  });

  const getState = (): HubState => {
    const nodes = registry.all();
    return {
      nodes,
      agents: runtime.listAgents(),
      jobs: queue.list(),
      streams: Object.fromEntries(TIERS.map((tier) => [tier, gateway.activeStreams(tier)])),
      projects: projectList,
      browser: browserStatus(),
    };
  };

  // In-flight busy agents, so a socket that connects mid-stream can be caught up.
  const busyAgents = new Set<number>();
  // Frames are only produced while somebody is watching the screening room, so the browser node is
  // left alone until the first `subscribe` and stops being polled after the last unsubscribe/close.
  const { broadcastState, broadcast, broadcastTo } = registerWs(app, getState, () => [...busyAgents], {
    onTopicCount: (topic, count) => {
      if (topic !== 'browser') return;
      if (count > 0) screencast.start(); else screencast.stop();
    },
  });
  const screencast = browser.screencast(opts.browser?.screencastIntervalMs);
  screencast.onFrame((frame) => broadcastTo('browser', { type: 'browser-frame', ...frame }));
  leases.onChange(() => broadcastState());

  // Refreshes read the db (via getState), so `stop()` waits for the in-flight ones before closing it.
  const refreshes = new Set<Promise<void>>();
  const refreshProjects = (): Promise<void> => {
    const refresh: Promise<void> = (async () => { projectList = await projects.list(); broadcastState(); })()
      .catch((err) => { app.log.error(`failed to refresh projects: ${(err as Error).message}`); })
      .finally(() => { refreshes.delete(refresh); });
    refreshes.add(refresh);
    return refresh;
  };
  // Scheduled turns change projects with no HTTP request behind them to trigger a broadcast.
  projects.onBriefing(() => { void refreshProjects(); });
  projects.start();
  void refreshProjects();

  /**
   * Resolves a `:slug` route param. A slug is a path segment, so a malformed one is a 400 and never
   * reaches the filesystem; an unknown project is a 404. Returns null once it has sent the reply.
   */
  const resolveProject = async (slug: string, reply: FastifyReply): Promise<ProjectBundle | null> => {
    try {
      return await projects.get(slug);
    } catch (err) {
      reply.code(err instanceof InvalidSlugError ? 400 : 404)
        .send({ error: err instanceof InvalidSlugError ? 'invalid slug' : 'unknown project' });
      return null;
    }
  };

  // The sweep is the only place a node is known to have just gone offline, so the alert hookup
  // hangs off it; briefings pass straight through to the service's own listeners, and a settled job
  // is announced by the two report routes below.
  const jobSettledListeners: ((job: Job) => void)[] = [];
  const emitJobSettled = (job: Job | null): void => {
    if (!job) return;
    for (const listener of jobSettledListeners) listener(job);
  };

  const nodeOfflineListeners: ((node: NodeInfo, requeued: number) => void)[] = [];
  const hubEvents: AlertEvents = {
    onNodeOffline: (cb) => { nodeOfflineListeners.push(cb); },
    onBriefing: (cb) => { projects.onBriefing(cb); },
    onJobSettled: (cb) => { jobSettledListeners.push(cb); },
    onAutoRunSuspended: (cb) => { projects.onAutoRunSuspended(cb); },
    onCloudCapReached: (cb) => { cloudCapListeners.push(cb); },
  };

  /**
   * Where a finished clip is stored (plan Global Constraints): `workspace/media/video/<jobId>.mp4`
   * in the requesting project's bundle, or `media/` under the memory root when the job names no
   * project — or names one that isn't a bundle, which is what `/video`'s `_telegram` does.
   */
  const videoArtifactPath = async (job: Job): Promise<string> => {
    if (job.project) {
      try {
        const bundle = await projects.get(job.project);
        return join(bundle.workspace, 'media', 'video', `${job.id}.mp4`);
      } catch { /* not a project bundle; fall through to the memory root */ }
    }
    return join(opts.assistant?.memoryRoot ?? DEFAULT_MEMORY_ROOT, 'media', `${job.id}.mp4`);
  };

  /** What the Telegram alert needs to decide between sending the clip and just naming its path. */
  const videoArtifactInfo = async (job: Job): Promise<VideoArtifact | null> => {
    const path = await videoArtifactPath(job);
    try {
      const { size } = await stat(path);
      return { path, size, read: () => readFile(path) };
    } catch {
      return null;
    }
  };

  /** Every path into a video job builds the spec here, so priority and tier can't drift apart. */
  const enqueueVideo = (payload: VideoPayload, project?: string): Job => {
    const job = queue.enqueue({
      type: 'video-gen', tier: 'video-gen', priority: 'batch', payload,
      ...(project ? { project } : {}),
    });
    broadcastState();
    return job;
  };

  /**
   * Gives back the node's serving after a video job settled. Called from every path a video job can
   * leave `running` by: the two report routes and the offline sweep.
   */
  const releaseVideoSlot = (job: Job | null, nodeName: string): void => {
    if (!job || job.type !== 'video-gen') return;
    void resources.release(nodeName, job.id)
      .catch((err) => app.log.error(`releasing the video slot on ${nodeName} failed: ${(err as Error).message}`));
  };

  const sweepAndRequeue = () => {
    // The cloud node has no daemon to heartbeat for it, so the hub does it here — every sweep, on
    // whichever path runs it — and the node is never swept offline.
    for (const name of cloudNodes) registry.heartbeat(name);
    for (const node of registry.sweep()) {
      // Read before requeueing: afterwards the jobs no longer name this node.
      for (const job of queue.list('running')) if (job.nodeId === node.id) releaseVideoSlot(job, node.name);
      const { requeued, failed } = queue.requeueForNode(node.id);
      if (requeued) app.log.info(`requeued ${requeued} jobs from offline node ${node.name}`);
      for (const jobId of failed) jobLogs.append(jobId, `[hub] max attempts exceeded after node ${node.name} went offline`);
      for (const listener of nodeOfflineListeners) listener(node, requeued);
    }
  };

  // The sweep writes (it requeues jobs), so it stays off for the switch window like every other
  // writer — the snapshot on its way to the other control node must not move under the copy.
  const sweeper = setInterval(() => {
    if (controlSwitch?.switching) return;
    sweepAndRequeue();
    leases.expire();
    broadcastState();
  }, opts.sweepIntervalMs ?? 5000);
  sweeper.unref();

  // --- auth ---------------------------------------------------------------------

  // Unauthenticated on purpose: a health probe that needs a session can't tell a down hub from a
  // logged-out one.
  app.get('/api/health', async () => ({ ok: true }));

  // The UI's boot check. The hook answers 401 for it when there is a session to be had and none was
  // sent; reaching the handler at all means the caller is the owner (or the hub is open).
  app.get('/api/me', async () => ({ owner: true }));

  if (auth) {
    // Guessing the password is the one attack a single-password hub is wide open to, so failures
    // are counted per client and a run of them shuts that client out for the window — the check
    // comes before the comparison, so a correct password during a lockout is refused too.
    app.post('/api/login', async (req, reply) => {
      const client = req.ip;
      if (loginThrottle.blocked(client)) {
        console.warn(`[auth] throttled login from ${client}`);
        return reply.code(429).send({ error: 'too many attempts' });
      }
      const body = req.body as Partial<{ password: string }> | undefined;
      if (!auth.passwordOk(body?.password)) {
        const count = loginThrottle.fail(client);
        console.warn(`[auth] failed login from ${client} (${count})`);
        return reply.code(401).send({ error: 'invalid password' });
      }
      loginThrottle.succeed(client);
      reply.header('set-cookie', auth.sessionCookie(isHttps(req)));
      return { owner: true };
    });

    app.post('/api/logout', async (req, reply) => {
      reply.header('set-cookie', auth.clearedCookie(isHttps(req)));
      return { ok: true };
    });
  }

  app.post('/api/nodes/register', async (req, reply) => {
    const name = (req.body as NodeRegistration)?.name;
    if (typeof name !== 'string' || !NODE_NAME_RE.test(name)) {
      return reply.code(400).send({ error: 'invalid node name' });
    }
    // The synthetic cloud nodes are owned by the hub; a daemon may not replace one of their rows.
    if (cloudNodes.includes(name)) {
      return reply.code(409).send({ error: 'reserved node name' });
    }
    // A name freed by a recent DELETE stays refused for REMOVED_LOCKOUT_MS — see `isRemoved`.
    if (isRemoved(name)) {
      return reply.code(410).send({ error: 'node removed' });
    }
    const result = registry.register(req.body as NodeRegistration);
    // A registration is also how a daemon comes back from its own restart, so the profile the node
    // is actually serving is re-checked against the slot the hub thinks it holds. Fire-and-forget:
    // `reconcile` never rejects, and a slow control server must not hold up the registration.
    void resources.reconcile(result.name, true);
    broadcastState();
    return result;
  });

  app.post('/api/nodes/:name/heartbeat', async (req, reply) => {
    const { name } = req.params as { name: string };
    if (isRemoved(name)) return reply.code(410).send({ error: 'node removed' });
    if (!registry.heartbeat(name)) return reply.code(404).send({ ok: false });
    // Only the first heartbeat per node does anything: it covers the hub having restarted under a
    // node that never re-registered.
    void resources.reconcile(name);
    broadcastState();
    return { ok: true };
  });

  /**
   * Mints the one-time token behind the Cluster page's *Add node* (PRD FR-D1). The owner's route:
   * the reply carries the plaintext token, which exists nowhere else — the hub keeps only its hash.
   * `command` is assembled here rather than in the UI so the hub, which knows how it is reached, is
   * the one that decides the URL the new machine will be told to call back on.
   */
  app.post('/api/nodes/enrollment-tokens', async (req, reply) => {
    const body = req.body as Partial<{ name: string }> | undefined;
    if (body?.name !== undefined && typeof body.name !== 'string') {
      return reply.code(400).send({ error: 'invalid name' });
    }
    const suggested = body?.name || undefined;
    const { token, expiresAt } = enrollmentTokens.mint(ADMIN_USER, suggested);
    const hubUrl = hubUrlFrom(req);
    return { token, expiresAt, command: installCommand(hubUrl, token) };
  });

  /**
   * The open route the installer calls with the token it was given (PRD FR-D1). It is the one place
   * an unauthenticated caller can create state, so: throttled per client exactly like login, the
   * token spent before anything else is decided, and the only name it gets to choose checked against
   * `NODE_NAME_RE` before it becomes a URL path segment.
   *
   * The plaintext node token is in this reply and nowhere else, ever again.
   */
  app.post('/api/nodes/enroll', async (req, reply) => {
    const client = req.ip;
    if (enrollThrottle.blocked(client)) {
      console.warn(`[enroll] throttled enrollment from ${client}`);
      return reply.code(429).send({ error: 'too many attempts' });
    }
    const body = req.body as Partial<{ token: string; name: string; arch: string; hardware: unknown }> | undefined;
    if (!body || typeof body.token !== 'string' || !body.token) {
      return reply.code(400).send({ error: 'invalid enrollment request' });
    }
    if (typeof body.name !== 'string' || !NODE_NAME_RE.test(body.name)) {
      return reply.code(400).send({ error: 'invalid node name' });
    }
    if (typeof body.arch !== 'string' || !body.arch) return reply.code(400).send({ error: 'invalid arch' });
    if (body.hardware !== undefined && (typeof body.hardware !== 'object' || body.hardware === null || Array.isArray(body.hardware))) {
      return reply.code(400).send({ error: 'invalid hardware' });
    }
    const { name, arch } = body;
    // Spent first, and spent whatever happens next: checking the name before the token would let an
    // unauthenticated caller map the fleet by watching which names answer 409.
    const minted = enrollmentTokens.consume(body.token);
    if (!minted) {
      const count = enrollThrottle.fail(client);
      console.warn(`[enroll] rejected enrollment token from ${client} (${count})`);
      return reply.code(401).send({ error: 'invalid or expired enrollment token' });
    }
    enrollThrottle.succeed(client);
    // The synthetic cloud nodes are the hub's own rows; handing one a bearer would let the holder
    // register a machine in their place.
    if (cloudNodes.includes(name)) return reply.code(409).send({ error: 'reserved node name' });
    const existing = registry.byName(name);
    // Taking over an existing row requires a token minted for this exact name — the owner
    // deliberately re-enrolling it — regardless of owner, and regardless of whether the row even
    // has a token_hash (a node registered under the shared DAEMON_TOKEN has none and is not fair
    // game either).
    if (existing && (minted.suggestedName !== name || existing.owner !== minted.createdBy)) {
      return reply.code(409).send({ error: 'name taken' });
    }
    // A node the same owner already has is a re-install: the row keeps everything it registered and
    // only its credential is replaced, so the old token stops working the moment the new one exists.
    const nodeToken = newNodeToken();
    registry.enroll({
      name, arch, owner: minted.createdBy, tokenHash: hashToken(nodeToken),
      ...(body.hardware ? { hardware: body.hardware as Record<string, unknown> } : {}),
    });
    // Enrolling is a deliberate act carrying a one-time token — far stronger evidence than the
    // register that the lockout exists to refuse — so re-adding a just-removed node works at once.
    removed.delete(name);
    broadcastState();
    return { name, nodeToken };
  });

  app.get('/api/nodes', async () => {
    sweepAndRequeue();
    return registry.all();
  });

  app.post('/api/nodes/:name/drain', async (req, reply) => {
    const { name } = req.params as { name: string };
    // The synthetic cloud nodes have no daemon to stop claiming or serving; draining one is meaningless.
    if (cloudNodes.includes(name)) return reply.code(409).send({ error: 'reserved node name' });
    const body = req.body as Partial<{ on: boolean }> | undefined;
    if (!body || typeof body.on !== 'boolean') return reply.code(400).send({ error: 'invalid drain request' });
    if (!registry.setDraining(name, body.on)) return reply.code(404).send({ error: 'unknown node' });
    broadcastState();
    return { ok: true };
  });

  app.delete('/api/nodes/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    if (cloudNodes.includes(name)) return reply.code(409).send({ error: 'reserved node name' });
    const node = registry.byName(name);
    if (!node) return reply.code(404).send({ error: 'unknown node' });
    // A forced removal (no drain first) must not orphan what the node was running: hand its jobs
    // back the same way the sweep does for a node that went offline.
    for (const job of queue.list('running')) if (job.nodeId === node.id) releaseVideoSlot(job, node.name);
    const { requeued, failed } = queue.requeueForNode(node.id);
    if (requeued) app.log.info(`requeued ${requeued} jobs from removed node ${name}`);
    for (const jobId of failed) jobLogs.append(jobId, `[hub] max attempts exceeded after node ${name} was removed`);
    // Deleting the row takes the node's token hash with it, which is the revocation: a removed
    // daemon still holding its bearer authenticates as nobody and cannot register itself back.
    registry.remove(name);
    removed.set(name, Date.now());
    broadcastState();
    return { ok: true };
  });

  // --- installer ----------------------------------------------------------------
  //
  // Both routes are outside `/api/`, so `routeAccess` classifies them `none` and they answer before
  // any login — which is the point: the machine running them has no credential yet beyond the
  // enrollment token in its command line. `/install.sh` carries no secrets and stays fully open;
  // the tarball is the hub's own source, so it checks that enrollment token (or a node/admin
  // bearer) itself, below — `routeAccess` still says `none`, since the check is a handler-local,
  // token-in-query concern rather than the shared `onRequest` policy.

  /** The installer itself, straight off this checkout. Written by hand, not generated. */
  app.get('/install.sh', async (_req, reply) => {
    try {
      const script = await readFile(join(repoRoot, 'deploy', 'install.sh'));
      return reply.type('text/x-shellscript').send(script);
    } catch {
      return reply.code(404).send({ error: 'installer not found' });
    }
  });

  /**
   * The hub's own source, so a node never needs repo access (PRD FR-D2). Built once on the first
   * request and kept: the contents are pinned to HEAD, so nothing short of a hub restart after a
   * deploy can change what it should contain. The HEAD sha is the ETag; no conditional handling is
   * wired up, because an installer that sends `If-None-Match` and gets a 304 has no tarball.
   */
  let sourceArchive: Promise<{ sha: string; body: Buffer }> | null = null;
  const buildSourceArchive = async (): Promise<{ sha: string; body: Buffer }> => {
    const run = promisify(execFile);
    const { stdout: head } = await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
    const { stdout } = await run('git', ['archive', '--format=tgz', 'HEAD', '--', ...SOURCE_ARCHIVE_PATHS],
      { cwd: repoRoot, encoding: 'buffer', maxBuffer: SOURCE_ARCHIVE_MAX_BYTES });
    return { sha: String(head).trim(), body: stdout as unknown as Buffer };
  };

  /**
   * The hub is about to be reachable by anyone, and this route hands out its source — so, unlike
   * `/install.sh`, it needs a credential, just not the owner's: an installer running it has none of
   * those yet. Any of an unused enrollment token (`?token=`, checked without spending it), an
   * existing node's own bearer (the same lookup the daemon auth above uses, so a revoked or removed
   * node's token fails), or the admin `DAEMON_TOKEN` will do.
   */
  app.get('/install/agenthub-src.tgz', async (req, reply) => {
    const { token } = req.query as { token?: string };
    const credentialOk = (!!token && enrollmentTokens.isValid(token))
      || nodeByBearer(req.headers.authorization) !== null
      || (auth?.bearerOk(req.headers.authorization) ?? false);
    if (!credentialOk) {
      return reply.code(401).send({ error: 'an enrollment token or a node token is required' });
    }
    sourceArchive ??= buildSourceArchive();
    try {
      const { sha, body } = await sourceArchive;
      return reply.type('application/gzip').header('etag', sha).send(body);
    } catch (err) {
      // A deployment that isn't a checkout has no source to serve, and a failed build must not
      // poison the cache — the next request tries again.
      sourceArchive = null;
      app.log.error(`source archive unavailable: ${(err as Error).message}`);
      return reply.code(404).send({ error: 'not a git checkout' });
    }
  });

  /** Every id's price, null where the hub has none — so the picker can say "price unknown". */
  const pricesFor = (provider: CloudProvider, models: string[]): Record<string, ModelPrice | null> =>
    Object.fromEntries(models.map((model) => [model, priceFor(provider, model)]));

  /**
   * Everything the owner can point a project at. The local half is whatever is serving right now;
   * the cloud half is per configured provider, and Fireworks' list is the curated, tiered one —
   * `disabled` names the hard models the hub knows but currently refuses, each with its price.
   */
  const modelCatalog = (): ModelCatalog => {
    const local: ModelCatalog['local'] = [];
    for (const node of registry.online()) {
      for (const ep of node.endpoints) {
        if (!isCloudEndpoint(ep)) local.push({ node: node.name, tier: ep.tier, model: ep.model });
      }
    }
    const cloudRows: ModelCatalog['cloud'] = [];
    if (cloud) {
      const configured = {
        orchestrator: cloud.orchestratorModel ?? DEFAULT_ORCHESTRATOR_MODEL,
        worker: cloud.workerModel ?? DEFAULT_WORKER_MODEL,
      };
      const models = [...new Set([configured.orchestrator, configured.worker])].sort();
      cloudRows.push({ provider: 'anthropic', models, prices: pricesFor('anthropic', models), configured });
    }
    if (fireworks && fireworksModelSet) {
      cloudRows.push({
        provider: 'fireworks',
        models: fireworksModelSet.enabled,
        disabled: fireworksModelSet.disabled,
        prices: pricesFor('fireworks', [...fireworksModelSet.enabled, ...fireworksModelSet.disabled]),
        configured: {
          orchestrator: fireworks.orchestratorModel ?? DEFAULT_FIREWORKS_ORCHESTRATOR_MODEL,
          worker: fireworks.workerModel ?? DEFAULT_FIREWORKS_WORKER_MODEL,
        },
      });
    }
    return { local, cloud: cloudRows };
  };

  app.get('/api/models', async () => {
    sweepAndRequeue();
    return modelCatalog();
  });

  /**
   * What the hub has spent: over the trailing 24h by default, or since `?since=<epoch ms>`, and
   * narrowed to one project with `?project=<slug>`. `cap` always reports the hub-wide cloud spend
   * over its own window, whatever `since` asks for — the cap is not a per-project number.
   */
  app.get('/api/usage/summary', async (req, reply) => {
    const { since: sinceRaw, project } = req.query as { since?: unknown; project?: unknown };
    // Fastify hands a repeated query parameter back as an array; neither the window nor the subject
    // can be one, so both are checked rather than passed on to the store.
    if (project !== undefined && typeof project !== 'string') return reply.code(400).send({ error: 'invalid project' });
    if (sinceRaw !== undefined && typeof sinceRaw !== 'string') return reply.code(400).send({ error: 'invalid since' });
    const now = Date.now();
    let since = now - CLOUD_SPEND_WINDOW_MS;
    if (sinceRaw !== undefined) {
      const parsed = Number(sinceRaw);
      if (!Number.isFinite(parsed) || parsed < 0) return reply.code(400).send({ error: 'invalid since' });
      since = parsed;
    }
    const report: UsageReport = {
      ...usage.summary({ since, ...(project ? { subject: project } : {}) }),
      cap: {
        maxCloudUsdPerDay: cloudCap ?? null,
        cloudUsdToday: usage.cloudUsdSince(now - CLOUD_SPEND_WINDOW_MS),
      },
    };
    return report;
  });

  app.get('/api/state', async () => {
    sweepAndRequeue();
    projectList = await projects.list();
    return getState();
  });

  app.post('/api/jobs', async (req, reply) => {
    const spec = req.body as Partial<JobSpec> | undefined;
    if (!spec || spec.type === undefined || spec.tier === undefined || spec.priority === undefined || spec.payload === undefined) {
      return reply.code(400).send({ error: 'invalid job spec' });
    }
    if (!JOB_TYPES.includes(spec.type) || !TIERS.includes(spec.tier) || !PRIORITIES.includes(spec.priority)) {
      return reply.code(400).send({ error: 'invalid job spec' });
    }
    const job = queue.enqueue(spec as JobSpec);
    broadcastState();
    return reply.code(201).send(job);
  });

  app.get('/api/jobs/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { afterSeq: afterSeqRaw } = req.query as { afterSeq?: string };
    let afterSeq: number | undefined;
    if (afterSeqRaw !== undefined) {
      afterSeq = Number(afterSeqRaw);
      if (!Number.isInteger(afterSeq) || afterSeq < 0) return reply.code(400).send({ error: 'invalid afterSeq' });
    }
    const job = queue.get(id);
    if (!job) return reply.code(404).send({ error: 'unknown job' });
    return { ...job, logs: jobLogs.list(id, afterSeq) };
  });

  app.post('/api/jobs/claim', async (req, reply) => {
    const body = req.body as Partial<{ node: string; types: JobType[] }> | undefined;
    if (!body || typeof body.node !== 'string' || !body.node || !Array.isArray(body.types)) {
      return reply.code(400).send({ error: 'invalid claim request' });
    }
    const { node, types } = body as { node: string; types: JobType[] };
    const info = registry.byName(node);
    if (!info) return reply.code(404).send({ error: 'unknown node' });
    // Draining: no new work, whatever's already running finishes on its own.
    if (info.draining) return reply.code(204).send();
    if (!types.every((t) => info.jobTypes.includes(t))) return reply.code(403).send({ error: 'node cannot run requested job types' });
    // Only a node with a local ComfyUI, and only one video job at a time on it: a claim is what
    // triggers the exclusivity swap, so swapping a node that cannot render would park its serving
    // for nothing, and claiming a second clip while the first runs would only cost the job an
    // attempt before being handed straight back.
    const takesVideo = info.video && !resources.busy(info.name) && !resources.cooling(info.name);
    const claimable = takesVideo ? types : types.filter((t) => t !== 'video-gen');
    if (!claimable.length) return reply.code(204).send();
    const job = queue.claim(claimable, info.id);
    if (!job) return reply.code(204).send();
    if (job.type === 'video-gen') {
      // The swap happens before the job is handed over (PRD §4.3): worker serving is parked and
      // drained, then the daemon switches to its video profile. If that fails the job goes back on
      // the queue rather than running against a GPU that is still serving.
      try {
        await resources.acquire(info.name, job.id);
      } catch (err) {
        jobLogs.append(job.id, `[hub] video slot unavailable on ${info.name}: ${(err as Error).message}`);
        // The node never saw the job, so the claim's attempt is handed back rather than spent —
        // three quick claims against a down control server would otherwise retire the job. A swap
        // that failed for an infrastructure reason (as opposed to the slot simply being taken) also
        // backs this node off video work for a while, so the retries don't spin.
        queue.unclaim(job.id, info.id);
        if (!(err instanceof VideoSlotBusyError)) resources.coolDown(info.name);
        broadcastState();
        return reply.code(err instanceof VideoSlotBusyError ? 204 : 503).send();
      }
      broadcastState();
    }
    return job;
  });

  app.post('/api/jobs/:id/log', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = req.body as Partial<{ line: string }> | undefined;
    if (!body || typeof body.line !== 'string') return reply.code(400).send({ error: 'invalid log request' });
    if (!queue.get(id)) return reply.code(404).send({ error: 'unknown job' });
    return jobLogs.append(id, body.line);
  });

  app.post('/api/jobs/:id/complete', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = req.body as Partial<{ result: JobResult; node: string }> | undefined;
    if (!body || (body.node !== undefined && typeof body.node !== 'string')) {
      return reply.code(400).send({ error: 'invalid complete request' });
    }
    const { result, node } = body;
    if (!queue.get(id)) return reply.code(404).send({ error: 'unknown job' });
    const info = node ? registry.byName(node) : null;
    if (!info) return reply.code(404).send({ error: 'unknown node' });
    if (!queue.complete(id, info.id, result)) return reply.code(409).send({ error: 'not the current runner' });
    const settled = queue.get(id);
    releaseVideoSlot(settled, info.name);
    emitJobSettled(settled);
    broadcastState();
    return settled;
  });

  app.post('/api/jobs/:id/fail', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = req.body as Partial<{ error: string; requeue: boolean; node: string }> | undefined;
    if (!body || typeof body.error !== 'string'
      || (body.node !== undefined && typeof body.node !== 'string')
      || (body.requeue !== undefined && typeof body.requeue !== 'boolean')) {
      return reply.code(400).send({ error: 'invalid fail request' });
    }
    const { error, requeue, node } = body;
    if (!queue.get(id)) return reply.code(404).send({ error: 'unknown job' });
    const info = node ? registry.byName(node) : null;
    if (!info) return reply.code(404).send({ error: 'unknown node' });
    if (!queue.fail(id, info.id, { requeue, error })) return reply.code(409).send({ error: 'not the current runner' });
    const settled = queue.get(id);
    releaseVideoSlot(settled, info.name);
    // A requeued job hasn't settled — it will be claimed again — so only a terminal failure is
    // announced.
    if (settled?.status === 'failed') emitJobSettled(settled);
    broadcastState();
    return settled;
  });

  /**
   * Where a daemon puts a finished clip. The hub usually runs on another machine, so the file the
   * executor wrote to the node's own disk is unreachable from here — the daemon uploads the bytes
   * and the hub stores them at the path the Global Constraints fix.
   */
  app.post('/api/jobs/:id/artifact', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const job = queue.get(id);
    if (!job) return reply.code(404).send({ error: 'unknown job' });
    if (job.type !== 'video-gen') return reply.code(400).send({ error: 'job type has no artifact' });
    // Only the node the job is running on may write its clip, and only while it is still the runner
    // of record: a late upload from a node whose job was requeued elsewhere would otherwise
    // overwrite the real runner's output.
    const { node } = req.query as { node?: unknown };
    // A repeated `?node=` arrives as an array; it names no single uploader, so it is a bad request
    // rather than a silent "not the current runner".
    if (node !== undefined && typeof node !== 'string') return reply.code(400).send({ error: 'invalid node' });
    const uploader = node ? registry.byName(node) : null;
    if (!uploader || job.status !== 'running' || job.nodeId !== uploader.id) {
      return reply.code(409).send({ error: 'not the current runner' });
    }
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: 'empty artifact' });
    const path = await videoArtifactPath(job);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    jobLogs.append(id, `[hub] stored ${body.length} bytes at ${path}`);
    return { path, bytes: body.length };
  });

  app.post('/api/video', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { project, ...rest } = body;
    if (project !== undefined && (typeof project !== 'string' || !SLUG_RE.test(project))) {
      return reply.code(400).send({ error: 'invalid project' });
    }
    const payload = videoPayloadFrom(rest);
    if (!payload) return reply.code(400).send({ error: 'invalid video payload' });
    const job = enqueueVideo(payload, project as string | undefined);
    return reply.code(201).send({ ...job, outputPath: await videoArtifactPath(job) });
  });

  app.post('/api/agents', async (req) => {
    const agent = runtime.createAgent(req.body as { name: string; tier: Tier; systemPrompt: string });
    broadcastState();
    return agent;
  });

  app.post('/api/agents/:id/messages', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { text } = req.body as { text: string };
    if (!runtime.getAgent(id)) return reply.code(404).send({ error: 'unknown agent' });
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const ac = new AbortController();
    reply.raw.on('close', () => ac.abort());
    broadcast({ type: 'agent-busy', agentId: id, busy: true });
    busyAgents.add(id);
    try {
      const full = await runtime.send(id, text, (token) => {
        reply.raw.write(`data: ${JSON.stringify({ token })}\n\n`);
      }, ac.signal);
      reply.raw.write(`data: ${JSON.stringify({ done: true, full })}\n\n`);
    } catch (err) {
      reply.raw.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
    } finally {
      busyAgents.delete(id);
      broadcast({ type: 'agent-busy', agentId: id, busy: false });
    }
    reply.raw.end();
    return reply;
  });

  // --- projects ---------------------------------------------------------------

  app.get('/api/projects', async () => projects.list());

  /** Whether a private repository can be imported at all. Never the token — only that there is one. */
  app.get('/api/github/status', async () => github.status());

  app.post('/api/projects', async (req, reply) => {
    const body = req.body as Partial<{ slug: string; title: string; intent: string; priority: Priority; idea: string; prd: string; source: { url?: unknown; branch?: unknown } }> | undefined;
    if (!body || typeof body.slug !== 'string' || !SLUG_RE.test(body.slug)
      || typeof body.title !== 'string' || !body.title
      || typeof body.intent !== 'string' || !body.intent
      || (body.priority !== undefined && !PRIORITIES.includes(body.priority))
      || (body.idea !== undefined && typeof body.idea !== 'string')
      || (body.prd !== undefined && typeof body.prd !== 'string')) {
      return reply.code(400).send({ error: 'invalid project' });
    }
    // An imported project names a repository; the parser is the same one the wizard complains with,
    // so anything it accepts here the wizard already accepted there — and nothing else gets cloned.
    let source: { ref: { owner: string; repo: string }; branch?: string } | undefined;
    if (body.source !== undefined) {
      if (typeof body.source !== 'object' || body.source === null || typeof body.source.url !== 'string') {
        return reply.code(400).send({ error: 'invalid source' });
      }
      const ref = parseGithubSource(body.source.url);
      if (!ref) return reply.code(400).send({ error: 'not a GitHub repository: use owner/repo or its github.com URL' });
      const branch = body.source.branch;
      if (branch !== undefined && (typeof branch !== 'string' || (branch !== '' && !validBranch(branch)))) {
        return reply.code(400).send({ error: 'invalid branch' });
      }
      source = { ref, ...(typeof branch === 'string' && branch ? { branch } : {}) };
    }
    const duplicate = await projects.get(body.slug).then(() => true, () => false);
    if (duplicate) return reply.code(409).send({ error: 'project already exists' });
    // The idea (or a pasted PRD) is kept on the manifest and drafted from afterwards, by an explicit
    // call to the draft route: creating a project must not wait on a model. The clone is the one
    // exception — a project whose code has not landed has nothing to draft from.
    const intake = { ...(body.idea ? { idea: body.idea } : {}), ...(body.prd ? { prd: body.prd } : {}) };
    let manifest: ProjectManifest;
    try {
      manifest = await projects.create({
        slug: body.slug, title: body.title, intent: body.intent,
        ...(body.priority ? { priority: body.priority } : {}),
        ...(Object.keys(intake).length ? { intake } : {}),
        ...(source ? { source } : {}),
      });
    } catch (err) {
      if (!(err instanceof GithubError)) throw err;
      // A repository we cannot authenticate to is the owner's to fix (400); anything else went
      // wrong between the hub and GitHub, which is an upstream failure (502).
      const status = err.code === 'auth' || err.code === 'config' ? 400 : 502;
      return reply.code(status).send({ error: err.message });
    }
    await refreshProjects();
    return reply.code(201).send(manifest);
  });

  app.get('/api/projects/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const bundle = await resolveProject(slug, reply);
    if (!bundle) return reply;
    return {
      manifest: await bundle.manifest(),
      briefing: await bundle.latestBriefing(),
      tasks: (await bundle.tasks()).tasks,
    };
  });

  const lifecycle: Record<string, (slug: string) => Promise<ProjectManifest>> = {
    pause: (slug) => projects.pause(slug),
    resume: (slug) => projects.resume(slug),
    archive: (slug) => projects.archive(slug),
  };
  for (const [action, apply] of Object.entries(lifecycle)) {
    app.post(`/api/projects/:slug/${action}`, async (req, reply) => {
      const { slug } = req.params as { slug: string };
      if (!(await resolveProject(slug, reply))) return reply;
      const manifest = await apply(slug);
      await refreshProjects();
      return manifest;
    });
  }

  /**
   * Opens (or finds) the pull request for an imported project's `agenthub/<slug>` branch. The owner
   * presses this; agents never do — merging into the repository's own branch stays the owner's call.
   * Idempotent, because GitHub allows one open pull request per head and the owner may press it
   * again after a later milestone.
   */
  app.post('/api/projects/:slug/pr', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const bundle = await resolveProject(slug, reply);
    if (!bundle) return reply;
    const manifest = await bundle.manifest();
    const source = manifest.source;
    if (!source) return reply.code(400).send({ error: 'this project was not imported from a repository' });
    if (!source.pushedAt) return reply.code(400).send({ error: `nothing has been pushed to ${source.pushBranch} yet` });

    const milestones = await bundle.roadmap();
    const latest = [...milestones].reverse().find((m) => m.status === 'done');
    const briefing = await bundle.latestBriefing();
    try {
      const url = await github.openPullRequest(source, {
        title: latest ? `${manifest.title} — ${latest.title}` : manifest.title,
        body: briefing?.summary ?? `Work by AgentHub on ${manifest.title}.`,
      });
      await bundle.setSource({ ...source, prUrl: url });
      await bundle.commit(`hub: pull request for ${source.pushBranch}`);
      await refreshProjects();
      return { url };
    } catch (err) {
      if (!(err instanceof GithubError)) throw err;
      return reply.code(err.code === 'config' ? 400 : 502).send({ error: err.message });
    }
  });

  app.post('/api/projects/:slug/priority', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const body = req.body as Partial<{ priority: Priority }> | undefined;
    if (!body || body.priority === undefined || !PRIORITIES.includes(body.priority)) {
      return reply.code(400).send({ error: 'invalid priority' });
    }
    if (!(await resolveProject(slug, reply))) return reply;
    const manifest = await projects.setPriority(slug, body.priority);
    await refreshProjects();
    return manifest;
  });

  /** The owner's model choice for one project — see `validateModelPolicy` for the acceptance rules. */
  app.post('/api/projects/:slug/model', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const body = (req.body ?? {}) as Partial<ModelPolicy>;
    const validated = validateModelPolicy(body, modelCatalog());
    if ('error' in validated) return reply.code(400).send({ error: validated.error });
    if (!(await resolveProject(slug, reply))) return reply;
    const manifest = await projects.setModelPolicy(slug, validated.policy);
    await refreshProjects();
    return manifest;
  });

  app.post('/api/projects/:slug/turn', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const body = req.body as Partial<{ instruction: string }> | undefined;
    if (body?.instruction !== undefined && typeof body.instruction !== 'string') {
      return reply.code(400).send({ error: 'invalid instruction' });
    }
    if (!(await resolveProject(slug, reply))) return reply;
    let briefing: Briefing;
    try {
      briefing = await projects.runTurn(slug, body?.instruction);
    } catch (err) {
      if (err instanceof TurnRefusedError) return reply.code(409).send({ error: err.message });
      throw err;
    }
    await refreshProjects();
    return briefing;
  });

  /**
   * The owner's opt-in to scheduled turns. Fields left out keep their current value, or take the
   * defaults (hourly, six a day) on a project that had no auto-run yet.
   */
  app.post('/api/projects/:slug/autorun', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const body = (req.body ?? {}) as Partial<AutoRun>;
    if (typeof body.enabled !== 'boolean') return reply.code(400).send({ error: 'invalid enabled' });
    if (body.everyMinutes !== undefined && !(Number.isInteger(body.everyMinutes) && body.everyMinutes >= 5 && body.everyMinutes <= 1440)) {
      return reply.code(400).send({ error: 'invalid everyMinutes' });
    }
    if (body.maxTurnsPerDay !== undefined && !(Number.isInteger(body.maxTurnsPerDay) && body.maxTurnsPerDay >= 1 && body.maxTurnsPerDay <= 100)) {
      return reply.code(400).send({ error: 'invalid maxTurnsPerDay' });
    }
    const bundle = await resolveProject(slug, reply);
    if (!bundle) return reply;
    const current = (await bundle.manifest()).autoRun;
    const manifest = await projects.setAutoRun(slug, {
      enabled: body.enabled,
      everyMinutes: body.everyMinutes ?? current?.everyMinutes ?? DEFAULT_AUTO_RUN.everyMinutes,
      maxTurnsPerDay: body.maxTurnsPerDay ?? current?.maxTurnsPerDay ?? DEFAULT_AUTO_RUN.maxTurnsPerDay,
    });
    await refreshProjects();
    return manifest;
  });

  /** The last orchestrator turns with their events replayed from the transcript, newest first. */
  const turnRecord = (session: SessionRecord): TurnRecord => {
    const events = transcript.turnEvents(session.id);
    const end = events.find((e): e is TurnEvent & { kind: 'turn-end'; at: number } => e.kind === 'turn-end');
    return {
      sessionId: session.id,
      startedAt: session.startedAt,
      // A turn's own end comes after its session's: the briefing is published in between.
      endedAt: end?.at ?? session.endedAt,
      outcome: end?.outcome ?? session.outcome,
      summary: end?.summary ?? '',
      toolCalls: events.filter((e) => e.kind === 'tool-call' && e.who === 'manager').length,
      // Summed from the turn's own events rather than read off `turn-end`, so a turn still running
      // reports what it has spent so far and an old turn with no totals on its end event still adds up.
      cost: events.reduce(
        (sum, e) => (e.kind === 'usage' ? { usd: sum.usd + (e.usd ?? 0), tokens: sum.tokens + e.tokens } : sum),
        { usd: 0, tokens: 0 },
      ),
      events,
    };
  };

  app.get('/api/projects/:slug/turns', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!(await resolveProject(slug, reply))) return reply;
    const sessions = transcript.sessions({ kind: 'orchestrator', subject: slug, limit: TURNS_LIMIT }).reverse();
    return { running: projects.runningTurn(slug), turns: sessions.map(turnRecord), budget: await projects.budget(slug) };
  });

  app.get('/api/projects/:slug/transcript', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!(await resolveProject(slug, reply))) return reply;
    return transcript.sessions({ subject: slug }).map((session) => ({
      ...session,
      messages: transcript.messages(session.id),
      events: transcript.events(session.id),
    }));
  });

  // --- project team roster ------------------------------------------------------

  /** What the roster shows about a session: its outcome and the tail of its last message. */
  const teamSessionView = (session: SessionRecord): TeamSessionView => ({
    id: session.id,
    startedAt: session.startedAt,
    outcome: session.outcome,
    lastMessage: transcript.lastMessage(session.id).slice(0, TEAM_LAST_MESSAGE_LIMIT),
  });

  const teamStatus = (session: SessionRecord | undefined, now: number): TeamStatus =>
    session && session.outcome === null && now - session.startedAt < TEAM_WORKING_WINDOW_MS ? 'working' : 'idle';

  app.get('/api/projects/:slug/team', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const bundle = await resolveProject(slug, reply);
    if (!bundle) return reply;
    const now = Date.now();
    const members = (await bundle.team()).map((member): TeamMemberView => {
      const sessions = transcript.sessions({ subject: slug, memberId: member.id });
      const latest = sessions[sessions.length - 1];
      return {
        ...member,
        status: teamStatus(latest, now),
        ...(latest ? { currentSession: teamSessionView(latest) } : {}),
        sessionsCount: sessions.length,
      };
    });
    // The manager is the orchestrator itself — it is not on the roster, and its sessions carry no
    // member id.
    const managerSessions = transcript.sessions({ kind: 'orchestrator', subject: slug });
    const latestManager = managerSessions[managerSessions.length - 1];
    return {
      members,
      manager: {
        status: teamStatus(latestManager, now),
        ...(latestManager ? { currentSession: teamSessionView(latestManager) } : {}),
      },
    } satisfies TeamRoster;
  });

  app.post('/api/projects/:slug/team', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const bundle = await resolveProject(slug, reply);
    if (!bundle) return reply;
    const result = await bundle.hireMember(req.body);
    if ('error' in result) return reply.code(result.code).send({ error: result.error });
    await bundle.commit(`owner: hire ${result.member.name} (${result.member.id})`);
    await refreshProjects();
    return reply.code(201).send(result.member);
  });

  // Removing a member does not touch the sessions they ran: the transcript is a record of what
  // happened, and their past work stays attributed to them.
  app.delete('/api/projects/:slug/team/:id', async (req, reply) => {
    const { slug, id } = req.params as { slug: string; id: string };
    const bundle = await resolveProject(slug, reply);
    if (!bundle) return reply;
    const members = await bundle.team();
    const remaining = members.filter((m) => m.id !== id);
    if (remaining.length === members.length) return reply.code(404).send({ error: 'unknown member' });
    await bundle.writeTeam(remaining);
    await bundle.commit(`owner: remove team member ${id}`);
    await refreshProjects();
    return reply.code(204).send();
  });

  /**
   * A per-employee override of the project's model policy (`TeamMember.model`) — `model: null`
   * clears it back to the project default. Accepts exactly what `POST .../model` does, via
   * `validateModelPolicy`.
   */
  app.patch('/api/projects/:slug/team/:id', async (req, reply) => {
    const { slug, id } = req.params as { slug: string; id: string };
    const body = (req.body ?? {}) as Partial<{ model: ModelPolicy | null }>;
    if (body.model === undefined) return reply.code(400).send({ error: 'invalid model' });
    const validated = body.model === null ? null : validateModelPolicy(body.model, modelCatalog());
    if (validated && 'error' in validated) return reply.code(400).send({ error: validated.error });
    const bundle = await resolveProject(slug, reply);
    if (!bundle) return reply;
    const members = await bundle.team();
    const member = members.find((m) => m.id === id);
    if (!member) return reply.code(404).send({ error: 'unknown member' });
    const updated: TeamMember = { ...member };
    if (validated) updated.model = validated.policy;
    else delete updated.model;
    await bundle.writeTeam(members.map((m) => (m.id === id ? updated : m)));
    await bundle.commit(`owner: set ${member.name}'s model`);
    await refreshProjects();
    return updated;
  });

  app.get('/api/projects/:slug/team/:id/activity', async (req, reply) => {
    const { slug, id } = req.params as { slug: string; id: string };
    const bundle = await resolveProject(slug, reply);
    if (!bundle) return reply;
    if (!(await bundle.team()).some((m) => m.id === id)) return reply.code(404).send({ error: 'unknown member' });
    const sessions = transcript.sessions({ subject: slug, memberId: id });
    const session = sessions[sessions.length - 1];
    if (!session) return { session: null, messages: [], events: [] };
    return {
      session,
      messages: transcript.messages(session.id).slice(-TEAM_ACTIVITY_MESSAGE_LIMIT),
      events: transcript.events(session.id),
    };
  });

  // --- project chat -------------------------------------------------------------

  /** Resolves `:who` against the roster; replies 404 and returns null when nobody answers to it. */
  const resolveChatWho = async (bundle: ProjectBundle, who: string, reply: FastifyReply): Promise<boolean> => {
    if (await resolveWho(bundle, who)) return true;
    reply.code(404).send({ error: 'unknown team member' });
    return false;
  };

  app.get('/api/projects/:slug/chat/:who', async (req, reply) => {
    const { slug, who } = req.params as { slug: string; who: string };
    const bundle = await resolveProject(slug, reply);
    if (!bundle) return reply;
    if (!(await resolveChatWho(bundle, who, reply))) return reply;
    return { messages: chat.messages(slug, who) };
  });

  app.post('/api/projects/:slug/chat/:who/messages', async (req, reply) => {
    const { slug, who } = req.params as { slug: string; who: string };
    const body = req.body as Partial<{ text: string }> | undefined;
    if (!body || typeof body.text !== 'string' || !body.text) return reply.code(400).send({ error: 'invalid message' });
    const bundle = await resolveProject(slug, reply);
    if (!bundle) return reply;
    if (!(await resolveChatWho(bundle, who, reply))) return reply;
    // Same framing and abort wiring as the assistant route: a client that closes the stream should
    // not leave a model session running to completion for nobody.
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const ac = new AbortController();
    reply.raw.on('close', () => ac.abort());
    broadcast({ type: 'project-busy', slug, who, busy: true });
    try {
      const result = await chat.reply(slug, who, body.text, {
        onToken: (token) => { reply.raw.write(`data: ${JSON.stringify({ token })}\n\n`); },
        signal: ac.signal,
      });
      reply.raw.write(`data: ${JSON.stringify({ done: true, full: result.text })}\n\n`);
    } catch (err) {
      reply.raw.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
    } finally {
      broadcast({ type: 'project-busy', slug, who, busy: false });
    }
    reply.raw.end();
    return reply;
  });

  // --- project PRD, roadmap and docs ---------------------------------------------

  /**
   * The chat route's SSE framing, reused by the two long-running plan calls: streamed `token` frames
   * and one `done` frame carrying the finished artefact. A client that closes the stream aborts the
   * model run rather than leaving it to finish for nobody.
   */
  const streamPlan = async (
    reply: FastifyReply, slug: string, who: 'prd' | 'roadmap',
    run: (opts: { onToken: (t: string) => void; signal: AbortSignal }) => Promise<Record<string, unknown>>,
  ): Promise<FastifyReply> => {
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const ac = new AbortController();
    reply.raw.on('close', () => ac.abort());
    broadcast({ type: 'project-busy', slug, who, busy: true });
    let full = '';
    try {
      const done = await run({
        onToken: (token) => { full += token; reply.raw.write(`data: ${JSON.stringify({ token })}\n\n`); },
        signal: ac.signal,
      });
      reply.raw.write(`data: ${JSON.stringify({ done: true, full, ...done })}\n\n`);
      await refreshProjects();
    } catch (err) {
      reply.raw.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
    } finally {
      broadcast({ type: 'project-busy', slug, who, busy: false });
    }
    reply.raw.end();
    return reply;
  };

  app.get('/api/projects/:slug/prd', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const bundle = await resolveProject(slug, reply);
    if (!bundle) return reply;
    const markdown = await bundle.prd();
    return { markdown, audit: auditPrd(markdown), drafted: !isPrdScaffold(markdown), updatedAt: await bundle.prdUpdatedAt() };
  });

  app.put('/api/projects/:slug/prd', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const body = req.body as Partial<{ markdown: string }> | undefined;
    if (!body || typeof body.markdown !== 'string') return reply.code(400).send({ error: 'invalid prd' });
    const bundle = await resolveProject(slug, reply);
    if (!bundle) return reply;
    await bundle.writePrd(body.markdown);
    await bundle.commit('owner: edit prd');
    await refreshProjects();
    return { audit: auditPrd(body.markdown) };
  });

  app.post('/api/projects/:slug/prd/draft', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const body = (req.body ?? {}) as Partial<{ idea: string; prd: string }>;
    for (const field of ['idea', 'prd'] as const) {
      if (body[field] !== undefined && typeof body[field] !== 'string') {
        return reply.code(400).send({ error: `invalid ${field}` });
      }
    }
    const bundle = await resolveProject(slug, reply);
    if (!bundle) return reply;
    // Nothing in the request means "draft from what the owner already gave us at creation time".
    const intake = (await bundle.manifest()).intake ?? {};
    const input = {
      ...(body.idea ?? intake.idea ? { idea: body.idea ?? intake.idea } : {}),
      ...(body.prd ?? intake.prd ? { prd: body.prd ?? intake.prd } : {}),
    };
    return streamPlan(reply, slug, 'prd', async (opts) => {
      const result = await drafter.draft(slug, input, opts);
      return { full: result.markdown, questions: result.questions, audit: result.audit };
    });
  });

  app.get('/api/projects/:slug/roadmap', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const bundle = await resolveProject(slug, reply);
    if (!bundle) return reply;
    const milestones = await bundle.roadmap();
    return { milestones, currentId: currentMilestoneId(milestones) };
  });

  app.post('/api/projects/:slug/roadmap/generate', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const bundle = await resolveProject(slug, reply);
    if (!bundle) return reply;
    // Checked before the stream opens: once the SSE headers are out, a 400 has nowhere to go.
    if (isPrdScaffold(await bundle.prd())) return reply.code(400).send({ error: 'the PRD has not been drafted yet' });
    return streamPlan(reply, slug, 'roadmap', async (opts) => ({ milestones: await drafter.generateRoadmap(slug, opts) }));
  });

  app.post('/api/projects/:slug/roadmap/move', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const body = (req.body ?? {}) as Partial<{ id: string; direction: 'up' | 'down' }>;
    if (typeof body.id !== 'string' || (body.direction !== 'up' && body.direction !== 'down')) {
      return reply.code(400).send({ error: 'invalid move' });
    }
    const bundle = await resolveProject(slug, reply);
    if (!bundle) return reply;
    const milestones = await bundle.roadmap();
    if (!milestones.some((m) => m.id === body.id)) return reply.code(400).send({ error: 'unknown milestone' });
    // A move at either edge is a no-op, not an error: the owner asked for an order it already has.
    const moved = moveMilestone(milestones, body.id, body.direction);
    if (moved !== milestones) {
      await bundle.writeRoadmap(moved);
      await bundle.commit(`owner: move milestone ${body.id} ${body.direction}`);
    }
    return { milestones: moved };
  });

  app.patch('/api/projects/:slug/roadmap/:id', async (req, reply) => {
    const { slug, id } = req.params as { slug: string; id: string };
    const body = (req.body ?? {}) as Partial<{ title: string; summary: string; status: MilestoneStatus; estimate: string }>;
    for (const field of ['title', 'summary', 'estimate'] as const) {
      if (body[field] !== undefined && typeof body[field] !== 'string') {
        return reply.code(400).send({ error: `invalid ${field}` });
      }
    }
    if (body.status !== undefined && !MILESTONE_STATUSES.includes(body.status)) {
      return reply.code(400).send({ error: 'invalid status' });
    }
    const bundle = await resolveProject(slug, reply);
    if (!bundle) return reply;
    const milestones = await bundle.roadmap();
    if (!milestones.some((m) => m.id === id)) return reply.code(404).send({ error: 'unknown milestone' });
    // Only these four are the owner's to edit here — the raw body is untrusted, and passing it
    // through whole would let a `verification` or `startedCommit` field ride along and overwrite
    // evidence only complete_milestone is supposed to record.
    const patch = {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.summary !== undefined ? { summary: body.summary } : {}),
      ...(body.estimate !== undefined ? { estimate: body.estimate } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
    };
    const patched = patchMilestone(milestones, id, patch);
    await bundle.writeRoadmap(patched);
    await bundle.commit(`owner: edit milestone ${id}`);
    return { milestones: patched };
  });

  app.get('/api/projects/:slug/docs', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const bundle = await resolveProject(slug, reply);
    if (!bundle) return reply;
    // The decision log rides along: it is the other half of "why is it like this", and the docs view
    // shows both.
    return { ...(await bundle.docs()), decisions: await bundle.decisions() };
  });

  app.get('/api/projects/:slug/docs/:page', async (req, reply) => {
    const { slug, page } = req.params as { slug: string; page: string };
    if (!DOC_SLUG_RE.test(page)) return reply.code(400).send({ error: 'invalid page' });
    const bundle = await resolveProject(slug, reply);
    if (!bundle) return reply;
    const markdown = await bundle.doc(page);
    if (markdown === null) return reply.code(404).send({ error: 'unknown page' });
    const { pages } = await bundle.docs();
    return { slug: page, title: pages.find((p) => p.slug === page)?.title ?? page, markdown };
  });

  app.get('/api/briefings', async () => projects.briefings());

  app.post('/api/master/brief', async () => master.dailyBriefing());

  app.post('/api/master/command', async (req, reply) => {
    const body = req.body as Partial<{ text: string }> | undefined;
    if (!body || typeof body.text !== 'string' || !body.text) return reply.code(400).send({ error: 'invalid command' });
    const result = await master.command(body.text);
    await refreshProjects();
    return result;
  });

  // --- browser lease ------------------------------------------------------------

  /** Reads `{kind,id,project}` off a lease request; replies 400 and returns null when it's malformed. */
  const parseRequester = (body: unknown, reply: FastifyReply, kind?: BrowserRequesterKind): Requester | null => {
    const b = (body ?? {}) as Partial<{ kind: BrowserRequesterKind; id: string; project: string }>;
    const wanted = kind ?? b.kind;
    if (wanted === undefined || !REQUESTER_KINDS.includes(wanted)
      || typeof b.id !== 'string' || !b.id
      || (b.project !== undefined && typeof b.project !== 'string')) {
      reply.code(400).send({ error: 'invalid lease request' });
      return null;
    }
    return { kind: wanted, id: b.id, ...(b.project ? { project: b.project } : {}) };
  };

  app.get('/api/browser', async () => {
    leases.expire();
    return browserStatus();
  });

  app.post('/api/browser/lease', async (req, reply) => {
    const requester = parseRequester(req.body, reply);
    if (!requester) return reply;
    // The browser is one shared resource, not one per node, so draining its node doesn't preempt the
    // current holder — it just hands out nothing new: a fresh acquire is refused, but the holder (if
    // it's this requester) still renews, so work already using the browser finishes normally.
    const browserNode = browserStatus().node;
    if (browserNode && registry.byName(browserNode)?.draining) {
      const holder = leases.holder()?.requester;
      const isHolder = holder?.id === requester.id && holder?.kind === requester.kind;
      if (!isHolder) return reply.code(409).send({ error: 'browser busy' });
    }
    return leases.acquire(requester);
  });

  // The owner never queues: this preempts whoever is holding the browser, and their next action 409s.
  app.post('/api/browser/preempt', async (req, reply) => {
    const requester = parseRequester(req.body, reply, 'owner');
    if (!requester) return reply;
    return leases.acquire(requester);
  });

  app.delete('/api/browser/lease/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!leases.release(id)) return reply.code(404).send({ error: 'not the lease holder' });
    return { released: true };
  });

  app.post('/api/browser/act', async (req, reply) => {
    const body = req.body as Partial<{ leaseId: string; op: BrowserOp; args: Record<string, unknown> }> | undefined;
    if (!body || typeof body.leaseId !== 'string' || body.op === undefined || !BROWSER_OPS.includes(body.op)) {
      return reply.code(400).send({ error: 'invalid browser action' });
    }
    try {
      return await browser.act(body.leaseId, { op: body.op, ...(body.args ? { args: body.args } : {}) });
    } catch (err) {
      if (err instanceof BrowserError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  app.get('/api/browser/recordings/:leaseId', async (req, reply) => {
    const { leaseId } = req.params as { leaseId: string };
    if (!LEASE_ID_RE.test(leaseId)) return reply.code(400).send({ error: 'invalid lease id' });
    return { leaseId, actions: await recorder.list(leaseId) };
  });

  // --- external tool audit -------------------------------------------------------

  // Owner-only (the default class for an /api route): the ledger names everything that has left the
  // owner's machines, so it is read with the session cookie and nothing weaker.
  app.get('/api/audit', async (req, reply) => {
    const { limit: raw } = req.query as { limit?: string };
    let limit = AUDIT_DEFAULT_LIMIT;
    if (raw !== undefined) {
      limit = Number(raw);
      if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_MAX_LIMIT) {
        return reply.code(400).send({ error: 'invalid limit' });
      }
    }
    return toolAudit.list(limit);
  });

  // --- control node --------------------------------------------------------------

  /**
   * Answers the switch, then stops this hub: the reply has to reach the owner (and the Telegram
   * chat) before the process that would send it goes away, and the new hub is already healthy by
   * the time `switchTo` resolves, so the gap is only a handover, not an outage.
   */
  const scheduleSelfStop = (): number => {
    const delay = opts.controlNode?.stopDelayMs ?? DEFAULT_SWITCH_STOP_DELAY_MS;
    const timer = setTimeout(() => {
      hub.stop().catch((err) => app.log.error(`stopping after the control-node switch failed: ${(err as Error).message}`));
    }, delay);
    timer.unref?.();
    return delay;
  };

  const runSwitch = async (node: string): Promise<{ switchedTo: string; hubUrl: string; stoppingInMs: number }> => {
    const result = await controlSwitch!.switchTo(node);
    return { ...result, stoppingInMs: scheduleSelfStop() };
  };

  app.get('/api/controlnode', async (req, reply) => {
    if (!controlSwitch) return reply.code(501).send({ error: 'control-node switching is not configured' });
    return controlSwitch.candidates();
  });

  app.post('/api/controlnode', async (req, reply) => {
    if (!controlSwitch) return reply.code(501).send({ error: 'control-node switching is not configured' });
    const { node } = (req.body ?? {}) as { node?: unknown };
    if (typeof node !== 'string' || !node) return reply.code(400).send({ error: 'node required' });
    try {
      return await runSwitch(node);
    } catch (err) {
      if (err instanceof SwitchError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  // --- assistant ---------------------------------------------------------------

  /**
   * Opening the memory store is async (git init, scaffolding), so the wiring is a promise the
   * routes await rather than something `createHub` can finish synchronously. Telegram only starts
   * when a port was supplied — no token, no bot, and the rest of the assistant still works.
   */
  const initAssistant = async (cfg: AssistantOptions): Promise<AssistantHandle> => {
    const memory = await MemoryStore.open(cfg.memoryRoot);
    const planner = new Planner(join(cfg.memoryRoot, 'planner'), (msg) => memory.commit(msg));
    const tools = [
      ...assistantTools({ memory, planner, gate, service: projects, master, registry, jobs: queue }),
      ...external,
    ];
    const assistant = new Assistant({ loop, tools, memory, planner, gate, transcript });

    const handle: AssistantHandle = { memory, planner, gate, assistant, port: null, router: null, scheduler: null, alerts: null };
    if (!cfg.telegram) return handle;

    const { port, ownerChatId } = cfg.telegram;
    const clock = cfg.clock ?? new SystemClock();
    const router = new CommandRouter({
      port, ownerChatId, assistant, service: projects, master, planner, registry, gate,
      enqueueVideo: (payload) => enqueueVideo(payload, TELEGRAM_PROJECT),
      ...(controlSwitch ? { controlNodes: { list: () => controlSwitch.candidates(), switchTo: runSwitch } } : {}),
    });
    const scheduler = new Scheduler({
      clock, port, ownerChatId, master, service: projects, assistant,
      briefingTime: cfg.schedule?.briefingTime ?? DEFAULT_BRIEFING_TIME,
      checkinTimes: cfg.schedule?.checkinTimes ?? DEFAULT_CHECKIN_TIMES,
      ...(cfg.schedule?.tz ? { tz: cfg.schedule.tz } : {}),
    });
    // Telegram is one optional surface on the assistant, not a precondition for it: a bad token, an
    // unreachable Telegram, or a malformed BRIEFING_TIME costs the bot and nothing else — the
    // handle still comes back usable and the HTTP assistant routes keep working. Polling starts
    // first so nothing is wired to a port that never came up.
    try {
      await port.start();
      router.start();
      scheduler.start();
      const alerts = new Alerts({ port, ownerChatId, registry, service: projects, clock, videoArtifact: videoArtifactInfo });
      alerts.attach(hubEvents);
      handle.port = port;
      handle.router = router;
      handle.scheduler = scheduler;
      handle.alerts = alerts;
    } catch (err) {
      app.log.error(`telegram startup failed, continuing without it: ${(err as Error).message}`);
      scheduler.stop();
      await port.stop().catch((stopErr) => app.log.error(`telegram port stop failed: ${(stopErr as Error).message}`));
    }
    return handle;
  };

  /** Set by the first `stop()`; every later call awaits the same shutdown rather than repeating it. */
  let stopping: Promise<void> | undefined;

  const assistantReady = opts.assistant ? initAssistant(opts.assistant) : null;
  // Nothing awaits the wiring until the first request, so a failure would otherwise surface as an
  // unhandled rejection minutes later; this logs it and marks the promise handled.
  if (assistantReady) void assistantReady.catch((err) => app.log.error(`assistant wiring failed: ${(err as Error).message}`));

  /**
   * Resolves the wired assistant, or replies 503 and returns null when the hub has none — including
   * when the wiring itself failed (a memory root that won't open). That is unavailability, not a
   * request-handling bug, so it must not reach the client as a 500 from a rejected route promise.
   */
  const requireAssistant = async (reply: FastifyReply): Promise<AssistantHandle | null> => {
    const handle = assistantReady ? await assistantReady.catch(() => null) : null;
    if (!handle) {
      reply.code(503).send({ error: assistantReady ? 'assistant unavailable' : 'assistant not configured' });
      return null;
    }
    return handle;
  };

  const resolveList = (value: string, reply: FastifyReply): PlannerList | null => {
    if (!PLANNER_LISTS.includes(value as PlannerList)) {
      reply.code(400).send({ error: 'unknown planner list' });
      return null;
    }
    return value as PlannerList;
  };

  app.post('/api/assistant/messages', async (req, reply) => {
    const body = req.body as Partial<{ text: string }> | undefined;
    if (!body || typeof body.text !== 'string' || !body.text) return reply.code(400).send({ error: 'invalid message' });
    const handle = await requireAssistant(reply);
    if (!handle) return reply;
    // Same framing as the agent chat route, plus the pending actions this reply proposed so the
    // caller can render Confirm/Cancel for them.
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    // Same abort wiring as the agent chat route: a client that closes the stream (navigated away,
    // hit stop) should not leave a model session running to completion for nobody.
    const ac = new AbortController();
    reply.raw.on('close', () => ac.abort());
    try {
      const result = await handle.assistant.reply(body.text, {
        onToken: (token) => { reply.raw.write(`data: ${JSON.stringify({ token })}\n\n`); },
        signal: ac.signal,
      });
      const pending = result.pending.map(({ id, description }) => ({ id, description }));
      reply.raw.write(`data: ${JSON.stringify({ done: true, full: result.text, pending })}\n\n`);
    } catch (err) {
      reply.raw.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
    }
    reply.raw.end();
    return reply;
  });

  app.get('/api/assistant/pending', async (req, reply) => {
    const handle = await requireAssistant(reply);
    if (!handle) return reply;
    return handle.gate.pending().map(({ id, description, createdAt }) => ({ id, description, createdAt }));
  });

  app.post('/api/assistant/pending/:id/confirm', async (req, reply) => {
    const handle = await requireAssistant(reply);
    if (!handle) return reply;
    const { id } = req.params as { id: string };
    try {
      return { result: await handle.gate.confirm(id) };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  app.post('/api/assistant/pending/:id/cancel', async (req, reply) => {
    const handle = await requireAssistant(reply);
    if (!handle) return reply;
    const { id } = req.params as { id: string };
    if (!handle.gate.cancel(id)) return reply.code(404).send({ error: 'unknown pending action' });
    return { ok: true };
  });

  app.get('/api/memory/index', async (req, reply) => {
    const handle = await requireAssistant(reply);
    if (!handle) return reply;
    return { text: await handle.memory.indexText(), entries: await handle.memory.index() };
  });

  app.get('/api/planner', async (req, reply) => {
    const handle = await requireAssistant(reply);
    if (!handle) return reply;
    const lists = await Promise.all(PLANNER_LISTS.map((which) => handle.planner.list(which)));
    return Object.fromEntries(PLANNER_LISTS.map((which, i) => [which, lists[i]]));
  });

  app.post('/api/planner/:list', async (req, reply) => {
    const handle = await requireAssistant(reply);
    if (!handle) return reply;
    const which = resolveList((req.params as { list: string }).list, reply);
    if (!which) return reply;
    const body = req.body as Partial<{ text: string }> | undefined;
    if (!body || typeof body.text !== 'string' || !body.text.trim()) return reply.code(400).send({ error: 'invalid item' });
    const n = await handle.planner.add(which, body.text.trim());
    return reply.code(201).send({ n, items: await handle.planner.list(which) });
  });

  app.post('/api/planner/:list/:n/done', async (req, reply) => {
    const handle = await requireAssistant(reply);
    if (!handle) return reply;
    const params = req.params as { list: string; n: string };
    const which = resolveList(params.list, reply);
    if (!which) return reply;
    if (!(await handle.planner.complete(which, Number(params.n)))) return reply.code(404).send({ error: 'unknown item' });
    return { items: await handle.planner.list(which) };
  });

  const hub: Hub = {
    app, db, registry, queue, gateway, runtime, transcript, usage, projects, master, leases, browser, resources,
    assistant() {
      if (!assistantReady) return Promise.reject(new Error('assistant not configured'));
      return assistantReady;
    },
    // Idempotent: after a control-node switch the hub stops itself, and the owner's own shutdown
    // path (or a test's cleanup) may well call this again.
    stop(opts) {
      stopping ??= (async () => {
        clearInterval(sweeper);
        screencast.stop();
        // A failed wiring has already been logged; stopping must still tear the rest of the hub down.
        const handle = await assistantReady?.catch(() => null);
        handle?.scheduler?.stop();
        await handle?.port?.stop();
        await projects.stop(opts);
        await Promise.all([...refreshes]);
        await app.close();
        db.close();
      })();
      return stopping;
    },
  };
  return hub;
}
