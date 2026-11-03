import fs from 'node:fs';
import path from 'node:path';
import type { Blueprint, BoardMeta, RepoInfo, Ticket } from '../board/types.js';
import { currentBranch, git, remotes } from './git.js';

/**
 * A project is either one git repo, or a workspace folder holding several code repos (like a
 * tooling repo with separate API and UI repos inside). Every ticket works in exactly one repo.
 */

export function reposOf(meta: BoardMeta): RepoInfo[] {
  if (meta.repos?.length) return meta.repos;
  return [{ path: '.', base: meta.git?.base ?? 'main', remote: meta.git?.remote ?? '', commands: meta.commands ?? {} }];
}

export function repoFor(meta: BoardMeta, ticket: Ticket): RepoInfo {
  const all = reposOf(meta);
  return all.find((r) => r.path === ticket.repo) ?? all[0]!;
}

/** Each repo's base commit now, by repo path. Repos with no commit yet are left out. */
export function baseCommits(root: string, meta: BoardMeta): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of reposOf(meta)) {
    const sha = git(path.join(root, r.path), ['rev-parse', '--verify', '--quiet', `${r.base}^{commit}`], { allowFail: true });
    if (sha) out[r.path] = sha;
  }
  return out;
}

/**
 * Whether any repo's base has files added, moved or removed since the code was last read: since the base commit that
 * read saw, or for a read made before squad-kit kept it, the last base commit before the read. Edits inside files do
 * not count, and neither do squad-kit's own files (`skip`, the project's .squad folder). When git cannot tell, it counts
 * as moved, so the read is never missed.
 */
export function filesMoved(root: string, meta: BoardMeta, read: Pick<Blueprint, 'commits' | 'at'>, skip?: string): boolean {
  return reposOf(meta).some((r) => {
    const dir = path.join(root, r.path);
    const from = read.commits?.[r.path] ?? (read.at ? git(dir, ['rev-list', '-1', '--first-parent', `--before=${read.at}`, r.base], { allowFail: true }) : '');
    if (!from) return true;
    const own = skip ? path.relative(dir, skip) : '';
    const keepOut = own && !own.startsWith('..') && !path.isAbsolute(own) ? [`:(exclude)${own}`] : [];
    let changes: string;
    try {
      changes = git(dir, ['diff', '--name-status', '-M', from, r.base, '--', '.', ...keepOut]);
    } catch {
      return true;
    }
    // A for added, D for deleted, R for renamed or moved, C for copied. M (changed inside) leaves the map as it is.
    return changes.split('\n').some((l) => /^[ADRC]/.test(l));
  });
}

const SKIP = new Set(['node_modules', '.git', '.squad', 'dist', 'build', '.next', 'vendor']);

/** Code repos one level down that have their own git. */
export function findNestedRepos(root: string): RepoInfo[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !SKIP.has(d.name) && !d.name.startsWith('.'))
    .filter((d) => fs.existsSync(path.join(root, d.name, '.git')))
    .map((d) => {
      const dir = path.join(root, d.name);
      return { path: d.name, base: currentBranch(dir), remote: remotes(dir)[0] ?? '', commands: {} };
    });
}

/** Instruction files the project already has for AI tools; every role reads them first. */
export function rulesFiles(root: string): string[] {
  const found: string[] = [];
  for (const f of ['CLAUDE.md', 'AGENTS.md']) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) found.push(p);
  }
  const rulesDir = path.join(root, '.claude', 'rules');
  if (fs.existsSync(rulesDir)) {
    for (const f of fs.readdirSync(rulesDir)) if (f.endsWith('.md')) found.push(path.join(rulesDir, f));
  }
  // The tracker's wiki (business rules, definition of done), copied next to the board.
  const wiki = path.join(root, '.squad', 'board', 'context', 'wiki');
  if (fs.existsSync(wiki)) {
    for (const f of fs.readdirSync(wiki).sort()) if (f.endsWith('.md')) found.push(path.join(wiki, f));
  }
  return found;
}
