import { execFile } from 'node:child_process';
import type { Billing } from '../ai-tool/types.js';
import { claudeBinary, claudeEnv } from './direct.js';

/**
 * How the person pays for Claude, from `claude auth status --json`: it reads the login and runs no model. The same
 * order as the ACP adapter's own auth status: a cloud backend or an API key pays per use, and an API key wins over a
 * stored subscription login, because Claude Code uses it first. Agents start without ANTHROPIC_API_KEY (see
 * childEnv), so the check runs in their environment and sees what they see.
 */

const CLOUD: Record<string, string> = {
  bedrock: 'AWS Bedrock',
  vertex: 'Google Vertex AI',
  foundry: 'Azure AI Foundry',
  anthropicAws: 'Anthropic on AWS',
  anthropicGoogleCloud: 'Anthropic on Google Cloud',
  gateway: 'a model gateway',
};

/** "pro" → "Claude Pro"; a newer Claude Code already says "Claude Max". */
function planLabel(plan: unknown): string {
  if (typeof plan !== 'string' || !plan.trim()) return 'Claude plan';
  const titled = plan.trim().replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
  return /^claude(\s|$)/i.test(titled) ? titled : `Claude ${titled}`;
}

/** What Claude Code's auth status says about paying, or null when it says nothing or is not logged in. */
export function billingFrom(stdout: string): Billing | null {
  let s: unknown;
  try {
    s = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const o = s as Record<string, unknown>;
  const provider = typeof o.apiProvider === 'string' ? o.apiProvider : 'firstParty';
  if (provider !== 'firstParty') return { kind: 'api-key', label: CLOUD[provider] ?? provider };
  if (typeof o.apiKeySource === 'string' && o.apiKeySource) return { kind: 'api-key', label: 'Anthropic API key' };
  if (o.authMethod === 'api_key' || o.authMethod === 'api_key_helper') return { kind: 'api-key', label: 'Anthropic API key' };
  if (o.authMethod === 'third_party') return { kind: 'api-key', label: 'a cloud account' };
  if (o.authMethod === 'claude.ai' || o.authMethod === 'oauth_token' || typeof o.subscriptionType === 'string') return { kind: 'subscription', label: planLabel(o.subscriptionType) };
  return null;
}

/** Asks the installed Claude Code. Not logged in, an older Claude Code without `auth status`, or no answer: null. */
export function claudeBilling(timeoutMs = 8000): Promise<Billing | null> {
  const bin = claudeBinary();
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(bin, ['auth', 'status', '--json'], { env: claudeEnv(), timeout: timeoutMs, encoding: 'utf8', windowsHide: true }, (_err, stdout) => {
      // Logged out exits 1 with the same JSON on stdout, which says so.
      resolve(billingFrom(String(stdout ?? '')));
    });
  });
}

/** A folder for the shell, quoted only when it needs it. */
function quoted(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Opens a saved conversation in Claude Code, in the folder it ran in. */
export function claudeResume(sessionId: string, cwd?: string): string {
  return `${cwd ? `cd ${quoted(cwd)} && ` : ''}claude --resume ${sessionId}`;
}
