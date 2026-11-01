import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { resolveClaudeBinary } from '../../core/claude-binary.js';
import { childEnv } from '../../engine/agent-env.js';

/**
 * Runs the real Claude Code CLI headless (`claude -p`) in a project folder. squad-kit never
 * handles the login: Claude Code uses the subscription the person already signed in with.
 */

export type { ToolEvent } from '../ai-tool/types.js';
import type { ToolEvent } from '../ai-tool/types.js';

export interface RunOptions {
  cwd: string;
  prompt: string;
  /** Start a new saved conversation with this id. */
  sessionId?: string;
  /** Continue a saved conversation. */
  resume?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Files no agent may read or change, such as squad-kit's own secrets.yaml. */
  secretFiles?: string[];
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  /** JSON Schema for the final answer; Claude Code validates it and returns `structured`. */
  schema?: object;
  appendSystemPrompt?: string;
  /** A model name or alias such as sonnet or opus; empty uses the person's default. */
  model?: string;
  /** How hard the model thinks. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  addDirs?: string[];
  timeoutMs?: number;
  /** Stops the run when the person presses Stop. */
  signal?: AbortSignal;
  onTool?(event: ToolEvent): void;
  onText?(text: string): void;
  /** Any sign of life from Claude Code (a message, a tool call, a tool result), for the watchdog. */
  onActivity?(): void;
  /** The Claude Code process id, so the watchdog can look at the commands it runs. */
  onSpawn?(pid: number): void;
}

export interface RunResult {
  ok: boolean;
  sessionId: string;
  text: string;
  structured?: unknown;
  error?: string;
}

let cachedBinary: string | null = null;

/** Prefer the person's own `claude` on PATH (their settings and login), then the bundled one. */
export function claudeBinary(): string | null {
  if (cachedBinary) return cachedBinary;
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')[0]
      ?.trim();
    if (found) return (cachedBinary = found);
  } catch {
    // Not on PATH.
  }
  const bundled = resolveClaudeBinary();
  return (cachedBinary = bundled?.path ?? null);
}

export function toolVersion(bin: string): string | null {
  try {
    return execFileSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }).trim();
  } catch {
    return null;
  }
}

/** True when Claude Code already saved a conversation with this id (it can only be resumed, not started again). */
export function sessionExists(id: string): boolean {
  const dir = path.join(os.homedir(), '.claude', 'projects');
  try {
    return fs.readdirSync(dir).some((d) => fs.existsSync(path.join(dir, d, `${id}.jsonl`)));
  } catch {
    return false;
  }
}

/** The environment Claude Code starts with: every agent's, and no background tasks. */
export function claudeEnv(): NodeJS.ProcessEnv {
  // A step is one run: a command left running in the background would outlive it and the step would end too early.
  return { ...childEnv(), CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' };
}

/**
 * The tools a run may not use. Each secret file gets Read and Edit deny rules on its absolute path, so Claude Code
 * refuses it to its file tools and to Bash commands that read it (like cat), from any folder the agent works in.
 * A run that may only read gets the file-changing tools denied outright, not just left out of its allowed tools.
 */
export function deniedTools(opts: RunOptions): string[] {
  const files = new Set<string>();
  for (const f of opts.secretFiles ?? []) {
    files.add(path.resolve(f));
    // /tmp and /private/tmp are the same folder on a Mac: deny the real path too.
    if (fs.existsSync(f)) files.add(fs.realpathSync(f));
  }
  const allowed = opts.allowedTools ?? [];
  const readOnly = allowed.length > 0 && !allowed.some((t) => WRITE_TOOLS.includes(t));
  return [...(opts.disallowedTools ?? []), ...(readOnly ? WRITE_TOOLS : []), ...[...files].flatMap((f) => [`Read(/${f})`, `Edit(/${f})`])];
}

/** The tools that change files. */
export const WRITE_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'];

export function runClaude(opts: RunOptions): Promise<RunResult> {
  const bin = claudeBinary();
  const sessionId = opts.resume ?? opts.sessionId ?? randomUUID();
  if (!bin) {
    return Promise.resolve({ ok: false, sessionId, text: '', error: 'Claude Code is not installed. Install it and log in, then try again.' });
  }
  const args = ['-p', opts.prompt, '--output-format', 'stream-json', '--verbose'];
  // After a restart the same step may run again: continue its saved conversation instead of failing.
  if (opts.resume || sessionExists(sessionId)) args.push('--resume', sessionId);
  else args.push('--session-id', sessionId);
  if (opts.allowedTools?.length) args.push('--allowedTools', opts.allowedTools.join(','));
  const denied = deniedTools(opts);
  if (denied.length) args.push('--disallowedTools', denied.join(','));
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
  if (opts.schema) args.push('--json-schema', JSON.stringify(opts.schema));
  if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt);
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  for (const d of opts.addDirs ?? []) args.push('--add-dir', d);

  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: claudeEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    if (child.pid) opts.onSpawn?.(child.pid);
    opts.signal?.addEventListener('abort', () => {
      result = { ok: false, sessionId, text: lastText, error: 'You stopped the squad.' };
      child.kill('SIGTERM');
    });
    let buffer = '';
    let stderr = '';
    let result: RunResult | null = null;
    let lastText = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      result = { ok: false, sessionId, text: lastText, error: `Stopped after ${Math.round((opts.timeoutMs ?? 0) / 60000)} minutes without finishing.` };
    }, opts.timeoutMs ?? 20 * 60_000);

    const handle = (line: string) => {
      if (!line.trim()) return;
      let event: Record<string, any>;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      opts.onActivity?.();
      if (event.type === 'assistant') {
        for (const part of event.message?.content ?? []) {
          if (part.type === 'tool_use' && part.name !== 'StructuredOutput') opts.onTool?.({ name: part.name, input: part.input ?? {} });
          if (part.type === 'text' && part.text) {
            lastText = part.text;
            opts.onText?.(part.text);
          }
        }
      } else if (event.type === 'result') {
        const isError = Boolean(event.is_error) || event.subtype !== 'success';
        result = {
          ok: !isError,
          sessionId: event.session_id ?? sessionId,
          text: typeof event.result === 'string' ? event.result : lastText,
          structured: event.structured_output ?? undefined,
          ...(isError ? { error: plainError(typeof event.result === 'string' ? event.result : String(event.subtype)) } : {}),
        };
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        handle(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, sessionId, text: '', error: `Could not start Claude Code: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buffer) handle(buffer);
      if (result) return resolve(result);
      resolve({ ok: false, sessionId, text: lastText, error: plainError(stderr.trim() || `Claude Code stopped (exit ${code}).`) });
    });
  });
}

/** Turn Claude Code failures into a sentence a project manager can act on. */
export function plainError(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes('exit 143') || s.includes('sigterm')) {
    return 'The squad was interrupted before it finished, for example because the board was closed. Press Try again to carry on.';
  }
  if (s.includes('usage limit') || s.includes('rate limit') || s.includes('limit reached')) {
    return 'Claude hit its usage limit. Wait for the limit to reset, then press Try again.';
  }
  if (s.includes('not logged in') || s.includes('login') || s.includes('authenticat') || s.includes('oauth')) {
    return 'Claude Code is not logged in. Run `claude` in a terminal, log in, then press Try again.';
  }
  return raw.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400);
}

/** One plain-words line for what a tool call is doing, relative to the project folder. */
export function describeTool(e: ToolEvent, cwd: string): string | null {
  // Files outside the working folder (temp scripts, screenshots) show by name only.
  const rel = (p: unknown) => {
    if (typeof p !== 'string') return '';
    const r = path.relative(cwd, p);
    return !r ? p : r.startsWith('..') ? path.basename(p) : r;
  };
  const i = e.input;
  switch (e.name) {
    case 'Read':
      return `Reading ${rel(i.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
      return `Editing ${rel(i.file_path)}`;
    case 'Write':
      return `Writing ${rel(i.file_path)}`;
    case 'Glob':
      return `Looking for ${String(i.pattern ?? 'files')}`;
    case 'Grep':
      return `Searching for "${String(i.pattern ?? '').slice(0, 40)}"`;
    case 'LS':
      return `Listing ${rel(i.path) || 'the folder'}`;
    case 'Bash': {
      const cmd = String(i.command ?? '').split('\n')[0]!.slice(0, 70);
      return cmd ? `Running ${cmd}` : null;
    }
    case 'WebFetch':
    case 'WebSearch':
      return `Looking up ${String(i.url ?? i.query ?? '').slice(0, 60)}`;
    default:
      return null;
  }
}
