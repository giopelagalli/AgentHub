import { headingId } from './markdown.js';

/**
 * The PRD view's wire shapes and its completeness strip. Pure — the DOM lives in `views/prd.ts`.
 *
 * The hub grades the PRD section by section against its own fixed section list and hands back
 * `present`/`thin` per section plus a score; this file turns that verdict into a row of chips.
 * Everything here tolerates a missing or half-filled `audit`, because the view still has to render
 * when the hub answers with less than it promised.
 */

/** How well one section is covered, once the hub's two booleans are collapsed into one word. */
export type SectionState = 'filled' | 'thin' | 'missing';

export interface PrdAuditSection {
  /** Stable key from the hub's section list (`overview`, `goals`, …). */
  key: string;
  /** The heading as it appears in the document — what the chip shows, and what it scrolls to. */
  title: string;
  present: boolean;
  thin: boolean;
}

export interface PrdAudit {
  sections: PrdAuditSection[];
  /** 0–100; the strip shows it on the right. */
  score: number;
  /** Titles of the sections that are missing or thin — the same ground the chips cover. */
  missing?: string[];
}

export interface PrdDoc {
  /** False while the PRD is still the scaffold — the view shows its empty state instead. */
  drafted: boolean;
  markdown: string;
  audit?: PrdAudit;
  /** What the drafter still wants answered; only the draft stream reports these. */
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

/** A section that isn't there at all reads as missing; one that is there but slight reads as thin. */
export function sectionState(section: Pick<PrdAuditSection, 'present' | 'thin'>): SectionState {
  if (!section.present) return 'missing';
  return section.thin ? 'thin' : 'filled';
}

/** The completeness strip: one chip per section the hub graded, plus the score. */
export function auditStrip(audit: PrdAudit | undefined): AuditStrip {
  const chips = (audit?.sections ?? []).map((section) => {
    const state = sectionState(section);
    const heading = section.title?.trim() || section.key || 'Untitled section';
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
