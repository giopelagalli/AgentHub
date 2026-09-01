import { createHub } from './server.js';

const hub = createHub({ dbPath: process.env.HUB_DB ?? 'data/hub.db' });
const port = Number(process.env.PORT ?? 4000);
hub.app.listen({ port, host: '0.0.0.0' }).then((addr) => console.log(`[hub] listening at ${addr}`)).catch((err) => {
  console.error('[hub] failed to start:', err);
  process.exit(1);
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => hub.stop().then(() => process.exit(0)));
