export type Tier = 'orchestrator' | 'worker' | 'vision' | 'video-gen';
export type Priority = 'interactive' | 'project' | 'batch';
export const PRIORITY_RANK: Record<Priority, number> = { interactive: 0, project: 1, batch: 2 };
export type JobType = 'llm-session' | 'video-gen' | 'shell-task' | 'browser-lease';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

/** The cloud providers the hub can serve a tier from; each has its own synthetic node. */
export type CloudProvider = 'anthropic' | 'fireworks';

export interface ServingEndpoint {
  tier: Tier;
  url: string;
  model: string;
  maxStreams: number;
  /**
   * Which wire protocol `url` speaks. Absent means `openai` — every locally served endpoint — so
   * nodes registered before this field still parse. `anthropic` endpoints are served by the hub's
   * own SDK client rather than by an HTTP endpoint, and carry the placeholder url `anthropic://`.
   * `fireworks` is OpenAI-compatible over HTTP: same wire format, a bearer token, a remote url.
   */
  provider?: 'openai' | 'anthropic' | 'fireworks';
  /**
   * Name of the environment variable holding a bearer token for `url`. Set on any endpoint that
   * needs `Authorization: Bearer ...` — the cloud ones, and a local endpoint put behind a token.
   * The *name* travels, never the secret: only the hub process reads the value.
   */
  apiKeyEnv?: string;
  /**
   * vLLM request priority sent with every call to this endpoint (lower is served sooner; 0 is the
   * default and the front of the line). Set it on a server shared with an interactive user — the
   * Spark also answers the owner's Telegram assistant, which sends no priority and so goes first —
   * and only on a server started with `--scheduling-policy priority`: any non-zero value is a 400
   * otherwise. Absent means the field is not sent at all.
   */
  priority?: number;
  /**
   * Extra fields merged into every chat request to this endpoint (e.g. vLLM's
   * `chat_template_kwargs`). Never overrides `model`, `messages`, `stream`, `tools`, or `priority`.
   */
  requestExtras?: Record<string, unknown>;
}

/**
 * How one project picks the model that serves a tier (`ProjectManifest.modelPolicy`).
 *
 * `auto` is the hub's default: local endpoints first, cloud as overflow. `local` keeps the work on
 * hardware the owner already paid for and only reaches the cloud for a tier nothing local serves at
 * all. `cloud` goes out first and falls back to local. `provider` narrows which cloud is preferred;
 * the two model fields override that provider's configured model for their tier.
 */
export interface ModelPolicy {
  prefer: 'local' | 'cloud' | 'auto';
  provider?: CloudProvider;
  orchestratorModel?: string;
  workerModel?: string;
}

export interface NodeRegistration {
  name: string;
  arch: string;
  endpoints: ServingEndpoint[];
  jobTypes?: JobType[];
  /**
   * Present only on a node running the browser capability; `url` is its local browser server and
   * `slots` how many isolated sessions it runs (absent = 1, a daemon from before the pool).
   */
  browser?: { url: string; slots?: number };
  /** Serving profiles this node can switch between (spec §4.3); empty when it has none. */
  profiles?: string[];
  /** True when the node has a local ComfyUI configured for `video-gen` jobs. */
  video?: boolean;
  /** Present only when the node runs a control server; `url` is its `/control/*` base. */
  control?: { url: string };
  /** True when the node can host the hub itself — a control-node switch target (spec §4.2). */
  controlNode?: boolean;
}

export interface NodeInfo extends NodeRegistration {
  id: number;
  status: 'online' | 'offline';
  lastHeartbeat: number;
  jobTypes: JobType[];
  /** Set by the owner from the Cluster page: finishes work already in flight, gets nothing new. */
  draining?: boolean;
  /** Set by the owner from the Machines page: the gateway stops picking this node's serving endpoints; it still heartbeats and claims jobs. */
  modelsPaused?: boolean;
  /**
   * Who the node belongs to (PRD FR-D5). The enrolling user, or `admin` for a node that registered
   * with the shared `DAEMON_TOKEN` and was never enrolled. Single-user today, but every row has one.
   */
  owner: string;
  /** When the node traded an enrollment token for its own bearer; absent for a node that never did. */
  enrolledAt?: number;
  /** Whatever the installer detected about the machine (os, cpu, gpu, memory); free-form on purpose. */
  hardware?: Record<string, unknown>;
}

export interface ToolDef {
  type: 'tool';
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON text
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/** What one model request reported it consumed. `cachedTokens` is a subset of `promptTokens`. */
export interface TokenUsage {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
}

/** A request's tokens priced and attributed: what the hub's usage ledger records per model call. */
export interface ChatUsage extends TokenUsage {
  /** Null when the hub has no price for this model — the tokens are still recorded. */
  usd: number | null;
  provider: string;
  model: string;
  node: string;
}

/** A model's price in USD per million tokens. */
export interface ModelPrice {
  input: number;
  cachedInput: number;
  output: number;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  finish: 'stop' | 'tool_calls' | 'length';
  /** Absent when the endpoint reported no usage (an older local server, an aborted stream). */
  usage?: ChatUsage;
}

export interface JobSpec {
  type: JobType;
  tier: Tier;
  priority: Priority;
  project?: string;
  payload: unknown;
}

export interface ShellTaskPayload {
  cmd: string[];
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface JobResult {
  exitCode?: number;
  stdoutTail?: string;
  stderrTail?: string;
  data?: unknown;
  signal?: string;
  timedOut?: boolean;
}

export interface Job extends JobSpec {
  id: number;
  status: JobStatus;
  nodeId: number | null;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  result: JobResult | null;
  error: string | null;
}

export interface JobLogLine {
  jobId: number;
  seq: number;
  line: string;
  at: number;
}

export function comparePriority(a: Pick<JobSpec, 'priority'>, b: Pick<JobSpec, 'priority'>): number {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
}

export type ProjectStatus = 'active' | 'paused' | 'blocked' | 'done';

/** What the owner handed in at creation time, before anything was drafted from it. */
export interface ProjectIntake {
  /** A few sentences of "what I want", the seed a first-draft PRD is written from. */
  idea?: string;
  /** A PRD the owner already wrote and pasted in; the drafter fills its gaps rather than replacing it. */
  prd?: string;
}

/**
 * The per-project opt-in for scheduled turns (`ProjectManifest.autoRun`). `maxTurnsPerDay` counts
 * every turn — automatic or manual — in the trailing 24 hours, and `POST /turn` answers 409 at it.
 */
export interface AutoRun {
  enabled: boolean;
  everyMinutes: number;
  maxTurnsPerDay: number;
}

/**
 * A project's dev server: the argv the hub runs in `workspace/`, the port it listens on, the path
 * inside the app the preview opens on, and the capability the preview is served under.
 *
 * The app is served from the hub's *preview* listener, on its own port, at `/p/<slug>/<cap>/` — so
 * the dev server has to be built with that base path (Vite `base`, Next `basePath`), read from
 * `AGENTHUB_PREVIEW_BASE` rather than hard-coded, because resetting the link changes it. See
 * decisions 0037 and 0040.
 */
export interface PreviewConfig {
  cmd: string[];
  port: number;
  /** Where the iframe opens, relative to the app's base; defaults to `/`. */
  path?: string;
  /** 32 hex characters. Minted by the hub when the preview is saved; never taken from a request. */
  cap: string;
}

/** A preview config as the owner or an agent supplies it — the hub mints the capability itself. */
export type PreviewConfigInput = Omit<PreviewConfig, 'cap'>;

/** What the supervisor knows about a project's preview, with no request behind it. */
export interface PreviewSnapshot {
  configured: boolean;
  running: boolean;
  port: number | null;
  /** The path the preview is served under (`/p/<slug>/<cap>/`), or null when none is configured. */
  base: string | null;
  startedAt: number | null;
  /** The stored config, so the settings form and the iframe's path read from one answer. */
  config: PreviewConfig | null;
  /** True when the last run ended on its own rather than being stopped. */
  crashed: boolean;
  /** The tail of the process's output — the last 50 lines. */
  log: string[];
}

/** What `GET /api/projects/:slug/preview` answers: the snapshot plus where to reach it. */
export interface PreviewStatus extends PreviewSnapshot {
  /** The absolute address of the preview, on the preview listener's own origin. */
  url: string | null;
}

/** Turns spent in the trailing 24h against the project's cap (null when unset) and the hub's. */
export interface TurnBudget {
  usedToday: number;
  maxPerDay: number | null;
  hubUsedToday: number;
  hubMaxPerDay: number;
}

/** A project bundle's `manifest.yaml`. Lives here because `HubState` puts it on the wire. */
export interface ProjectManifest {
  schema: 1;
  slug: string;
  title: string;
  status: ProjectStatus;
  priority: Priority;
  intent: string;
  links: string[];
  createdAt: number;
  updatedAt: number;
  index: string[]; // relative paths of bundle files
  /** Absent means `auto` — the hub-wide default of local first, cloud as overflow. */
  modelPolicy?: ModelPolicy;
  /** The harness this project's employees run on unless their own `harness` says otherwise. */
  harness?: HarnessKind;
  /** The owner's raw idea/PRD from `POST /api/projects`; kept so the drafter can be run later. */
  intake?: ProjectIntake;
  /** Unattended turns for this project. Absent means off: a turn is the hub's most expensive unit. */
  autoRun?: AutoRun;
  /** When the scheduler last started an automatic turn; persisted so a restart doesn't re-fire early. */
  lastAutoTurnAt?: number;
  /** `auditPrd(prd.md).score`, refreshed on every PRD write, so the UI can badge an unfinished PRD. */
  prdScore?: number;
  /**
   * The shell command `complete_milestone` runs in `workspace/` to verify a milestone, when the
   * project's tests aren't a plain `npm test`. Absent, the command is inferred from the workspace.
   */
  verifyCmd?: string;
  /** Present on a project imported from a repository; absent on one started from an idea or a PRD. */
  source?: ProjectSource;
  /** The dev server the hub supervises and proxies at `/preview/<slug>/`. Absent means none. */
  preview?: PreviewConfig;
  /**
   * How the project's latest finished manager turn ended. Not part of the stored manifest: the hub
   * adds it to the entries of `HubState.projects`, from the transcript, so the sidebar can show a
   * failed turn before the browser has loaded any turns for the project.
   */
  lastTurn?: { outcome: string; endedAt: number };
}

// --- imported repositories ------------------------------------------------------

/**
 * Where an imported project's code came from, and the one branch agents are allowed to push.
 *
 * `branch` is the repository's own branch — what was cloned and what a pull request targets; it is
 * never written to. `pushBranch` (`agenthub/<slug>`) is the hub's, and the owner merges it through a
 * pull request they open themselves.
 */
export interface ProjectSource {
  kind: 'github';
  owner: string;
  repo: string;
  branch: string;
  /** HEAD of `branch` when the repository was cloned, so a diff has a starting point. */
  importedCommit: string;
  pushBranch: string;
  /** When the hub last pushed `pushBranch`; absent until the first milestone was verified. */
  pushedAt?: number;
  /** The pull request open for `pushBranch`, once one has been opened. */
  prUrl?: string;
}

/** A repository named as `owner/repo`, however the owner spelled it. */
export interface GithubRepoRef {
  owner: string;
  repo: string;
}

// GitHub's own rules: an account name is alphanumeric with single dashes, at most 39 characters; a
// repository name also allows `.` and `_`. Both are checked here rather than by the clone, so a
// hostile "repo name" can never reach a git command line as an option or a path segment.
const GH_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const GH_REPO_RE = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * The repository an owner named, from any of the three spellings they are likely to paste: the
 * browser URL (`https://github.com/owner/repo`, with or without `.git` or a trailing slash), the SSH
 * remote (`git@github.com:owner/repo.git`), or the short `owner/repo`. Null for anything else —
 * including a URL on another host, which is refused rather than cloned.
 *
 * Shared because both ends need it: the wizard so it can complain before posting, and the hub
 * because it must validate whatever actually arrives.
 */
export function parseGithubSource(input: string): GithubRepoRef | null {
  const raw = input.trim();
  if (!raw) return null;
  const ssh = /^git@github\.com:(.+)$/.exec(raw);
  const https = /^https?:\/\/(?:www\.)?github\.com\/(.+)$/i.exec(raw);
  const path = ssh?.[1] ?? https?.[1] ?? raw;
  const parts = path.replace(/\/+$/, '').split('/');
  if (parts.length !== 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!GH_OWNER_RE.test(owner) || !GH_REPO_RE.test(repo) || repo === '.' || repo === '..') return null;
  return { owner, repo };
}

// --- product plan: PRD, roadmap, docs ------------------------------------------

export type MilestoneStatus = 'planned' | 'in-progress' | 'done' | 'blocked';

/** One ordered step of a project's roadmap, stored in the bundle's `roadmap.yaml`. */
export interface Milestone {
  id: string;
  title: string;
  summary: string;
  status: MilestoneStatus;
  /** Coarse and optional — "half a day", "2 days" — omitted when nobody is sure. */
  estimate?: string;
  /** Ids of earlier milestones this one needs finished first. */
  dependsOn?: string[];
  /** The bundle commit when the milestone went `in-progress`; what "changed since" is measured from. */
  startedCommit?: string;
  /** What the last `complete_milestone` found, whether or not it ended in `done`. */
  verification?: MilestoneVerification;
}

/** The evidence behind a milestone's status: tests ran (or couldn't), the reviewer read the change. */
export interface MilestoneVerification {
  tests: 'pass' | 'fail' | 'skipped';
  review: 'approved' | 'changes' | 'skipped';
  at: number;
  notes: string;
}

export const MILESTONE_STATUSES = ['planned', 'in-progress', 'done', 'blocked'] as const satisfies readonly MilestoneStatus[];

/**
 * The sections every project's PRD is expected to have, in order. They are the contract between the
 * PRD persona (which fills them), `auditPrd` (which scores them) and the UI (which lists them).
 */
export const PRD_SECTIONS: { key: string; title: string; hint: string }[] = [
  { key: 'overview', title: 'Overview & problem', hint: 'What this is, who it is for, and the problem it removes.' },
  { key: 'goals', title: 'Goals & non-goals', hint: 'What success means, and what this deliberately will not do.' },
  { key: 'users', title: 'Users & use cases', hint: 'Who uses it and the concrete jobs they use it for.' },
  { key: 'requirements', title: 'Functional requirements', hint: 'The behaviour, numbered and specific enough to build from.' },
  { key: 'ux', title: 'UX & UI', hint: 'The screens and flows, and what each one shows.' },
  { key: 'data', title: 'Data model', hint: 'The entities, their fields and how they relate.' },
  { key: 'architecture', title: 'Architecture', hint: 'The components, the named technologies and how they talk.' },
  { key: 'security', title: 'Security & privacy', hint: 'Authn/authz, the data held, and the threat cases handled.' },
  { key: 'scale', title: 'Scalability & performance', hint: 'Expected load, the limits, and the latency budget.' },
  { key: 'ops', title: 'Reliability & operations', hint: 'Deploys, backups, monitoring and what happens when it breaks.' },
  { key: 'testing', title: 'Testing & acceptance', hint: 'How it is tested and the acceptance criteria for done.' },
  { key: 'risks', title: 'Risks & open questions', hint: 'What could sink this, and what is still undecided.' },
];

/** `auditPrd`'s verdict: per-section coverage plus the 0..100 score the UI badges. */
export interface PrdAudit {
  sections: { key: string; title: string; present: boolean; thin: boolean }[];
  /** Percentage of sections that are present and not thin, rounded. */
  score: number;
  /** Titles of the sections that are missing or thin. */
  missing: string[];
}

/** One page of the project's living documentation, as `GET /api/projects/:slug/docs` lists it. */
export interface DocPage {
  slug: string;
  title: string;
  updatedAt: number;
}

/**
 * What `GET /api/models` answers: every model this hub can actually route to right now. `local` is
 * one row per online serving endpoint; `cloud` is one row per configured provider, with the ids that
 * provider will serve (Fireworks lists them; Anthropic has no catalog call, so it reports the two it
 * is configured with) and the ids each tier uses today.
 */
export interface ModelCatalog {
  local: { node: string; tier: Tier; model: string }[];
  cloud: {
    provider: CloudProvider;
    models: string[];
    /** Ids the hub knows but refuses right now (Fireworks' hard models while FIREWORKS_HARD_MODELS is unset). */
    disabled?: string[];
    /** Price per model id, `models` and `disabled` alike; null for one the hub has no price for. */
    prices?: Record<string, ModelPrice | null>;
    configured: { orchestrator: string; worker: string };
  }[];
}

export type BrowserRequesterKind = 'owner' | 'orchestrator' | 'subagent';

/** Who wants the browser. `id` identifies the requester across polls (agent id, or `owner`). */
export interface BrowserRequester {
  kind: BrowserRequesterKind;
  id: string;
  project?: string;
}

export interface BrowserLease {
  leaseId: string;
  requester: BrowserRequester;
  expiresAt: number;
  /** The pool slot this lease drives: a browser node and a context on it (FR-D8). */
  node: string;
  slot: number;
  /** When the lease was granted — renewals push `expiresAt`, never this. */
  since: number;
}

/** One session in the browser pool, and its lease when somebody holds it. */
export interface BrowserSlotStatus {
  node: string;
  slot: number;
  lease: BrowserLease | null;
  /** True while the node is draining: the slot finishes its lease but takes no new one. */
  draining?: boolean;
}

/** The browser room as the UI sees it: who holds the lease, who is waiting, which node it runs on. */
export interface BrowserStatus {
  /** The first held slot's lease — the single-browser view, kept for clients from before the pool. */
  holder: BrowserLease | null;
  queue: BrowserRequester[];
  /** Name of the first online node advertising the browser capability, null when none is up. */
  node: string | null;
  /** Every slot of every online browser node; optional so a hub from before the pool still type-checks. */
  slots?: BrowserSlotStatus[];
}

export interface HubState {
  nodes: NodeInfo[];
  agents: { id: number; name: string; tier: Tier; systemPrompt: string }[];
  jobs: Job[];
  streams: Record<string, number>;
  /** Optional so a hub (or a UI) built before project bundles still satisfies the type. */
  projects?: ProjectManifest[];
  /** Optional for the same reason: a UI built before the browser lease still satisfies the type. */
  browser?: BrowserStatus;
}

export type WsMessage =
  | { type: 'state'; state: HubState }
  | { type: 'agent-busy'; agentId: number; busy: boolean }
  // A project agent (the manager, or a roster member id) is mid-reply in a one-on-one chat.
  | { type: 'project-busy'; slug: string; who: string; busy: boolean }
  // A turn the hub declined to run (daily cap, hub cap) — the UI toasts it.
  | { type: 'turn-refused'; slug: string; reason: string }
  // Only reaches sockets that sent {type:'subscribe', topic:'browser'} — frames are big and most
  // clients are not looking at the screening room.
  | { type: 'browser-frame'; nodeName: string; slot?: number; leaseId: string | null; jpegBase64: string; at: number }
  | TurnEventFrame;

// --- orchestrator turn events --------------------------------------------------

/**
 * What happens inside one orchestrator turn, as it happens: the manager's own text and tool calls,
 * the subagents it spawns (whose events are forwarded with their own `who`), milestone verifications
 * and the turn's start and end. Streamed live over the websocket and replayed by `/turns`.
 */
export type TurnEvent =
  | { kind: 'turn-start'; who: 'manager' }
  /** `text` is at most 300 chars. */
  | { kind: 'text'; who: string; text: string }
  /** `args` is a JSON-ish summary of at most 200 chars. */
  | { kind: 'tool-call'; who: string; tool: string; args: string }
  /** `summary` is at most 200 chars; `ok` is false when the result was an `error:`. */
  | { kind: 'tool-result'; who: string; tool: string; ok: boolean; summary: string; ms: number }
  /** `who` is the member id; `task` is at most 200 chars. */
  | { kind: 'subagent-start'; who: string; name: string; role: string; task: string }
  | { kind: 'subagent-end'; who: string; outcome: string; ms: number }
  | { kind: 'verify'; milestoneId: string; tests: 'pass' | 'fail' | 'skipped'; review: 'approved' | 'changes' | 'skipped'; summary: string }
  /**
   * What one model call by `who` cost; `usd` is null for a model the hub has no price for. A turn's
   * total is the sum of these — see `TurnRecord.cost`, which is the only place it is stated.
   */
  | { kind: 'usage'; who: string; usd: number | null; tokens: number }
  | { kind: 'turn-end'; outcome: string; ms: number; summary: string };

export interface TurnEventFrame { type: 'turn-event'; slug: string; sessionId: number; at: number; event: TurnEvent }

/** One orchestrator turn as `GET /api/projects/:slug/turns` replays it. */
export interface TurnRecord {
  sessionId: number;
  startedAt: number;
  endedAt: number | null;
  outcome: string | null;
  summary: string;
  /** The manager's own tool calls — the ones its turn budget counts. */
  toolCalls: number;
  /** The turn's own spend: the sum of its `usage` events, manager and subagents alike. */
  cost: { usd: number; tokens: number };
  events: (TurnEvent & { at: number })[];
}

/** `GET /api/usage/summary`: what the hub spent since a moment, and where it went. */
export interface UsageSummary {
  since: number;
  usd: number;
  tokens: { prompt: number; cached: number; completion: number };
  byModel: { provider: string; model: string; usd: number; tokens: number }[];
  bySubject: { subject: string; usd: number; tokens: number }[];
}

/** The summary plus where the daily cloud cap stands; `maxCloudUsdPerDay` is null when unset. */
export interface UsageReport extends UsageSummary {
  cap: { maxCloudUsdPerDay: number | null; cloudUsdToday: number };
}

/** Exactly the video payload of PRD §11 / the plan's Global Constraints. */
export interface VideoPayload {
  prompt: string;
  mode: 't2v' | 'i2v' | 'ref2v';
  durationSec: number;
  aspect: '16:9' | '9:16' | '1:1' | '3:4' | '4:3' | '21:9' | '3:2';
  resolution: '768p' | '1080p';
  imagePath?: string;
}

export const VIDEO_MODES = ['t2v', 'i2v', 'ref2v'] as const;
export const VIDEO_ASPECTS = ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9', '3:2'] as const;
export const VIDEO_RESOLUTIONS = ['768p', '1080p'] as const;
export const VIDEO_DURATION_MIN = 4;
export const VIDEO_DURATION_MAX = 15;

/** What everything but `prompt` becomes when the caller (Telegram, a tool) doesn't say. */
export const VIDEO_DEFAULTS = { mode: 't2v', durationSec: 6, aspect: '16:9', resolution: '768p' } as const;

/** Returns the payload, or null when it doesn't match the schema exactly. */
export function parseVideoPayload(raw: unknown): VideoPayload | null {
  const p = raw as Partial<VideoPayload> | undefined;
  if (!p || typeof p !== 'object') return null;
  if (typeof p.prompt !== 'string' || p.prompt === '') return null;
  if (typeof p.mode !== 'string' || !VIDEO_MODES.includes(p.mode as VideoPayload['mode'])) return null;
  if (typeof p.durationSec !== 'number' || !Number.isFinite(p.durationSec)
    || p.durationSec < VIDEO_DURATION_MIN || p.durationSec > VIDEO_DURATION_MAX) return null;
  if (typeof p.aspect !== 'string' || !VIDEO_ASPECTS.includes(p.aspect as VideoPayload['aspect'])) return null;
  if (typeof p.resolution !== 'string' || !VIDEO_RESOLUTIONS.includes(p.resolution as VideoPayload['resolution'])) return null;
  if (p.imagePath !== undefined && typeof p.imagePath !== 'string') return null;
  // i2v/ref2v animate a source image — without one there's nothing to animate.
  if ((p.mode === 'i2v' || p.mode === 'ref2v') && !p.imagePath) return null;
  // Rebuilt field by field rather than handed back as-is: whatever else the caller put in the
  // object (a stray `project`, a hand-written extra key) must not ride along into the job payload
  // and out to the daemon.
  return {
    prompt: p.prompt, mode: p.mode, durationSec: p.durationSec, aspect: p.aspect, resolution: p.resolution,
    ...(p.imagePath !== undefined ? { imagePath: p.imagePath } : {}),
  };
}

/**
 * Fills the defaults a caller left out, then validates. Used by every hub-side entry point
 * (`POST /api/video`, `/video`, the `generate_video` tool) so all three take the same shapes and
 * reject the same ones; the daemon still re-validates what it is handed.
 */
export function videoPayloadFrom(raw: unknown): VideoPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  // Explicit `undefined` reads as "didn't say" — a spread would otherwise let it blank out a
  // default and fail validation on a field the caller never meant to set.
  const given = Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([, v]) => v !== undefined));
  return parseVideoPayload({ ...VIDEO_DEFAULTS, ...given });
}

// --- project team roster ------------------------------------------------------

/** The roles a team member — and so a subagent — can have. The manager is the orchestrator itself. */
export const TEAM_ROLES = ['coder', 'researcher', 'reviewer', 'browser-operator'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/** The fixed avatar set the UI draws from; a member's `avatar` must be one of these. */
export const AVATARS = ['robot-cyan', 'robot-magenta', 'robot-amber', 'robot-violet', 'robot-green', 'robot-white'] as const;
export type Avatar = (typeof AVATARS)[number];

/**
 * Which runtime executes an employee's task. `builtin` is the hub's own tool loop — the manager's
 * runtime and the fallback for everyone. `pi` is the open-source coding agent (pi.dev) run as a
 * subprocess in the workspace. `claude-code` is reserved for the third implementation (FR-G3).
 */
export const HARNESS_KINDS = ['builtin', 'pi', 'claude-code'] as const;
export type HarnessKind = (typeof HARNESS_KINDS)[number];

/** One entry of `GET /api/harnesses`: whether this hub host can actually run that harness today. */
export interface HarnessInfo {
  kind: HarnessKind;
  /** `builtin` is always available; an external harness is available when its CLI is on PATH. */
  available: boolean;
  /** What the CLI reports for `--version`; absent when it is not installed. */
  version?: string;
}

/** One employee on a project's roster, stored in the bundle's `team.yaml`. */
export interface TeamMember {
  /** Slug-ish, unique within the project; generated from the role (`coder-1`). */
  id: string;
  name: string;
  role: TeamRole;
  avatar: string;
  /** Appended to the role's system prompt when this member runs a task. At most 2000 chars. */
  instructions?: string;
  /** Overrides the project's `modelPolicy` for this employee's tasks; absent = project default. */
  model?: ModelPolicy;
  /**
   * Which harness runs this employee's tasks; absent falls back to `manifest.harness`, and absent
   * on both means `builtin`. A kind the hub host cannot run falls back to `builtin` at run time.
   */
  harness?: HarnessKind;
  createdAt: number;
}

/** What a member's latest session says they are doing right now. */
export interface TeamSessionView {
  id: number;
  startedAt: number;
  outcome: string | null;
  /** Tail of the session's last message, at most 200 chars. */
  lastMessage: string;
}

export type TeamStatus = 'idle' | 'working';

export interface TeamMemberView extends TeamMember {
  status: TeamStatus;
  /** The member's most recent session, when they have ever run one. */
  currentSession?: TeamSessionView;
  sessionsCount: number;
}

/** `GET /api/projects/:slug/team`. The manager is the project orchestrator, not a roster member. */
export interface TeamRoster {
  members: TeamMemberView[];
  manager: { status: TeamStatus; currentSession?: TeamSessionView };
}
