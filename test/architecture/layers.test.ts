import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * ADR-005: the layers only talk the agreed way. The board's pages reach the engine through REST alone, and the engine
 * never reaches back into an interface. Product folders are checked in module-boundaries.test.ts (ADR-002).
 * The live squad's own files are reached only through src/engine/live.ts.
 */

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');
const UI = path.join(ROOT, 'console-ui/src');
/** The live squad's folder. Its entry, src/engine/live.ts, has the same path without the extension. */
const LIVE = path.join(SRC, 'engine/live');

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? files(p) : /\.tsx?$/.test(d.name) ? [p] : [];
  });
}

/** Every file a file imports by a relative path, as full paths without the extension. */
function imported(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)].map((m) => path.resolve(path.dirname(file), m[1]!).replace(/\.(js|tsx?)$/, ''));
}

const inside = (dir: string, target: string) => !path.relative(dir, target).startsWith('..');

describe('layers', () => {
  it("the board's pages never import anything outside console-ui/src", () => {
    const offenders = files(UI).flatMap((f) => imported(f).filter((t) => !inside(UI, t)).map((t) => `${path.relative(ROOT, f)} imports ${path.relative(ROOT, t)}`));
    expect(offenders).toEqual([]);
  });

  it('the board files, the engine and the modules never import an interface: the console, the commands or the CLI', () => {
    const interfaces = [path.join(SRC, 'console'), path.join(SRC, 'commands'), path.join(SRC, 'cli')];
    const offenders = ['board', 'engine', 'modules'].flatMap((layer) =>
      files(path.join(SRC, layer)).flatMap((f) =>
        imported(f)
          .filter((t) => interfaces.some((i) => t === i || inside(i, t)))
          .map((t) => `${path.relative(ROOT, f)} imports ${path.relative(ROOT, t)}`),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("only the live squad's own files import from src/engine/live/: everything else goes through src/engine/live.ts", () => {
    // A step's file loaded before live/squad.ts puts the steps on the class would stop with "before initialization".
    const offenders = [SRC, UI, path.join(ROOT, 'scripts'), path.join(ROOT, 'test')]
      .flatMap((dir) => files(dir))
      .filter((f) => f !== `${LIVE}.ts` && !inside(LIVE, f))
      .flatMap((f) => imported(f).filter((t) => t !== LIVE && inside(LIVE, t)).map((t) => `${path.relative(ROOT, f)} imports ${path.relative(ROOT, t)}`));
    expect(offenders).toEqual([]);
  });
});
