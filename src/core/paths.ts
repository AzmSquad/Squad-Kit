import path from 'node:path';
import fs from 'node:fs';

export const SQUAD_DIR = '.squad';

export interface SquadPaths {
  root: string;
  squadDir: string;
  configFile: string;
  promptsDir: string;
  storiesDir: string;
  plansDir: string;
  indexFile: string;
}

export function buildPaths(root: string): SquadPaths {
  const squadDir = path.join(root, SQUAD_DIR);
  return {
    root,
    squadDir,
    configFile: path.join(squadDir, 'config.yaml'),
    promptsDir: path.join(squadDir, 'prompts'),
    storiesDir: path.join(squadDir, 'stories'),
    plansDir: path.join(squadDir, 'plans'),
    indexFile: path.join(squadDir, 'plans', '00-index.md'),
  };
}

export function findSquadRoot(startDir: string = process.cwd()): string | null {
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

export function requireSquadRoot(startDir: string = process.cwd()): string {
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
