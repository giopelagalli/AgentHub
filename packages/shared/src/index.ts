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

export interface HubState {
  nodes: NodeInfo[];
  agents: { id: number; name: string; tier: Tier; systemPrompt: string }[];
  jobs: Job[];
  streams: Record<string, number>;
}

export type WsMessage =
  | { type: 'state'; state: HubState }
  | { type: 'agent-busy'; agentId: number; busy: boolean };
