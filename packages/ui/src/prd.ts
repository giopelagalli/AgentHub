import { headingId } from './markdown.js';

/**
 * The PRD tab's wire shapes and its completeness strip. Pure — the DOM lives in `views/prd.ts`.
 *
 * The hub decides how well each section of the PRD is covered; this file turns that verdict into
 * a row of chips. Everything here tolerates a missing or half-filled `audit`, because the tab
 * still has to render when the hub answers with less than it promised.
 */

/** How well one section is covered. `present` is accepted as a synonym of `filled`. */
export type SectionState = 'filled' | 'thin' | 'missing';

export interface PrdAuditSection {
  /** The heading this verdict is about, as it appears in the document. */
  heading: string;
  state: SectionState | 'present';
}

export interface PrdAudit {
  /** 0–100; the strip shows it on the right. */
  score: number;
  sections: PrdAuditSection[];
}

export interface PrdDoc {
  /** False before anything has been drafted — the tab shows its empty state instead. */
  drafted: boolean;
  markdown: string;
  audit?: PrdAudit;
  /** What the drafter still wants answered. */
  questions?: string[];
  updatedAt?: number;
}

const STATE_LABELS: Record<SectionState, string> = {
  filled: 'covered',
  thin: 'thin',
  missing: 'missing',
};

export interface AuditChip {
  heading: string;
  state: SectionState;
  /** The full class string for the chip element. */
  className: string;
  /** Hover text: the heading and what the hub said about it. */
  hint: string;
  /** The heading `id` clicking this chip scrolls to. */
  targetId: string;
}

export interface AuditStrip {
  chips: AuditChip[];
  /** Clamped to 0–100, rounded; 0 when the hub sent no usable score. */
  score: number;
  scoreLabel: string;
}

function normalise(state: SectionState | 'present' | undefined): SectionState {
  if (state === 'present' || state === 'filled') return 'filled';
  return state === 'thin' ? 'thin' : 'missing';
}

/** The completeness strip: one chip per section the hub graded, plus the score. */
export function auditStrip(audit: PrdAudit | undefined): AuditStrip {
  const chips = (audit?.sections ?? []).map((section) => {
    const state = normalise(section.state);
    const heading = section.heading?.trim() || 'Untitled section';
    return {
      heading,
      state,
      className: `chip chip--${state}`,
      hint: `${heading} — ${STATE_LABELS[state]}`,
      targetId: headingId(heading),
    };
  });
  const raw = typeof audit?.score === 'number' && Number.isFinite(audit.score) ? audit.score : 0;
  const score = Math.round(Math.min(100, Math.max(0, raw)));
  return { chips, score, scoreLabel: `${score}%` };
}
