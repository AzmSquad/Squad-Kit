import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { AcpStartError, runAcp, type AcpLaunch } from '../../engine/acp-runner.js';
import type { AgentResult, AgentRun, AiTool } from '../ai-tool/types.js';
import { claudeBinary, claudeEnv, costSoFar, deniedTools, describeTool, ownWords, passing, plainError, runClaude, sessionExists, toolVersion, type RunOptions } from './direct.js';
import { claudeLimit } from './limit.js';
import { CLAUDE_ENV, claudeBlocked, claudePrivateFiles, claudeSandbox, claudeSandboxSupport, withCap } from './sandbox.js';
import { claudeBilling, claudeResume } from './billing.js';

/**
 * Claude Code as a squad-kit AI tool, on the person's own Claude login: over ACP through the official adapter, with
 * Claude Code's own headless mode (`claude -p`) as the fallback.
 */

/** Steps that only read may look around with the shell too, but any other command is refused, even when asked. */
const READ_SHELL = ['cat', 'ls', 'grep', 'rg', 'head', 'tail', 'wc', 'cd', 'pwd', 'git log', 'git show', 'git diff', 'git status'].map((c) => `Bash(${c}:*)`);
export const READ_ONLY = ['Read', 'Glob', 'Grep', 'LS', ...READ_SHELL];
const GIT_READ = ['git diff', 'git status', 'git log', 'git show'].map((c) => `Bash(${c}:*)`);
const BUILD_TOOLS = ['Read', 'Edit', 'MultiEdit', 'Write', 'Glob', 'Grep', 'LS', 'Bash', 'TodoWrite'];
/** A step that runs the app and a browser (the Tester): any command, but no file-editing tools. */
const RUN_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'Bash', 'TodoWrite'];
/** Git that changes history is squad-kit's job, never an agent's; so are pull requests and the repo on the code host. */
const NO_GIT_WRITES = [
  'Bash(git commit:*)',
  'Bash(git push:*)',
  'Bash(git checkout:*)',
  'Bash(git switch:*)',
  'Bash(git reset:*)',
  'Bash(git rebase:*)',
  'Bash(git merge:*)',
  'Bash(git branch:*)',
  'Bash(git tag:*)',
  'Bash(git stash:*)',
  'Bash(git clean:*)',
  'Bash(git pull:*)',
  'Bash(git cherry-pick:*)',
  'Bash(git revert:*)',
  'Bash(git am:*)',
  'Bash(git update-ref:*)',
  'Bash(git worktree:*)',
  // The same commands on another folder's git.
  'Bash(git -C:*)',
  'Bash(gh pr:*)',
  'Bash(gh repo:*)',
];
/** The tools that change a file, each with its own rule. */
const FILE_TOOLS = ['Edit', 'Write', 'MultiEdit'];

/**
 * Deny rules for files no agent may change, by name at any depth: under the folder it works in, and anywhere on disk
 * (`//` is the root), so a folder above it or the person's own ~/.claude is covered too.
 */
function protectedRules(names: string[]): string[] {
  return names.flatMap((n) => {
    // A name that starts with "/" counts from the top of the copy: the rule is a little wider, and only ever on a hook's name.
    const name = n.replace(/^\//, '');
    const pattern = name.endsWith('/') ? `**/${name}**` : `**/${name}`;
    return [pattern, `//${pattern}`].flatMap((p) => FILE_TOOLS.map((t) => `${t}(${p})`));
  });
}

/** Claude Code's names for the window's tools: mcp__<server>__<tool>. They are allowed outright, so no prompt asks. */
export function windowTools(w: AgentRun['window']): string[] {
  return w ? w.tools.map((t) => `mcp__${w.name}__${t}`) : [];
}

/** Claude's model for each level, by the aliases Claude Code always points at the newest of each. */
const LEVEL_MODEL = { strongest: 'opus', balanced: 'sonnet', fast: 'haiku' } as const;

/** Claude Code's settings for one run of a role. */
export function claudeRunOptions(r: AgentRun): RunOptions {
  const edits = r.permissions.includes('edit');
  const own = edits ? BUILD_TOOLS
    : r.permissions.includes('run') ? RUN_TOOLS
    : [...new Set([...READ_ONLY, ...(r.permissions.includes('git-read') ? GIT_READ : [])])];
  const access: Pick<RunOptions, 'allowedTools' | 'disallowedTools' | 'permissionMode'> = {
    allowedTools: [...own, ...windowTools(r.window)],
    disallowedTools: [...NO_GIT_WRITES, ...protectedRules(r.protectedFiles ?? [])],
    // Always a mode of squad-kit's own: without one, the run starts in the person's default mode, maybe "bypass".
    permissionMode: edits ? 'acceptEdits' : 'default',
  };
  return {
    cwd: r.cwd,
    prompt: r.prompt,
    ...(r.sessionId ? { sessionId: r.sessionId } : {}),
    ...(r.resume ? { resume: r.resume } : {}),
    ...access,
    ...(r.secretFiles ? { secretFiles: r.secretFiles } : {}),
    ...(r.privatePlaces ? { privatePlaces: r.privatePlaces } : {}),
    ...(r.schema ? { schema: r.schema } : {}),
    ...(r.instructions ? { appendSystemPrompt: r.instructions } : {}),
    ...(r.model || r.level ? { model: r.model || LEVEL_MODEL[r.level!] } : {}),
    ...(r.effort ? { effort: r.effort } : {}),
    ...(r.addDirs ? { addDirs: r.addDirs } : {}),
    ...(r.sandbox ? { sandbox: claudeSandbox(r.sandbox) } : {}),
    ...(r.env ? { env: r.env } : {}),
    ...(r.caps?.turns ? { maxTurns: r.caps.turns } : {}),
    ...(r.caps?.spendUsd ? { maxBudgetUsd: r.caps.spendUsd } : {}),
    ...(r.window ? { window: r.window } : {}),
    ...(r.timeoutMs ? { timeoutMs: r.timeoutMs } : {}),
    ...(r.signal ? { signal: r.signal } : {}),
    ...(r.onTool ? { onTool: r.onTool } : {}),
    ...(r.onBlocked ? { onBlocked: r.onBlocked } : {}),
    ...(r.onText ? { onText: r.onText } : {}),
    ...(r.onActivity ? { onActivity: r.onActivity } : {}),
    ...(r.onSpawn ? { onSpawn: r.onSpawn } : {}),
  };
}

/** The official Claude ACP adapter's entry point, or null when it is not installed. */
export function acpAdapterPath(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve('@agentclientprotocol/claude-agent-acp/package.json');
    const entry = path.join(path.dirname(pkg), 'dist', 'index.js');
    return fs.existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

/** A window call may take a few minutes (squad-kit caps each at about 2): Claude Code waits that long for it. */
export const WINDOW_ENV = { MCP_TOOL_TIMEOUT: '240000' };

/** How the gateway starts the Claude adapter and what it sends it. */
export function claudeLaunch(opts: RunOptions, adapter: string, bin: string): AcpLaunch {
  const denied = deniedTools(opts);
  const options = {
    ...(opts.allowedTools?.length ? { allowedTools: opts.allowedTools } : {}),
    ...(denied.length ? { disallowedTools: denied } : {}),
    // Left on, the adapter lets the person's own "bypass" default skip every rule above, the denied tools too.
    allowDangerouslySkipPermissions: false,
    ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
    ...(opts.schema ? { outputFormat: { type: 'json_schema', schema: opts.schema } } : {}),
    ...(opts.appendSystemPrompt ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: opts.appendSystemPrompt } } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
    ...(opts.addDirs?.length ? { additionalDirectories: opts.addDirs } : {}),
    // The Agent SDK's own options: it puts the sandbox in the run's settings and passes the caps to Claude Code.
    ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
    ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
    ...(opts.maxBudgetUsd ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
  };
  return {
    label: 'Claude Code',
    command: process.execPath,
    args: [adapter],
    // The adapter takes its model from ANTHROPIC_MODEL (an option alone does not change it), and each run starts its own adapter.
    // The run's own environment reaches Claude Code through the adapter, and from there the commands it runs.
    env: { ...claudeEnv(), ...opts.env, CLAUDE_CODE_EXECUTABLE: bin, ...(opts.model ? { ANTHROPIC_MODEL: opts.model } : {}), ...(opts.window ? WINDOW_ENV : {}) },
    meta: { claudeCode: { options } },
    // The adapter starts in the person's own default mode and ignores permissionMode above: the session gets it instead.
    mode: opts.permissionMode ?? 'default',
    canResume: sessionExists,
    costSoFar,
    explain: plainError,
    toolName: (update) => update._meta?.claudeCode?.toolName,
    structuredTool: 'StructuredOutput',
    blocked: claudeBlocked,
  };
}

/** One run over ACP. Throws AcpStartError when the adapter cannot start, before any work began. */
export async function runClaudeAcp(opts: RunOptions & { logDir?: string }): Promise<AgentResult> {
  const adapter = acpAdapterPath();
  if (!adapter) throw new AcpStartError('The Claude ACP adapter is not installed.');
  const bin = claudeBinary();
  if (!bin) return { ok: false, sessionId: opts.resume ?? opts.sessionId ?? '', text: '', error: 'Claude Code is not installed. Install it and log in, then try again.' };
  // A missing answer is not an error here: squad-kit checks every answer against its shape and asks once more.
  return runAcp(claudeLaunch(opts, adapter, bin), { ...opts, ...(opts.logDir ? { logDir: opts.logDir } : {}) });
}

/** Claude Code's own limit message, when it ends a turn with it as its only answer instead of an error. */
const SAID_LIMIT = /^(you've (hit|reached) your [\w' -]{0,40}limit\b|you're out of (extra )?usage|claude (ai )?usage limit reached|(5-hour|weekly|session) limit reached)/i;

/** A stop on the usage limit says so to the engine, with the reset time when Claude said it, whichever way it ran. */
export function withLimit(r: AgentResult): AgentResult {
  if (r.limit) return r;
  if (r.ok) {
    const said = (r.text ?? '').trim();
    if (r.structured !== undefined || said.length > 400 || !SAID_LIMIT.test(said)) return r;
    return withLimit({ ...r, ok: false, error: plainError(said), detail: said });
  }
  const found = claudeLimit(r.detail ?? r.error ?? '');
  return found ? { ...r, limit: { name: 'Claude', ...found } } : r;
}

/** The ACP adapter's version, from its package file. */
function adapterVersion(): string | null {
  try {
    const require = createRequire(import.meta.url);
    return (require('@agentclientprotocol/claude-agent-acp/package.json') as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

export const claudeTool: AiTool = {
  name: 'claude',
  label: 'Claude Code',
  plan: 'Claude',
  canRun: true,
  supportsEffort: true,
  // Claude Code takes extra high too (`--effort xhigh`, and the same option over ACP).
  efforts: ['xhigh', 'high', 'medium', 'low'],
  instructionFiles: ['CLAUDE.md', 'CLAUDE.local.md', '.claude/'],
  privateFiles: (home) => claudePrivateFiles(home),
  secretEnv: CLAUDE_ENV,
  modelFor: (level) => ({ strongest: 'Opus', balanced: 'Sonnet', fast: 'Haiku' })[level],
  ready() {
    const bin = claudeBinary();
    return Boolean(bin && toolVersion(bin));
  },
  version() {
    const bin = claudeBinary();
    const v = bin ? toolVersion(bin) : null;
    const acp = adapterVersion();
    return v ? `${v}${acp ? `, ACP adapter ${acp}` : ''}` : null;
  },
  sandbox: claudeSandboxSupport,
  // `--max-turns` and `--max-budget-usd`, and the Agent SDK's maxTurns and maxBudgetUsd over ACP.
  caps: { turns: true, spend: true },
  blocked: claudeBlocked,
  async run(r) {
    const opts = claudeRunOptions(r);
    const done = (res: AgentResult) => withCap(withLimit(res), r.caps);
    if (r.direct || !acpAdapterPath()) return done(await runClaude(opts));
    try {
      return done(await runClaudeAcp({ ...opts, ...(r.logDir ? { logDir: r.logDir } : {}) }));
    } catch (err) {
      if (!(err instanceof AcpStartError)) throw err;
      // After a Stop nothing starts again, not even the other way.
      if (r.signal?.aborted) return { ok: false, sessionId: opts.resume ?? opts.sessionId ?? '', text: '', error: 'You stopped the squad.' };
      r.onFallback?.(err.message);
      return done(await runClaude(opts));
    }
  },
  ownWords,
  passing,
  describe: describeTool,
  billing: () => claudeBilling(),
  resumeCommand: claudeResume,
};
