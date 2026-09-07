export type Tier = 'orchestrator' | 'worker' | 'vision' | 'video-gen';
export type Priority = 'interactive' | 'project' | 'batch';
export const PRIORITY_RANK: Record<Priority, number> = { interactive: 0, project: 1, batch: 2 };
export type JobType = 'llm-session' | 'video-gen' | 'shell-task' | 'browser-lease';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface ServingEndpoint {
  tier: Tier;
  url: string;
  model: string;
  maxStreams: number;
}

export interface NodeRegistration {
  name: string;
  arch: string;
  endpoints: ServingEndpoint[];
  jobTypes?: JobType[];
  /** Present only on a node running the browser capability; `url` is its local browser server. */
  browser?: { url: string };
  /** Serving profiles this node can switch between (spec §4.3); empty when it has none. */
  profiles?: string[];
  /** True when the node has a local ComfyUI configured for `video-gen` jobs. */
  video?: boolean;
  /** Present only when the node runs a control server; `url` is its `/control/*` base. */
  control?: { url: string };
}

export interface NodeInfo extends NodeRegistration {
  id: number;
  status: 'online' | 'offline';
  lastHeartbeat: number;
  jobTypes: JobType[];
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

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  finish: 'stop' | 'tool_calls' | 'length';
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
}

/** The browser room as the UI sees it: who holds the lease, who is waiting, which node it runs on. */
export interface BrowserStatus {
  holder: BrowserLease | null;
  queue: BrowserRequester[];
  /** Name of the online node advertising the browser capability, null when none is up. */
  node: string | null;
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
  // Only reaches sockets that sent {type:'subscribe', topic:'browser'} — frames are big and most
  // clients are not looking at the screening room.
  | { type: 'browser-frame'; nodeName: string; leaseId: string | null; jpegBase64: string; at: number };

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
  return p as VideoPayload;
}

/**
 * Fills the defaults a caller left out, then validates. Used by every hub-side entry point
 * (`POST /api/video`, `/video`, the `generate_video` tool) so all three take the same shapes and
 * reject the same ones; the daemon still re-validates what it is handed.
 */
export function videoPayloadFrom(raw: unknown): VideoPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  return parseVideoPayload({ ...VIDEO_DEFAULTS, ...(raw as Record<string, unknown>) });
}
