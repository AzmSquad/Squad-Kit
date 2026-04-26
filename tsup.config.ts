import { defineConfig } from 'tsup';

// SPA lives under dist/console-ui/ from Vite; this bundle is CLI-only — do not import or inline UI assets.
// clean must stay false so `pnpm build` can run UI first into dist/console-ui/ and tsup second without wiping it.
export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node18',
  platform: 'node',
  clean: false,
  sourcemap: true,
  shims: true,
  banner: { js: '#!/usr/bin/env node' },
});
