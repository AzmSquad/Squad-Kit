import { execFileSync } from 'node:child_process';
import type { HostSignIn } from '../code-host/types.js';
import { githubApi } from './auth.js';

/**
 * Whether GitHub's own tool, gh, is on this computer and signed in. Only gh's exit code is read: what it prints (the
 * token) goes nowhere, not even into squad-kit's memory. Kept a minute, so the many quick asks of a board cost nothing.
 */

export type GhState = HostSignIn['state'];

export const GH_PAGE = 'https://cli.github.com';

/** The steps for the person, by what is missing. */
export const GH_STEPS: Record<Exclude<GhState, 'ready'>, string[]> = {
  missing: ["Install GitHub's tool, gh, from cli.github.com.", 'Sign in: open a terminal and run gh auth login.', 'Come back and press Try again.'],
  'signed-out': ['Sign in: open a terminal and run gh auth login.', 'Come back and press Try again.'],
};

/** The words for a stop card when GitHub said no to the sign-in. */
export const SIGN_IN_HELP = "Sign in again with GitHub's tool: open a terminal and run gh auth login. If gh is not on this computer, install it from cli.github.com first.";

const KEEP_MS = 60_000;
let kept: { at: number; path: string; state: GhState } | null = null;
let account: { at: number; login: string } | null = null;

export function ghState(at = Date.now()): GhState {
  const where = process.env.PATH ?? '';
  if (kept && kept.path === where && at - kept.at < KEEP_MS) return kept.state;
  let state: GhState = 'ready';
  try {
    execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], { stdio: 'ignore', timeout: 10_000 });
  } catch (err) {
    state = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'signed-out';
  }
  kept = { at, path: where, state };
  return state;
}

/** Asks gh again next time: after GitHub refused the sign-in, or in a test. */
export function forgetGhState(): void {
  kept = null;
  account = null;
}


/** Who is signed in, as GitHub says. Kept ten minutes. */
export async function signedInAs(): Promise<string> {
  if (account && Date.now() - account.at < 10 * KEEP_MS) return account.login;
  const me = await githubApi<{ login: string }>('/user');
  account = { at: Date.now(), login: me.login };
  return me.login;
}

/** The sign-in as the board shows it. */
export async function ghSignIn(): Promise<HostSignIn> {
  const state = ghState();
  if (state !== 'ready') return { state, steps: GH_STEPS[state], link: GH_PAGE };
  const login = await signedInAs().catch(() => null);
  if (!login) {
    forgetGhState();
    return { state: 'signed-out', steps: GH_STEPS['signed-out'], link: GH_PAGE };
  }
  return { state, account: login, steps: [], link: GH_PAGE };
}
