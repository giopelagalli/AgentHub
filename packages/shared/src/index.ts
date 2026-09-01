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
}

export interface NodeInfo extends NodeRegistration {
  id: number;
  status: 'online' | 'offline';
  lastHeartbeat: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface JobSpec {
  type: JobType;
  tier: Tier;
  priority: Priority;
  project?: string;
  payload: unknown;
}

export interface Job extends JobSpec {
  id: number;
  status: JobStatus;
  nodeId: number | null;
  createdAt: number;
  updatedAt: number;
}

export function comparePriority(a: Pick<JobSpec, 'priority'>, b: Pick<JobSpec, 'priority'>): number {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
}
