import type { PreviewStatus, TeamRoster } from '@agenthub/shared';
import { docsEntries, type DocsIndex } from './docs.js';
import { auditStrip, type PrdDoc } from './prd.js';
import { roadmapRows, type RoadmapDoc } from './roadmap.js';
import { activityHint, type TurnRecord, type TurnsState } from './turns.js';

/**
 * The big buttons above the org chart. Pure — each one turns something the hub sent into the one
 * line the button shows, so the owner can tell what state the PRD, the roadmap, the docs, the
 * team's current turn and the running app are in without opening any of them.
 */

export type ArtifactId = 'prd' | 'roadmap' | 'docs' | 'activity' | 'preview';

/** Where each button's document is in its own fetch. */
export type DocState = 'loading' | 'ready' | 'failed';

export interface ArtifactSummary {
  id: ArtifactId;
  /** The button's face. */
  label: string;
  /** What it is, under the name. */
  caption: string;
  /** One line of state: the score's sections, the milestones, the page count. */
  hint: string;
  /** The completeness score, on the only artifact the hub grades. */
  badge?: string;
  /** False while there is nothing in the artifact yet, so the button can read quieter. */
  filled: boolean;
  /** True on the Activity button while a turn is running: the hint is live and the card says so. */
  live?: boolean;
}

const CAPTIONS: Record<ArtifactId, string> = {
  prd: 'What we are building',
  roadmap: 'The order it gets built',
  docs: 'What the team wrote down',
  activity: 'What the team is doing',
  preview: 'The app, live',
};

export const ARTIFACT_LABELS: Record<ArtifactId, string> = {
  prd: 'PRD',
  roadmap: 'Roadmap',
  docs: 'Docs',
  activity: 'Activity',
  preview: 'Preview',
};

/** The heading the artifact wears once it is open in the sheet. */
export const ARTIFACT_TITLES: Record<ArtifactId, string> = {
  prd: 'Product requirements',
  roadmap: 'Roadmap',
  docs: 'Docs',
  activity: 'Activity',
  preview: 'Preview',
};

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function shell(id: ArtifactId, hint: string, filled: boolean): ArtifactSummary {
  return { id, label: ARTIFACT_LABELS[id], caption: CAPTIONS[id], hint, filled };
}

/** Loading and failed read the same on all three; only the body of the line differs. */
function pending(id: ArtifactId, state: DocState): ArtifactSummary | null {
  if (state === 'loading') return shell(id, 'Loading…', false);
  if (state === 'failed') return shell(id, 'Could not be read', false);
  return null;
}

/** The PRD button: how much of the document the hub thinks is covered, and its score. */
export function prdSummary(state: DocState, doc: PrdDoc | null): ArtifactSummary {
  const waiting = pending('prd', state);
  if (waiting) return waiting;
  if (!doc?.drafted) return shell('prd', 'Not drafted yet', false);
  const strip = auditStrip(doc.audit);
  // No graded sections means no honest score to show, so the button shows neither.
  if (!strip.chips.length) return { ...shell('prd', 'Drafted', true) };
  const short = strip.chips.filter((chip) => chip.state !== 'filled').length;
  return {
    ...shell('prd', short ? `${plural(short, 'section')} still thin` : 'Every section covered', true),
    badge: strip.scoreLabel,
  };
}

/** The roadmap button: how many milestones there are, and which one is being worked on. */
export function roadmapSummary(state: DocState, doc: RoadmapDoc | null): ArtifactSummary {
  const waiting = pending('roadmap', state);
  if (waiting) return waiting;
  const rows = roadmapRows(doc);
  if (!rows.length) return shell('roadmap', 'No milestones yet', false);
  const current = rows.find((row) => row.current);
  const tail = current ? `current: ${current.title}` : 'nothing started';
  return shell('roadmap', `${plural(rows.length, 'milestone')} · ${tail}`, true);
}

/**
 * The docs button: how many pages there are to read. The bundle always carries a decision log,
 * empty or not, so a page only counts once it has something in it.
 */
export function docsSummary(state: DocState, doc: DocsIndex | null): ArtifactSummary {
  const waiting = pending('docs', state);
  if (waiting) return waiting;
  const written = docsEntries(doc).filter(
    (entry) => entry.kind === 'page' || (entry.markdown ?? '').trim().length > 0,
  );
  if (!written.length) return shell('docs', 'No pages yet', false);
  return shell('docs', plural(written.length, 'page'), true);
}

/** The activity button: the turn in progress and who is on it, or how the last one went. */
export function activitySummary(
  state: TurnsState,
  turns: TurnRecord[],
  roster: TeamRoster | null,
  now: number,
): ArtifactSummary {
  const { hint, filled, running } = activityHint(state, turns, roster, now);
  return { ...shell('activity', hint, filled), live: running };
}

/**
 * The preview button: whether the app is up, and on which port. A project with no preview declared
 * says so rather than offering a dead button — setting one is the first thing the sheet does.
 */
export function previewSummary(state: DocState, status: PreviewStatus | null): ArtifactSummary {
  const waiting = pending('preview', state);
  if (waiting) return waiting;
  if (!status?.configured) return shell('preview', 'Not configured', false);
  if (status.running) return shell('preview', `Running on :${status.port}`, true);
  if (status.crashed) return shell('preview', 'Crashed — read the log', false);
  return shell('preview', 'Stopped', false);
}
