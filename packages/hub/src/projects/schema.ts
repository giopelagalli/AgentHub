import { AVATARS, TEAM_ROLES, type Priority, type ProjectStatus, type TeamMember, type TeamRole } from '@agenthub/shared';

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

// --- team roster --------------------------------------------------------------

export const TEAM_NAME_LIMIT = 40;
export const TEAM_INSTRUCTIONS_LIMIT = 2000;

/** Either the member to append, or the status and message the API should answer with. */
export type NewMemberResult = { member: TeamMember } | { error: string; code: 400 | 409 };

/** `<role>-<n>`, with `n` walked past whatever the roster already holds — ids are never reused. */
function nextMemberId(role: TeamRole, existing: TeamMember[]): string {
  const taken = new Set(existing.map((m) => m.id));
  let n = existing.filter((m) => m.role === role).length + 1;
  while (taken.has(`${role}-${n}`)) n++;
  return `${role}-${n}`;
}

/**
 * Validates an owner-supplied roster addition and assigns its id. Names are unique per project
 * case-insensitively: the roster is how the owner and the orchestrator refer to an employee, and two
 * Adas would make both references ambiguous.
 */
export function newTeamMember(body: unknown, existing: TeamMember[], now = Date.now()): NewMemberResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > TEAM_NAME_LIMIT) return { error: 'invalid name', code: 400 };
  if (typeof b.role !== 'string' || !TEAM_ROLES.includes(b.role as TeamRole)) return { error: 'invalid role', code: 400 };
  if (typeof b.avatar !== 'string' || !AVATARS.includes(b.avatar as (typeof AVATARS)[number])) return { error: 'invalid avatar', code: 400 };
  const instructions = b.instructions;
  if (instructions !== undefined && (typeof instructions !== 'string' || instructions.length > TEAM_INSTRUCTIONS_LIMIT)) {
    return { error: 'invalid instructions', code: 400 };
  }
  if (existing.some((m) => m.name.toLowerCase() === name.toLowerCase())) return { error: 'duplicate name', code: 409 };

  const role = b.role as TeamRole;
  const id = nextMemberId(role, existing);
  // The id is a roster key the UI puts in a URL path; a role that stopped being slug-ish would make
  // one that isn't, so it is checked rather than assumed.
  validateSlug(id);
  return { member: { id, name, role, avatar: b.avatar, ...(instructions ? { instructions } : {}), createdAt: now } };
}
