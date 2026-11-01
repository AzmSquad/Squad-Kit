import os from 'node:os';
import path from 'node:path';

/** squad-kit's folder on this computer (ADR-001): the person's settings and each project's local files. SQUAD_KIT_HOME moves it, for tests. */
export function squadHome(): string {
  return process.env.SQUAD_KIT_HOME?.trim() || path.join(os.homedir(), '.squad-kit');
}
