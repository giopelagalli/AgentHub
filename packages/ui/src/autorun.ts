import type { AutoRun, TurnBudget } from '@agenthub/shared';

/**
 * The auto-run toggle: the interval choices `renderHead`'s inline form offers, the labels for the
 * toggle button and the budget line beside it, and the form's own validation. Pure — the DOM lives
 * in `pages/projects.ts`.
 */

export const AUTO_RUN_INTERVALS = [15, 30, 60, 120, 240] as const;

/** `15m`, `30m`, `1h`, `2h`, `4h` — and `90m` for anything not a whole number of hours. */
export function formatInterval(minutes: number): string {
  return minutes < 60 || minutes % 60 !== 0 ? `${minutes}m` : `${minutes / 60}h`;
}

/** The toggle button's text: off when there's nothing to run, else the schedule in short form. */
export function autoRunLabel(autoRun: AutoRun | undefined): string {
  if (!autoRun || !autoRun.enabled) return 'Auto-run: off';
  return `Auto-run: every ${formatInterval(autoRun.everyMinutes)} · ${autoRun.maxTurnsPerDay}/day`;
}

/** The turns left today, project cap and hub cap both — empty until a budget has arrived. */
export function budgetText(budget: TurnBudget | undefined): string {
  if (!budget) return '';
  const hubLeft = Math.max(0, budget.hubMaxPerDay - budget.hubUsedToday);
  if (budget.maxPerDay !== null) {
    const left = Math.max(0, budget.maxPerDay - budget.usedToday);
    return `${left}/${budget.maxPerDay} turns left today · hub ${hubLeft}/${budget.hubMaxPerDay}`;
  }
  return `hub ${hubLeft}/${budget.hubMaxPerDay} turns left today`;
}

/** The inline form's fields, validated into an `AutoRun` — null when either is out of range. */
export function autoRunFromForm(
  form: { enabled: boolean; everyMinutes: string | number; maxTurnsPerDay: string | number },
): AutoRun | null {
  const everyMinutes = Number(form.everyMinutes);
  if (!(AUTO_RUN_INTERVALS as readonly number[]).includes(everyMinutes)) return null;
  const maxTurnsPerDay = Number(form.maxTurnsPerDay);
  if (!Number.isInteger(maxTurnsPerDay) || maxTurnsPerDay < 1 || maxTurnsPerDay > 100) return null;
  return { enabled: form.enabled, everyMinutes, maxTurnsPerDay };
}
