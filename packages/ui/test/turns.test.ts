import { describe, it, expect } from 'vitest';
import type { TeamRoster } from '@agenthub/shared';
import {
  activeWho, activityHint, applyTurnEvent, doingCaption, formatClock, formatDuration, formatElapsed, memberFeed,
  mergeTurns, openSubagents, runningTurn, timelineModel, toolPhrase, whoView,
  type SubagentBlock, type TimedEvent, type TimelineGroup, type TurnEvent, type TurnRecord,
} from '../src/turns.js';

const roster: TeamRoster = {
  manager: { status: 'idle' },
  members: [
    { id: 'coder-1', name: 'Ada', role: 'coder', avatar: 'robot-cyan', createdAt: 0, status: 'idle', sessionsCount: 0 },
    { id: 'reviewer-1', name: 'Vex', role: 'reviewer', avatar: 'robot-amber', createdAt: 0, status: 'idle', sessionsCount: 0 },
  ],
};

const T0 = 1_700_000_000_000;

function frame(sessionId: number, at: number, event: TurnEvent) {
  return { sessionId, at, event };
}

function play(turns: TurnRecord[], sessionId: number, events: TurnEvent[], from = T0, step = 1000): TurnRecord[] {
  return events.reduce((acc, event, i) => applyTurnEvent(acc, frame(sessionId, from + i * step, event)), turns);
}

const SCRIPT: TurnEvent[] = [
  { kind: 'turn-start', who: 'manager' },
  { kind: 'text', who: 'manager', text: 'Reading the roadmap.' },
  { kind: 'tool-call', who: 'manager', tool: 'read_file', args: { path: 'docs/roadmap.md' } },
  { kind: 'tool-result', who: 'manager', tool: 'read_file', ok: true, summary: '3 milestones', ms: 40 },
  { kind: 'subagent-start', who: 'coder-1', name: 'Ada', role: 'coder', task: 'Write the store' },
  { kind: 'tool-call', who: 'coder-1', tool: 'write_file', args: { path: 'lib/store.js' } },
  { kind: 'tool-result', who: 'coder-1', tool: 'write_file', ok: true, summary: 'wrote 84 lines', ms: 18 },
  { kind: 'tool-call', who: 'coder-1', tool: 'bash', args: 'npm test' },
  { kind: 'tool-result', who: 'coder-1', tool: 'bash', ok: false, summary: '1 failed', ms: 3100 },
  { kind: 'subagent-end', who: 'coder-1', outcome: 'done', ms: 212000 },
  { kind: 'verify', milestoneId: 'm1', tests: 'pass', review: 'approved', summary: 'Looks right.' },
  { kind: 'turn-end', outcome: 'done', ms: 300000, summary: 'Milestone 1 done.' },
];

describe('applyTurnEvent', () => {
  it('creates the running turn on turn-start and closes it on turn-end', () => {
    let turns = play([], 1, SCRIPT.slice(0, 1));
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ sessionId: 1, startedAt: T0, endedAt: null, outcome: null, toolCalls: 0 });
    expect(runningTurn(turns)?.sessionId).toBe(1);

    turns = play(turns, 1, SCRIPT.slice(1), T0 + 1000);
    expect(turns[0].events).toHaveLength(SCRIPT.length);
    expect(turns[0].toolCalls).toBe(3);
    expect(turns[0]).toMatchObject({ endedAt: T0 + 11_000, outcome: 'done', summary: 'Milestone 1 done.' });
    expect(runningTurn(turns)).toBeNull();
  });

  it('starts a turn from any first frame, so a socket that came up mid-turn still shows it', () => {
    const turns = play([], 1, SCRIPT.slice(5, 7), T0 + 5000);
    expect(turns[0]).toMatchObject({ sessionId: 1, startedAt: T0 + 5000, endedAt: null, toolCalls: 1 });
    expect(turns[0].events.map((e) => e.kind)).toEqual(['tool-call', 'tool-result']);
  });

  it('keeps newest first and holds at most twenty', () => {
    let turns: TurnRecord[] = [];
    for (let i = 0; i < 25; i++) turns = play(turns, i, [SCRIPT[0], SCRIPT[SCRIPT.length - 1]], T0 + i * 60_000);
    expect(turns).toHaveLength(20);
    expect(turns[0].sessionId).toBe(24);
    expect(turns[19].sessionId).toBe(5);
  });

  it('does not touch other projects’ turns in the same list of sessions', () => {
    const a = play([], 1, SCRIPT.slice(0, 2));
    const both = play(a, 2, SCRIPT.slice(0, 1), T0 + 5000);
    expect(both.map((t) => t.sessionId)).toEqual([2, 1]);
    expect(both[1].events).toHaveLength(2);
  });
});

describe('mergeTurns', () => {
  const fetched = (events: TimedEvent[], ended = false): TurnRecord => ({
    sessionId: 1, startedAt: T0, endedAt: ended ? T0 + 11_000 : null, outcome: ended ? 'done' : null,
    summary: ended ? 'Milestone 1 done.' : '', toolCalls: events.filter((e) => e.kind === 'tool-call').length, events,
  });
  const timed = (events: TurnEvent[], from = T0): TimedEvent[] => events.map((e, i) => ({ ...e, at: from + i * 1000 }));

  it('recovers a turn in progress after a reload: history from the fetch, the tail from the socket', () => {
    // The page reloaded mid-turn; the socket delivered events 6 and 7 before /turns answered
    // with 0..6. The tail the fetch had not seen is kept, the overlap is not doubled.
    const local = play([], 1, SCRIPT.slice(6, 8), T0 + 6000);
    const merged = mergeTurns(local, { running: { sessionId: 1, startedAt: T0 }, turns: [fetched(timed(SCRIPT.slice(0, 7)))] });
    expect(merged).toHaveLength(1);
    expect(merged[0].startedAt).toBe(T0);
    expect(merged[0].events.map((e) => e.kind)).toEqual(SCRIPT.slice(0, 8).map((e) => e.kind));
    expect(merged[0].toolCalls).toBe(3);
    expect(runningTurn(merged)?.sessionId).toBe(1);
  });

  it('keeps a local turn-end the fetch predates', () => {
    const local = play([], 1, SCRIPT, T0);
    const merged = mergeTurns(local, { running: { sessionId: 1, startedAt: T0 }, turns: [fetched(timed(SCRIPT.slice(0, 4)))] });
    expect(merged[0].endedAt).toBe(T0 + 11_000);
    expect(merged[0].outcome).toBe('done');
    expect(merged[0].events).toHaveLength(SCRIPT.length);
  });

  it('takes the fetched record as truth where the socket saw nothing, and keeps turns the fetch lacks', () => {
    const local = play([], 2, SCRIPT.slice(0, 2), T0 + 100_000);
    const merged = mergeTurns(local, { running: null, turns: [fetched(timed(SCRIPT), true)] });
    expect(merged.map((t) => t.sessionId)).toEqual([2, 1]);
    expect(merged[1]).toMatchObject({ endedAt: T0 + 11_000, summary: 'Milestone 1 done.' });
  });

  it('an empty fetch leaves what the socket delivered alone', () => {
    const local = play([], 1, SCRIPT.slice(0, 3));
    expect(mergeTurns(local, { running: null, turns: [] })).toEqual(local);
  });

  it('closes a fetched turn the hub no longer names as running — a hub restart, or a dropped turn-end', () => {
    const noRunning = mergeTurns([], { running: null, turns: [fetched(timed(SCRIPT.slice(0, 4)))] });
    expect(noRunning[0]).toMatchObject({ endedAt: T0, outcome: 'unknown' });

    const otherRunning = mergeTurns([], { running: { sessionId: 2, startedAt: T0 }, turns: [fetched(timed(SCRIPT.slice(0, 4)))] });
    expect(otherRunning[0]).toMatchObject({ endedAt: T0, outcome: 'unknown' });
  });

  it('leaves the fetched turn open when the hub names it as the one running', () => {
    const merged = mergeTurns([], { running: { sessionId: 1, startedAt: T0 }, turns: [fetched(timed(SCRIPT.slice(0, 4)))] });
    expect(merged[0].endedAt).toBeNull();
  });
});

describe('timelineModel', () => {
  const events = play([], 1, SCRIPT)[0].events;
  const model = timelineModel(events);

  it('groups contiguous rows by who, and names each run once', () => {
    expect(model.map((item) => item.kind)).toEqual(['group', 'subagent', 'group']);
    const first = model[0] as TimelineGroup;
    expect(first.who).toBe('manager');
    expect(first.rows.map((r) => r.kind)).toEqual(['start', 'text', 'tool']);
    const last = model[2] as TimelineGroup;
    expect(last.rows.map((r) => r.kind)).toEqual(['verify', 'end']);
  });

  it('folds a tool call and its result into one row', () => {
    const first = model[0] as TimelineGroup;
    const tool = first.rows[2];
    expect(tool).toMatchObject({ kind: 'tool', tool: 'read_file', args: '{"path":"docs/roadmap.md"}', ok: true, summary: '3 milestones', ms: 40, key: 2 });
  });

  it('nests a subagent’s rows under its task, and closes the block with outcome and duration', () => {
    const block = model[1] as SubagentBlock;
    expect(block).toMatchObject({ who: 'coder-1', name: 'Ada', role: 'coder', task: 'Write the store', outcome: 'done', ms: 212000, key: 4 });
    expect(block.items).toHaveLength(1);
    const inner = block.items[0] as TimelineGroup;
    expect(inner.who).toBe('coder-1');
    expect(inner.rows.map((r) => r.kind)).toEqual(['tool', 'tool']);
    expect(inner.rows[1]).toMatchObject({ tool: 'bash', args: 'npm test', ok: false, summary: '1 failed' });
  });

  it('leaves a call unanswered until its result lands, and a block open until it ends', () => {
    const partial = timelineModel(play([], 1, SCRIPT.slice(0, 6))[0].events);
    const block = partial[1] as SubagentBlock;
    expect(block.outcome).toBeNull();
    const inner = block.items[0] as TimelineGroup;
    expect(inner.rows[0]).toMatchObject({ kind: 'tool', tool: 'write_file', ok: null, ms: null });
  });

  it('matches a result to the newest unanswered call of that tool by that who', () => {
    const script: TurnEvent[] = [
      { kind: 'tool-call', who: 'manager', tool: 'read_file', args: 'a' },
      { kind: 'tool-call', who: 'manager', tool: 'read_file', args: 'b' },
      { kind: 'tool-result', who: 'manager', tool: 'read_file', ok: true, summary: 'B', ms: 1 },
      { kind: 'tool-result', who: 'manager', tool: 'read_file', ok: true, summary: 'A', ms: 2 },
    ];
    const rows = (timelineModel(play([], 1, script)[0].events)[0] as TimelineGroup).rows;
    expect(rows.map((r) => r.kind === 'tool' && `${r.args}:${r.summary}`)).toEqual(['a:A', 'b:B']);
  });

  it('gives a result whose call was never seen a row of its own', () => {
    const rows = (timelineModel(play([], 1, SCRIPT.slice(3, 4))[0].events)[0] as TimelineGroup).rows;
    expect(rows[0]).toMatchObject({ kind: 'tool', tool: 'read_file', args: '', ok: true, ms: 40 });
  });

  it('keys every row to the event it came from, so an expanded row survives a rebuild', () => {
    const keys = (model[0] as TimelineGroup).rows.map((r) => r.key);
    expect(keys).toEqual([0, 1, 2]);
    expect((model[2] as TimelineGroup).rows.map((r) => r.key)).toEqual([10, 11]);
  });

  it('nests a subagent inside a subagent and closes the inner one first', () => {
    const script: TurnEvent[] = [
      { kind: 'subagent-start', who: 'coder-1', name: 'Ada', role: 'coder', task: 'outer' },
      { kind: 'subagent-start', who: 'reviewer-1', name: 'Vex', role: 'reviewer', task: 'inner' },
      { kind: 'text', who: 'reviewer-1', text: 'hi' },
      { kind: 'subagent-end', who: 'reviewer-1', outcome: 'approved', ms: 5 },
      { kind: 'text', who: 'coder-1', text: 'back' },
      { kind: 'subagent-end', who: 'coder-1', outcome: 'done', ms: 9 },
    ];
    const [outer] = timelineModel(play([], 1, script)[0].events) as SubagentBlock[];
    expect(outer.items.map((i) => i.kind)).toEqual(['subagent', 'group']);
    expect((outer.items[0] as SubagentBlock).outcome).toBe('approved');
    expect(outer.outcome).toBe('done');
  });

  it('puts the closing row at the top level even if a subagent was left open', () => {
    const script: TurnEvent[] = [
      { kind: 'subagent-start', who: 'coder-1', name: 'Ada', role: 'coder', task: 'x' },
      { kind: 'turn-end', outcome: 'aborted', ms: 1, summary: 'stopped' },
    ];
    const items = timelineModel(play([], 1, script)[0].events);
    expect(items.map((i) => i.kind)).toEqual(['subagent', 'group']);
    expect((items[1] as TimelineGroup).rows[0].kind).toBe('end');
  });
});

describe('memberFeed', () => {
  const turn = play([], 1, SCRIPT)[0];

  it('gives a member their own rows in order, with the task they were handed around them', () => {
    expect(memberFeed(turn, 'coder-1')).toEqual([
      { kind: 'task-start', key: 4, at: T0 + 4000, role: 'coder', task: 'Write the store' },
      { kind: 'tool', key: 5, at: T0 + 5000, tool: 'write_file', subject: 'lib/store.js', result: 'wrote 84 lines', ok: true, ms: 18 },
      { kind: 'tool', key: 7, at: T0 + 7000, tool: 'bash', subject: 'npm test', result: '1 failed', ok: false, ms: 3100 },
      { kind: 'task-end', key: 4, at: T0 + 4000 + 212_000, outcome: 'done', ms: 212_000 },
    ]);
  });

  it('leaves the manager theirs alone: no one else’s rows, and no turn or verify rows', () => {
    expect(memberFeed(turn, 'manager')).toEqual([
      { kind: 'text', key: 1, at: T0 + 1000, text: 'Reading the roadmap.' },
      { kind: 'tool', key: 2, at: T0 + 2000, tool: 'read_file', subject: 'docs/roadmap.md', result: '3 milestones', ok: true, ms: 40 },
    ]);
  });

  it('is empty for a turn nobody has started, and for a who the turn never names', () => {
    expect(memberFeed(null, 'coder-1')).toEqual([]);
    expect(memberFeed(turn, 'ghost-9')).toEqual([]);
  });

  it('shows a call still running as unanswered, and its task as still open', () => {
    const rows = memberFeed(play([], 1, SCRIPT.slice(0, 6))[0], 'coder-1');
    expect(rows.map((r) => r.kind)).toEqual(['task-start', 'tool']);
    expect(rows[1]).toMatchObject({ tool: 'write_file', result: '', ok: null, ms: null });
  });

  it('keeps one line of a result, and the one argument worth naming out of the args', () => {
    const script: TurnEvent[] = [
      { kind: 'tool-call', who: 'manager', tool: 'run_shell', args: { command: 'npm test', cwd: '/repo' } },
      { kind: 'tool-result', who: 'manager', tool: 'run_shell', ok: false, summary: '\n1 failed\nexpected true, got undefined\n', ms: 90 },
      { kind: 'text', who: 'manager', text: 'Fixing the flag.' },
    ];
    expect(memberFeed(play([], 1, script)[0], 'manager')).toMatchObject([
      { kind: 'tool', tool: 'run_shell', subject: 'npm test', result: '1 failed', ok: false, ms: 90 },
      { kind: 'text', text: 'Fixing the flag.' },
    ]);
  });

  it('leaves a subagent’s own subagent on that one’s card, and picks the member up after it', () => {
    const script: TurnEvent[] = [
      { kind: 'subagent-start', who: 'coder-1', name: 'Ada', role: 'coder', task: 'outer' },
      { kind: 'subagent-start', who: 'reviewer-1', name: 'Vex', role: 'reviewer', task: 'inner' },
      { kind: 'tool-call', who: 'reviewer-1', tool: 'bash', args: 'ls -la' },
      { kind: 'subagent-end', who: 'reviewer-1', outcome: 'approved', ms: 5 },
      { kind: 'text', who: 'coder-1', text: 'back' },
      { kind: 'subagent-end', who: 'coder-1', outcome: 'done', ms: 9 },
    ];
    const played = play([], 1, script)[0];
    expect(memberFeed(played, 'coder-1').map((r) => r.kind)).toEqual(['task-start', 'text', 'task-end']);
    expect(memberFeed(played, 'reviewer-1').map((r) => r.kind)).toEqual(['task-start', 'tool', 'task-end']);
  });
});

describe('who and doing', () => {
  it('names the manager and roster members, and falls back to the id', () => {
    expect(whoView('manager', roster)).toMatchObject({ name: 'Manager', avatar: 'robot-amber' });
    expect(whoView('coder-1', roster)).toMatchObject({ name: 'Ada', role: 'coder', avatar: 'robot-cyan' });
    expect(whoView('ghost-9', roster)).toMatchObject({ name: 'ghost-9', avatar: null });
    expect(whoView('coder-1', null).name).toBe('coder-1');
  });

  it('turns a tool call into a short phrase', () => {
    expect(toolPhrase('write_file', { path: 'lib/store.js' })).toBe('writing lib/store.js');
    expect(toolPhrase('read_file', { path: 'a.md' })).toBe('reading a.md');
    expect(toolPhrase('bash', 'npm test')).toBe('running npm test');
    expect(toolPhrase('grep', { pattern: 'x', path: 'lib/' })).toBe('searching lib/');
    expect(toolPhrase('update_roadmap', { id: 'm2' })).toBe('updating m2');
    expect(toolPhrase('frobnicate', undefined)).toBe('using frobnicate');
    expect(toolPhrase('bash', 'x'.repeat(100))).toHaveLength(60);
  });

  it('reads the latest tool call or text by who, held to sixty characters', () => {
    const turn = play([], 1, SCRIPT.slice(0, 9))[0];
    expect(doingCaption(turn, 'coder-1')).toBe('running npm test');
    expect(doingCaption(turn, 'manager')).toBe('reading docs/roadmap.md');
    expect(doingCaption(turn, 'reviewer-1')).toBeNull();
    expect(doingCaption(null, 'manager')).toBeNull();
    const chatty = play([], 1, [{ kind: 'text', who: 'manager', text: 'y'.repeat(120) }])[0];
    expect(doingCaption(chatty, 'manager')).toHaveLength(60);
  });

  it('knows who is acting: the innermost open subagent, else the manager', () => {
    expect(activeWho(play([], 1, SCRIPT.slice(0, 3))[0])).toBe('manager');
    expect(activeWho(play([], 1, SCRIPT.slice(0, 6))[0])).toBe('coder-1');
    expect(activeWho(play([], 1, SCRIPT.slice(0, 11))[0])).toBe('manager');
    expect(openSubagents(play([], 1, SCRIPT.slice(0, 6))[0])).toEqual(['coder-1']);
    expect(openSubagents(null)).toEqual([]);
  });
});

describe('activityHint', () => {
  it('says what the team is doing while a turn runs', () => {
    const turns = play([], 1, SCRIPT.slice(0, 8), T0);
    const { hint, filled, running } = activityHint('ready', turns, roster, T0 + 252_000);
    expect(hint).toBe('Running · 4m12s · Ada is running npm test');
    expect(filled).toBe(true);
    expect(running).toBe(true);
  });

  it('says only the clock while the turn has nothing to show yet', () => {
    const turns = play([], 1, SCRIPT.slice(0, 1), T0);
    expect(activityHint('loading', turns, roster, T0 + 3000).hint).toBe('Running · 3s');
  });

  it('describes the last turn once idle', () => {
    const turns = play([], 1, SCRIPT, T0);
    const done = { ...turns[0], endedAt: T0 + 18 * 60_000 };
    const { hint, filled, running } = activityHint('ready', [done], roster, T0 + 99 * 60_000);
    expect(hint).toBe('Last turn 18m · Milestone 1 done.');
    expect(filled).toBe(true);
    expect(running).toBe(false);
  });

  it('degrades to a clear empty state before, and without, the turns route', () => {
    expect(activityHint('loading', [], roster, T0)).toEqual({ hint: 'Loading…', filled: false, running: false });
    expect(activityHint('failed', [], roster, T0)).toEqual({ hint: 'Could not be read', filled: false, running: false });
    expect(activityHint('ready', [], roster, T0)).toEqual({ hint: 'No turns yet', filled: false, running: false });
  });

  it('still shows what the socket delivered when the fetch failed', () => {
    const turns = play([], 1, SCRIPT.slice(0, 3), T0);
    expect(activityHint('failed', turns, roster, T0 + 5000).running).toBe(true);
  });
});

describe('time formatting', () => {
  it('formatElapsed picks the shortest honest form', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(38_000)).toBe('38s');
    expect(formatElapsed(252_000)).toBe('4m12s');
    expect(formatElapsed(18 * 60_000)).toBe('18m');
    expect(formatElapsed(62 * 60_000)).toBe('1h02m');
    expect(formatElapsed(-5)).toBe('0s');
  });

  it('formatClock ticks like a stopwatch', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(252_000)).toBe('4:12');
    expect(formatClock(3_852_000)).toBe('1:04:12');
  });

  it('formatDuration keeps milliseconds for tool calls', () => {
    expect(formatDuration(36)).toBe('36ms');
    expect(formatDuration(3100)).toBe('3.1s');
    expect(formatDuration(212_000)).toBe('3m32s');
  });
});
