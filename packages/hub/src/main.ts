import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHub } from './server.js';

const uiDist = fileURLToPath(new URL('../../ui/dist', import.meta.url));
if (!existsSync(uiDist)) console.log(`[hub] no UI build at ${uiDist}; serving API only`);

const hub = createHub({
  dbPath: process.env.HUB_DB ?? 'data/hub.db',
  projectsRoot: process.env.PROJECTS_ROOT ?? 'data/projects',
  uiDist,
});
const port = Number(process.env.PORT ?? 4000);
hub.app.listen({ port, host: '0.0.0.0' }).then((addr) => console.log(`[hub] listening at ${addr}`)).catch((err) => {
  console.error('[hub] failed to start:', err);
  process.exit(1);
});
const FORCE_EXIT_MS = 10_000;

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    // Safety net, not the happy path: unref'd so a clean, timely stop() lets the process exit on its
    // own; if stop() hangs (a turn that won't unwind), this fires and forces the exit anyway.
    const forceExit = setTimeout(() => {
      console.error(`[hub] stop() did not finish within ${FORCE_EXIT_MS}ms; forcing exit`);
      process.exit(1);
    }, FORCE_EXIT_MS);
    forceExit.unref();
    hub.stop().then(() => process.exit(0)).catch((err) => {
      console.error('[hub] stop() failed:', err);
      process.exit(1);
    });
  });
}
