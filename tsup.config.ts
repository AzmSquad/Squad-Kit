import { defineConfig } from 'tsup';

// SPA lives under dist/console-ui/ from Vite; this bundle is CLI-only — do not import or inline UI assets.
// clean must stay false so `pnpm build` can run UI first into dist/console-ui/ and tsup second without wiping it.
export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node18',
  platform: 'node',
  clean: false,
  /** Omit from `dist/` by default so the npm tarball stays under size:guard; set `SQUAD_TSUP_SOURCEMAP=1` for local maps. */
  sourcemap: process.env.SQUAD_TSUP_SOURCEMAP === '1',
  shims: true,
  /**
   * Spaces, and syntax written shorter where it means exactly the same; names stay, so a stack trace still says which
   * function. The package has a 4 MB limit.
   */
  minifyWhitespace: true,
  minifySyntax: true,
  banner: { js: '#!/usr/bin/env node' },
});
