import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

/**
 * The code at each path, joined: a file as it is, a folder file by file. A module split into a folder of its own
 * (src/engine/live.ts and src/engine/live/) reads as one text. Paths are from squad-kit's own folder.
 */
export function codeAt(...paths: string[]): string {
  return paths
    .map((p) => path.resolve(ROOT, p))
    .flatMap((p) => (fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter((f) => /\.tsx?$/.test(f)).sort().map((f) => path.join(p, f)) : [p]))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
}
