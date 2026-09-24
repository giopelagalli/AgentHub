import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      // `ws: true` because one route under /api is an upgrade: the project terminal (FR-B2).
      '/api': { target: 'http://127.0.0.1:4000', ws: true },
      '/ws': { target: 'http://127.0.0.1:4000', ws: true },
    },
  },
});
