import path from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { loadConfig } from '../../core/config.js';
import type { ConnectionModule, ConnectionStatus, GuideStep, SignInFlow } from '../connection/types.js';
import { repoName } from './pull-page.js';
import { forgetGhState, ghSignIn, signedInAs } from './sign-in.js';

/**
 * GitHub on the Connections page: "Sign in with GitHub" runs GitHub's own tool, `gh auth login`, the way it signs in
 * from a terminal. gh gives a one-time code and its page; the person types the code there and approves. squad-kit only
 * reads the code and the page from what gh prints (never a token), opens no window, and keeps no password: gh holds the
 * sign-in, as before. Cancel stops that one gh process by its id.
 */

const HOST = 'github.com';
const CODE = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/;
const PAGE = /(https:\/\/github\.com\/login\/device\S*)/;
const DEVICE_PAGE = 'https://github.com/login/device';
/**
 * gh prints its code at once: with none in `codeWaitMs`, the sign-in failed. GitHub keeps a code for 15 minutes, so gh
 * is stopped then too (`lifeMs`), and when squad-kit itself stops.
 */
const PACE = { codeWaitMs: 20_000, lifeMs: 15 * 60_000 };
let pace = PACE;

/** Tests wait less. Null goes back to the real pace. */
export function useConnectPace(p: Partial<typeof PACE> | null): void {
  pace = p ? { ...PACE, ...p } : PACE;
}

/** Only a project whose stories come from a GitHub Project asks gh for the Projects right (ADR-009). */
function needsProjects(root: string): boolean {
  try {
    const t = loadConfig(path.join(root, '.squad', 'config.yaml')).tracker as { type: string; options?: Record<string, unknown> };
    return t.type === 'github' && t.options?.from === 'project';
  } catch {
    return false;
  }
}

/** gh run plainly: no colors, no questions, never as if in a terminal. */
function ghEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', GH_PROMPT_DISABLED: '1' };
  delete env.GH_FORCE_TTY;
  delete env.CLICOLOR_FORCE;
  return env;
}

/**
 * gh saves the git protocol it signs in with for github.com. The person's own choice stays: squad-kit passes the one gh
 * has now (gh says https when none is set), so an ssh setup is never turned into https.
 */
function gitProtocol(): Promise<'ssh' | 'https'> {
  return new Promise((resolve) => {
    execFile('gh', ['config', 'get', 'git_protocol', '--host', HOST], { env: ghEnv(), timeout: 10_000 }, (err, out) => resolve(!err && String(out).trim() === 'ssh' ? 'ssh' : 'https'));
  });
}

function loginArgs(projects: boolean, protocol: 'ssh' | 'https'): string[] {
  return ['auth', 'login', '--hostname', HOST, '--web', '--git-protocol', protocol, ...(projects ? ['--scopes', 'project'] : [])];
}

interface Running extends SignInFlow {
  child?: ChildProcess;
}

let flow: Running | null = null;
let starting: Promise<SignInFlow> | null = null;

const shown = (f: Running): SignInFlow => {
  const { child: _child, ...rest } = f;
  return rest;
};

const alive = (c?: ChildProcess) => Boolean(c && c.exitCode === null && c.signalCode === null);

/** squad-kit stops: the gh it started stops with it. */
const stopWithUs = () => {
  if (alive(flow?.child)) flow!.child!.kill('SIGTERM');
};

/** The last line gh printed, for a plain failure. The device code never carries a secret; a token is never printed here. */
function lastLine(out: string): string {
  return out.split('\n').map((l) => l.replace(/^[!✓X-]\s*/, '').trim()).filter(Boolean).pop()?.slice(0, 200) ?? '';
}

function start(root: string): Promise<SignInFlow> {
  if (starting) return starting;
  if (flow?.state === 'waiting' && alive(flow.child)) return Promise.resolve(shown(flow));
  const f: Running = { state: 'waiting', startedAt: new Date().toISOString() };
  flow = f;
  starting = gitProtocol()
    .then((protocol) => (f.state === 'waiting' ? run(f, loginArgs(needsProjects(root), protocol)) : shown(f)))
    .finally(() => (starting = null));
  return starting;
}

function run(f: Running, args: string[]): Promise<SignInFlow> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let life: NodeJS.Timeout | undefined;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(shown(f));
    };
    let child: ChildProcess;
    try {
      child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: ghEnv() });
    } catch (err) {
      Object.assign(f, { state: 'failed', line: (err as Error).message });
      settle();
      return;
    }
    f.child = child;
    f.pid = child.pid;
    process.once('exit', stopWithUs);
    timer = setTimeout(() => {
      if (f.code) return;
      if (alive(child)) child.kill('SIGTERM');
      Object.assign(f, { state: 'failed', line: "GitHub's tool gave no sign-in code. Try again, or sign in step by step." });
      settle();
    }, pace.codeWaitMs);
    const read = (d: Buffer) => {
      out = (out + String(d)).slice(-8000);
      const code = CODE.exec(out)?.[1];
      if (code && !f.code) {
        f.code = code;
        f.url = PAGE.exec(out)?.[1] ?? DEVICE_PAGE;
        // GitHub's code lasts 15 minutes: gh does not wait longer than that.
        life = setTimeout(() => {
          if (f.state !== 'waiting' || !alive(child)) return;
          Object.assign(f, { state: 'failed', line: 'The code expired after 15 minutes. Try again.' });
          child.kill('SIGTERM');
        }, pace.lifeMs);
        settle();
      }
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    child.on('error', (err) => {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      Object.assign(f, { state: 'failed', line: missing ? "GitHub's tool, gh, is not on this computer. Install it from the Tools page first." : err.message });
      settle();
    });
    child.on('exit', (code) => {
      clearTimeout(life);
      process.removeListener('exit', stopWithUs);
      forgetGhState();
      if (f.state !== 'waiting') return settle();
      if (code === 0) {
        f.state = 'done';
        void signedInAs()
          .then((login) => (f.account = login))
          .catch(() => undefined);
      } else Object.assign(f, { state: 'failed', line: `GitHub did not finish the sign-in${lastLine(out) ? `: ${lastLine(out)}` : ''}. Try again.` });
      settle();
    });
  });
}

/** Cancel: stops the gh process this sign-in started, by its id, and only while it still runs. */
function cancel(): SignInFlow | null {
  if (!flow) return null;
  const c = flow.child;
  if (flow.state === 'waiting') flow.state = 'cancelled';
  if (c?.pid && alive(c)) process.kill(c.pid, 'SIGTERM');
  return shown(flow);
}

/** Signs GitHub's tool out on this computer, for this one account: every app that uses gh is signed out too. */
function signOut(account: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('gh', ['auth', 'logout', '--hostname', HOST, '--user', account], { timeout: 20_000 }, (err, _out, said) => {
      forgetGhState();
      if (err) reject(new Error(`GitHub's tool did not sign out: ${lastLine(String(said ?? '')) || err.message}`));
      else resolve();
    });
  });
}

let version: { at: number; found: string | null } | null = null;

/** gh's version, kept ten minutes: "2.98.0". */
function ghVersion(): Promise<string | null> {
  if (version && Date.now() - version.at < 600_000) return Promise.resolve(version.found);
  return new Promise((resolve) => {
    execFile('gh', ['--version'], { timeout: 10_000 }, (err, out) => {
      const found = err ? null : (/gh version (\S+)/.exec(String(out))?.[1] ?? null);
      version = { at: Date.now(), found };
      resolve(found);
    });
  });
}

function steps(root: string, found: string | null, account?: string): GuideStep[] {
  const mac = process.platform === 'darwin';
  const list: GuideStep[] = [
    {
      text: { en: "Install GitHub's own tool", ar: 'ثبّت أداة GitHub الرسمية' },
      ...(mac ? { command: 'brew install gh' } : {}),
      page: '/tools#gh',
      ...(found ? { done: { en: `Found gh ${found}`, ar: `لقينا gh ${found}` } } : {}),
    },
    {
      text: { en: 'Sign in to GitHub with it', ar: 'سجّل الدخول لـ GitHub فيها' },
      command: 'gh auth login --web',
      ...(account ? { done: { en: `Signed in as ${account}`, ar: `مسجّل باسم ${account}` } } : {}),
    },
  ];
  if (needsProjects(root)) list.push({ text: { en: 'Let it read Projects too (only for GitHub Projects)', ar: 'خلّها تقرأ المشاريع كمان (بس لمشاريع GitHub)' }, command: 'gh auth refresh -s project' });
  return list;
}

async function status(root: string): Promise<ConnectionStatus> {
  const [s, found] = await Promise.all([ghSignIn(), ghVersion()]);
  const state = s.state === 'ready' ? 'connected' : s.state === 'missing' || !found ? 'missing' : s.state === 'signed-out' ? 'not-connected' : 'unknown';
  return { state, ...(s.account ? { account: s.account } : {}), steps: steps(root, found, s.account) };
}

/** A test asks gh again. */
export function forgetGhConnect(): void {
  forgetGhState();
  version = null;
  if (flow && !alive(flow.child)) flow = null;
}

export const githubConnection: ConnectionModule = {
  name: 'github',
  label: 'GitHub',
  what: { en: 'Pull requests, Issues and Projects', ar: 'طلبات الدمج والمهام والمشاريع' },
  how: 'sign-in',
  can: [
    { en: 'Push your branches and open pull requests', ar: 'يرفع فروعك ويفتح طلبات الدمج' },
    { en: 'Read and move Issues and Projects', ar: 'يقرأ المهام والمشاريع ويحرّكها' },
    { en: 'Never merges into a repo that is not yours', ar: 'ما يدمج أبداً في مستودع مو لك' },
  ],
  repoName,
  status,
  forget: forgetGhConnect,
  signIn: { start, now: () => (flow ? shown(flow) : null), cancel },
  signOut,
};
