import fs from 'node:fs';
import type { BoardPaths } from '../board/store.js';
import type { Ticket } from '../board/types.js';
import { git } from './git.js';
import type { ReviewLook } from './prompts.js';
import { tryBlocked, tryingAt } from './try-app.js';

/** At most this many changed files go into a chat's opening; the agent reads the rest in the copy itself. */
const MAX_FILES = 40;

/**
 * What an agent needs to answer "where do I look": the address of the ticket's own copy only while it really runs,
 * whether Try it yourself can start it, and the files the ticket changed in its copy of the code, where the agent
 * reads the routes. The address in the project's settings is not here: nothing may be running there.
 */
export function reviewLook(bp: BoardPaths, t: Ticket): ReviewLook {
  const tryUrl = tryingAt(bp, t.id);
  return { ...(tryUrl ? { tryUrl } : {}), canTry: !tryBlocked(bp, t), accepted: t.stage === 'release' || t.stage === 'done', changed: changedFiles(t) };
}

/** The files the ticket changed against the commit it started from, in its own copy; new files too. */
export function changedFiles(t: Ticket): string[] {
  if (!t.worktree || !fs.existsSync(t.worktree)) return [];
  const lines = (args: string[]) => git(t.worktree!, args, { allowFail: true }).split('\n').map((l) => l.trim()).filter(Boolean);
  const changed = t.baseCommit ? lines(['diff', '--name-only', t.baseCommit]) : [];
  const added = lines(['ls-files', '--others', '--exclude-standard']);
  return [...new Set([...changed, ...added])].slice(0, MAX_FILES);
}
