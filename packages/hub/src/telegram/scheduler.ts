import type { Assistant } from '../assistant/assistant.js';
import type { MasterOrchestrator } from '../projects/master.js';
import type { ProjectService } from '../projects/service.js';
import { formatBriefing } from './format.js';
import type { TelegramPort } from './port.js';

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): { clear(): void };
}

/** A real-time `Clock`: wraps `Date.now`/`setTimeout` and unrefs every timer, so a scheduled fire never keeps the process alive. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  setTimeout(fn: () => void, ms: number): { clear(): void } {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return { clear: () => clearTimeout(t) };
  }
}

export interface SchedulerDeps {
  clock: Clock;
  port: TelegramPort;
  ownerChatId: string;
  master: MasterOrchestrator;
  service: ProjectService;
  assistant: Assistant;
  briefingTime: string;
  checkinTimes: string[];
  tz?: string;
}

type Kind = 'briefing' | 'checkin';

function parseHHMM(s: string): { h: number; m: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`invalid time "${s}", expected HH:MM`);
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) throw new Error(`invalid time "${s}", expected HH:MM`);
  return { h, m: mi };
}

function partsInTz(ms: number, tz: string): { y: number; mo: number; d: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return { y: Number(parts.year), mo: Number(parts.month) - 1, d: Number(parts.day) };
}

/** The instant `ms` rendered as local wall-clock fields in `tz`, packed back into an epoch for comparison. */
function renderedAsUtc(ms: number, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
  );
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), 0);
}

/**
 * Epoch of local `y-mo-d h:m` in `tz`. There is no inverse local-to-UTC conversion without a tz
 * database, so this guesses (treating the wall-clock fields as UTC) and corrects for the zone's
 * actual offset at that instant; two passes are enough to settle any local time that exists.
 *
 * One does not: the hour skipped by a spring-forward. No instant renders as it, so the correction
 * just oscillates around the gap and lands on whichever side the arithmetic happened to leave it —
 * for a `02:30` briefing that can mean 01:30, an hour *before* the owner asked for. The final step
 * pushes such a result forward onto the far side of the gap, so a skipped time fires just after it
 * and never early.
 */
function epochForTz(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const desiredAsUtc = Date.UTC(y, mo, d, h, mi, 0);
  let guess = desiredAsUtc;
  for (let i = 0; i < 2; i++) {
    const diff = desiredAsUtc - renderedAsUtc(guess, tz);
    if (diff === 0) break;
    guess += diff;
  }
  const rendered = renderedAsUtc(guess, tz);
  if (rendered < desiredAsUtc) guess += desiredAsUtc - rendered;
  return guess;
}

function epochLocal(y: number, mo: number, d: number, h: number, mi: number): number {
  return new Date(y, mo, d, h, mi, 0, 0).getTime();
}

/**
 * Fires the daily briefing and configured check-ins at local `HH:MM` times, computed from an
 * injected `Clock` so tests never sleep. Each kind reschedules its own next occurrence *before*
 * doing any async work, so a slow send can't delay — or double-fire — the timer behind it.
 */
export class Scheduler {
  private timers: Partial<Record<Kind, { clear(): void }>> = {};

  constructor(private deps: SchedulerDeps) {}

  start(): void {
    // Idempotent: a second start() must not orphan the timers the first one set — stop() first so
    // scheduleNext never piles a new timer on top of one still pending.
    this.stop();
    this.scheduleNext('briefing');
    this.scheduleNext('checkin');
  }

  stop(): void {
    this.timers.briefing?.clear();
    this.timers.checkin?.clear();
    this.timers = {};
  }

  /** Earliest epoch strictly after `from` at which `kind` is next due. Pure — no clock reads — so tests can assert on it directly. */
  nextFire(kind: Kind, from: number): number {
    const times = kind === 'briefing' ? [this.deps.briefingTime] : this.deps.checkinTimes;
    if (!times.length) throw new Error(`no ${kind} times configured`);
    const tz = this.deps.tz;
    const candidates = times.map((t) => {
      const { h, m } = parseHHMM(t);
      if (tz) {
        const base = partsInTz(from, tz);
        let epoch = epochForTz(base.y, base.mo, base.d, h, m, tz);
        if (epoch <= from) epoch = epochForTz(base.y, base.mo, base.d + 1, h, m, tz);
        return epoch;
      }
      const dt = new Date(from);
      let epoch = epochLocal(dt.getFullYear(), dt.getMonth(), dt.getDate(), h, m);
      if (epoch <= from) epoch = epochLocal(dt.getFullYear(), dt.getMonth(), dt.getDate() + 1, h, m);
      return epoch;
    });
    return Math.min(...candidates);
  }

  private scheduleNext(kind: Kind): void {
    const from = this.deps.clock.now();
    const delay = Math.max(0, this.nextFire(kind, from) - from);
    this.timers[kind] = this.deps.clock.setTimeout(() => this.onTimer(kind), delay);
  }

  private onTimer(kind: Kind): void {
    // Scheduled first: an in-flight send that takes a while must not push the next occurrence back.
    this.scheduleNext(kind);
    const run = kind === 'briefing' ? this.fireBriefing() : this.fireCheckin();
    run.catch((err) => console.error(`[telegram] scheduled ${kind} failed:`, err));
  }

  private async fireBriefing(): Promise<void> {
    const { text, briefings } = await this.deps.master.dailyBriefing();
    await this.deps.port.send(this.deps.ownerChatId, formatBriefing(text, briefings));
  }

  private async fireCheckin(): Promise<void> {
    const result = await this.deps.assistant.reply(
      '(scheduled check-in) Ask the owner one useful question about today based on the planner and memory.',
    );
    await this.deps.port.send(this.deps.ownerChatId, { text: result.text || '(no reply)' });
  }
}
