/// <reference types="vitest/config" />
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const consoleUiRoot = fileURLToPath(new URL('.', import.meta.url));

/** Every browser the board supports reads woff2: the older woff copy of each font only adds weight to the package. */
const woff2Only = {
  name: 'woff2-only',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (!id.includes('@fontsource') || !id.endsWith('.css')) return null;
    return code.replace(/,\s*url\([^)]*\.woff\)\s*format\(['"]woff['"]\)/g, '');
  },
};

export default defineConfig({
  plugins: [woff2Only, react(), tailwindcss()],
  resolve: {
    alias: { '~': path.join(consoleUiRoot, 'src') },
  },
  base: '/',
  build: {
    outDir: '../dist/console-ui',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    // Fonts must ship as files: the console's CSP blocks data: URLs.
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4571', changeOrigin: false },
      // Each project's API in the one app: /p/<project id>/api/…
      '^/p/[^/]+/(api|mockup)/': { target: 'http://127.0.0.1:4571', changeOrigin: false },
      '/healthz': { target: 'http://127.0.0.1:4571', changeOrigin: false },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
});
