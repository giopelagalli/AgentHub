import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4000',
      '/ws': { target: 'http://127.0.0.1:4000', ws: true },
    },
  },
});
