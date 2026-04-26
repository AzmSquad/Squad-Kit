#!/usr/bin/env tsx
import fs from 'node:fs';
import path from 'node:path';

const htmlPath = path.join(process.cwd(), 'dist/console-ui/index.html');
if (!fs.existsSync(htmlPath)) {
  console.error('verify-console-build: missing dist/console-ui/index.html (run pnpm run build:ui first)');
  process.exit(1);
}

const html = fs.readFileSync(htmlPath, 'utf8');
// Vite emits hashed filenames under assets/ (e.g. index-abc123def.js)
const hasHashedAsset =
  /\/assets\/[^"'>\s]+-[a-zA-Z0-9_-]{6,}\.(js|css)/.test(html) ||
  (/\/assets\/[^"'>\s]+\.(js|css)/.test(html) && /[a-f0-9]{8}/.test(html));

if (!hasHashedAsset) {
  console.error('verify-console-build: index.html does not reference a hashed asset under assets/');
  process.exit(1);
}

console.log('verify-console-build: OK');
