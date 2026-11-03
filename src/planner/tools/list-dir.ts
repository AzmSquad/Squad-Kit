import fs from 'node:fs';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { buildRepoIgnore } from '../../core/repo-map.js';
import type { Budget } from '../budget.js';
import type { PlannerEventBus } from '../events.js';
import type { ToolCall } from '../types.js';

const MAX_ENTRIES_PER_LIST = 200;

export const LIST_DIR_TOOL_NAME = 'list_dir';

export const listDirSchema = z.object({
  path: z.string().describe('Repo-relative directory path. Use "." for the project root.'),
});

export const LIST_DIR_TOOL_DESCRIPTION =
  'List the contents of a directory in the project (one level deep). ' +
  'Returns up to 200 entries with type (file/dir) and size. ' +
  'Cheap; use this to discover sibling files before reading them.';

export interface ListDirToolHooks {
  runId: string;
  turn: number;
  bus: PlannerEventBus;
  onToolCall?: (tc: ToolCall, bytesLoaded: number, totalBytes: number) => void;
}

type EntryRow = { type: 'f' | 'd'; name: string; size: number | null };

export function listDirToolFactory(root: string, budget: Budget, hooks: ListDirToolHooks) {
  return tool({
    description: LIST_DIR_TOOL_DESCRIPTION,
    inputSchema: listDirSchema,
    execute: async (args, { toolCallId }) => {
      const tc: ToolCall = {
        id: toolCallId,
        name: LIST_DIR_TOOL_NAME,
        input: { path: args.path },
      };
      const before = budget.snapshot().bytes;
      const out = runListDir(root, budget, args.path);
      const after = budget.snapshot().bytes;
      hooks.onToolCall?.(tc, after - before, after);
      hooks.bus.emit({
        kind: 'tool_call',
        runId: hooks.runId,
        turn: hooks.turn,
        toolCall: tc,
        bytesLoaded: after - before,
        totalBytes: after,
      });
      return out;
    },
  });
}

export function runListDir(root: string, budget: Budget, rawPath: string): { content: string; isError: boolean } {
  const exec = budget.canExecuteTool();
  if (!exec.ok) {
    return {
      content: `list_dir: ${exec.reason}. Finalise the plan with what you already have.`,
      isError: true,
    };
  }

  const normalized = rawPath.trim() === '' ? '.' : rawPath.trim();
  const resolved = path.resolve(root, normalized);
  const relCheck = path.relative(root, resolved);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    return {
      content: `list_dir: path "${rawPath}" escapes the project root and was refused.`,
      isError: true,
    };
  }
  const relNorm = relCheck.split(path.sep).join('/');
  const ig = buildRepoIgnore(root);
  if (relNorm && (ig.ignores(relNorm) || ig.ignores(`${relNorm}/`))) {
    return { content: 'list_dir: (directory ignored by repo-map filter)', isError: true };
  }
  if (!fs.existsSync(resolved)) {
    return { content: `list_dir: not found "${rawPath}".`, isError: true };
  }
  const st = fs.statSync(resolved);
  if (!st.isDirectory()) {
    return { content: `list_dir: "${rawPath}" is not a directory.`, isError: true };
  }

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(resolved, { withFileTypes: true });
  } catch (e) {
    return { content: `list_dir: failed to read (${(e as Error).message}).`, isError: true };
  }

  const rows: EntryRow[] = [];
  for (const d of dirents) {
    if (rows.length >= MAX_ENTRIES_PER_LIST) break;
    const childAbs = path.join(resolved, d.name);
    const childRel = path.relative(root, childAbs).split(path.sep).join('/');
    if (childRel && (ig.ignores(childRel) || (d.isDirectory() && ig.ignores(`${childRel}/`)))) continue;

    if (d.isDirectory()) {
      rows.push({ type: 'd', name: d.name + '/', size: null });
    } else if (d.isFile()) {
      let size = 0;
      try {
        size = fs.statSync(childAbs).size;
      } catch {
        size = 0;
      }
      rows.push({ type: 'f', name: d.name, size });
    }
  }

  rows.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'd' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const lines = rows.map((r) => {
    const sz = r.type === 'd' ? '—' : String(r.size ?? 0);
    return `${r.type}  ${sz.padStart(8, ' ')}  ${r.name}`;
  });
  const body =
    lines.length > 0
      ? `Entries (max ${MAX_ENTRIES_PER_LIST}):\n${lines.join('\n')}`
      : '(empty directory)';

  const byteSize = Buffer.byteLength(body, 'utf8');
  const cap = budget.canRead(byteSize);
  if (!cap.ok) {
    return {
      content: `list_dir: ${cap.reason}. Finalise the plan with what you already have.`,
      isError: true,
    };
  }
  budget.recordRead(byteSize);
  return { content: body, isError: false };
}
