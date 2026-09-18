import type { Store } from '../store.js';
import type { TurnEvent, TurnRecord } from '../turns.js';

/**
 * Dev harness only: scripted turn frames for the selected project, so the Activity panel can be
 * looked at without an 18-minute turn behind it. Loaded by `main.ts` on `?fake-turns` in dev
 * builds and nowhere else. `mode`: '' plays a running turn over history, 'idle' is history only,
 * 'long' plays a turn that keeps going for a few hundred rows.
 */

const HOUR = 3_600_000;
const MIN = 60_000;

/** A finished turn from earlier today, so the list has more than the running one in it. */
function finished(sessionId: number, startedAt: number, ms: number, outcome: string, summary: string, verify: boolean): TurnRecord {
  const at = (offset: number): number => startedAt + offset;
  const events: TurnRecord['events'] = [
    { kind: 'turn-start', who: 'manager', at: at(0) },
    { kind: 'text', who: 'manager', text: 'Reading the roadmap and the PRD to pick the next milestone.', at: at(1200) },
    { kind: 'tool-call', who: 'manager', tool: 'read_file', args: { path: 'docs/roadmap.md' }, at: at(2000) },
    { kind: 'tool-result', who: 'manager', tool: 'read_file', ok: true, summary: '3 milestones, 1 in progress', ms: 41, at: at(2100) },
    { kind: 'subagent-start', who: 'coder-1', name: 'Ada', role: 'coder', task: 'Implement the add command with a JSON store', at: at(4000) },
    { kind: 'tool-call', who: 'coder-1', tool: 'write_file', args: { path: 'lib/store.js' }, at: at(9000) },
    { kind: 'tool-result', who: 'coder-1', tool: 'write_file', ok: true, summary: 'wrote 84 lines', ms: 18, at: at(9100) },
    { kind: 'tool-call', who: 'coder-1', tool: 'bash', args: 'npm test', at: at(30000) },
    { kind: 'tool-result', who: 'coder-1', tool: 'bash', ok: true, summary: '12 passed', ms: 4200, at: at(34200) },
    { kind: 'subagent-end', who: 'coder-1', outcome: 'done', ms: ms - 60000, at: at(ms - 56000) },
    ...(verify
      ? [{ kind: 'verify' as const, milestoneId: 'm1', tests: 'pass' as const, review: 'approved' as const, summary: 'Store round-trips; reviewer approved the shape.', at: at(ms - 30000) }]
      : []),
    { kind: 'turn-end', outcome, ms, summary, at: at(ms) },
  ];
  return {
    sessionId, startedAt, endedAt: startedAt + ms, outcome, summary,
    toolCalls: events.filter((e) => e.kind === 'tool-call').length, events,
  };
}

/** The running turn's script, played one line every few hundred ms. */
const SCRIPT: TurnEvent[] = [
  { kind: 'turn-start', who: 'manager' },
  { kind: 'text', who: 'manager', text: 'Milestone 2 is next: list and complete commands. Checking what Ada left in the store module before delegating.' },
  { kind: 'tool-call', who: 'manager', tool: 'read_file', args: { path: 'lib/store.js' } },
  { kind: 'tool-result', who: 'manager', tool: 'read_file', ok: true, summary: '84 lines — load(), save(), add()', ms: 36 },
  { kind: 'tool-call', who: 'manager', tool: 'read_file', args: { path: 'docs/prd.md' } },
  { kind: 'tool-result', who: 'manager', tool: 'read_file', ok: true, summary: 'PRD §3: list shows id, title, done marker', ms: 22 },
  { kind: 'tool-call', who: 'manager', tool: 'grep', args: { pattern: 'complete', path: 'lib/' } },
  { kind: 'tool-result', who: 'manager', tool: 'grep', ok: false, summary: 'no matches', ms: 15 },
  { kind: 'text', who: 'manager', text: 'Nothing implements complete yet. Delegating both commands to Ada with the PRD section as the spec.' },
  { kind: 'subagent-start', who: 'coder-1', name: 'Ada', role: 'coder', task: 'Add `list` and `complete <id>` to the CLI, backed by lib/store.js; tests for both.' },
  { kind: 'tool-call', who: 'coder-1', tool: 'read_file', args: { path: 'lib/store.js' } },
  { kind: 'tool-result', who: 'coder-1', tool: 'read_file', ok: true, summary: '84 lines', ms: 12 },
  { kind: 'tool-call', who: 'coder-1', tool: 'read_file', args: { path: 'bin/todo.js' } },
  { kind: 'tool-result', who: 'coder-1', tool: 'read_file', ok: true, summary: '40 lines — add only', ms: 9 },
  { kind: 'text', who: 'coder-1', text: 'Adding list() and complete(id) to the store, then the two subcommands.' },
  { kind: 'tool-call', who: 'coder-1', tool: 'edit_file', args: { path: 'lib/store.js', old: 'module.exports = { load, save, add };', new: 'module.exports = { load, save, add, list, complete };' } },
  { kind: 'tool-result', who: 'coder-1', tool: 'edit_file', ok: true, summary: 'applied 1 hunk', ms: 8 },
  { kind: 'tool-call', who: 'coder-1', tool: 'write_file', args: { path: 'bin/todo.js' } },
  { kind: 'tool-result', who: 'coder-1', tool: 'write_file', ok: true, summary: 'wrote 71 lines', ms: 14 },
  { kind: 'tool-call', who: 'coder-1', tool: 'write_file', args: { path: 'test/list.test.js' } },
  { kind: 'tool-result', who: 'coder-1', tool: 'write_file', ok: true, summary: 'wrote 38 lines', ms: 11 },
  { kind: 'tool-call', who: 'coder-1', tool: 'bash', args: 'npm test' },
  { kind: 'tool-result', who: 'coder-1', tool: 'bash', ok: false, summary: 'FAIL test/list.test.js — complete(3): expected done=true, got undefined', ms: 3100 },
  { kind: 'text', who: 'coder-1', text: 'complete() wrote the flag on a copy. Fixing to mutate the loaded item and save.' },
  { kind: 'tool-call', who: 'coder-1', tool: 'edit_file', args: { path: 'lib/store.js', old: 'const item = { ...found }', new: 'const item = found' } },
  { kind: 'tool-result', who: 'coder-1', tool: 'edit_file', ok: true, summary: 'applied 1 hunk', ms: 7 },
  { kind: 'tool-call', who: 'coder-1', tool: 'bash', args: 'npm test' },
  { kind: 'tool-result', who: 'coder-1', tool: 'bash', ok: true, summary: '17 passed', ms: 2900 },
  { kind: 'subagent-end', who: 'coder-1', outcome: 'done', ms: 212000 },
  { kind: 'text', who: 'manager', text: 'Ada is done. Sending the diff to Vex for review before marking the milestone.' },
  { kind: 'subagent-start', who: 'reviewer-1', name: 'Vex', role: 'reviewer', task: 'Review the list/complete change for correctness and test coverage.' },
  { kind: 'tool-call', who: 'reviewer-1', tool: 'bash', args: 'git diff --stat' },
  { kind: 'tool-result', who: 'reviewer-1', tool: 'bash', ok: true, summary: '3 files changed, 121 insertions(+), 2 deletions(-)', ms: 60 },
  { kind: 'tool-call', who: 'reviewer-1', tool: 'read_file', args: { path: 'lib/store.js' } },
  { kind: 'tool-result', who: 'reviewer-1', tool: 'read_file', ok: true, summary: '112 lines', ms: 10 },
  { kind: 'text', who: 'reviewer-1', text: 'complete() throws on an unknown id, which the CLI turns into a clear message. Coverage is fine.' },
  { kind: 'subagent-end', who: 'reviewer-1', outcome: 'approved', ms: 48000 },
  { kind: 'verify', milestoneId: 'm2', tests: 'pass', review: 'approved', summary: 'Both commands land with tests; reviewer approved.' },
  { kind: 'tool-call', who: 'manager', tool: 'update_roadmap', args: { id: 'm2', status: 'done' } },
  { kind: 'tool-result', who: 'manager', tool: 'update_roadmap', ok: true, summary: 'm2 → done', ms: 19 },
];

/** A filler loop for the long mode: a subagent chewing through many files. */
function filler(index: number): TurnEvent[] {
  const path = `src/module-${index}.js`;
  return [
    { kind: 'tool-call', who: 'coder-1', tool: 'read_file', args: { path } },
    { kind: 'tool-result', who: 'coder-1', tool: 'read_file', ok: true, summary: `${40 + (index % 90)} lines`, ms: 8 + (index % 30) },
    { kind: 'tool-call', who: 'coder-1', tool: 'edit_file', args: { path, old: 'var ', new: 'const ' } },
    { kind: 'tool-result', who: 'coder-1', tool: 'edit_file', ok: index % 17 !== 0, summary: index % 17 === 0 ? 'no match for old text' : 'applied 1 hunk', ms: 6 },
  ];
}

/** The roadmap route, with a verification stamped on the first two milestones the hub returns. */
function fakeVerification(): void {
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const response = await real(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!/\/api\/projects\/[^/]+\/roadmap$/.test(url) || !response.ok) return response;
    const doc = (await response.json()) as { milestones?: Array<Record<string, unknown>> };
    const stamps = [
      { tests: 'pass', review: 'approved', at: Date.now() - HOUR, notes: 'Store round-trips; reviewer approved the shape.' },
      { tests: 'pass', review: 'changes', at: Date.now() - MIN, notes: 'Reviewer asked for an error on unknown ids.' },
      { tests: 'fail', review: 'skipped', at: Date.now() - MIN },
    ];
    (doc.milestones ?? []).forEach((m, i) => { if (stamps[i]) m.verification = stamps[i]; });
    return new Response(JSON.stringify(doc), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

export function injectFakeTurns(store: Store, mode: string): void {
  fakeVerification();
  const slugOf = (): string | null => store.getState().project;

  const start = (slug: string): void => {
    const now = Date.now();
    const history: TurnRecord[] = [
      finished(3, now - 2 * HOUR, 18 * MIN, 'done', 'Milestone 1 done: the add command writes to a JSON store, with tests.', true),
      finished(2, now - 5 * HOUR, 6 * MIN, 'failed', 'Turn stopped: the coder hit its tool budget while wiring the CLI entry point.', false),
      finished(1, now - 26 * HOUR, 11 * MIN, 'done', 'Drafted the PRD and generated the roadmap.', false),
    ];
    store.dispatch({ type: 'turns-loaded', slug, response: { running: null, turns: history } });
    if (mode === 'idle') return;

    const sessionId = 1000;
    const startedAt = now - 4 * MIN - 12000;
    let clock = startedAt;
    const script: TurnEvent[] = mode === 'long'
      ? [
        ...SCRIPT.slice(0, 10),
        ...Array.from({ length: 60 }, (_, i) => filler(i + 1)).flat(),
        ...SCRIPT.slice(10),
      ]
      : SCRIPT;
    // The first few land at once, so the panel opens on a turn already under way.
    let index = 0;
    const play = (): void => {
      if (index >= script.length) return;
      const event = script[index++];
      // The first frame lands at `startedAt`; later ones a beat apart, never in the future.
      if (index > 1) clock = Math.min(clock + 900, Date.now());
      store.dispatch({ type: 'turn-event', frame: { slug, sessionId, at: clock, event } });
    };
    for (let i = 0; i < 12; i++) play();
    const timer = setInterval(() => {
      if (index >= script.length) {
        clearInterval(timer);
        // Hold the last row open a while, then close the turn.
        setTimeout(() => store.dispatch({
          type: 'turn-event',
          frame: {
            slug, sessionId, at: Date.now(),
            event: { kind: 'turn-end', outcome: 'done', ms: Date.now() - startedAt, summary: 'Milestone 2 done: list and complete commands, reviewed and tested.' },
          },
        }), 30000);
        return;
      }
      play();
    }, mode === 'long' ? 250 : 1400);
  };

  const slug = slugOf();
  if (slug) return start(slug);
  const unsubscribe = store.subscribe(() => {
    const picked = slugOf();
    if (!picked) return;
    unsubscribe();
    start(picked);
  });
}
