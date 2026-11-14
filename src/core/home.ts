import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** squad-kit's folder on this computer (ADR-001): the person's settings and each project's local files. SQUAD_KIT_HOME moves it, for tests. */
export function squadHome(): string {
  return process.env.SQUAD_KIT_HOME?.trim() || path.join(os.homedir(), '.squad-kit');
}

/**
 * A module's own private folder inside squad-kit's folder, named by the module: the settings of an outside tool that
 * squad-kit signs in with on its own, apart from the person's (ADR-011). The guard keeps every one from agents. A plain
 * name only (small letters, digits, dashes), so it can never point outside squad-kit's folder.
 */
export function privateFolder(name: string, home: string = squadHome()): string {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`"${name}" is not a name for a private folder.`);
  return path.join(home, name);
}

/**
 * The private folder, made sure of before a tool uses it: a real folder that only this person may read. Anything else
 * standing there (a link to another place, a file) is taken away first, never followed.
 */
export function readyPrivateFolder(name: string): string {
  const dir = privateFolder(name);
  const there = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (there && (there.isSymbolicLink() || !there.isDirectory())) fs.rmSync(dir, { force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  return dir;
}

/**
 * squad-kit's folders the guard keeps out of reach: this board's own, and the person's usual one. A board started with
 * SQUAD_KIT_HOME elsewhere (a test, or the squad-kit a story of squad-kit's own code starts) still hides the person's
 * own board, its sign-in and its token.
 */
export function squadHomes(home: string = os.homedir()): string[] {
  return [...new Set([squadHome(), path.join(home, '.squad-kit')])];
}
