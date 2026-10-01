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

/** An interval as a sentence says it: `15 minutes`, `hour`, `2 hours` — for "every …". */
export function intervalWords(minutes: number): string {
  if (minutes === 60) return 'hour';
  if (minutes < 60 || minutes % 60 !== 0) return `${minutes} minutes`;
  return `${minutes / 60} hours`;
}

/** The schedule in words people use, for the settings sheet and the Overview. */
export function scheduleSentence(autoRun: AutoRun | undefined): string {
  if (!autoRun || !autoRun.enabled) return 'Runs only when you start a turn';
  const cap = `at most ${autoRun.maxTurnsPerDay} turn${autoRun.maxTurnsPerDay === 1 ? '' : 's'} a day`;
  return `Runs on its own every ${intervalWords(autoRun.everyMinutes)}, ${cap}`;
}

/** The turns left today in a sentence — empty until a budget has arrived. */
export function budgetSentence(budget: TurnBudget | undefined): string {
  if (!budget) return '';
  const hubLeft = Math.max(0, budget.hubMaxPerDay - budget.hubUsedToday);
  const hub = `${hubLeft} of ${budget.hubMaxPerDay} left across the hub`;
  if (budget.maxPerDay === null) return `No cap for this project · ${hub}`;
  const left = Math.max(0, budget.maxPerDay - budget.usedToday);
  return `${left} of ${budget.maxPerDay} turns left today · ${hub}`;
}
