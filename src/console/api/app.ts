import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Context, Hono } from 'hono';
import { SQUAD_DIR } from '../../core/paths.js';
import { MAX_PARALLEL, parallelLimit, setParallelLimit } from '../../core/settings.js';
import { ticketsRunning } from '../../engine/live.js';
import { isOwnFolder } from '../../engine/setup.js';
import type { OpenProjects } from '../open-projects.js';

/**
 * The app's own API (ADR-001), beside each project's: the projects, Add project with a folder browser, one Waiting
 * for you list across all projects, and the person's settings for every project. Every project's own API stays under
 * /p/<project id>/api/v1/.
 */

export type FolderKind = 'project' | 'repo' | 'repos' | 'empty' | 'files';

export interface FolderListing {
  path: string;
  parent: string | null;
  home: string;
  /** What this folder is, so the person knows what adding it does. */
  kind: FolderKind;
  /** Code repos inside, for a folder of several repos. */
  repos: number;
  /** A home folder or the disk's top folder can't be a project; a folder inside it can. */
  canAdd: boolean;
  folders: { name: string; path: string; kind: 'project' | 'repo' | 'folder' }[];
  /** Folders people often start from. */
  places: { name: string; path: string }[];
}

/** Folders nobody picks as a project, kept out of the list. */
const NOISE = new Set(['node_modules', 'dist', 'build', 'coverage', '__pycache__', 'Library', 'Applications']);
const MAX_FOLDERS = 500;

const has = (dir: string, ...parts: string[]) => fs.existsSync(path.join(dir, ...parts));

function listFolder(asked: string): FolderListing {
  const home = os.homedir();
  const dir = path.resolve(asked || home);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`There is no folder at ${dir}.`);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new Error(`squad-kit may not look inside ${dir}.`);
  }
  const visible = entries.filter((e) => !e.name.startsWith('.'));
  const folders = visible
    .filter((e) => e.isDirectory() && !NOISE.has(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .slice(0, MAX_FOLDERS)
    .map((e) => {
      const p = path.join(dir, e.name);
      return { name: e.name, path: p, kind: has(p, SQUAD_DIR, 'config.yaml') ? ('project' as const) : has(p, '.git') ? ('repo' as const) : ('folder' as const) };
    });
  const repos = folders.filter((f) => f.kind !== 'folder' && has(f.path, '.git')).length;
  const kind: FolderKind = has(dir, SQUAD_DIR, 'config.yaml') ? 'project' : has(dir, '.git') ? 'repo' : repos ? 'repos' : visible.length ? 'files' : 'empty';
  const parent = path.dirname(dir) === dir ? null : path.dirname(dir);
  const places = [
    { name: 'Home', path: home },
    ...['Desktop', 'Documents', 'Workspace', 'Projects', 'Developer', 'code']
      .map((name) => ({ name, path: path.join(home, name) }))
      .filter((p) => fs.existsSync(p.path)),
  ];
  return { path: dir, parent, home, kind, repos, canAdd: kind === 'project' || isOwnFolder(dir), folders, places };
}

export async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return {} as T;
  }
}

export async function act(c: Context, fn: () => unknown) {
  try {
    return c.json(((await fn()) as object) ?? { ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
}

export function mountAppApi(app: Hono, opts: { projects: OpenProjects }): void {
  const projects = opts.projects;
  const settings = () => ({ parallel: parallelLimit(), max: MAX_PARALLEL, running: ticketsRunning() });

  app.get('/api/v1/app/projects', (c) => c.json({ projects: projects.summaries(), ...settings() }));

  // Add project: the folder the person picked, set up the way `squad console` sets it up.
  app.post('/api/v1/app/projects', async (c) => {
    const b = await body<{ folder?: string }>(c);
    return act(c, () => {
      if (!b.folder?.trim()) throw new Error('Pick a folder first.');
      const { project, did, added } = projects.add(b.folder.trim());
      const row = projects.summaries().find((p) => p.id === project.id);
      return { ...row, did, added };
    });
  });

  app.delete('/api/v1/app/projects/:id', (c) =>
    act(c, () => {
      if (!projects.remove(c.req.param('id'))) throw new Error('That project is not in the app.');
      return { ok: true };
    }),
  );

  app.get('/api/v1/app/waiting', (c) => c.json({ items: projects.waiting() }));

  // The folder browser: a page cannot read a real folder path, so the app lists folders itself, from the home folder.
  app.get('/api/v1/app/folders', (c) => act(c, () => listFolder(c.req.query('path') ?? '')));

  app.post('/api/v1/app/folders', async (c) => {
    const b = await body<{ parent?: string; name?: string }>(c);
    return act(c, () => {
      const name = (b.name ?? '').trim();
      if (!name || name.startsWith('.') || /[/\\:]/.test(name)) throw new Error('Give the folder a name without / or : in it.');
      const dir = path.join(path.resolve(b.parent || os.homedir()), name);
      if (fs.existsSync(dir)) throw new Error(`${name} is there already.`);
      fs.mkdirSync(dir);
      return listFolder(dir);
    });
  });

  // How many tickets run at once, shared by every project: they all use the same AI accounts.
  app.get('/api/v1/app/settings', (c) => c.json(settings()));

  app.put('/api/v1/app/settings', async (c) => {
    const b = await body<{ parallel?: number }>(c);
    return act(c, () => {
      if (b.parallel !== undefined) setParallelLimit(Number(b.parallel));
      return settings();
    });
  });
}
