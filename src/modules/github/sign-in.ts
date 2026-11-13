import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HostSignIn } from '../code-host/types.js';
import type { SetupStep } from '../tracker/types.js';
import { githubApi, githubToken } from './auth.js';

/**
 * Whether GitHub's own tool, gh, is on this computer and signed in. gh itself is asked beside everything else, never
 * holding the board up: only its exit code is read, and what it prints (the token) goes nowhere. Its answer is kept a
 * minute. Until it has answered, a quick guess from files stands in: gh on the PATH, and github.com in its hosts file.
 * The pull request part and the tracker's Settings steps both read it from here.
 */

type GhState = HostSignIn['state'];

const GH_PAGE = 'https://cli.github.com';

/** The steps for the person, by what is missing. */
const GH_STEPS: Record<Exclude<GhState, 'ready'>, string[]> = {
  missing: ["Install GitHub's tool, gh, from cli.github.com.", 'Sign in: open a terminal and run gh auth login.', 'Come back and press Try again.'],
  'signed-out': ['Sign in: open a terminal and run gh auth login.', 'Come back and press Try again.'],
  unknown: ["GitHub's tool did not answer just now. Wait a moment, then press Try again.", 'If it happens again, open a terminal and run gh auth status.'],
};

/** The words for a stop card when GitHub said no to the sign-in. */
export const SIGN_IN_HELP = "Sign in again with GitHub's tool: open a terminal and run gh auth login. If gh is not on this computer, install it from cli.github.com first.";

const KEEP_MS = 60_000;
const ASK_MS = 10_000;
let kept: { at: number; key: string; state: GhState } | null = null;
let asking: { key: string; answer: Promise<GhState> } | null = null;
let account: { at: number; login: string } | null = null;

/** What the answer depends on: a new PATH or gh folder asks again. */
const keyNow = () => `${process.env.PATH ?? ''}\0${process.env.GH_CONFIG_DIR ?? ''}`;

function configDir(): string {
  const env = process.env;
  if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR;
  if (process.platform === 'win32' && env.AppData) return path.join(env.AppData, 'GitHub CLI');
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'gh');
}

function onPath(): boolean {
  const names = process.platform === 'win32' ? ['gh.exe', 'gh.cmd'] : ['gh'];
  return (process.env.PATH ?? '').split(path.delimiter).some((d) => d && names.some((n) => fs.existsSync(path.join(d, n))));
}

/** A quick guess from files only, for the moment before gh has answered. */
function guess(): GhState {
  if (!onPath()) return 'missing';
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return 'ready';
  try {
    return /^github\.com:/m.test(fs.readFileSync(path.join(configDir(), 'hosts.yml'), 'utf8')) ? 'ready' : 'signed-out';
  } catch {
    return 'signed-out';
  }
}

/**
 * Asks gh now, beside everything else, and keeps its answer. Only gh's own answer counts: one that never came (it timed
 * out, or could not start) keeps the last answer, or is 'unknown' when there was none, never a sign-out. Neither gh nor
 * its timer keeps a terminal command from ending.
 */
export function checkGh(): Promise<GhState> {
  const key = keyNow();
  // Asked already, for this same gh: that answer. A new PATH or gh folder asks its own.
  if (asking?.key === key) return asking.answer;
  const answer = new Promise<GhState>((resolve) => {
    let done = false;
    const end = (state: GhState | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const last = kept?.key === key ? kept.state : 'unknown';
      kept = { at: Date.now(), key, state: state ?? last };
      resolve(kept.state);
    };
    let child: ReturnType<typeof spawn> | null = null;
    const timer = setTimeout(() => {
      child?.kill();
      end(null);
    }, ASK_MS);
    timer.unref();
    try {
      child = spawn('gh', ['auth', 'token', '--hostname', 'github.com'], { stdio: 'ignore' });
    } catch (err) {
      // A gh that cannot start at all (not a program): no answer.
      end((err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : null);
      return;
    }
    child.unref();
    child.on('error', (err: NodeJS.ErrnoException) => end(err.code === 'ENOENT' ? 'missing' : null));
    child.on('exit', (code) => end(code === 0 ? 'ready' : code === null ? null : 'signed-out'));
  }).finally(() => {
    if (asking?.answer === answer) asking = null;
  });
  asking = { key, answer };
  return answer;
}

/** The sign-in now, never waiting: gh's last answer, else the guess while gh is asked. */
export function ghState(at = Date.now()): GhState {
  const key = keyNow();
  const mine = kept?.key === key ? kept : null;
  if (mine && at - mine.at < KEEP_MS) return mine.state;
  void checkGh();
  return mine?.state ?? guess();
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

/** The sign-in as the board shows it, from gh's own answer. */
export async function ghSignIn(): Promise<HostSignIn> {
  const state = await checkGh();
  if (state !== 'ready') return { state, steps: GH_STEPS[state], link: GH_PAGE };
  const login = await signedInAs().catch(() => null);
  if (!login) {
    forgetGhState();
    return { state: 'signed-out', steps: GH_STEPS['signed-out'], link: GH_PAGE };
  }
  return { state, account: login, steps: [], link: GH_PAGE };
}

/* ── The tracker's Settings steps ─────────────────────────────── */

/** What the tracker's steps read: gh's own answer, and the rights its token has (null when GitHub does not say). */
export interface SignInProbe {
  state(): Promise<GhState>;
  scopes(): Promise<string[] | null>;
}

export const realProbe: SignInProbe = {
  state: () => checkGh(),
  async scopes() {
    const token = await githubToken();
    if (!token) return null;
    try {
      const res = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
      const said = res.headers.get('x-oauth-scopes');
      return said === null ? null : said.split(',').map((s) => s.trim()).filter(Boolean);
    } catch {
      return null;
    }
  },
};

const PROJECTS: SetupStep = { say: 'Let it use Projects', command: 'gh auth refresh -s project' };

/** The steps Settings and squad doctor show: install gh, sign in, and for a Project let gh use Projects. */
export async function signInSteps(forProject: boolean, probe: SignInProbe = realProbe): Promise<SetupStep[]> {
  const project = forProject ? [PROJECTS] : [];
  const state = await probe.state();
  if (state === 'missing') return [{ say: "Install GitHub's tool, gh", link: GH_PAGE }, { say: 'Sign in with it', command: 'gh auth login' }, ...project];
  if (state === 'signed-out') return [{ say: "Sign in with GitHub's tool", command: 'gh auth login' }, ...project];
  if (!forProject) return [];
  const scopes = await probe.scopes();
  return scopes && !scopes.includes('project') ? project : [];
}
