import kleur from 'kleur';
import * as ui from '../ui/index.js';
import { addLocalFile, addLockedFile, lockDockerFiles, projectFilesView, removeProjectFile, useMyFile } from '../board/project-files.js';
import { board } from './board.js';

/** `squad files`: the files agents may not touch, the same as the list in Settings, with every change as an option. */

const out = (s = '') => process.stdout.write(`${s}\n`);
const cmd = (s: string) => kleur.green(s);

export interface FilesOptions {
  local?: string;
  lock?: string;
  lockDocker?: boolean;
  useMine?: string;
  remove?: string;
  repo?: string;
}

export async function runFiles(opts: FilesOptions): Promise<void> {
  const bp = board();
  if (opts.local !== undefined) {
    const f = addLocalFile(bp, opts.repo, opts.local);
    ui.success(`${f.path} is a local file. No agent can read it.`);
    ui.info(`Stories need their own values for it. Use test values: a test could read and send them. Start from yours: ${cmd(`squad files --use-mine ${f.path}`)}`);
  } else if (opts.lock !== undefined) ui.success(`${addLockedFile(bp, opts.repo, opts.lock).path} is locked. Agents can read it and never change it.`);
  else if (opts.lockDocker) ui.success(`Locked ${lockDockerFiles(bp).map((f) => f.path).join(', ')}.`);
  else if (opts.useMine !== undefined) ui.success(`Stories now use a copy of your ${useMyFile(bp, opts.repo, opts.useMine).path}. Change any real values in it to test values: ${projectFilesView(bp).local.find((f) => f.path === opts.useMine)?.storyFile ?? ''}`);
  else if (opts.remove !== undefined) ui.success(`${removeProjectFile(bp, opts.repo, opts.remove).path} is off the list.`);
  else {
    const v = projectFilesView(bp);
    const shown = (repo: string, file: string) => (v.repos.length > 1 ? `${repo}/${file}` : file);
    out();
    out(`  ${kleur.bold('Local files')}  ${kleur.gray('git does not carry them, and no agent can read them')}`);
    if (!v.local.length) out(kleur.gray('    None'));
    for (const f of v.local) out(`    ${shown(f.repo, f.path)}  ${f.ready ? kleur.green('ready') : kleur.yellow('no values for stories yet')}${f.ready ? kleur.gray(`  ${f.storyFile}`) : ''}`);
    out();
    out(`  ${kleur.bold('Locked files')}  ${kleur.gray('agents can read them and never change them')}`);
    if (!v.locked.length) out(kleur.gray('    None'));
    for (const f of v.locked) out(`    ${shown(f.repo, f.path)}`);
    out();
    if (v.docker.length) ui.info(`${v.docker.length} Docker ${v.docker.length === 1 ? 'file is' : 'files are'} not locked: ${cmd('squad files --lock-docker')}`);
    ui.info(`Add one: ${cmd('squad files --local .env.dev')}   ${cmd('squad files --lock docker-compose.yml')}`);
  }
}
