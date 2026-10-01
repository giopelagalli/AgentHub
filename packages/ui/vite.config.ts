import { defineConfig } from 'vite';

/** Where the dev server forwards the API; `HUB_URL` points it at a hub on another port. */
const hub = process.env.HUB_URL ?? 'http://127.0.0.1:4000';

export default defineConfig({
  server: {
    proxy: {
      // `ws: true` because one route under /api is an upgrade: the project terminal (FR-B2).
      '/api': { target: hub, ws: true },
      '/ws': { target: hub, ws: true },
    },
  },
});
