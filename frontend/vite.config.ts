import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// https://vite.dev/config/
export default defineConfig({
  plugins: [preact(), tailwindcss()],
  build: {
    outDir: path.resolve(import.meta.dirname, '../dist/web/public'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api':
        process.env.VITE_API_TARGET ||
        (process.env.WEB_UI_PORT
          ? `http://127.0.0.1:${process.env.WEB_UI_PORT}`
          : 'http://127.0.0.1:8484'),
    },
  },
});
