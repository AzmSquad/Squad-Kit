import os from 'node:os';
import path from 'node:path';

/** squad-kit's folder on this computer (ADR-001): the person's settings and each project's local files. SQUAD_KIT_HOME moves it, for tests. */
export function squadHome(): string {
  return process.env.SQUAD_KIT_HOME?.trim() || path.join(os.homedir(), '.squad-kit');
}

/**
 * squad-kit's own sign-in with Microsoft's Azure tool, az, apart from the person's own `~/.azure` (ADR-011). Inside
 * squad-kit's folder, so the guard keeps it from agents too.
 */
export function ownAzureFolder(home: string = squadHome()): string {
  return path.join(home, 'azure-cli');
}

/**
 * squad-kit's folders the guard keeps out of reach: this board's own, and the person's usual one. A board started with
 * SQUAD_KIT_HOME elsewhere (a test, or the squad-kit a story of squad-kit's own code starts) still hides the person's
 * own board, its sign-in and its token.
 */
export function squadHomes(home: string = os.homedir()): string[] {
  return [...new Set([squadHome(), path.join(home, '.squad-kit')])];
}
