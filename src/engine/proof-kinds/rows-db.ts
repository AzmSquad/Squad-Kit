import fs from 'node:fs';
import path from 'node:path';
import { loadSecrets } from '../../core/secrets.js';
import { readMeta, type BoardPaths } from '../../board/store.js';
import { findDatabase, readAddress } from '../find-database.js';
import { git } from '../git.js';
import { readRows } from '../db/read-rows.js';
import { storyDbs } from '../story-db.js';
import { NoRows, type RowsReader } from './rows.js';

/**
 * Which database read_rows reads: only the story's own (1.3.5). A server database squad-kit made for the story, by its
 * address in this computer's secrets; or a SQLite file inside the story's copy. Never the person's own database, and
 * never one outside the copy: then there is nothing to read, and the Tester is told so.
 */

const NONE = "This story has no database of its own, so squad-kit reads none: prove this line with the API or a picture instead, and say so in the note.";

/** The SQLite file inside the copy that the app's setting names, where it is: from the copy, or from Prisma's schema folder. */
function copyFile(dir: string): string | null {
  const found = findDatabase(dir, ['.']).found;
  const name = found?.kind === 'sqlite' && found.address ? readAddress(found.address).name : undefined;
  if (!name) return null;
  const schemas = git(dir, ['ls-files', '--', '*schema.prisma'], { allowFail: true }).split('\n').filter(Boolean);
  const inside = `${path.resolve(dir)}${path.sep}`;
  const places = path.isAbsolute(name) ? [name] : [...schemas.map((s) => path.resolve(dir, path.dirname(s), name)), path.resolve(dir, name)];
  return places.find((f) => f.startsWith(inside) && fs.existsSync(f)) ?? null;
}

/** The story's own database, or null with no such database. */
export function storyDatabase(bp: BoardPaths, story: string, dir: string): { kind: 'sqlite' | 'postgres' | 'mysql' | 'mongo'; address: string } | null {
  const db = readMeta(bp).database;
  if (!db) return null;
  const own = storyDbs(bp).find((s) => s.story === story);
  if (own) {
    let address: string | undefined;
    try {
      address = loadSecrets(bp.secretsFile).database?.stories?.[story];
    } catch {
      address = undefined;
    }
    if (!address) return null;
    if (own.kind !== 'sqlite') return { kind: own.kind, address };
    const file = readAddress(address).name;
    return file && path.resolve(file).startsWith(`${path.resolve(dir)}${path.sep}`) ? { kind: 'sqlite', address: path.resolve(file) } : null;
  }
  if (db.kind !== 'sqlite') return null;
  const file = copyFile(dir);
  return file ? { kind: 'sqlite', address: file } : null;
}

/** The reader the Tester's window gets for the story's copy `dir`. */
export function rowsReader(bp: BoardPaths, story: string, dir: string): RowsReader {
  return {
    read: async (ask) => {
      const db = storyDatabase(bp, story, dir);
      if (!db) throw new NoRows(NONE);
      return readRows(db.kind, db.address, ask);
    },
  };
}
