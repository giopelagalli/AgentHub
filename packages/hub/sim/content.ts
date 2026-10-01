import { PRD_SECTIONS } from '@agenthub/shared';

/**
 * What the simulation's projects are made of: the PRDs and roadmaps the scripted model "writes",
 * the pomodoro-cli workspace and docs. Plain data — `agent-script.ts` serves the model-written
 * parts through the mock, `seed.ts` puts the rest in through the hub's APIs.
 */

export interface RoadmapItem { title: string; summary: string; estimate?: string; dependsOn?: string[] }

/** A PRD in the drafter's shape: a `# ` title, then every `PRD_SECTIONS` heading in order. */
function prd(title: string, bodies: string[]): string {
  return [`# ${title} — PRD`, ``, ...PRD_SECTIONS.flatMap((s, i) => [`## ${s.title}`, ``, bodies[i] ?? '', ``])].join('\n');
}

export const POMODORO_PRD = prd('Pomodoro CLI', [
  'A terminal Pomodoro timer for developers who live in a shell. It runs focused work intervals and breaks without a browser tab or a phone, logs every session locally, and answers "what did I actually focus on this week" from that log. The problem it removes is context switching to a separate app just to keep time.',
  'Goals: start a session in one command, never lose a completed session, and show daily and weekly focus totals. Success is a week of real use with zero lost sessions and stats that match a manual count. Non-goals: team features, cloud sync, task management, and any GUI beyond the optional local web dashboard.',
  'The primary user is a single developer on macOS or Linux. Use cases: start a 25/5 cycle before deep work; change the lengths for a long writing session; get a desktop notification when a phase ends while in another window; review yesterday\'s focus time during standup; open the dashboard on a second screen.',
  '1. `pomodoro start` runs work/break cycles (defaults 25/5, long break 15 every 4). 2. `--work`, `--break`, `--long-break` and `--cycles` override the lengths. 3. Each phase end raises a desktop notification. 4. Every completed or abandoned session is appended to a JSON log. 5. `pomodoro stats` prints today and the last 7 days. 6. `p`/`r`/`q` pause, resume and quit. 7. `pomodoro serve` shows the live timer in a browser.',
  'One screen in the terminal: phase name, a large mm:ss countdown, a progress bar, and the cycle count (2/4). Keys are listed on the bottom line. `stats` prints a compact table with a sparkline per day. The web dashboard mirrors the terminal: one big countdown, the phase color, and today\'s total, readable from across a room.',
  'Session: { id, startedAt, endedAt, phase: work|break|long-break, plannedMin, actualMin, completed: boolean, label? }. The log is an append-only JSON-lines file at ~/.local/share/pomodoro/sessions.jsonl. Config: { workMin, breakMin, longBreakMin, cyclesBeforeLong, notify } in ~/.config/pomodoro/config.json, overridden by flags.',
  'Node.js 22, ES modules, no runtime dependencies beyond node-notifier for notifications. bin/pomodoro.mjs parses arguments and wires src/timer.mjs (a pure state machine driven by a tick function), src/log.mjs (append and read the JSONL log) and src/stats.mjs (aggregation). serve.mjs is a tiny static server for the dashboard, reading timer state from a local file.',
  'Everything stays on the local machine; nothing is sent anywhere. The log may reveal working hours, so it is created with 0600 permissions. The dashboard binds to 127.0.0.1 only. Session labels are stored as typed and escaped when rendered in the dashboard, so a label cannot inject markup.',
  'One user, one process; the log grows by a few hundred lines a month. `stats` must answer in under 100 ms for a year of history (about 20k lines), which a single streaming pass over the file meets. The timer must not drift more than one second per hour, so it computes remaining time from the wall clock rather than counting ticks.',
  'Releases are npm versions installed globally. The log is append-only and fsynced after each session, so a crash loses at most the session in progress. A corrupt line is skipped with a warning rather than failing stats. There is no service to monitor; `pomodoro doctor` prints config and log paths for bug reports.',
  'Unit tests with node:test cover the timer state machine (phase order, long breaks, pause accounting), the log (append, read, skip corrupt lines) and stats (day boundaries, time zones). Acceptance: a full 4-cycle run with a fake clock produces the expected log, and stats over a fixture log match hand-computed totals.',
  'Desktop notifications differ per OS and may need a fallback to a terminal bell. Wall-clock timing breaks across sleep/resume, which needs a decision (pause or count). Open: should abandoned sessions count toward stats, and is a weekly goal worth adding in v1?',
]);

export const HABIT_PRD = prd('Habit Tracker', [
  'A small web app for tracking daily habits with streaks. It is for one person who wants a quick, private check-in once a day rather than a social fitness app. The problem it removes is the friction of spreadsheets and the noise of gamified habit apps that want attention all day.',
  'Goals: check off today\'s habits in under ten seconds, see the current streak for each, and never lose history. Success is daily use for a month. Non-goals: reminders by push notification, sharing, coaching content, and multiple users in v1.',
  'One user on a phone browser and a laptop. Use cases: add a habit with a target (daily or N times a week); tick it off; see streaks at a glance; look back over a month as a heat map; archive a habit without losing its history.',
  '1. Create, rename and archive habits with a daily or weekly target. 2. Toggle completion for today and the previous two days. 3. Show the current and best streak per habit. 4. Month heat map per habit. 5. Export all data as JSON. 6. Works offline and syncs when back online.',
  'A single list screen: each habit is a row with its name, a check button for today, the streak count and a seven-day strip. Tapping a row opens the detail view with the heat map and edit controls. An empty state explains how to add the first habit.',
  'Habit: { id, name, target: { kind: daily|weekly, count }, createdAt, archivedAt? }. Check: { habitId, date (YYYY-MM-DD, local), at }. Streaks are derived from checks, never stored, so they cannot drift from the history.',
  'A Vite + TypeScript single-page app with IndexedDB as the local store and a small Fastify API with SQLite for sync. The client is offline-first: writes land locally and a sync queue pushes them with last-write-wins per check.',
  'Single-user login with a password and an HTTP-only session cookie. Data is private to the owner; the API rejects cross-origin writes. Export is the only bulk read. Backups of the SQLite file are encrypted at rest on the host.',
  'Tiny data: a few habits and a few thousand checks a year. The list must render in under 200 ms on a mid-range phone and a toggle must feel instant (optimistic update). The API handles sync bursts of a few hundred checks.',
  'Deployed as one container behind Caddy. Nightly SQLite backups with a weekly restore test. If the API is down the app keeps working offline and shows a quiet "not synced" badge.',
  'Unit tests for the streak calculation (weekly targets, gaps, time zones) and the sync queue; a Playwright smoke test that adds a habit, checks it, reloads offline and sees the check. Acceptance: a month of fixture checks produces the expected streaks and heat map.',
  'Time-zone changes can break streaks if dates are computed wrongly. Offline conflict handling is simple but may surprise. Open: do weekly targets reset on Monday or rolling 7 days, and is a PWA install worth it in v1?',
]);

/** Any other project the owner drafts in the sim: still a complete, non-thin PRD. */
export function genericPrd(title: string, intent: string): string {
  return prd(title, PRD_SECTIONS.map((s) =>
    `${s.hint} For ${title}: ${intent.replace(/\.$/, '')}. This section is drafted by the simulation's scripted model, so it is plausible rather than considered — edit it, or treat it as a placeholder long enough to count as written.`));
}

export const POMODORO_ROADMAP: RoadmapItem[] = [
  { title: 'CLI skeleton and timer core', summary: 'bin/pomodoro.mjs runs a 25/5 cycle from a pure timer state machine; node:test covers phase order.', estimate: 'half a day' },
  { title: 'Session length flags', summary: '--work, --break, --long-break and --cycles override the defaults, validated with clear errors.', estimate: 'half a day', dependsOn: ['m1'] },
  { title: 'Desktop notifications', summary: 'Each phase end raises a desktop notification, with a terminal-bell fallback.', estimate: '1 day', dependsOn: ['m1'] },
  { title: 'Session log', summary: 'Completed and abandoned sessions append to a JSONL log with 0600 permissions.', estimate: '1 day', dependsOn: ['m1'] },
  { title: 'Daily stats command', summary: '`pomodoro stats` prints today and the last 7 days with a sparkline, from the log.', estimate: '1 day', dependsOn: ['m4'] },
  { title: 'Web dashboard', summary: '`pomodoro serve` shows the live countdown in a browser on 127.0.0.1.', estimate: '1 day', dependsOn: ['m1'] },
  { title: 'Pause, resume and keys', summary: 'p/r/q control the running timer; paused time is excluded from the session.', estimate: 'half a day', dependsOn: ['m1'] },
  { title: 'Config file and profiles', summary: 'A config file sets defaults; named profiles switch between them.', estimate: '1 day', dependsOn: ['m2'] },
  { title: 'Packaging and release', summary: 'npm package with a bin entry, README, and a 0.1.0 release.', estimate: 'half a day', dependsOn: ['m5', 'm6'] },
];

export const HABIT_ROADMAP: RoadmapItem[] = [
  { title: 'App shell and local store', summary: 'Vite + TS app with an IndexedDB store for habits and checks.', estimate: '1 day' },
  { title: 'Habits list and check-off', summary: 'Create habits and toggle today\'s check with an optimistic update.', estimate: '1 day', dependsOn: ['m1'] },
  { title: 'Streaks', summary: 'Current and best streak per habit, derived from checks, with tests for weekly targets.', estimate: '1 day', dependsOn: ['m2'] },
  { title: 'Detail view and heat map', summary: 'Per-habit month heat map and edit/archive controls.', estimate: '1 day', dependsOn: ['m2'] },
  { title: 'Sync API', summary: 'Fastify + SQLite API with login and a sync queue on the client.', estimate: '2 days', dependsOn: ['m1'] },
  { title: 'Export and deploy', summary: 'JSON export, container image and nightly backups.', estimate: '1 day', dependsOn: ['m5'] },
];

export function genericRoadmap(title: string): RoadmapItem[] {
  return [
    { title: 'Project skeleton', summary: `A runnable ${title} skeleton with a test runner wired up.`, estimate: 'half a day' },
    { title: 'Core feature', summary: 'The one behaviour the PRD centres on, end to end, with tests.', estimate: '1 day', dependsOn: ['m1'] },
    { title: 'Persistence', summary: 'State survives a restart.', estimate: '1 day', dependsOn: ['m2'] },
    { title: 'Polish and release', summary: 'Error messages, README, and a first tagged release.', estimate: 'half a day', dependsOn: ['m3'] },
  ];
}

/** pomodoro-cli's workspace as m1 left it: written through the Code screen's save route. */
export const POMODORO_WORKSPACE: Record<string, string> = {
  'package.json': `${JSON.stringify({
    name: 'pomodoro-cli', version: '0.1.0', type: 'module',
    bin: { pomodoro: 'bin/pomodoro.mjs' },
    scripts: { test: 'node --test', start: 'node bin/pomodoro.mjs', serve: 'node serve.mjs' },
  }, null, 2)}\n`,
  'README.md': [
    '# pomodoro-cli',
    '',
    'A terminal Pomodoro timer. `pomodoro start` runs 25/5 cycles; `npm test` runs the suite.',
    '',
    '```sh',
    'node bin/pomodoro.mjs start --work 50 --break 10',
    '```',
    '',
  ].join('\n'),
  'bin/pomodoro.mjs': [
    '#!/usr/bin/env node',
    "import { createTimer, format } from '../src/timer.mjs';",
    '',
    'const [command = \'start\'] = process.argv.slice(2);',
    "if (command !== 'start') {",
    '  console.error(`unknown command: ${command}`);',
    '  process.exit(2);',
    '}',
    '',
    'const timer = createTimer({ workMin: 25, breakMin: 5 });',
    'const tick = setInterval(() => {',
    '  const state = timer.tick(Date.now());',
    '  process.stdout.write(`\\r${state.phase.padEnd(10)} ${format(state.remainingMs)}`);',
    "  if (state.phase === 'done') clearInterval(tick);",
    '}, 250);',
    '',
  ].join('\n'),
  'src/timer.mjs': [
    '/** A pure timer state machine: the caller supplies the clock, so tests never wait. */',
    'export function createTimer({ workMin = 25, breakMin = 5, longBreakMin = 15, cycles = 4 } = {}, start = Date.now()) {',
    '  const phases = [];',
    '  for (let i = 1; i <= cycles; i++) {',
    "    phases.push({ phase: 'work', ms: workMin * 60_000 });",
    "    phases.push({ phase: i === cycles ? 'long-break' : 'break', ms: (i === cycles ? longBreakMin : breakMin) * 60_000 });",
    '  }',
    '  return {',
    '    tick(now) {',
    '      let elapsed = now - start;',
    '      for (const p of phases) {',
    '        if (elapsed < p.ms) return { phase: p.phase, remainingMs: p.ms - elapsed };',
    '        elapsed -= p.ms;',
    '      }',
    "      return { phase: 'done', remainingMs: 0 };",
    '    },',
    '  };',
    '}',
    '',
    'export function format(ms) {',
    '  const s = Math.ceil(ms / 1000);',
    "  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;",
    '}',
    '',
  ].join('\n'),
  'test/timer.test.mjs': [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { createTimer, format } from '../src/timer.mjs';",
    '',
    "test('runs work then break', () => {",
    '  const t = createTimer({ workMin: 25, breakMin: 5 }, 0);',
    "  assert.equal(t.tick(0).phase, 'work');",
    "  assert.equal(t.tick(25 * 60_000).phase, 'break');",
    '});',
    '',
    "test('the fourth break is long', () => {",
    '  const t = createTimer({ workMin: 1, breakMin: 1, longBreakMin: 3, cycles: 4 }, 0);',
    "  assert.equal(t.tick(7 * 60_000).phase, 'long-break');",
    "  assert.equal(t.tick(11 * 60_000).phase, 'done');",
    '});',
    '',
    "test('formats mm:ss', () => assert.equal(format(61_000), '01:01'));",
    '',
  ].join('\n'),
  'serve.mjs': [
    '// The preview: serves web/ under the base path the hub hands us, on the port it hands us.',
    "import { createServer } from 'node:http';",
    "import { readFile } from 'node:fs/promises';",
    '',
    "const base = process.env.AGENTHUB_PREVIEW_BASE ?? '/';",
    'const port = Number(process.env.PORT ?? 4180);',
    'createServer(async (req, res) => {',
    "  const path = (req.url ?? '/').split('?')[0];",
    "  const rel = path.startsWith(base) ? path.slice(base.length) : '';",
    "  const file = rel === '' || rel === 'index.html' ? 'web/index.html' : null;",
    '  if (!file) { res.writeHead(404).end(\'not found\'); return; }',
    "  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });",
    "  res.end(await readFile(new URL(file, import.meta.url)));",
    "}).listen(port, '127.0.0.1', () => console.log(`pomodoro dashboard on ${port}${base}`));",
    '',
  ].join('\n'),
  'web/index.html': [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Pomodoro</title>',
    '<style>',
    '  body { margin: 0; height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #1d1f24; color: #f4f1ea; }',
    '  .phase { text-transform: uppercase; letter-spacing: .2em; color: #e76f51; font-size: 14px; }',
    '  .clock { font-size: 18vmin; font-variant-numeric: tabular-nums; margin: .1em 0; }',
    '  .meta { color: #9aa0a6; font-size: 14px; }',
    '</style></head>',
    '<body><main style="text-align:center">',
    '  <div class="phase" id="phase">work</div>',
    '  <div class="clock" id="clock">25:00</div>',
    '  <div class="meta">cycle 2 / 4 · 1h 40m focused today</div>',
    '</main>',
    '<script>',
    '  let left = 25 * 60;',
    '  setInterval(() => {',
    '    left = left > 0 ? left - 1 : 25 * 60;',
    "    document.getElementById('clock').textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;",
    '  }, 1000);',
    '</script></body></html>',
    '',
  ].join('\n'),
};

/** pomodoro-cli's docs pages besides the code map, which the scripted model writes itself. */
export const POMODORO_DOCS: Record<string, string> = {
  'getting-started': [
    '# Getting started',
    '',
    'Install the CLI from the workspace and run one cycle:',
    '',
    '```sh',
    'npm install -g .',
    'pomodoro start',
    '```',
    '',
    'The defaults are 25 minutes of work and 5 of break, with a 15-minute break after every fourth cycle.',
    'Press `q` to stop; an unfinished session is logged as abandoned.',
    '',
  ].join('\n'),
  architecture: [
    '---',
    'section: Internals',
    '---',
    '# Architecture',
    '',
    'Three modules, each testable on its own:',
    '',
    '- **src/timer.mjs** — a pure state machine. It never reads the clock; the caller passes `now`.',
    '- **src/log.mjs** — appends sessions to a JSON-lines file and reads them back, skipping corrupt lines.',
    '- **src/stats.mjs** — folds the log into daily and weekly totals.',
    '',
    ':::info',
    'The timer computes remaining time from the wall clock rather than counting ticks, so a slow event',
    'loop or a laptop sleep never makes it drift. See the decision log entry for m1.',
    ':::',
    '',
    '`bin/pomodoro.mjs` is the only module that touches the terminal, and `serve.mjs` the only one that',
    'opens a socket.',
    '',
  ].join('\n'),
  'cli-reference': [
    '# CLI reference',
    '',
    '| Command | What it does |',
    '| --- | --- |',
    '| `pomodoro start` | Runs work/break cycles until the last long break ends. |',
    '| `pomodoro stats` | Today and the last 7 days, from the session log. |',
    '| `pomodoro serve` | The live dashboard on 127.0.0.1. |',
    '',
    '## Flags',
    '',
    '- `--work <min>` — work length (default 25)',
    '- `--break <min>` — short break (default 5)',
    '- `--long-break <min>` — long break (default 15)',
    '- `--cycles <n>` — work blocks before a long break (default 4)',
    '',
  ].join('\n'),
  'session-log': [
    '---',
    'section: Internals',
    '---',
    '# Session log format',
    '',
    'One JSON object per line in `~/.local/share/pomodoro/sessions.jsonl`:',
    '',
    '```json',
    '{"id":"s_01","startedAt":1759300000000,"endedAt":1759301500000,"phase":"work","plannedMin":25,"actualMin":25,"completed":true}',
    '```',
    '',
    'The file is append-only and created with mode 0600.',
    '',
  ].join('\n'),
};

/** The code map the scripted model writes when asked (`write_code_map`). */
export const POMODORO_CODE_MAP = [
  '# Code map',
  '',
  '## Where it starts',
  '- `bin/pomodoro.mjs:1` — the CLI entry: parses the command and drives the timer.',
  '- `serve.mjs:1` — the dashboard server behind the preview.',
  '',
  '## The timer',
  '- `src/timer.mjs:2` — `createTimer`: the phase list and the pure `tick(now)`.',
  '- `src/timer.mjs:19` — `format`: milliseconds to mm:ss.',
  '',
  '## Tests',
  '- `test/timer.test.mjs:5` — phase order and the long break.',
  '',
].join('\n');
