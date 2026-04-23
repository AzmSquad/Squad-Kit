import fs from 'node:fs';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';

export interface RepoMapOptions {
  maxEntries?: number; // safety cap on total paths returned
  includeHidden?: boolean;
}

const DEFAULT_IGNORES = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  '.squad/plans', // don't include existing plans as context; planner will see them separately
];

export function buildRepoMap(root: string, opts: RepoMapOptions = {}): string {
  const maxEntries = opts.maxEntries ?? 5000;
  const ig = buildIgnore(root);
  const entries: string[] = [];
  walk(root, root, ig, entries, maxEntries, !!opts.includeHidden);
  entries.sort();
  return entries.join('\n') + '\n';
}

function buildIgnore(root: string): Ignore {
  const ig = ignore().add(DEFAULT_IGNORES);
  const gitignore = path.join(root, '.gitignore');
  if (fs.existsSync(gitignore)) {
    try {
      ig.add(fs.readFileSync(gitignore, 'utf8'));
    } catch {
      /* ignore */
    }
  }
  return ig;
}

function walk(root: string, dir: string, ig: Ignore, out: string[], max: number, includeHidden: boolean): void {
  if (out.length >= max) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (out.length >= max) return;
    if (!includeHidden && entry.name.startsWith('.') && entry.name !== '.squad') continue;

    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs);
    if (!rel || ig.ignores(rel) || (entry.isDirectory() && ig.ignores(rel + '/'))) continue;

    if (entry.isDirectory()) {
      walk(root, abs, ig, out, max, includeHidden);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}
