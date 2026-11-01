import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { squadHome } from './home.js';
import { SQUAD_DIR, findSquadRoot } from './paths.js';

/**
 * The one app's list of projects (ADR-001), in ~/.squad-kit/projects.json: each project's folder and id. The id is the
 * one in the project's own settings, so the app finds this computer's files for it again.
 */

export interface ProjectEntry {
  id: string;
  root: string;
  addedAt: string;
}

function listFile(): string {
  return path.join(squadHome(), 'projects.json');
}

export function readProjects(): ProjectEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(listFile(), 'utf8')) as { projects?: ProjectEntry[] };
    return Array.isArray(raw.projects) ? raw.projects.filter((p) => p && typeof p.id === 'string' && typeof p.root === 'string') : [];
  } catch {
    return [];
  }
}

function writeProjects(list: ProjectEntry[]): void {
  fs.mkdirSync(squadHome(), { recursive: true });
  const file = listFile();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ projects: list }, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** Adds a project to the list, or updates its folder when it moved. Its place in the list stays. */
export function rememberProject(id: string, root: string): ProjectEntry {
  const list = readProjects();
  const same = (p: ProjectEntry) => p.root === root || p.id === id;
  const old = list.find(same);
  const entry = { id, root, addedAt: old?.addedAt ?? new Date().toISOString() };
  const next = list.flatMap((p) => (p === old ? [entry] : same(p) ? [] : [p]));
  writeProjects(old ? next : [...next, entry]);
  return entry;
}

/** Takes a project off the app's list. Its files stay where they are. */
export function forgetProject(id: string): boolean {
  const list = readProjects();
  const left = list.filter((p) => p.id !== id);
  if (left.length === list.length) return false;
  writeProjects(left);
  return true;
}

/** The project's name, as its settings say, or its folder's name. */
export function projectName(root: string): string {
  try {
    const raw = yaml.load(fs.readFileSync(path.join(root, SQUAD_DIR, 'config.yaml'), 'utf8')) as { project?: { name?: string }; board?: { project?: string } } | undefined;
    return String(raw?.board?.project || raw?.project?.name || path.basename(root));
  } catch {
    return path.basename(root);
  }
}

const norm = (s: string) => s.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');

/**
 * The project a terminal command names with --project: a folder, or a project in the app by its id or name. Throws a
 * plain message with the projects there are when nothing matches.
 */
export function findProject(ref: string): string {
  const asked = ref.trim();
  const asPath = path.resolve(asked.replace(/^~(?=$|\/)/, os.homedir()));
  if (fs.existsSync(asPath) && fs.statSync(asPath).isDirectory()) {
    const root = findSquadRoot(asPath);
    if (root) return root;
  }
  const list = readProjects().filter((p) => fs.existsSync(path.join(p.root, SQUAD_DIR, 'config.yaml')));
  const hit =
    list.find((p) => p.id === asked) ??
    list.find((p) => norm(projectName(p.root)) === norm(asked)) ??
    list.find((p) => norm(path.basename(p.root)) === norm(asked));
  if (hit) return hit.root;
  const known = list.map((p) => projectName(p.root));
  throw new Error(
    `No project called "${asked}".${known.length ? ` Your projects: ${known.join(', ')}.` : ''} To add one, open a terminal in its folder and run: squad console`,
  );
}
