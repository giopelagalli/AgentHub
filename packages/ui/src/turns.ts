import type { TeamRoster } from '@agenthub/shared';

/**
 * A turn as the owner watches it: the wire shapes the hub sends over the socket and answers on
 * `GET /api/projects/:slug/turns`, the reducer that folds both into one list per project, the
 * timeline the Activity panel draws from a turn's events, and the one-line strings the page shows
 * while a turn runs. Pure — the DOM lives in `views/activity.ts` and `pages/projects.ts`.
 */

export type TurnEvent =
  | { kind: 'turn-start'; who: 'manager' }
  | { kind: 'text'; who: string; text: string }
  | { kind: 'tool-call'; who: string; tool: string; args: unknown }
  | { kind: 'tool-result'; who: string; tool: string; ok: boolean; summary: string; ms: number }
  | { kind: 'subagent-start'; who: string; name: string; role: string; task: string }
  | { kind: 'subagent-end'; who: string; outcome: string; ms: number }
  | { kind: 'verify'; milestoneId: string; tests: VerifyTests; review: VerifyReview; summary: string }
  | { kind: 'turn-end'; outcome: string; ms: number; summary: string };

export type VerifyTests = 'pass' | 'fail' | 'skipped';
export type VerifyReview = 'approved' | 'changes' | 'skipped';

export type TimedEvent = TurnEvent & { at: number };

/** One `turn-event` frame off the socket. */
export interface TurnFrame {
  slug: string;
  sessionId: string;
  at: number;
  event: TurnEvent;
}

export interface TurnRecord {
  sessionId: string;
  startedAt: number;
  endedAt: number | null;
  outcome: string | null;
  summary: string;
  toolCalls: number;
  events: TimedEvent[];
}

/** `GET /api/projects/:slug/turns`. */
export interface TurnsResponse {
  running: { sessionId: string; startedAt: number } | null;
  turns: TurnRecord[];
}

/** How many turns the hub keeps, and so how many the list shows. */
export const TURNS_KEPT = 20;

/** The manager is not on the roster; it wears the same face the org chart gives it. */
export const MANAGER_AVATAR = 'robot-amber';

// --- reducer -------------------------------------------------------------------

function blankTurn(sessionId: string, startedAt: number): TurnRecord {
  return { sessionId, startedAt, endedAt: null, outcome: null, summary: '', toolCalls: 0, events: [] };
}

function byNewest(turns: TurnRecord[]): TurnRecord[] {
  return [...turns].sort((a, b) => b.startedAt - a.startedAt).slice(0, TURNS_KEPT);
}

/**
 * One frame folded into a project's turns. A frame for a session we have not seen starts one — a
 * socket that came up mid-turn has no `turn-start` to wait for — and `turn-end` closes it.
 */
export function applyTurnEvent(turns: TurnRecord[], frame: Omit<TurnFrame, 'slug'>): TurnRecord[] {
  const existing = turns.find((t) => t.sessionId === frame.sessionId);
  const base = existing ?? blankTurn(frame.sessionId, frame.at);
  const timed: TimedEvent = { ...frame.event, at: frame.at };
  const next: TurnRecord = { ...base, events: [...base.events, timed] };
  if (timed.kind === 'tool-call') next.toolCalls += 1;
  if (timed.kind === 'turn-end') {
    next.endedAt = frame.at;
    next.outcome = timed.outcome;
    next.summary = timed.summary;
  }
  const rest = turns.filter((t) => t.sessionId !== frame.sessionId);
  return byNewest([next, ...rest]);
}

/**
 * The hub's history folded under what the socket already delivered. The fetched record is the
 * truth up to the moment it was built; anything the socket appended after that moment is kept.
 */
function mergeTurn(local: TurnRecord | undefined, fetched: TurnRecord): TurnRecord {
  if (!local) return fetched;
  const lastAt = fetched.events.length ? fetched.events[fetched.events.length - 1].at : -Infinity;
  const tail = local.events.filter((e) => e.at > lastAt);
  const events = [...fetched.events, ...tail];
  const ended = local.endedAt !== null && fetched.endedAt === null ? local : fetched;
  return {
    ...fetched,
    events,
    toolCalls: events.filter((e) => e.kind === 'tool-call').length,
    endedAt: ended.endedAt,
    outcome: ended.outcome,
    summary: ended.summary || fetched.summary || local.summary,
  };
}

/** `/turns` landed: every fetched turn replaces its local twin, and turns only we know of stay. */
export function mergeTurns(local: TurnRecord[], fetched: TurnsResponse): TurnRecord[] {
  const merged = fetched.turns.map((turn) => mergeTurn(local.find((t) => t.sessionId === turn.sessionId), turn));
  const known = new Set(merged.map((t) => t.sessionId));
  return byNewest([...merged, ...local.filter((t) => !known.has(t.sessionId))]);
}

/** The turn in progress, if any: the newest one nothing has closed. */
export function runningTurn(turns: TurnRecord[]): TurnRecord | null {
  return turns.find((t) => t.endedAt === null) ?? null;
}

// --- time ----------------------------------------------------------------------

/** `38s`, `4m12s`, `18m`, `1h02m`: the shortest thing that still says how long. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m >= 10) return `${m}m`;
  if (m) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** `36ms`, `3.1s`, `4m12s`: how long one tool call or one subagent took. */
export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 1000) return `${Math.round(safe)}ms`;
  if (safe < 60_000) return `${(safe / 1000).toFixed(1)}s`;
  return formatElapsed(safe);
}

/** `4:12`, `1:04:12`: the ticking clock on the Run turn button. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** `14:02` — wall-clock start of a turn, for the list. */
export function formatTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** How long a turn has run, or ran: to `now` while open, to its end once closed. */
export function turnDuration(turn: TurnRecord, now: number): number {
  return (turn.endedAt ?? now) - turn.startedAt;
}

// --- names ---------------------------------------------------------------------

export interface WhoView {
  id: string;
  name: string;
  role: string;
  /** An `AVATARS` id, or null for an id the roster doesn't know. */
  avatar: string | null;
}

/** `who` on the wire, as the roster names it; the manager and unknown ids get a fixed look. */
export function whoView(who: string, roster: TeamRoster | null): WhoView {
  if (who === 'manager') return { id: who, name: 'Manager', role: 'orchestrator', avatar: MANAGER_AVATAR };
  const member = roster?.members.find((m) => m.id === who);
  return member
    ? { id: who, name: member.name, role: member.role, avatar: member.avatar }
    : { id: who, name: who, role: '', avatar: null };
}

// --- one-line strings ----------------------------------------------------------

/** `args` as one line of text: the string it is, or the JSON it serialises to. */
export function argsText(args: unknown): string {
  if (typeof args === 'string') return args;
  if (args === undefined || args === null) return '';
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** The verb a tool call reads as, from the words in the tool's name (`write_file`, `readFile`, `bash`). */
const VERBS: Array<[RegExp, string]> = [
  [/^(edit|patch|replace|str_replace)$/, 'editing'],
  [/^(write|create|save|put)$/, 'writing'],
  [/^(read|cat|open|view|get)$/, 'reading'],
  [/^(bash|shell|sh|exec|run|command|cmd|test)$/, 'running'],
  [/^(search|grep|glob|find|list|ls)$/, 'searching'],
  [/^(delegate|subagent|dispatch|task|agent)$/, 'delegating'],
  [/^(fetch|http|browse|navigate|curl)$/, 'fetching'],
  [/^(update|set|mark|move)$/, 'updating'],
];

function verbFor(tool: string): string {
  const words = tool.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (const word of words) {
    const hit = VERBS.find(([pattern]) => pattern.test(word));
    if (hit) return hit[1];
  }
  return `using ${tool}`;
}

/** The one argument worth naming: a path or command if the args carry one, else the args flat. */
function subjectOf(args: unknown): string {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const record = args as Record<string, unknown>;
    for (const key of ['path', 'file', 'file_path', 'filename', 'command', 'cmd', 'query', 'pattern', 'url', 'task']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
    const first = Object.values(record).find((v) => typeof v === 'string' && v.trim());
    if (typeof first === 'string') return first;
  }
  return argsText(args);
}

/** `writing lib/store.js` — a tool call as the phrase the hints use. */
export function toolPhrase(tool: string, args: unknown, max = 60): string {
  const subject = subjectOf(args);
  return truncate(subject ? `${verbFor(tool)} ${subject}` : verbFor(tool), max);
}

/**
 * What `who` is doing right now, from their latest tool call or line of text in the turn — or
 * null when they have not done anything in it yet. Held to `max` characters.
 */
export function doingCaption(turn: TurnRecord | null, who: string, max = 60): string | null {
  if (!turn) return null;
  for (let i = turn.events.length - 1; i >= 0; i--) {
    const event = turn.events[i];
    if (event.kind === 'tool-call' && event.who === who) return toolPhrase(event.tool, event.args, max);
    if (event.kind === 'text' && event.who === who) return truncate(event.text, max);
  }
  return null;
}

/** The subagents still open in the turn, outermost first; empty once they have all reported. */
export function openSubagents(turn: TurnRecord | null): string[] {
  const open: string[] = [];
  for (const event of turn?.events ?? []) {
    if (event.kind === 'subagent-start') open.push(event.who);
    else if (event.kind === 'subagent-end') {
      const at = open.lastIndexOf(event.who);
      if (at >= 0) open.splice(at, 1);
    }
  }
  return open;
}

/** Who is acting right now: the innermost subagent still open, else the manager. */
export function activeWho(turn: TurnRecord): string {
  const open = openSubagents(turn);
  return open[open.length - 1] ?? 'manager';
}

export type TurnsState = 'loading' | 'ready' | 'failed';

/** The Activity button's hint, as the page shows it under the name. */
export function activityHint(
  state: TurnsState,
  turns: TurnRecord[],
  roster: TeamRoster | null,
  now: number,
): { hint: string; filled: boolean; running: boolean } {
  const running = runningTurn(turns);
  if (running) {
    const who = activeWho(running);
    const doing = doingCaption(running, who, 48);
    const parts = [`Running · ${formatElapsed(turnDuration(running, now))}`];
    if (doing) parts.push(`${whoView(who, roster).name} is ${doing}`);
    return { hint: parts.join(' · '), filled: true, running: true };
  }
  if (state === 'loading' && !turns.length) return { hint: 'Loading…', filled: false, running: false };
  if (state === 'failed' && !turns.length) return { hint: 'Could not be read', filled: false, running: false };
  const last = turns[0];
  if (!last) return { hint: 'No turns yet', filled: false, running: false };
  const tail = last.summary ? truncate(last.summary, 60) : last.outcome ?? '';
  return {
    hint: tail ? `Last turn ${formatElapsed(turnDuration(last, now))} · ${tail}` : `Last turn ${formatElapsed(turnDuration(last, now))}`,
    filled: true,
    running: false,
  };
}

// --- timeline ------------------------------------------------------------------

/** A tool call and its result, folded into one row; `ok`/`ms` are null until the result lands. */
export interface ToolRow {
  kind: 'tool';
  key: number;
  who: string;
  at: number;
  tool: string;
  args: string;
  ok: boolean | null;
  summary: string;
  ms: number | null;
}

export type TimelineRow =
  | { kind: 'start'; key: number; who: string; at: number }
  | { kind: 'text'; key: number; who: string; at: number; text: string }
  | ToolRow
  | { kind: 'verify'; key: number; at: number; milestoneId: string; tests: VerifyTests; review: VerifyReview; summary: string }
  | { kind: 'end'; key: number; at: number; outcome: string; ms: number; summary: string };

/** A contiguous run of rows by one `who`, named once at the top. */
export interface TimelineGroup {
  kind: 'group';
  who: string;
  rows: TimelineRow[];
}

/** Everything a subagent did, indented under its task; closed once its `subagent-end` lands. */
export interface SubagentBlock {
  kind: 'subagent';
  key: number;
  who: string;
  name: string;
  role: string;
  task: string;
  at: number;
  outcome: string | null;
  ms: number | null;
  items: TimelineItem[];
}

export type TimelineItem = TimelineGroup | SubagentBlock;

interface Container {
  items: TimelineItem[];
}

/**
 * The turn's events as the panel draws them: rows grouped by who did them, tool calls folded
 * with their results, subagents nested under the task they were given. `key` is the index of
 * the event a row came from, stable across re-renders while the turn grows.
 */
export function timelineModel(events: TimedEvent[]): TimelineItem[] {
  const root: Container = { items: [] };
  const stack: Container[] = [root];

  const top = (): Container => stack[stack.length - 1];

  const push = (who: string, row: TimelineRow): void => {
    const container = top();
    const last = container.items[container.items.length - 1];
    if (last?.kind === 'group' && last.who === who) last.rows.push(row);
    else container.items.push({ kind: 'group', who, rows: [row] });
  };

  /** The newest unanswered call by `who` to `tool`, in the container being written to. */
  const pendingCall = (who: string, tool: string): ToolRow | null => {
    const container = top();
    for (let i = container.items.length - 1; i >= 0; i--) {
      const item = container.items[i];
      if (item.kind !== 'group') continue;
      if (item.who !== who) continue;
      for (let j = item.rows.length - 1; j >= 0; j--) {
        const row = item.rows[j];
        if (row.kind === 'tool' && row.tool === tool && row.ok === null) return row;
      }
    }
    return null;
  };

  events.forEach((event, key) => {
    switch (event.kind) {
      case 'turn-start':
        push(event.who, { kind: 'start', key, who: event.who, at: event.at });
        break;
      case 'text':
        push(event.who, { kind: 'text', key, who: event.who, at: event.at, text: event.text });
        break;
      case 'tool-call':
        push(event.who, {
          kind: 'tool', key, who: event.who, at: event.at,
          tool: event.tool, args: argsText(event.args), ok: null, summary: '', ms: null,
        });
        break;
      case 'tool-result': {
        const call = pendingCall(event.who, event.tool);
        if (call) {
          call.ok = event.ok;
          call.summary = event.summary;
          call.ms = event.ms;
        } else {
          // A result whose call we never saw (a socket that came up mid-turn): still worth a row.
          push(event.who, {
            kind: 'tool', key, who: event.who, at: event.at,
            tool: event.tool, args: '', ok: event.ok, summary: event.summary, ms: event.ms,
          });
        }
        break;
      }
      case 'subagent-start': {
        const block: SubagentBlock = {
          kind: 'subagent', key, who: event.who, name: event.name, role: event.role, task: event.task,
          at: event.at, outcome: null, ms: null, items: [],
        };
        top().items.push(block);
        stack.push(block);
        break;
      }
      case 'subagent-end': {
        // Close the innermost open block for this subagent, and everything nested under it.
        let depth = stack.length - 1;
        while (depth > 0 && (stack[depth] as SubagentBlock).who !== event.who) depth--;
        if (depth > 0) {
          const block = stack[depth] as SubagentBlock;
          block.outcome = event.outcome;
          block.ms = event.ms;
          stack.length = depth;
        }
        break;
      }
      case 'verify':
        push('manager', {
          kind: 'verify', key, at: event.at, milestoneId: event.milestoneId,
          tests: event.tests, review: event.review, summary: event.summary,
        });
        break;
      case 'turn-end':
        // The closing row belongs to the turn, not to whichever subagent was left open.
        stack.length = 1;
        push('manager', { kind: 'end', key, at: event.at, outcome: event.outcome, ms: event.ms, summary: event.summary });
        break;
    }
  });

  return root.items;
}
