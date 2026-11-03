import fs from 'node:fs';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import type { Budget } from '../budget.js';
import type { PlannerEventBus } from '../events.js';
import type { ToolCall } from '../types.js';
import type { PlannerLimitDecision, PlannerSessionLimitContext } from '../session-limits.js';

/** Tool name registered with the planner; kept stable for tests and telemetry. */
export const READ_FILE_TOOL_NAME = 'read_file';

export const MAX_BYTES_PER_FULL_READ = 32_000;
export const MAX_LINES_PER_RANGED_READ = 400;
const MAX_BYTES_FOR_SYNC_LINE_SPLIT = 2_000_000;

export const rangedReadFileSchema = z
  .object({
    path: z.string().min(1).describe('Repo-relative POSIX path.'),
    offset: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('1-indexed line number to start reading at (use with limit).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LINES_PER_RANGED_READ)
      .optional()
      .describe(`Line count from offset (max ${MAX_LINES_PER_RANGED_READ}).`),
  })
  .refine(
    (o) =>
      (o.offset === undefined && o.limit === undefined) || (o.offset !== undefined && o.limit !== undefined),
    { message: 'Provide both offset and limit for a ranged read, or neither for a full read.' },
  );

export const fullReadFileSchema = z.object({
  path: z.string().min(1).describe('Repo-relative POSIX path.'),
});

export const READ_FILE_TOOL_DESCRIPTION =
  'Read a UTF-8 text file from the project, returning its contents so you can plan against real code. ' +
  'Pass `offset` and `limit` together to read a line range (preferred when you know the region). ' +
  'Without them the whole file is read, capped at 32 KB. ' +
  'Paths must be relative to the project root. Binary files are refused. ' +
  'You have a bounded context budget; prefer small, targeted reads.';

export const READ_FILE_TOOL_DESCRIPTION_WHOLE_ONLY =
  'Read a UTF-8 text file from the project, returning its contents so you can plan against real code. ' +
  'Whole-file reads only; capped at 32 KB. ' +
  'Paths must be relative to the project root. Binary files are refused. ' +
  'You have a bounded context budget; prefer small, targeted reads.';

export interface ReadFileResult {
  content: string;
  isError: boolean;
}

export interface ReadFileToolHooks {
  runId: string;
  turn: number;
  bus: PlannerEventBus;
  onToolCall?: (tc: ToolCall, bytesLoaded: number, totalBytes: number) => void;
  decideOnLimit?: (ctx: PlannerSessionLimitContext) => Promise<PlannerLimitDecision>;
  getLimitCtx: () => PlannerSessionLimitContext;
  extendSessionLimits: () => void;
  getAccumulatedText: () => string;
  /** Set when read budget blocks without interactive continue. */
  setBudgetExhausted: (v: boolean) => void;
}

export interface ReadFileToolOptions {
  /** When false, `read_file` only accepts `path` (whole-file reads). */
  ranged?: boolean;
}

export function readFileTool(
  root: string,
  budget: Budget,
  input: { path?: unknown; offset?: unknown; limit?: unknown },
): ReadFileResult {
  const raw = typeof input.path === 'string' ? input.path : '';
  if (!raw.length) {
    return err('read_file: missing or invalid "path" argument.');
  }

  const offset = typeof input.offset === 'number' && Number.isInteger(input.offset) ? input.offset : undefined;
  const limit =
    typeof input.limit === 'number' && Number.isInteger(input.limit) ? input.limit : undefined;

  if (offset !== undefined && offset < 1) {
    return err('read_file: offset must be a 1-indexed line number ≥ 1.');
  }
  if (limit !== undefined && (limit < 1 || limit > MAX_LINES_PER_RANGED_READ)) {
    return err(`read_file: limit must be between 1 and ${MAX_LINES_PER_RANGED_READ}.`);
  }
  if ((offset === undefined) !== (limit === undefined)) {
    return err('read_file: pass both offset and limit for a ranged read, or neither for a full read.');
  }

  const resolved = path.resolve(root, raw);
  const relCheck = path.relative(root, resolved);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    return err(`read_file: path "${raw}" escapes the project root and was refused.`);
  }
  if (!fs.existsSync(resolved)) {
    return err(`read_file: not found "${raw}".`);
  }
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    return err(`read_file: "${raw}" is a directory. Ask for a specific file path.`);
  }

  if (offset !== undefined && limit !== undefined) {
    return readFileRanged(resolved, raw, budget, stat.size, offset, limit);
  }

  if (stat.size > MAX_BYTES_PER_FULL_READ) {
    return err(
      `read_file: "${raw}" is ${stat.size} bytes (> ${MAX_BYTES_PER_FULL_READ}). Use offset/limit for a ranged read or ask for a smaller region.`,
    );
  }

  const capacity = budget.canRead(stat.size);
  if (!capacity.ok) {
    return err(`read_file: ${capacity.reason}. Finalise the plan with what you already have.`);
  }

  let buf: Buffer;
  try {
    buf = fs.readFileSync(resolved);
  } catch (e) {
    return err(`read_file: failed to read "${raw}" (${(e as Error).message}).`);
  }

  if (looksBinary(buf)) {
    return err(`read_file: "${raw}" looks binary and was refused.`);
  }

  budget.recordRead(stat.size);
  return { content: buf.toString('utf8'), isError: false };
}

function readFileRanged(
  resolved: string,
  rawRel: string,
  budget: Budget,
  fileSize: number,
  offset: number,
  limit: number,
): ReadFileResult {
  const est = Math.min(fileSize, limit * 200);
  const cap = budget.canRead(est);
  if (!cap.ok) {
    return err(`read_file: ${cap.reason}. Finalise the plan with what you already have.`);
  }

  if (fileSize > MAX_BYTES_FOR_SYNC_LINE_SPLIT) {
    return err(
      `read_file: "${rawRel}" is too large for a ranged read in-process (${fileSize} bytes). Grep for a symbol or narrow the path.`,
    );
  }

  let data: Buffer;
  try {
    data = fs.readFileSync(resolved);
  } catch (e) {
    return err(`read_file: failed to read "${rawRel}" (${(e as Error).message}).`);
  }
  if (looksBinary(data)) {
    return err(`read_file: "${rawRel}" looks binary and was refused.`);
  }

  const text = data.toString('utf8');
  const lines = text.split(/\r?\n/);
  if (offset > lines.length) {
    return err(
      `read_file: offset ${offset} is past the end of the file (only ${lines.length} lines).`,
    );
  }
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const out = slice.map((line, i) => `${String(offset + i).padStart(6, ' ')}│ ${line}`).join('\n');
  const bytes = Buffer.byteLength(out, 'utf8');
  budget.recordRead(bytes);
  return { content: out, isError: false };
}

export function readFileToolFactory(
  root: string,
  budget: Budget,
  hooks: ReadFileToolHooks,
  opts?: ReadFileToolOptions,
) {
  const ranged = opts?.ranged ?? true;
  const params = ranged ? rangedReadFileSchema : fullReadFileSchema;
  const description = ranged ? READ_FILE_TOOL_DESCRIPTION : READ_FILE_TOOL_DESCRIPTION_WHOLE_ONLY;

  return tool({
    description,
    inputSchema: params,
    execute: async (args: { path: string; offset?: number; limit?: number }, { toolCallId }) => {
      const tc: ToolCall = {
        id: toolCallId,
        name: READ_FILE_TOOL_NAME,
        input: { path: args.path, offset: args.offset, limit: args.limit },
      };
      const before = budget.snapshot().bytes;
      let result = readFileTool(root, budget, args);
      let after = budget.snapshot().bytes;
      let bytesLoaded = after - before;
      hooks.onToolCall?.(tc, bytesLoaded, after);
      hooks.bus.emit({
        kind: 'tool_call',
        runId: hooks.runId,
        turn: hooks.turn,
        toolCall: tc,
        bytesLoaded,
        totalBytes: after,
      });

      if (readBudgetishError(result)) {
        const decide = hooks.decideOnLimit;
        if (decide) {
          const d = await decide(hooks.getLimitCtx());
          if (d === 'cancel') {
            throw new PlannerUserCancelledError(
              hooks.getAccumulatedText(),
              hooks.runId,
              hooks.turn,
              'budget_reads',
              tc,
              result,
            );
          }
          hooks.extendSessionLimits();
          result = readFileTool(root, budget, args);
          after = budget.snapshot().bytes;
          bytesLoaded = after - before;
        } else {
          hooks.setBudgetExhausted(true);
        }
      }

      return { content: result.content, isError: result.isError };
    },
  });
}

export class PlannerUserCancelledError extends Error {
  constructor(
    readonly planText: string,
    readonly runId: string,
    readonly turn: number,
    readonly incompleteKind: 'budget_reads',
    readonly toolCall: ToolCall,
    readonly pendingResult: ReadFileResult,
  ) {
    super('PlannerUserCancelledError');
    this.name = 'PlannerUserCancelledError';
  }

  static is(e: unknown): e is PlannerUserCancelledError {
    return e instanceof PlannerUserCancelledError;
  }
}

export function readBudgetishError(result: ReadFileResult): boolean {
  return result.isError && (/budget/i.test(result.content) || /max file reads/i.test(result.content));
}

function err(msg: string): ReadFileResult {
  return { content: msg, isError: true };
}

export function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8000));
  for (const b of sample) {
    if (b === 0) return true;
  }
  return false;
}
