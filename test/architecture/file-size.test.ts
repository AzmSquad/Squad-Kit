// After a split, lower the file's number in file-size-caps.json to its new line count (wc -l), or remove it at 600 or less.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * ADR-005: no source file grows past 600 lines. The files that were bigger when the rule came are listed with their
 * size then, and each may only shrink.
 */

const ROOT = path.resolve(__dirname, '../..');
const LIMIT = 600;
/** The source folders the rule covers: the CLI and engine, the board's pages and squad-kit's own scripts. */
const FOLDERS = ['src', 'console-ui/src', 'scripts'];
const caps = JSON.parse(fs.readFileSync(path.join(__dirname, 'file-size-caps.json'), 'utf8')) as Record<string, number>;

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? files(p) : /\.tsx?$/.test(d.name) ? [p] : [];
  });
}

/** Lines as `wc -l` counts them. */
function lines(file: string): number {
  return (fs.readFileSync(file, 'utf8').match(/\n/g) ?? []).length;
}

const sizes = new Map(FOLDERS.flatMap((f) => files(path.join(ROOT, f))).map((f) => [path.relative(ROOT, f).split(path.sep).join('/'), lines(f)]));

describe('file size', () => {
  it('finds the source files', () => {
    expect(sizes.size).toBeGreaterThan(100);
  });

  it(`a file not on the list stays at ${LIMIT} lines or less`, () => {
    const over = [...sizes].filter(([f, n]) => n > LIMIT && caps[f] === undefined).map(([f, n]) => `${f}: ${n} lines`);
    expect(over, `Split these by feature: no new file may pass ${LIMIT} lines (ADR-005).`).toEqual([]);
  });

  it('a listed file never grows past its number', () => {
    const grew = Object.entries(caps)
      .filter(([f, cap]) => (sizes.get(f) ?? 0) > cap)
      .map(([f, cap]) => `${f}: ${sizes.get(f)} lines, its number is ${cap}`);
    expect(grew, 'A listed file may only shrink. Move the new code to a new, smaller file.').toEqual([]);
  });

  it('the list only holds files that are still too big', () => {
    const stale = Object.keys(caps)
      .filter((f) => (sizes.get(f) ?? 0) <= LIMIT)
      .map((f) => (sizes.has(f) ? `${f}: ${sizes.get(f)} lines` : `${f}: gone`));
    expect(stale, `Take these off file-size-caps.json: they are ${LIMIT} lines or less now.`).toEqual([]);
  });
});
