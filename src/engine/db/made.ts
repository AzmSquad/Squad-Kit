import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { squadHome } from '../../core/home.js';
import type { DbKind } from './types.js';

/**
 * squad-kit's mark on the databases it made: one small file per database on this computer, in squad-kit's own folder
 * (`~/.squad-kit/databases/made/`). A story's database is dropped only when its mark is here (and, on Postgres, its
 * comment on the server says the same), so a database squad-kit did not make is never dropped, whatever its name.
 * One file per database: two stories made at once never write the same file.
 */

export interface MadeMark {
  kind: DbKind;
  /** Who the server is (never a password), from address.ts. */
  server: string;
  /** The database's name, or the file's real path for SQLite. */
  name: string;
  role: 'story' | 'template';
  /** The story's id, for a story's database. */
  story?: string;
  /** The person's database it was made from: its name. */
  sourceName: string;
  madeAt: string;
}

function marksDir(): string {
  return path.join(squadHome(), 'databases', 'made');
}

function markFile(kind: DbKind, server: string, name: string): string {
  const id = createHash('sha256').update(`${kind}\n${server}\n${kind === 'sqlite' ? name : name.toLowerCase()}`).digest('hex').slice(0, 24);
  return path.join(marksDir(), `${id}.json`);
}

export function putMark(mark: MadeMark): void {
  const file = markFile(mark.kind, mark.server, mark.name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(mark, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function readMark(kind: DbKind, server: string, name: string): MadeMark | null {
  try {
    const mark = JSON.parse(fs.readFileSync(markFile(kind, server, name), 'utf8')) as MadeMark;
    return mark.kind === kind && mark.server === server ? mark : null;
  } catch {
    return null;
  }
}

export function dropMark(kind: DbKind, server: string, name: string): void {
  fs.rmSync(markFile(kind, server, name), { force: true });
}
