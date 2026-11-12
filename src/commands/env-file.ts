import kleur from 'kleur';
import * as ui from '../ui/index.js';
import { readMeta } from '../board/store.js';
import { envFilesOf, setEnvFile } from '../engine/env-file.js';
import { reposOf } from '../engine/repos.js';
import { board } from './board.js';

/**
 * `squad config set env-file <path>`: the env file a part's app reads its settings from, like .env.dev, the same as the
 * Env file field beside the part's commands in Settings. squad-kit gives its values to every command it runs for the part
 * on this computer, with its own database, Redis and port on top. Only the path is shown and saved, never a value.
 */

const out = (s = '') => process.stdout.write(`${s}\n`);
const cmd = (s: string) => kleur.green(s);

export async function runEnvFile(paths: string[], opts: { repo?: string; clear?: boolean } = {}): Promise<void> {
  const bp = board();
  if (!paths.length && !opts.clear) {
    const repos = reposOf(readMeta(bp));
    out();
    for (const r of repos) {
      const files = envFilesOf(r.commands);
      out(`  ${kleur.bold(repos.length > 1 ? `Env file of ${r.path}` : 'Env file')}  ${files.length ? files.join(', ') : kleur.gray('none')}`);
    }
    out();
    ui.info(`Set one: ${cmd(`squad config set env-file .env.dev${repos.length > 1 ? ' --repo <repo>' : ''}`)}   None: ${cmd('squad config set env-file --clear')}`);
    return;
  }
  const set = setEnvFile(bp, opts.repo, opts.clear ? [] : paths);
  const where = reposOf(readMeta(bp)).length > 1 ? ` of ${set.repo}` : '';
  if (!set.files.length) ui.success(`The app${where} gets no env file from squad-kit now.`);
  else {
    ui.success(`squad-kit gives the app${where} the settings in ${set.files.join(', ')} from the next command it runs, with its own database, Redis and port on top.`);
    ui.info(`In a story's copy, a file git does not carry needs values for stories: ${cmd(`squad files --local ${set.files[0]}`)}`);
  }
}
