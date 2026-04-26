import path from 'node:path';

/**
 * True when `abs` is inside `parent` (canonical paths, no prefix-collision on sibling dirs).
 */
export function isInside(abs: string, parent: string): boolean {
  const a = path.resolve(abs) + path.sep;
  const p = path.resolve(parent) + path.sep;
  return a.startsWith(p);
}
