import fs from 'node:fs';
import path from 'node:path';
import type { BoardPaths } from '../board/store.js';
import type { Ticket } from '../board/types.js';
import { gitLater } from './git.js';
import type { ReviewLook } from './prompts.js';
import { tryBlocked, tryingAt } from './try-app.js';

/** At most this many changed files go into a chat's opening; the agent reads the rest in the copy itself. */
const MAX_FILES = 40;

/**
 * What an agent needs to answer "where do I look": the address of the ticket's own copy only while it really runs,
 * whether Try it yourself can start it, and the files the ticket changed in its copy of the code, where the agent
 * reads the routes. The address in the project's settings is not here: nothing may be running there.
 */
export async function reviewLook(bp: BoardPaths, t: Ticket): Promise<ReviewLook> {
  const tryUrl = tryingAt(bp, t.id);
  return { ...(tryUrl ? { tryUrl } : {}), canTry: !tryBlocked(bp, t), accepted: t.stage === 'release' || t.stage === 'done', changed: await changedFiles(t) };
}

/** The files the ticket changed against the commit it started from, in its own copy; new files too. */
export async function changedFiles(t: Ticket): Promise<string[]> {
  if (!t.worktree || !fs.existsSync(t.worktree)) return [];
  const of = async (dir: string, base?: string): Promise<string[]> => {
    const lines = async (args: string[]) => (await gitLater(dir, args, { allowFail: true })).split('\n').map((l) => l.trim()).filter(Boolean);
    const changed = base ? await lines(['diff', '--name-only', base]) : [];
    return [...changed, ...(await lines(['ls-files', '--others', '--exclude-standard']))].map((f) => (t.storyDir ? `${path.relative(t.storyDir, dir)}/${f}` : f));
  };
  const all = await of(t.worktree, t.baseCommit);
  for (const c of (t.copies ?? []).filter((x) => fs.existsSync(x.dir))) all.push(...(await of(c.dir, c.baseCommit)));
  return [...new Set(all)].slice(0, MAX_FILES);
}
