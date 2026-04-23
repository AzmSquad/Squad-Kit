import fs from 'node:fs';
import path from 'node:path';
import type { Budget } from './budget.js';
import type { ToolSchema } from './types.js';

export const READ_FILE_TOOL: ToolSchema = {
  name: 'read_file',
  description:
    'Read a UTF-8 text file from the project, returning its contents so you can plan against real code. ' +
    'Paths must be relative to the project root. Binary files and files outside the project are refused. ' +
    'You have a bounded context budget; prefer small, targeted reads.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
      path: { type: 'string', description: 'Repo-relative POSIX path.' },
    },
  },
};

export interface ReadFileResult {
  content: string;
  isError: boolean;
}

const MAX_BYTES_PER_READ = 32_000;

export function readFileTool(root: string, budget: Budget, input: unknown): ReadFileResult {
  const raw = (input as { path?: unknown })?.path;
  if (typeof raw !== 'string' || raw.length === 0) {
    return error('read_file: missing or invalid "path" argument.');
  }

  const resolved = path.resolve(root, raw);
  const relCheck = path.relative(root, resolved);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    return error(`read_file: path "${raw}" escapes the project root and was refused.`);
  }
  if (!fs.existsSync(resolved)) {
    return error(`read_file: not found "${raw}".`);
  }
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    return error(`read_file: "${raw}" is a directory. Ask for a specific file path.`);
  }
  if (stat.size > MAX_BYTES_PER_READ) {
    return error(
      `read_file: "${raw}" is ${stat.size} bytes (> ${MAX_BYTES_PER_READ}). Ask for a smaller file or a specific range.`,
    );
  }

  const capacity = budget.canRead(stat.size);
  if (!capacity.ok) {
    return error(`read_file: ${capacity.reason}. Finalise the plan with what you already have.`);
  }

  let buf: Buffer;
  try {
    buf = fs.readFileSync(resolved);
  } catch (e) {
    return error(`read_file: failed to read "${raw}" (${(e as Error).message}).`);
  }

  if (looksBinary(buf)) {
    return error(`read_file: "${raw}" looks binary and was refused.`);
  }

  budget.recordRead(stat.size);
  return { content: buf.toString('utf8'), isError: false };
}

function error(msg: string): ReadFileResult {
  return { content: msg, isError: true };
}

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8000));
  for (const b of sample) {
    if (b === 0) return true;
  }
  return false;
}
