import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * ADR-002: the engine only knows the module interfaces and the registry, and a product folder never uses another
 * one. Adding a tracker, code host, AI tool, speech service or browser then never touches the engine.
 */

const SRC = path.resolve(__dirname, '../src');
const MODULES = path.join(SRC, 'modules');
/** The folders that hold one kind's interface, not a product. */
const KINDS = new Set(['tracker', 'code-host', 'ai-tool', 'speech', 'browser']);
const PRODUCTS = fs
  .readdirSync(MODULES, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !KINDS.has(d.name))
  .map((d) => d.name);

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? files(p) : /\.tsx?$/.test(d.name) ? [p] : [];
  });
}

/** Every product folder a file imports from. */
function productsImported(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const found = new Set<string>();
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(file), m[1]!);
    const rel = path.relative(MODULES, target);
    if (rel.startsWith('..')) continue;
    const top = rel.split(path.sep)[0]!;
    if (PRODUCTS.includes(top)) found.add(top);
  }
  return [...found];
}

describe('module boundaries', () => {
  it('has product folders to check', () => {
    expect(PRODUCTS.length).toBeGreaterThan(0);
  });

  it('the engine and the interfaces never import a product, only the registry does', () => {
    const offenders = files(SRC)
      .filter((f) => f !== path.join(MODULES, 'registry.ts'))
      .filter((f) => {
        const rel = path.relative(MODULES, f);
        return rel.startsWith('..') || KINDS.has(rel.split(path.sep)[0]!) || !rel.includes(path.sep);
      })
      .flatMap((f) => productsImported(f).map((p) => `${path.relative(SRC, f)} imports ${p}`));
    expect(offenders).toEqual([]);
  });

  it('a product folder never imports another product', () => {
    const offenders = PRODUCTS.flatMap((product) =>
      files(path.join(MODULES, product)).flatMap((f) =>
        productsImported(f)
          .filter((p) => p !== product)
          .map((p) => `${path.relative(SRC, f)} imports ${p}`),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
