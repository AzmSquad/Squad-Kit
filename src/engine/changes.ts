import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { readMeta, requireTicket, type BoardPaths } from '../board/store.js';
import { BoardActionError } from '../board/actions.js';
import type { Ticket } from '../board/types.js';
import { GitSaidTooMuch, git, gitLater } from './git.js';
import { repoFor } from './repos.js';
import { projectRoot } from './live.js';

/**
 * Each ticket is built in its own copy (a git worktree), so the person's folder shows nothing until Looks right.
 * These two make the copy easy to see: the full diff against main for the Changes tab, and opening it in an editor.
 */

export interface FileChange {
  path: string;
  status: 'added' | 'changed' | 'deleted' | 'renamed';
  added: number;
  removed: number;
  /** The unified diff for this file; empty for binary files or when the whole diff was too large. */
  patch: string;
  binary?: boolean;
}

export interface TicketChanges {
  /** Where the changes were read from: the ticket's copy, or its branch once the copy is gone. */
  from: 'copy' | 'branch' | 'none';
  base?: string;
  branch?: string;
  files: FileChange[];
  /** True when some patches were left out because the diff is very large. */
  cut?: boolean;
}

const MAX_PATCH = 600 * 1024;
/** More of a diff than this is never shown, so it is not read: the list of files says what changed. */
const MAX_DIFF_READ = 64 * 1024 * 1024;

/** A diff too long to read: which files changed, with no patches. */
async function diffOrNames(dir: string, range: string): Promise<{ files: FileChange[]; cut: boolean }> {
  try {
    return { files: splitDiff(await gitLater(dir, ['diff', '--no-color', '--find-renames', range], { allowFail: true, mostBytes: MAX_DIFF_READ })), cut: false };
  } catch (err) {
    if (!(err instanceof GitSaidTooMuch)) throw err;
  }
  const fields = (await gitLater(dir, ['diff', '--name-status', '-z', '--find-renames', range], { allowFail: true })).split('\0').filter(Boolean);
  const files: FileChange[] = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i++]![0]!;
    const from = status === 'R' || status === 'C' ? fields[i++]! : '';
    const to = fields[i++]!;
    files.push({ path: from ? `${from} → ${to}` : to, status: status === 'A' ? 'added' : status === 'D' ? 'deleted' : from ? 'renamed' : 'changed', added: 0, removed: 0, patch: '' });
  }
  return { files, cut: true };
}

export async function ticketChanges(bp: BoardPaths, id: string): Promise<TicketChanges> {
  const t = requireTicket(bp, id);
  if (!t.baseCommit) return { from: 'none', files: [] };
  if (t.worktree && fs.existsSync(t.worktree)) {
    let cut = false;
    const inCopy = async (dir: string, base: string): Promise<FileChange[]> => {
      const diff = await diffOrNames(dir, base);
      cut ||= diff.cut;
      const { files } = diff;
      for (const f of (await gitLater(dir, ['ls-files', '--others', '--exclude-standard'], { allowFail: true })).split('\n').filter(Boolean)) {
        files.push(newFile(dir, f));
      }
      // In a story's folder, each file says which part it is in.
      const where = t.storyDir ? path.relative(t.storyDir, dir) : '';
      return where ? files.map((x) => ({ ...x, path: `${where}/${x.path}` })) : files;
    };
    const files = await inCopy(t.worktree, t.baseCommit);
    for (const c of (t.copies ?? []).filter((x) => fs.existsSync(x.dir) && x.baseCommit)) files.push(...(await inCopy(c.dir, c.baseCommit!)));
    return cap({ from: 'copy', base: t.baseCommit, branch: t.branch, files, ...(cut ? { cut } : {}) });
  }
  const dir = repoDir(bp, t);
  if (t.branch && git(dir, ['rev-parse', '--verify', '--quiet', t.branch], { allowFail: true })) {
    const { files, cut } = await diffOrNames(dir, `${t.baseCommit}...${t.branch}`);
    return cap({ from: 'branch', base: t.baseCommit, branch: t.branch, files, ...(cut ? { cut } : {}) });
  }
  return { from: 'none', base: t.baseCommit, files: [] };
}

function repoDir(bp: BoardPaths, t: Ticket): string {
  return path.join(projectRoot(bp), repoFor(readMeta(bp), t).path);
}

/** Splits `git diff` output into one entry per file. */
export function splitDiff(raw: string): FileChange[] {
  if (!raw.trim()) return [];
  return raw
    .split(/^(?=diff --git )/m)
    .filter((chunk) => chunk.startsWith('diff --git '))
    .map((chunk) => {
      const head = chunk.slice(0, chunk.indexOf('\n'));
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(head);
      const to = m?.[2] ?? head;
      const status: FileChange['status'] = /^new file mode/m.test(chunk)
        ? 'added'
        : /^deleted file mode/m.test(chunk)
          ? 'deleted'
          : /^rename from /m.test(chunk)
            ? 'renamed'
            : 'changed';
      const binary = /^Binary files /m.test(chunk);
      const body = chunk.slice(chunk.indexOf('\n@@') + 1);
      const lines = chunk.indexOf('\n@@') >= 0 ? body.split('\n') : [];
      return {
        path: status === 'renamed' && m ? `${m[1]} → ${to}` : to,
        status,
        added: lines.filter((l) => l.startsWith('+')).length,
        removed: lines.filter((l) => l.startsWith('-')).length,
        patch: lines.length ? body.replace(/\n$/, '') : '',
        ...(binary ? { binary } : {}),
      };
    });
}

function newFile(dir: string, file: string): FileChange {
  const full = path.join(dir, file);
  let text = '';
  try {
    const buf = fs.readFileSync(full);
    if (buf.includes(0)) return { path: file, status: 'added', added: 0, removed: 0, patch: '', binary: true };
    text = buf.toString('utf8');
  } catch {
    return { path: file, status: 'added', added: 0, removed: 0, patch: '' };
  }
  const lines = text.replace(/\n$/, '').split('\n');
  return { path: file, status: 'added', added: lines.length, removed: 0, patch: [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n') };
}

function cap(c: TicketChanges): TicketChanges {
  let size = 0;
  let cut = Boolean(c.cut);
  for (const f of c.files) {
    size += f.patch.length;
    if (size > MAX_PATCH) {
      f.patch = '';
      cut = true;
    }
  }
  return cut ? { ...c, cut } : c;
}

/* ── Open in editor ─────────────────────────────────────── */

export const EDITORS = [
  { id: 'cursor', name: 'Cursor', bin: 'cursor' },
  { id: 'code', name: 'VS Code', bin: 'code' },
] as const;

export type EditorId = (typeof EDITORS)[number]['id'];

/** Editors with a command on this computer, in order of preference. */
export function installedEditors(has: (bin: string) => boolean = onPath): EditorId[] {
  return EDITORS.filter((e) => has(e.bin)).map((e) => e.id);
}

function onPath(bin: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The folder to open: the ticket's copy while it exists, else the project's repo (after the change was merged). */
export function editorFolder(bp: BoardPaths, id: string): string {
  const t = requireTicket(bp, id);
  if (t.worktree && fs.existsSync(t.worktree)) return t.storyDir ?? t.worktree;
  return repoDir(bp, t);
}

export function openInEditor(
  bp: BoardPaths,
  id: string,
  pick?: string,
  opts: { has?: (bin: string) => boolean; launch?: (bin: string, dir: string) => void } = {},
): { editor: string; folder: string } {
  const folder = editorFolder(bp, id);
  const found = installedEditors(opts.has);
  const editorId = (pick && found.includes(pick as EditorId) ? pick : found[0]) as EditorId | undefined;
  const editor = EDITORS.find((e) => e.id === editorId);
  if (!editor) {
    throw new BoardActionError(`No editor command found. In VS Code or Cursor, run "Shell Command: Install command in PATH", or open this folder yourself: ${folder}`);
  }
  (opts.launch ?? launch)(editor.bin, folder);
  return { editor: editor.name, folder };
}

function launch(bin: string, dir: string): void {
  const child = spawn(bin, [dir], { detached: true, stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();
}
