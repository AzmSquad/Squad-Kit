import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRepoMap } from '../src/core/repo-map.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-map-'));
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.git'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), '// a\n');
  fs.writeFileSync(path.join(tmp, 'src', 'b.ts'), '// b\n');
  fs.writeFileSync(path.join(tmp, 'src', 'c.log'), 'log\n');
  fs.writeFileSync(path.join(tmp, 'node_modules', 'evil.js'), 'evil\n');
  fs.writeFileSync(path.join(tmp, 'dist', 'out.js'), 'out\n');
  fs.writeFileSync(path.join(tmp, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(tmp, '.gitignore'), '*.log\n');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function posixLines(map: string): string[] {
  return map
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => l.replace(/\\/g, '/'));
}

describe('buildRepoMap', () => {
  it('includes source files and excludes ignored paths', () => {
    const map = buildRepoMap(tmp);
    const lines = posixLines(map);
    expect(lines).toContain('src/a.ts');
    expect(lines).toContain('src/b.ts');
    expect(lines.some((l) => l.includes('node_modules'))).toBe(false);
    expect(lines.some((l) => l.startsWith('dist/') || l === 'dist/out.js')).toBe(false);
    expect(lines.some((l) => l.includes('.git'))).toBe(false);
    expect(lines).not.toContain('src/c.log');
  });

  it('returns paths in sorted order', () => {
    const map = buildRepoMap(tmp);
    const lines = posixLines(map);
    const sorted = [...lines].sort((a, b) => a.localeCompare(b));
    expect(lines).toEqual(sorted);
  });

  it('respects maxEntries', () => {
    const map = buildRepoMap(tmp, { maxEntries: 1 });
    const lines = posixLines(map);
    expect(lines.length).toBeLessThanOrEqual(1);
  });
});
