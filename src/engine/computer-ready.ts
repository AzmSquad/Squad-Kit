import { AI_TOOLS } from '../modules/registry.js';
import { detectClaudeLogin } from '../core/planner-auth.js';
import { gitIsNewEnough, gitVersion } from './git.js';

/**
 * What "Is your computer ready?" shows at the first start: git and an AI tool, checked by themselves, with one clear step
 * for what is missing. The page has the words, in the person's language. A check that cannot be sure never stops anyone:
 * the page always lets them go on.
 */

export type ReadyStep = 'install-git' | 'update-git' | 'install-tool' | 'sign-in';

export interface ComputerReady {
  git: { ok: boolean; step?: ReadyStep };
  tool: { ok: boolean; label?: string; step?: ReadyStep };
}

export function computerReady(): ComputerReady {
  const version = gitVersion();
  const git: ComputerReady['git'] = !version ? { ok: false, step: 'install-git' } : gitIsNewEnough(version) ? { ok: true } : { ok: false, step: 'update-git' };
  const ready = AI_TOOLS.find((t) => t.ready());
  if (!ready) return { git, tool: { ok: false, step: 'install-tool' } };
  // Only Claude Code's sign-in can be seen from here. An API key counts too.
  const signedIn = ready.name !== 'claude' || detectClaudeLogin().present || Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  return { git, tool: signedIn ? { ok: true, label: ready.label } : { ok: false, label: ready.label, step: 'sign-in' } };
}
