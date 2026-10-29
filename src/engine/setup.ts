import { execSync } from 'node:child_process';
import { boardExists, readMeta, writeMeta, type BoardPaths } from '../board/store.js';
import type { BoardMeta } from '../board/types.js';
import { claudeBinary, toolVersion } from './claude.js';
import { currentBranch, ensureRepo, isRepo, remotes } from './git.js';
import { findNestedRepos } from './repos.js';
import { projectRoot } from './live.js';

/** A short ticket key from the project name: "moj-taqadi" becomes "MT", "Leave requests" becomes "LR". */
export function keyFor(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const key = (words.length > 1 ? words.map((w) => w[0]) : [words[0]?.slice(0, 2) ?? 'SK']).join('').toUpperCase().slice(0, 3);
  return key || 'SK';
}

function gitUser(): string {
  try {
    return execSync('git config user.name', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/)[0] || 'You';
  } catch {
    return 'You';
  }
}

function codexReady(): boolean {
  try {
    execSync(process.platform === 'win32' ? 'where codex' : 'which codex', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function detectTools(): BoardMeta['tools'] {
  const claude = claudeBinary();
  return [
    { name: 'Claude Code', ready: Boolean(claude && toolVersion(claude)) },
    { name: 'Codex', ready: codexReady() },
  ];
}

/**
 * Opening the board in a project with no board yet starts a live one: the project gets a git repo
 * if it has none, and the Architect reads it first.
 */
export function ensureLiveBoard(bp: BoardPaths, projectName: string): void {
  const root = projectRoot(bp);
  if (boardExists(bp)) {
    const meta = readMeta(bp);
    if (meta.engine === 'live') {
      meta.tools = detectTools();
      writeMeta(bp, meta);
    }
    return;
  }
  // A workspace of separate code repos needs no repo of its own; a plain folder becomes one.
  if (isRepo(root) || findNestedRepos(root).length === 0) ensureRepo(root, projectName);
  const tools = detectTools();
  const meta: BoardMeta = {
    project: projectName,
    key: keyFor(projectName),
    nextNumber: 1,
    engine: 'live',
    user: { name: gitUser(), role: 'Project manager' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools,
    speed: 1,
    map: [],
    lessons: [],
    commands: {},
    git: { base: currentBranch(root), remote: remotes(root)[0] ?? '' },
    scan: { status: 'pending' },
    parallel: 2,
  };
  writeMeta(bp, meta);
}
