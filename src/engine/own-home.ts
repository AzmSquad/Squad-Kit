import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A squad-kit that a project command or an agent starts never lands on the person's own board. Every project command
 * (setup, checks, the app, Try it yourself) and every agent gets a squad-kit home folder of its own copy, in the cache
 * home that copy may write (engine/cache-home.ts), or in the temp folder where there is none. A squad-kit started there,
 * as a story of squad-kit's own code starts one, keeps its settings, sample board and lock there: it never reads the
 * person's board, its token, its lock or its keeper, and the guard hides those anyway. It looks for no update and opens
 * no browser.
 */

/** The home folder of the squad-kit a command in this copy starts. */
export function commandHome(cwd: string, cache?: string): string {
  // The copy's real place, so its agents and its commands (whose guard keeps real paths) share one home.
  let at = path.resolve(cwd);
  try {
    at = fs.realpathSync(at);
  } catch {
    // Not made yet: its path as given.
  }
  const name = `${path.basename(at).replace(/[^\w.-]+/g, '-').slice(0, 40) || 'copy'}-${createHash('sha256').update(at).digest('hex').slice(0, 8)}`;
  return path.join(cache ?? path.join(os.tmpdir(), 'squad-kit-copies'), 'squad-kit-homes', name);
}

/** The environment that sends a squad-kit started in this copy to its own home, with no update check and no browser. */
export function ownHomeEnv(cwd: string, cache?: string): Record<string, string> {
  return { SQUAD_KIT_HOME: commandHome(cwd, cache), SQUAD_KIT_UPDATES: 'off', SQUAD_KIT_BROWSER: 'off' };
}
