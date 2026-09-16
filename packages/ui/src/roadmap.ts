/**
 * The roadmap tab's wire shapes and its row model. Pure — the DOM lives in `views/roadmap.ts`.
 *
 * The hub owns the order; this file only numbers it, marks the current milestone, and works out
 * which of the two move buttons have nowhere to go.
 */

export const MILESTONE_STATUSES = ['planned', 'in-progress', 'done', 'blocked'] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

export interface Milestone {
  id: string;
  title: string;
  summary: string;
  status: MilestoneStatus;
  /** Free text ("2 days", "~1 week"); absent where nobody estimated it. */
  estimate?: string;
}

export interface RoadmapDoc {
  milestones: Milestone[];
  /** The milestone being worked on, or null/absent when none is. */
  currentId?: string | null;
}

export interface RoadmapRow extends Milestone {
  /** 1-based position, which is what the row shows. */
  order: number;
  current: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
}

function status(value: string | undefined): MilestoneStatus {
  return (MILESTONE_STATUSES as readonly string[]).includes(value ?? '')
    ? (value as MilestoneStatus)
    : 'planned';
}

/** The rows the tab draws, in the order the hub gave them. */
export function roadmapRows(doc: RoadmapDoc | null): RoadmapRow[] {
  const milestones = doc?.milestones ?? [];
  const last = milestones.length - 1;
  return milestones.map((milestone, index) => ({
    ...milestone,
    title: milestone.title?.trim() || 'Untitled milestone',
    summary: milestone.summary ?? '',
    status: status(milestone.status),
    order: index + 1,
    current: !!doc?.currentId && milestone.id === doc.currentId,
    canMoveUp: index > 0,
    canMoveDown: index < last,
  }));
}
