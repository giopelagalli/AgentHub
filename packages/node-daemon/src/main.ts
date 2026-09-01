import { loadConfig } from './config.js';
import { Daemon } from './daemon.js';

const cfgPath = process.argv[2];
if (!cfgPath) { console.error('usage: tsx src/main.ts <config.yaml>'); process.exit(1); }
const daemon = new Daemon(loadConfig(cfgPath));
daemon.start().then(() => console.log('[daemon] up'));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => daemon.stop().then(() => process.exit(0)));
