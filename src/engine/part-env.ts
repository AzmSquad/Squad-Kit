import path from 'node:path';
import { writeLog } from '../core/app-log.js';
import { isCompose } from './compose-run.js';
import { envFilesFor, readEnvFiles } from './env-file.js';
import { addressKind, composeServices, swapServiceHost, type ComposeService } from './service-hosts.js';

/**
 * What a part's env file gives a command squad-kit starts for that part on this computer: the start, the setup, the
 * checks and the agents' run_checks (engine/env-file.ts). Its values come first, from the file in the copy the command
 * runs in, and squad-kit's own go on top: a setting that names a Docker service reaches it through the port that service
 * publishes here, then the story's own database, its own Redis number and the port squad-kit picked (project-guard.ts
 * puts those after this). A database on another computer stays as it is: no story database is made there (story-db.ts).
 * Only a copy squad-kit made gets it, never the person's own folder, and never a command that runs in Compose, which
 * reads the file itself. The log hears the names only, never a value.
 */

export function partEnv(command: string, cwd: string): Record<string, string> {
  if (isCompose(command)) return {};
  try {
    const part = envFilesFor(cwd);
    if (!part?.copy) return {};
    const got = readEnvFiles(part.top, part.files);
    let services: ComposeService[] | undefined;
    const swapped: string[] = [];
    for (const [name, value] of Object.entries(got.env)) {
      const kind = addressKind(name, value);
      if (!kind) continue;
      services ??= composeServices(part.top);
      const here = swapServiceHost(value, services, kind === 'redis');
      if (!here) continue;
      got.env[name] = here;
      swapped.push(name);
    }
    const names = Object.keys(got.env);
    const named = names.length > 20 ? `${names.slice(0, 20).join(', ')} and ${names.length - 20} more` : names.join(', ') || 'none';
    tell(part.top, [
      ...(got.read.length ? [`squad-kit gives the commands it runs in ${path.basename(part.top)} the settings in ${got.read.join(', ')}: ${named}. Its own database, Redis and port go on top.`] : []),
      ...(swapped.length ? [`${swapped.join(', ')} in ${got.read.join(', ')} ${swapped.length === 1 ? 'names' : 'name'} a Docker service, so the app squad-kit starts on this computer reaches it through the port that service publishes here.`] : []),
      ...(got.missing.length ? [`${path.basename(part.top)} has no ${got.missing.join(', ')}, so its commands run without ${got.missing.length === 1 ? 'that env file' : 'those env files'}. An untracked file needs values for stories: add it as a local file in Settings.`] : []),
      ...(got.refused.length ? [`squad-kit did not read ${got.refused.join(', ')} in ${path.basename(part.top)}: an env file must be a small file inside the copy.`] : []),
    ]);
    return got.env;
  } catch {
    // An env file squad-kit cannot read changes nothing: the command runs as it did.
    return {};
  }
}

/** Each copy hears each line once: an app starts again for each round of pictures. */
const told = new Set<string>();
function tell(top: string, lines: string[]): void {
  for (const text of lines) {
    if (told.has(`${top}\n${text}`)) continue;
    told.add(`${top}\n${text}`);
    writeLog({ level: 'info', text });
  }
}
