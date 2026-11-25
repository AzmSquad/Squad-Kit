import fs from 'node:fs';

/** Reads are cached by the files' change times, so a board with thousands of tickets stays fast. */
const cache = new Map<string, { stamp: string; value: unknown }>();

function stampOf(files: string[]): string {
  return files.map((f) => (fs.existsSync(f) ? `${fs.statSync(f).mtimeMs}:${fs.statSync(f).size}` : '-')).join('|');
}

/** The value `read` gave for these files, read again only when one of them changed. Each caller gets its own copy. */
export function cached<T>(key: string, files: string[], read: () => T): T {
  const stamp = stampOf(files);
  const hit = cache.get(key);
  if (hit && hit.stamp === stamp) return structuredClone(hit.value) as T;
  const value = read();
  cache.set(key, { stamp, value });
  return structuredClone(value);
}
