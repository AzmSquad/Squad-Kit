import fs from 'node:fs';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { buildRepoIgnore } from '../../core/repo-map.js';
import type { Budget } from '../budget.js';
import type { PlannerEventBus } from '../events.js';
import type { ToolCall } from '../types.js';
import { looksBinary } from './read-file.js';

const MAX_GREP_MATCHES = 200;
const MAX_GREP_FILE_SIZE_BYTES = 1_000_000;

export const GREP_TOOL_NAME = 'grep';

export const grepSchema = z.object({
  pattern: z.string().min(1).describe('Literal string or regex (default literal).'),
  regex: z.boolean().optional().default(false),
  path: z.string().optional().describe('Optional sub-path to scope the search to (relative).'),
  caseInsensitive: z.boolean().optional().default(false),
});

export const GREP_TOOL_DESCRIPTION =
  'Search the project for a literal string or regex pattern. ' +
  'Returns up to 200 matches across files, each shown as `path:line:match`. ' +
  'Use this BEFORE `read_file` to locate symbols or call sites; it is much cheaper than reading whole files.';

export interface GrepToolHooks {
  runId: string;
  turn: number;
  bus: PlannerEventBus;
  onToolCall?: (tc: ToolCall, bytesLoaded: number, totalBytes: number) => void;
}

export function grepToolFactory(root: string, budget: Budget, hooks: GrepToolHooks) {
  return tool({
    description: GREP_TOOL_DESCRIPTION,
    inputSchema: grepSchema,
    execute: async (args, { toolCallId }) => {
      const tc: ToolCall = {
        id: toolCallId,
        name: GREP_TOOL_NAME,
        input: { ...args },
      };
      const before = budget.snapshot().bytes;
      const out = runGrep(root, budget, args);
      const after = budget.snapshot().bytes;
      const bytesLoaded = after - before;
      hooks.onToolCall?.(tc, bytesLoaded, after);
      hooks.bus.emit({
        kind: 'tool_call',
        runId: hooks.runId,
        turn: hooks.turn,
        toolCall: tc,
        bytesLoaded,
        totalBytes: after,
      });
      return out;
    },
  });
}

export function runGrep(
  root: string,
  budget: Budget,
  args: {
    pattern: string;
    regex: boolean;
    path?: string;
    caseInsensitive: boolean;
  },
): { content: string; isError: boolean } {
  const exec = budget.canExecuteTool();
  if (!exec.ok) {
    return {
      content: `grep: ${exec.reason}. Finalise the plan with what you already have.`,
      isError: true,
    };
  }

  let re: RegExp;
  try {
    if (args.regex) {
      re = new RegExp(args.pattern, args.caseInsensitive ? 'gi' : 'g');
    } else {
      const esc = args.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      re = new RegExp(esc, args.caseInsensitive ? 'gi' : 'g');
    }
  } catch (e) {
    return { content: `grep: invalid pattern (${(e as Error).message}).`, isError: true };
  }

  const ig = buildRepoIgnore(root);
  const scopeRoot = args.path?.trim()
    ? path.resolve(root, args.path)
    : root;
  const relScope = path.relative(root, scopeRoot);
  if (relScope.startsWith('..') || path.isAbsolute(relScope)) {
    return { content: `grep: scope path escapes the project root and was refused.`, isError: true };
  }
  if (!fs.existsSync(scopeRoot)) {
    return { content: `grep: scope path not found "${args.path}".`, isError: true };
  }

  const matches: string[] = [];
  const walk = (dir: string): void => {
    if (matches.length >= MAX_GREP_MATCHES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= MAX_GREP_MATCHES) return;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (!rel || ig.ignores(rel) || (entry.isDirectory() && ig.ignores(rel + '/'))) continue;

      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        let st: fs.Stats;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        if (st.size > MAX_GREP_FILE_SIZE_BYTES) continue;
        let buf: Buffer;
        try {
          buf = fs.readFileSync(abs);
        } catch {
          continue;
        }
        if (looksBinary(buf)) continue;
        const text = buf.toString('utf8');
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= MAX_GREP_MATCHES) return;
          const line = lines[i] ?? '';
          re.lastIndex = 0;
          if (re.test(line)) {
            const trimmed = line.trim().slice(0, 200);
            matches.push(`${rel}:${i + 1}:${trimmed}`);
          }
        }
      }
    }
  };

  if (fs.statSync(scopeRoot).isFile()) {
    /* single file scope */
    const rel = path.relative(root, scopeRoot).split(path.sep).join('/');
    if (ig.ignores(rel)) {
      return { content: `grep: file is ignored by repository filters.`, isError: true };
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(scopeRoot);
    } catch {
      return { content: `grep: not found.`, isError: true };
    }
    if (st.size > MAX_GREP_FILE_SIZE_BYTES) {
      return { content: `grep: file too large to search.`, isError: true };
    }
    let buf: Buffer;
    try {
      buf = fs.readFileSync(scopeRoot);
    } catch (e) {
      return { content: `grep: failed to read (${(e as Error).message}).`, isError: true };
    }
    if (looksBinary(buf)) return { content: `grep: file looks binary and was skipped.`, isError: true };
    const text = buf.toString('utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= MAX_GREP_MATCHES) break;
      const line = lines[i] ?? '';
      re.lastIndex = 0;
      if (re.test(line)) {
        matches.push(`${rel}:${i + 1}:${line.trim().slice(0, 200)}`);
      }
    }
  } else {
    walk(scopeRoot);
  }

  const header =
    matches.length >= MAX_GREP_MATCHES
      ? `Found ${matches.length} matches (capped at ${MAX_GREP_MATCHES}):`
      : `Found ${matches.length} match${matches.length === 1 ? '' : 'es'}:`;
  const body = matches.length ? `${header}\n${matches.join('\n')}` : `No matches found for "${args.pattern}".`;

  const byteSize = Buffer.byteLength(body, 'utf8');
  const cap = budget.canRead(byteSize);
  if (!cap.ok) {
    return {
      content: `grep: ${cap.reason}. Finalise the plan with what you already have.`,
      isError: true,
    };
  }
  budget.recordRead(byteSize);
  return { content: body, isError: false };
}
