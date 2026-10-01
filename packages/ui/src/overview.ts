import type { Briefing } from './panels/master.js';
import { roadmapRows, type RoadmapDoc } from './roadmap.js';
import type { TurnRecord } from './turns.js';

/**
 * The Overview tab's model. Pure — it turns the roadmap, the latest briefing and the turns into
 * the few things the tab says: where the project is, how far along, what happened last, and the
 * one thing to do next when there is nothing yet to show.
 */

/** The project's sections, in the order the toolbar's segmented control shows them. */
export const PROJECT_TABS = ['overview', 'plan', 'docs', 'code', 'activity'] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];

export const TAB_LABELS: Record<ProjectTab, string> = {
  overview: 'Overview',
  plan: 'Plan',
  docs: 'Docs',
  code: 'Code',
  activity: 'Activity',
};

/** Plan's two halves, Docs' two and Code's three, each a sub-segmented control under the toolbar. */
export type PlanPart = 'prd' | 'roadmap';
export type DocsPart = 'pages' | 'media';
export type CodePart = 'files' | 'terminal' | 'preview';

export interface OverviewNow {
  /** The milestone being worked on; else the next one planned; null without a roadmap. */
  milestone: string | null;
  /** Whether `milestone` is in progress (true) or only the next one up (false). */
  milestoneCurrent: boolean;
  /** Milestones done out of all of them; null without a roadmap. */
  progress: { done: number; total: number } | null;
  /** The latest briefing's summary, which the tab clamps to two lines. */
  briefing: string | null;
  /** The first next step the briefing names. */
  next: string | null;
  blockers: string[];
}

export function overviewNow(roadmap: RoadmapDoc | null, briefing: Briefing | null): OverviewNow {
  const rows = roadmapRows(roadmap);
  const current = rows.find((row) => row.current) ?? rows.find((row) => row.status === 'in-progress');
  const upcoming = rows.find((row) => row.status === 'planned');
  const done = rows.filter((row) => row.status === 'done').length;
  return {
    milestone: current?.title ?? upcoming?.title ?? null,
    milestoneCurrent: !!current,
    progress: rows.length ? { done, total: rows.length } : null,
    briefing: briefing?.summary?.trim() || null,
    next: briefing?.nextSteps?.find((step) => step.trim())?.trim() ?? null,
    blockers: (briefing?.blockers ?? []).filter((b) => b.trim()),
  };
}

/** The one invitation the Overview leads with while the project has nothing to show yet. */
export interface OverviewInvite {
  kind: 'prd' | 'roadmap' | 'turn';
  line: string;
  action: string;
}

/**
 * What to do first, in the order a project is built: describe it, plan it, run it. Null while any
 * of the three is still loading (an invitation that flips a moment later is worse than none), and
 * once the project has run a turn.
 */
export function overviewInvite(
  prdDrafted: boolean | null, milestones: number | null, turns: number | null,
): OverviewInvite | null {
  if (prdDrafted === null || milestones === null || turns === null) return null;
  if (!prdDrafted) {
    return { kind: 'prd', line: 'Describe the idea — we’ll draft the PRD.', action: 'Draft the PRD' };
  }
  if (!milestones) {
    return { kind: 'roadmap', line: 'The PRD is ready. Turn it into milestones.', action: 'Generate the roadmap' };
  }
  if (!turns) {
    return { kind: 'turn', line: 'The plan is in place. The team starts on the first milestone.', action: 'Run the first turn' };
  }
  return null;
}

/** The last few turns, newest first, for the Overview's activity lines. */
export function recentTurns(turns: TurnRecord[], count = 3): TurnRecord[] {
  return turns.slice(0, count);
}

/** A turn's outcome as one of three tones: running, failed, or fine. */
export function turnTone(turn: TurnRecord): 'running' | 'failed' | 'ok' {
  if (turn.endedAt === null) return 'running';
  return turn.outcome && /fail|error|abort/i.test(turn.outcome) ? 'failed' : 'ok';
}
