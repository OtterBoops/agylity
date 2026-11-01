import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const rootPkg = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8')
);

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version || '0.2.0'),
  },
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
