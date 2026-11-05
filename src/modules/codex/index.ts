import { execSync } from 'node:child_process';
import path from 'node:path';
import type { AiTool } from '../ai-tool/types.js';

/** Codex: squad-kit finds it and lets a role choose it, but cannot run it yet. Its ACP adapter comes next. */
export const codexTool: AiTool = {
  name: 'codex',
  label: 'Codex',
  plan: 'ChatGPT',
  canRun: false,
  supportsEffort: false,
  instructionFiles: ['AGENTS.md'],
  // Codex's sign-in and its saved conversations; OpenAI's keys and Codex's own settings in the environment.
  privateFiles: (home) => ['auth.json', 'sessions', 'history.jsonl'].map((f) => path.join(home, '.codex', f)),
  secretEnv: ['OPENAI_*', 'CODEX_*'],
  modelFor: () => '',
  ready() {
    try {
      execSync(process.platform === 'win32' ? 'where codex' : 'which codex', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  },
  run: () => Promise.reject(new Error('squad-kit cannot run Codex yet.')),
  describe: () => null,
};
