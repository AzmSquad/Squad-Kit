import { kindOfAddress as guessKind } from './address.js';
import { readTemplate as readFolder } from './folder.js';
import { mongo } from './mongo.js';
import { mysql } from './mysql.js';
import { postgres } from './postgres.js';
import { sqlite } from './sqlite.js';
import type { DbAdapter, DbKind, DbTemplate } from './types.js';

/**
 * The way in to squad-kit's database adapters: one per kind, behind the interface in types.ts. Nothing outside this
 * folder names a kind's tools.
 */

const ADAPTERS: Record<DbKind, DbAdapter> = { sqlite, postgres, mysql, mongo };

export function dbAdapter(kind: DbKind): DbAdapter {
  const a = ADAPTERS[kind];
  if (!a) throw new Error(`squad-kit has no adapter for ${String(kind)} databases.`);
  return a;
}

/** A guess at the kind of database from the address's form alone, or null when the form does not say. */
export function kindOfAddress(address: string): DbKind | null {
  return guessKind(address);
}

/** A template made earlier, read back from its folder, with the person's address (and its password) to make databases with. */
export function readTemplate(folder: string, source: string): DbTemplate | null {
  return readFolder(folder, source);
}

export * from './types.js';
