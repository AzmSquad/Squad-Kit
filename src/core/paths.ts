import path from 'node:path';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { squadHome } from './home.js';

export const SQUAD_DIR = '.squad';

export interface SquadPaths {
  root: string;
  squadDir: string;
  configFile: string;
  secretsFile: string;
  /**
   * Legacy: path where 0.1.x copied prompt templates. No longer created on fresh install
   * and no longer read at runtime. Kept on the interface so `squad doctor` and
   * `squad migrate` can locate and clean up stale copies from pre-0.2 users.
   */
  promptsDir: string;
  storiesDir: string;
  plansDir: string;
  indexFile: string;
  /** `.squad/.trash` — created on demand by `squad rm --trash`. */
  trashDir: string;
}

/**
 * Secrets belong to this computer (ADR-001): once a project has a board id they live in
 * ~/.squad-kit/projects/<id>/secrets.yaml. A project not moved yet keeps them in .squad/secrets.yaml.
 */
function secretsFileOf(squadDir: string): string {
  const old = path.join(squadDir, 'secrets.yaml');
  try {
    const id = (yaml.load(fs.readFileSync(path.join(squadDir, 'config.yaml'), 'utf8')) as { board?: { id?: string } } | undefined)?.board?.id;
    if (!id) return old;
    const local = path.join(squadHome(), 'projects', String(id), 'secrets.yaml');
    return fs.existsSync(local) || !fs.existsSync(old) ? local : old;
  } catch {
    return old;
  }
}

export function buildPaths(root: string): SquadPaths {
  const squadDir = path.join(root, SQUAD_DIR);
  return {
    root,
    squadDir,
    configFile: path.join(squadDir, 'config.yaml'),
    secretsFile: secretsFileOf(squadDir),
    promptsDir: path.join(squadDir, 'prompts'),
    storiesDir: path.join(squadDir, 'stories'),
    plansDir: path.join(squadDir, 'plans'),
    indexFile: path.join(squadDir, 'plans', '00-index.md'),
    trashDir: path.join(squadDir, '.trash'),
  };
}

/** The project a terminal command named with --project; without one, commands use the folder they run in. */
let chosenProject: string | null = null;

export function chooseProject(root: string | null): void {
  chosenProject = root;
}

export function findSquadRoot(startDir: string = chosenProject ?? process.cwd()): string | null {
  let current = path.resolve(startDir);
  const { root } = path.parse(current);
  while (true) {
    if (fs.existsSync(path.join(current, SQUAD_DIR, 'config.yaml'))) {
      return current;
    }
    if (current === root) return null;
    current = path.dirname(current);
  }
}

export function requireSquadRoot(startDir: string = chosenProject ?? process.cwd()): string {
  const root = findSquadRoot(startDir);
  if (!root) {
    throw new Error(
      `No .squad/ directory found (searched upward from ${startDir}). Run \`squad init\` first.`,
    );
  }
  return root;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
