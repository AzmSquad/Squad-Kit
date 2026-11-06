import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import kleur from 'kleur';
import * as ui from '../ui/index.js';
import { SQUAD_DIR } from '../core/paths.js';
import { findProject, forgetProject, projectName, readProjects } from '../core/projects.js';
import { boardExists, boardPaths, listTickets, readMeta } from '../board/store.js';
import { inbox } from '../board/actions.js';
import { runningApp } from '../board/console-info.js';
import { setupLine, setupView } from '../board/first-run.js';
import { makeNewProject, type NewProjectInput } from '../engine/new-project.js';
import { rememberProject } from '../core/projects.js';

const out = (s = '') => process.stdout.write(`${s}\n`);
const home = (p: string) => (p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p);

/** One line of what a project is doing, the way Home shows it. */
function stateOf(root: string): string {
  if (!fs.existsSync(path.join(root, SQUAD_DIR, 'config.yaml'))) return kleur.red(fs.existsSync(root) ? 'its squad-kit files are gone' : 'the folder is not there any more');
  const bp = boardPaths(path.join(root, SQUAD_DIR));
  if (!boardExists(bp)) return kleur.gray('no board yet: run squad console in its folder');
  const meta = readMeta(bp);
  // The first run, step by step, until the person checked the overview: `squad setup` and `squad overview` there.
  const setup = setupView(bp);
  if (setup && !setup.approved) {
    const line = setupLine(setup);
    return setup.steps.some((s) => s.state === 'failed' && s.id === 'read') ? kleur.red(line) : kleur.yellow(line);
  }
  if (meta.engine === 'live' && meta.scan && meta.scan.status !== 'done') {
    return meta.scan.status === 'failed' ? kleur.red('the Architect could not read it') : kleur.yellow('setting up: the Architect reads it');
  }
  const open = listTickets(bp).filter((t) => t.stage !== 'done').length;
  const waiting = inbox(bp).length;
  return `${kleur.gray(`${open} open`)}${waiting ? kleur.yellow(` · ${waiting} waiting for you`) : ''}`;
}

export interface ProjectsOptions {
  remove?: string;
  new?: string;
  where?: string;
  idea?: string;
  brd?: string;
}

/** `squad projects --new`: the same New project as the app's button, through the running app when there is one. */
async function newProject(name: string, opts: ProjectsOptions): Promise<void> {
  if (opts.brd && !fs.existsSync(opts.brd)) throw new Error(`There is no file at ${opts.brd}.`);
  const input: NewProjectInput = {
    name,
    ...(opts.where ? { where: path.resolve(opts.where) } : {}),
    ...(opts.idea ? { idea: opts.idea } : {}),
    ...(opts.brd ? { file: { name: path.basename(opts.brd), data: fs.readFileSync(opts.brd).toString('base64') } } : {}),
  };
  const app = runningApp();
  let root: string;
  if (app) {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/v1/app/projects/new`, {
      method: 'POST',
      headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const made = (await res.json()) as { root?: string; error?: string };
    if (!res.ok || !made.root) throw new Error(made.error ?? 'squad-kit could not make the project.');
    root = made.root;
  } else {
    const made = makeNewProject(input);
    rememberProject(made.bp.projectId, made.bp.root);
    root = made.bp.root;
  }
  ui.success(`${path.basename(root)} is ready in ${home(root)}.`);
  out(opts.idea ? '  The Architect reads what you want to build. Follow it in its folder with: squad setup --follow' : '  The Analyst reads your BRD. Follow it in its folder with: squad requirements');
  if (!app) out('  Its squad starts when you open squad-kit: squad');
}

/** `squad projects`: the app's list of projects, `--new` to start one, or `--remove` to take one out. Its files stay in its folder. */
export async function runProjects(opts: ProjectsOptions): Promise<void> {
  if (opts.new !== undefined) return newProject(opts.new, opts);
  const app = runningApp();
  if (opts.remove) {
    // A project whose folder is gone can still be taken off the list: by its id, its folder or its folder's name.
    const gone = readProjects().find((p) => !fs.existsSync(p.root) && (p.id === opts.remove || p.root === path.resolve(opts.remove!) || path.basename(p.root).toLowerCase() === opts.remove!.toLowerCase()));
    const root = gone?.root ?? findProject(opts.remove);
    const entry = readProjects().find((p) => p.root === root);
    if (!entry) throw new Error(`${projectName(root)} is not in squad-kit.`);
    if (app) {
      // The running app stops that project's squad and takes it off its list.
      const res = await fetch(`http://127.0.0.1:${app.port}/api/v1/app/projects/${encodeURIComponent(entry.id)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${app.token}` },
      }).catch(() => null);
      if (!res?.ok) forgetProject(entry.id);
    } else {
      forgetProject(entry.id);
    }
    ui.success(`${projectName(root)} is out of squad-kit. Its files stay in ${home(root)}. Add it again any time: squad console in its folder.`);
    return;
  }
  const list = readProjects();
  out();
  out(`  ${kleur.bold('Your projects')} ${kleur.gray(`(${list.length})`)}${app ? kleur.gray(`  squad-kit is open: http://127.0.0.1:${app.port}/?t=${app.token}`) : ''}`);
  out();
  if (!list.length) {
    out(kleur.gray('  No projects yet. Open a terminal in a project folder (or a new, empty one) and run: squad console'));
    out();
    return;
  }
  const names = list.map((p) => projectName(p.root));
  const w = Math.max(...names.map((n) => n.length));
  list.forEach((p, i) => out(`  ${kleur.bold(names[i]!.padEnd(w))}  ${kleur.gray(home(p.root))}  ${stateOf(p.root)}`));
  out();
  out(kleur.gray(app ? '  Add one: squad console in its folder, or Add project on Home.' : '  Open them all: squad'));
  out();
}
