import { MILESTONE_STATUSES, type Milestone, type MilestoneStatus, type MilestoneVerification } from '@agenthub/shared';

/**
 * The milestone the project is on: the first one that isn't done. A roadmap whose every milestone is
 * done has no current one, and neither does an empty roadmap.
 */
export function currentMilestoneId(milestones: Milestone[]): string | null {
  return milestones.find((m) => m.status !== 'done')?.id ?? null;
}

// Milestone ids are positional, not stable: `write_roadmap` (below, via `normalizeMilestones`)
// renumbers m1..mN from list order on every persona rewrite, while `moveMilestone` reorders the
// list without renumbering it. A `dependsOn` value captured before either call is not guaranteed
// to still point at the same milestone afterwards — don't rely on it surviving until milestones
// get an id of their own that isn't just their position.

/** Moves one milestone one place up or down. Already at the edge (or unknown) leaves the order alone. */
export function moveMilestone(milestones: Milestone[], id: string, direction: 'up' | 'down'): Milestone[] {
  const from = milestones.findIndex((m) => m.id === id);
  const to = direction === 'up' ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= milestones.length) return milestones;
  const next = [...milestones];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Moves one milestone to the 0-based index `to`, clamped to the list. Already there (or unknown) leaves the order alone. */
export function moveMilestoneTo(milestones: Milestone[], id: string, to: number): Milestone[] {
  const from = milestones.findIndex((m) => m.id === id);
  const target = Math.min(Math.max(to, 0), milestones.length - 1);
  if (from < 0 || target === from) return milestones;
  const next = [...milestones];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return next;
}

/**
 * Applies an edit to one milestone — the owner's, or a turn's status change with the evidence behind
 * it. Ids are positional handles the roadmap is ordered by, so they are never patched; everything
 * else is replaced field by field, and `estimate: ''` clears it.
 */
export function patchMilestone(
  milestones: Milestone[],
  id: string,
  patch: { title?: string; summary?: string; status?: MilestoneStatus; estimate?: string; startedCommit?: string; verification?: MilestoneVerification },
): Milestone[] {
  return milestones.map((m) => {
    if (m.id !== id) return m;
    const next: Milestone = { ...m };
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.summary !== undefined) next.summary = patch.summary;
    if (patch.status !== undefined) next.status = patch.status;
    if (patch.startedCommit !== undefined) next.startedCommit = patch.startedCommit;
    if (patch.verification !== undefined) next.verification = patch.verification;
    if (patch.estimate !== undefined) {
      if (patch.estimate) next.estimate = patch.estimate;
      else delete next.estimate;
    }
    return next;
  });
}

/**
 * Validates a caller-supplied milestone list (a model's tool call, or the drafter's parsed JSON) and
 * renumbers it `m1..mN` in order. Ids are assigned here rather than taken from the caller: they are
 * the roadmap's position, and a model that invents its own would break the ordering the rest of the
 * system reads.
 */
export function normalizeMilestones(raw: unknown): Milestone[] {
  if (!Array.isArray(raw)) throw new Error('milestones must be an array');
  const ids = raw.map((_, i) => `m${i + 1}`);
  return raw.map((entry, i): Milestone => {
    const item = (entry ?? {}) as Record<string, unknown>;
    if (typeof item.title !== 'string' || !item.title) throw new Error(`milestones[${i}]: title is required`);
    if (item.summary !== undefined && typeof item.summary !== 'string') throw new Error(`milestones[${i}]: summary must be a string`);
    const status = item.status === undefined ? 'planned' : item.status;
    if (!MILESTONE_STATUSES.includes(status as MilestoneStatus)) {
      throw new Error(`milestones[${i}]: status must be one of: ${MILESTONE_STATUSES.join(', ')}`);
    }
    // A dependency on a milestone that isn't in the list would point at nothing; drop it rather than
    // reject the whole roadmap over a model's stray reference.
    const dependsOn = Array.isArray(item.dependsOn)
      ? item.dependsOn.filter((d): d is string => typeof d === 'string' && ids.includes(d))
      : [];
    return {
      id: ids[i],
      title: item.title,
      summary: typeof item.summary === 'string' ? item.summary : '',
      status: status as MilestoneStatus,
      ...(typeof item.estimate === 'string' && item.estimate ? { estimate: item.estimate } : {}),
      ...(dependsOn.length ? { dependsOn } : {}),
      // Not something a model sets — it's the evidence complete_milestone already recorded on this
      // milestone. Dropping it here would erase that history the moment the roadmap is rewritten.
      ...(typeof item.startedCommit === 'string' && item.startedCommit ? { startedCommit: item.startedCommit } : {}),
      ...(item.verification && typeof item.verification === 'object' ? { verification: item.verification as MilestoneVerification } : {}),
    };
  });
}
