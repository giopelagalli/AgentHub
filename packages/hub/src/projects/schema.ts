import type { Priority, ProjectStatus } from '@agenthub/shared';

// The manifest shape lives in @agenthub/shared because HubState carries it to the UI.
export type { ProjectManifest as Manifest, ProjectStatus } from '@agenthub/shared';

export const SLUG_RE = /^[a-z0-9-]{1,40}$/;

/**
 * A slug that can't name a bundle directory. Typed because a slug is a path segment: callers that
 * take one from the network must answer "malformed" rather than "not found", and must never let it
 * reach `join(root, slug)`.
 */
export class InvalidSlugError extends Error {
  constructor(slug: unknown) {
    super(`invalid slug: ${JSON.stringify(slug)}`);
    this.name = 'InvalidSlugError';
  }
}

export function validateSlug(slug: string): asserts slug is string {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw new InvalidSlugError(slug);
}

export type TaskStatus = 'backlog' | 'in-progress' | 'done' | 'blocked';

export interface TaskItem {
  id: string;
  title: string;
  status: TaskStatus;
  owner?: string;
  notes?: string;
}

export interface Tasks {
  tasks: TaskItem[];
}

export interface Briefing {
  slug: string;
  title: string;
  status: ProjectStatus;
  priority: Priority;
  summary: string; // <= 600 chars
  progress: { done: number; total: number };
  blockers: string[];
  nextSteps: string[];
  updatedAt: number;
}

const STATUSES: ProjectStatus[] = ['active', 'paused', 'blocked', 'done'];
const PRIORITIES: Priority[] = ['interactive', 'project', 'batch'];

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export function validateBriefing(b: unknown): asserts b is Briefing {
  if (typeof b !== 'object' || b === null) throw new Error('briefing: expected an object');
  const r = b as Record<string, unknown>;
  if (typeof r.slug !== 'string' || !SLUG_RE.test(r.slug)) throw new Error('briefing: invalid slug');
  if (typeof r.title !== 'string' || r.title.length === 0) throw new Error('briefing: title required');
  if (!STATUSES.includes(r.status as ProjectStatus)) throw new Error(`briefing: invalid status ${JSON.stringify(r.status)}`);
  if (!PRIORITIES.includes(r.priority as Priority)) throw new Error(`briefing: invalid priority ${JSON.stringify(r.priority)}`);
  if (typeof r.summary !== 'string') throw new Error('briefing: summary must be a string');
  if (r.summary.length > 600) throw new Error(`briefing: summary exceeds 600 chars (${r.summary.length})`);
  if (typeof r.progress !== 'object' || r.progress === null) throw new Error('briefing: progress required');
  const progress = r.progress as Record<string, unknown>;
  if (typeof progress.done !== 'number' || typeof progress.total !== 'number') throw new Error('briefing: progress.done/total must be numbers');
  if (!isStringArray(r.blockers)) throw new Error('briefing: blockers must be a string[]');
  if (!isStringArray(r.nextSteps)) throw new Error('briefing: nextSteps must be a string[]');
  if (typeof r.updatedAt !== 'number') throw new Error('briefing: updatedAt must be a number');
}
