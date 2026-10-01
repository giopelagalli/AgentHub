import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startSim } from './sim.js';

/**
 * `npm run sim` / `npm run sim:ui`: starts the simulation, prints how to reach it, and on Ctrl-C
 * stops everything it started — the hub, its previews and terminals, the mock and the Vite server.
 */
const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '4100' },
    data: { type: 'string' },
    reset: { type: 'boolean', default: false },
    ui: { type: 'boolean', default: false },
    'ui-port': { type: 'string', default: '5180' },
    'token-delay': { type: 'string', default: '30' },
  },
});

process.on('unhandledRejection', (err) => console.error('[sim] unhandled rejection', err));

const port = Number(values.port);
const uiPort = Number(values['ui-port']);
console.log('[sim] starting: mock model, hub, nodes, seed data…');
const sim = await startSim({
  port,
  ...(values.data ? { dataRoot: resolve(values.data) } : {}),
  reset: values.reset,
  tokenDelayMs: Number(values['token-delay']),
  log: (line) => console.log(line),
});

let vite: ChildProcess | undefined;
if (values.ui) {
  const repo = fileURLToPath(new URL('../../..', import.meta.url));
  // detached: its own process group, so stopping takes Vite and anything it spawned down together.
  vite = spawn('npm', ['run', 'dev', '-w', 'packages/ui', '--', '--port', String(uiPort), '--strictPort'], {
    cwd: repo, stdio: 'inherit', detached: true,
    env: { ...process.env, AGENTHUB_HUB_URL: sim.url },
  });
  // Detached means it outlives us unless told otherwise — whatever the exit path (a crash, the
  // force-exit timer), take its whole group down with us. `exit` handlers must be synchronous; kill is.
  process.on('exit', () => {
    if (vite?.pid) {
      try { process.kill(-vite.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
  });
}

const open = values.ui ? `http://localhost:${uiPort}` : sim.url;
console.log([
  '',
  '──────────────── AgentHub simulation ────────────────',
  `  open       ${open}${values.ui ? `   (hub API at ${sim.url})` : ''}`,
  `  password   ${sim.password}`,
  `  data       ${sim.dataRoot}${values.data ? '' : '   (temporary, removed on exit)'}`,
  `  nodes      sim-spark (online, mock model)   sim-mini (browser, 3 slots)   sim-pc (goes offline ~15 s after start)`,
  ...(sim.seeded.length
    ? ['  projects', ...sim.seeded.map((l) => `    ${l}`)]
    : ['  projects   reused from the data directory (not reseeded; --reset to start over)']),
  '  stop       Ctrl-C',
  '──────────────────────────────────────────────────────',
  '',
].join('\n'));

let stopping = false;
function shutdown(code: number): void {
  if (stopping) return;
  stopping = true;
  console.log('\n[sim] stopping…');
  if (vite?.pid) {
    try { process.kill(-vite.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  sim.stop().then(() => process.exit(code), (err: unknown) => {
    console.error('[sim] stop failed:', err);
    process.exit(1);
  });
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => shutdown(0));
// sim:ui without its UI is not what was asked for (a taken --ui-port, usually): say so and stop.
vite?.on('exit', (code) => {
  if (stopping) return;
  console.error(`[sim] the UI dev server exited (${code ?? 'signal'}); is port ${uiPort} taken? Try --ui-port.`);
  shutdown(1);
});
