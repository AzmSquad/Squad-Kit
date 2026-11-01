import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { AcpStartError, runAcp, type AcpLaunch } from '../../engine/acp-runner.js';
import type { AgentResult, AgentRun, AiTool } from '../ai-tool/types.js';
import { claudeBinary, claudeEnv, deniedTools, describeTool, plainError, runClaude, sessionExists, toolVersion, type RunOptions } from './direct.js';

/**
 * Claude Code as a squad-kit AI tool, on the person's own Claude login: over ACP through the official adapter, with
 * Claude Code's own headless mode (`claude -p`) as the fallback.
 */

/** Steps that only read may look around with the shell too, but any other command is refused, even when asked. */
const READ_SHELL = ['cat', 'ls', 'grep', 'rg', 'head', 'tail', 'wc', 'cd', 'pwd', 'git log', 'git show', 'git diff', 'git status'].map((c) => `Bash(${c}:*)`);
export const READ_ONLY = ['Read', 'Glob', 'Grep', 'LS', ...READ_SHELL];
const GIT_READ = ['git diff', 'git status', 'git log', 'git show'].map((c) => `Bash(${c}:*)`);
const BUILD_TOOLS = ['Read', 'Edit', 'MultiEdit', 'Write', 'Glob', 'Grep', 'LS', 'Bash', 'TodoWrite'];
/** Git that changes history is squad-kit's job, never an agent's. */
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
];

/** Claude's model for each level, by the aliases Claude Code always points at the newest of each. */
const LEVEL_MODEL = { strongest: 'opus', balanced: 'sonnet', fast: 'haiku' } as const;

/** Claude Code's settings for one run of a role. */
export function claudeRunOptions(r: AgentRun): RunOptions {
  const access: Pick<RunOptions, 'allowedTools' | 'disallowedTools' | 'permissionMode'> = r.permissions.includes('edit')
    ? { allowedTools: BUILD_TOOLS, disallowedTools: NO_GIT_WRITES, permissionMode: 'acceptEdits' }
    : { allowedTools: [...new Set([...READ_ONLY, ...(r.permissions.includes('git-read') ? GIT_READ : [])])], disallowedTools: NO_GIT_WRITES };
  return {
    cwd: r.cwd,
    prompt: r.prompt,
    ...(r.sessionId ? { sessionId: r.sessionId } : {}),
    ...(r.resume ? { resume: r.resume } : {}),
    ...access,
    ...(r.secretFiles ? { secretFiles: r.secretFiles } : {}),
    ...(r.schema ? { schema: r.schema } : {}),
    ...(r.instructions ? { appendSystemPrompt: r.instructions } : {}),
    ...(r.model || r.level ? { model: r.model || LEVEL_MODEL[r.level!] } : {}),
    ...(r.effort ? { effort: r.effort } : {}),
    ...(r.addDirs ? { addDirs: r.addDirs } : {}),
    ...(r.timeoutMs ? { timeoutMs: r.timeoutMs } : {}),
    ...(r.signal ? { signal: r.signal } : {}),
    ...(r.onTool ? { onTool: r.onTool } : {}),
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

/** How the gateway starts the Claude adapter and what it sends it. */
export function claudeLaunch(opts: RunOptions, adapter: string, bin: string): AcpLaunch {
  const denied = deniedTools(opts);
  const options = {
    ...(opts.allowedTools?.length ? { allowedTools: opts.allowedTools } : {}),
    ...(denied.length ? { disallowedTools: denied } : {}),
    ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
    ...(opts.schema ? { outputFormat: { type: 'json_schema', schema: opts.schema } } : {}),
    ...(opts.appendSystemPrompt ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: opts.appendSystemPrompt } } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
    ...(opts.addDirs?.length ? { additionalDirectories: opts.addDirs } : {}),
  };
  return {
    command: process.execPath,
    args: [adapter],
    // The adapter takes its model from ANTHROPIC_MODEL (an option alone does not change it), and each run starts its own adapter.
    env: { ...claudeEnv(), CLAUDE_CODE_EXECUTABLE: bin, ...(opts.model ? { ANTHROPIC_MODEL: opts.model } : {}) },
    meta: { claudeCode: { options } },
    canResume: sessionExists,
    explain: plainError,
    toolName: (update) => update._meta?.claudeCode?.toolName,
    structuredTool: 'StructuredOutput',
  };
}

/** One run over ACP. Throws AcpStartError when the adapter cannot start, before any work began. */
export async function runClaudeAcp(opts: RunOptions & { logDir?: string }): Promise<AgentResult> {
  const adapter = acpAdapterPath();
  if (!adapter) throw new AcpStartError('The Claude ACP adapter is not installed.');
  const bin = claudeBinary();
  if (!bin) return { ok: false, sessionId: opts.resume ?? opts.sessionId ?? '', text: '', error: 'Claude Code is not installed. Install it and log in, then try again.' };
  return runAcp(claudeLaunch(opts, adapter, bin), { ...opts, expectStructured: Boolean(opts.schema), ...(opts.logDir ? { logDir: opts.logDir } : {}) });
}

export const claudeTool: AiTool = {
  name: 'claude',
  label: 'Claude Code',
  canRun: true,
  supportsEffort: true,
  modelFor: (level) => ({ strongest: 'Opus', balanced: 'Sonnet', fast: 'Haiku' })[level],
  ready() {
    const bin = claudeBinary();
    return Boolean(bin && toolVersion(bin));
  },
  async run(r) {
    const opts = claudeRunOptions(r);
    if (r.direct || !acpAdapterPath()) return runClaude(opts);
    try {
      return await runClaudeAcp({ ...opts, ...(r.logDir ? { logDir: r.logDir } : {}) });
    } catch (err) {
      if (!(err instanceof AcpStartError)) throw err;
      r.onFallback?.(err.message);
      return runClaude(opts);
    }
  },
  describe: describeTool,
};
