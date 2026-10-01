import { defineConfig } from 'vite';

// The hub the dev server proxies to: the owner's local hub by default, or whatever `AGENTHUB_HUB_URL`
// names — `npm run sim:ui` points it at the simulation's hub.
const hub = process.env.AGENTHUB_HUB_URL ?? 'http://127.0.0.1:4000';

export default defineConfig({
  server: {
    proxy: {
      // `ws: true` because one route under /api is an upgrade: the project terminal (FR-B2).
      '/api': { target: hub, ws: true },
      '/ws': { target: hub, ws: true },
    },
  },
});
