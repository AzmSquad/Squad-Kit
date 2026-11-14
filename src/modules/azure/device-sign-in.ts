import type { ChildProcess } from 'node:child_process';
import type { SignInFlow } from '../connection/types.js';
import { azAccounts, azLastLine, clearAzFolder, runAz, startAz, stopAz } from './az.js';
import { orgTenant } from './tenant.js';
import { forgetMicrosoftTokens, personalOrg } from './token.js';

/**
 * "Sign in with Microsoft": runs Microsoft's own tool, `az login --use-device-code`, with squad-kit's own settings
 * folder (ADR-011). az gives a one-time code and its page; the person types the code there, picks their account and
 * approves. squad-kit only reads the code and the page from what az prints (never a token), opens no window and keeps
 * no password: az holds the sign-in in squad-kit's folder. Cancel stops that one az, by its id. When the organization's
 * directory is known, the sign-in goes straight to it (`--tenant`), so a guest account works too.
 */

/** What az 2.88 prints: "To sign in, use a web browser to open the page https://login.microsoft.com/device and enter the code GZ3SDVTBE to authenticate." */
const CODE = /enter the code\s+([A-Z0-9]{6,12})\b/i;
const PAGE = /open the page\s+(https:\/\/\S+)/i;
const DEVICE_PAGE = 'https://microsoft.com/devicelogin';
/** az starts slowly (Python): a code in 45 seconds. Microsoft keeps a code for 15 minutes, so az is stopped then. */
const PACE = { codeWaitMs: 45_000, lifeMs: 15 * 60_000 };
let pace = PACE;

/** Tests wait less. Null goes back to the real pace. */
export function useAzurePace(p: Partial<typeof PACE> | null): void {
  pace = p ? { ...PACE, ...p } : PACE;
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

/**
 * Starts the sign-in for this organization (or for any, when none is set yet). An organization of personal Microsoft
 * accounts cannot sign in this way: it fails at once, in plain words, before az starts.
 */
export function startMicrosoftSignIn(org: string | undefined, done: () => void): Promise<SignInFlow> {
  if (starting) return starting;
  if (flow?.state === 'waiting' && alive(flow.child)) return Promise.resolve(shown(flow));
  const f: Running = { state: 'waiting', startedAt: new Date().toISOString() };
  flow = f;
  starting = (org ? orgTenant(org) : Promise.resolve(null))
    .then((t) => {
      if (f.state !== 'waiting') return shown(f);
      if (t?.kind === 'personal') {
        Object.assign(f, { state: 'failed', line: `${personalOrg(org!)} Sign in with Microsoft cannot reach it.` });
        return shown(f);
      }
      return run(f, ['login', '--use-device-code', '--allow-no-subscriptions', ...(t?.kind === 'entra' ? ['--tenant', t.tenant] : []), '--output', 'none'], done);
    })
    .finally(() => (starting = null));
  return starting;
}

function run(f: Running, args: string[], done: () => void): Promise<SignInFlow> {
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
      child = startAz(args);
    } catch (err) {
      Object.assign(f, { state: 'failed', line: (err as Error).message });
      settle();
      return;
    }
    child.stdin?.end();
    // squad-kit stopping stops this az too (engine/process-group.ts track).
    f.child = child;
    f.pid = child.pid;
    timer = setTimeout(() => {
      if (f.code) return;
      stopAz(child);
      Object.assign(f, { state: 'failed', line: "Microsoft's tool gave no sign-in code. Try again, or use a token instead." });
      settle();
    }, pace.codeWaitMs);
    const read = (d: Buffer) => {
      out = (out + String(d)).slice(-8000);
      const code = CODE.exec(out)?.[1];
      if (code && !f.code) {
        f.code = code;
        f.url = PAGE.exec(out)?.[1]?.replace(/[.,]$/, '') ?? DEVICE_PAGE;
        // Microsoft's code lasts 15 minutes: az does not wait longer than that.
        life = setTimeout(() => {
          if (f.state !== 'waiting' || !alive(child)) return;
          Object.assign(f, { state: 'failed', line: 'The code expired after 15 minutes. Try again.' });
          stopAz(child);
        }, pace.lifeMs);
        settle();
      }
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    child.on('error', (err: NodeJS.ErrnoException) => {
      Object.assign(f, { state: 'failed', line: err.code === 'ENOENT' ? "Microsoft's Azure tool, az, is not on this computer. Install it from the Tools page first, or use a token instead." : err.message });
      settle();
    });
    child.on('close', (code) => {
      clearTimeout(life);
      forgetMicrosoftTokens();
      done();
      if (f.state !== 'waiting') return settle();
      if (code === 0) {
        f.state = 'done';
        const who = azAccounts()[0]?.user;
        if (who) f.account = who;
      } else if (code === 127 || code === 9009) {
        Object.assign(f, { state: 'failed', line: "Microsoft's Azure tool, az, is not on this computer. Install it from the Tools page first, or use a token instead." });
      } else {
        const said = azLastLine(out).replace(/\.$/, '');
        Object.assign(f, { state: 'failed', line: `Microsoft did not finish the sign-in${said ? `: ${said}` : ''}. Try again.` });
      }
      settle();
    });
  });
}

/** Cancel: stops the az this sign-in started, by its id, and only while it still runs. */
export function cancelMicrosoftSignIn(): SignInFlow | null {
  if (!flow) return null;
  if (flow.state === 'waiting') flow.state = 'cancelled';
  if (flow.child && alive(flow.child)) stopAz(flow.child);
  return shown(flow);
}

export function microsoftSignInNow(): SignInFlow | null {
  return flow ? shown(flow) : null;
}

/**
 * Signs squad-kit out of Microsoft: az clears its accounts when it is here, then squad-kit's own az folder is emptied
 * all the same, saved tokens too, so a missing or stuck az never leaves a sign-in behind. The person's own az sign-ins,
 * in their own folder, are never touched.
 */
export async function signOutOfMicrosoft(): Promise<void> {
  await runAz(['account', 'clear'], 30_000);
  clearAzFolder();
  forgetMicrosoftTokens();
}

/** A test starts afresh. */
export function forgetMicrosoftFlow(): void {
  if (flow && !alive(flow.child)) flow = null;
}
