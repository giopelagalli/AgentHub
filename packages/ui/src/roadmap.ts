/**
 * The roadmap view's wire shapes and its row model. Pure — the DOM lives in `views/roadmap.ts`.
 *
 * The hub owns the order; this file only numbers it, marks the current milestone, and works out
 * which of the two move buttons have nowhere to go.
 */

export const MILESTONE_STATUSES = ['planned', 'in-progress', 'done', 'blocked'] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

/** What the last turn that touched a milestone found when it checked the work. */
export interface MilestoneVerification {
  tests: 'pass' | 'fail' | 'skipped';
  review: 'approved' | 'changes' | 'skipped';
  at: number;
  notes?: string;
}

export interface Milestone {
  id: string;
  title: string;
  summary: string;
  status: MilestoneStatus;
  /** Free text ("2 days", "~1 week"); absent where nobody estimated it. */
  estimate?: string;
  /** Absent until a turn has verified the milestone. */
  verification?: MilestoneVerification;
}

export interface VerifyChip {
  label: string;
  /** Green for a pass, red for a failure, amber for changes requested, mute for skipped. */
  tone: 'pass' | 'fail' | 'changes' | 'skipped';
}

/** The two small chips a verified milestone wears beside its status: tests, then review. */
export function verificationChips(verification: MilestoneVerification | undefined): VerifyChip[] {
  if (!verification) return [];
  const tests: VerifyChip = {
    label: `tests ${verification.tests}`,
    tone: verification.tests === 'pass' ? 'pass' : verification.tests === 'fail' ? 'fail' : 'skipped',
  };
  const review: VerifyChip = {
    label: `review ${verification.review}`,
    tone: verification.review === 'approved' ? 'pass' : verification.review === 'changes' ? 'changes' : 'skipped',
  };
  return [tests, review];
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

export interface RoadmapEmptyState {
  line: string;
  hint: string;
  /** `generate` runs the planner; `prd` swaps the sheet to the document that has to exist first. */
  action: 'generate' | 'prd';
}

/**
 * What the empty roadmap view says and offers. Generating reads the PRD, so offering it before a
 * PRD is drafted just invites a 400 — point at the PRD instead until one exists.
 */
export function roadmapEmptyState(prdDrafted: boolean): RoadmapEmptyState {
  return prdDrafted
    ? {
      line: 'No roadmap yet — generate from the PRD.',
      hint: 'The planner reads the PRD and proposes the milestones in order.',
      action: 'generate',
    }
    : {
      line: 'The roadmap comes from the PRD.',
      hint: 'Draft the PRD first — the planner reads it to propose the milestones.',
      action: 'prd',
    };
}

/** The rows the view draws, in the order the hub gave them. */
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
