#!/usr/bin/env tsx
/**
 * Fails CI if the published npm tarball unpacked size would exceed 2.5 MB.
 * This cap is intentionally generous (~1.2 MB CLI today + headroom for console-ui growth)
 * so minor UI iterations do not require constant limit tuning; tighten when the bundle
 * is stable again.
 */
import { execSync } from 'node:child_process';

const MAX_PUBLISHED_BYTES = 2.5 * 1024 * 1024;

interface PackedFile {
  path: string;
  size: number;
}
interface PackJson {
  name: string;
  version: string;
  size: number;
  unpackedSize: number;
  files: PackedFile[];
}

const out = execSync('npm pack --dry-run --json', { cwd: process.cwd(), encoding: 'utf8' });
const records = JSON.parse(out) as PackJson | PackJson[];
const pack = Array.isArray(records) ? records[0] : records;
if (!pack) {
  console.error('size-guard: npm pack --dry-run --json returned no records');
  process.exit(1);
}

const total = pack.unpackedSize;
const totalGz = pack.size;

console.log(`Pack:    ${pack.name}@${pack.version}`);
console.log(`Files:   ${pack.files?.length ?? 0}`);
console.log(`Tarball: ${kb(totalGz)} (gzipped)`);
console.log(`Unpacked:${kb(total)}`);
console.log('');
const top = [...(pack.files ?? [])].sort((a, b) => b.size - a.size).slice(0, 10);
console.log('Top files by size:');
for (const f of top) {
  console.log(`  ${kb(f.size).padStart(8)}  ${f.path}`);
}

if (total > MAX_PUBLISHED_BYTES) {
  console.error('');
  console.error(`✗ FAIL: unpacked size ${kb(total)} exceeds cap ${kb(MAX_PUBLISHED_BYTES)}.`);
  console.error('  Investigate the top files above. Likely culprits: an un-minified asset under dist/console-ui/');
  console.error('  or a stray map file. Adjust vite.config.ts (sourcemap: false) or .npmignore as needed.');
  process.exit(1);
}
console.log('');
console.log(`✓ size guard OK  (${kb(total)} ≤ ${kb(MAX_PUBLISHED_BYTES)})`);

function kb(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
