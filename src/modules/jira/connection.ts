import type { CodePage, ConnectionModule, ConnectionStatus, GuideStep } from '../connection/types.js';
import { ModuleError } from '../errors.js';
import { atlassianPace, atlassianReady } from './atlassian-app.js';
import { holdRefreshLock } from './atlassian-lock.js';
import { atlassianSignInNow, cancelAtlassianSignIn, signOutOfAtlassian, startAtlassianSignIn } from './atlassian-sign-in.js';
import { ATLASSIAN_FOLDER, hostOf, readAtlassianSignIn, writeAtlassianSignIn, type AtlassianSite } from './atlassian-store.js';
import { atlassianCloud, atlassianEnded, atlassianToken, forgetAtlassianFailure, grantedSite } from './atlassian-token.js';
import { JiraClient, MissingScopeError } from './client.js';
import { LINES, SIGN_IN_FOOT, TOKEN_STEPS, signInSteps } from './connection-words.js';
import { jiraTracker } from './module.js';
import { siteOf } from './refs.js';
import { movedWords, readSaved } from './settings.js';
import { JiraTracker } from './tracker.js';

/**
 * Jira on the Connections page (ADR-012): "Sign in with Atlassian" through squad-kit's own Atlassian app, with a pasted
 * API token as the other way. A token saved for the project's site wins. The project's own Jira site is used; a project
 * with none uses the site the sign-in chose, picked here when Atlassian gave several. Until the app is registered, the
 * row is the token way only, with the sign-in shown as coming. What Jira answers is kept a minute; not reaching Jira or
 * Atlassian is never taken as a sign-in problem.
 */

const KEEP_MS = 60_000;
let kept: { at: number; root: string; status: ConnectionStatus } | null = null;

const CODE_PAGE: CodePage = {
  name: 'Atlassian',
  then: { en: 'pick your Jira site and press Accept', ar: 'اختر موقع Jira واضغط Accept' },
  foot: SIGN_IN_FOOT,
};

/** The token way only, while squad-kit's Atlassian app is not registered yet (ADR-010). */
async function tokenOnly(root: string): Promise<ConnectionStatus> {
  const tracker = jiraTracker.open(root);
  const moved = readSaved(root)?.moved;
  if (tracker) {
    const account = await tracker.whoAmI().catch(() => null);
    if (account) return { state: 'connected', account, steps: TOKEN_STEPS };
  }
  return { state: 'not-connected', steps: moved ? [{ text: movedWords(moved) }, ...TOKEN_STEPS] : TOKEN_STEPS };
}

const refused = (err: unknown) => err instanceof ModuleError && err.kind === 'sign-in';

/** Not reaching Jira (offline, too many calls, its own outage) waits and is asked again; anything else is for the log. */
function trouble(err: unknown): Pick<ConnectionStatus, 'state' | 'line'> {
  const e = err instanceof ModuleError ? err : null;
  if (e?.kind === 'offline' || e?.kind === 'too-many' || (e?.status ?? 0) >= 500) return { state: 'unknown', line: LINES.offline };
  return { state: 'unknown', line: LINES.error };
}

/** The site this project uses with the sign-in: its own; else the one the sign-in chose, or its only one. */
function siteFor(projectSite: string | undefined, sites: AtlassianSite[], chosen?: string): AtlassianSite | undefined {
  if (projectSite) return grantedSite(sites, projectSite);
  return sites.find((s) => s.id === chosen) ?? (sites.length === 1 ? sites[0] : undefined);
}

async function look(root: string): Promise<ConnectionStatus> {
  const saved = readSaved(root);
  const s = readAtlassianSignIn();
  // A sign-in left in squad-kit's folder can always be ended, whatever else is true here.
  const left: Pick<ConnectionStatus, 'signedIn'> = s ? { signedIn: s.account ? { as: s.account.name } : {} } : {};
  // A pasted token for the project's site wins: it is the person's own choice for this project.
  const tracker = saved?.token && saved.email ? jiraTracker.open(root) : null;
  if (tracker) {
    try {
      return { state: 'connected', account: await tracker.whoAmI(), by: 'token', ...left, steps: TOKEN_STEPS };
    } catch (err) {
      if (refused(err)) return { state: 'not-connected', by: 'token', ...left, line: LINES.tokenFailed, steps: TOKEN_STEPS };
      return { ...trouble(err), by: 'token', ...left, steps: TOKEN_STEPS };
    }
  }
  if (!s) {
    const ended = atlassianEnded();
    const line = ended ? LINES.ended(ended) : saved?.moved ? movedWords(saved.moved) : undefined;
    return { state: 'not-connected', ...(line ? { line } : {}), steps: signInSteps() };
  }
  const steps = signInSteps(s.account?.name);
  const site = siteFor(saved?.site, s.sites, s.site);
  if (!site) {
    if (saved?.site) return { state: 'not-connected', ...left, line: LINES.notGranted(saved.site, s.sites), steps };
    if (!s.sites.length) return { state: 'not-connected', ...left, line: LINES.noSite, steps };
    return { state: 'not-connected', ...left, line: LINES.pick(s.sites.length), pick: s.sites.map((x) => ({ site: hostOf(x.url), name: x.name })), steps };
  }
  const t = await atlassianToken();
  if (!t.ok) {
    if (t.why === 'no-answer') return { state: 'unknown', ...left, line: LINES.offline, steps };
    return { state: 'not-connected', ...(t.why === 'ended' ? { line: LINES.ended(atlassianEnded()) } : {}), steps: signInSteps() };
  }
  const host = hostOf(site.url);
  const signedIn = atlassianCloud(host);
  if (!signedIn) return { state: 'not-connected', steps: signInSteps() };
  try {
    const access = { site: host, email: signedIn.who, cloud: signedIn.cloud };
    const name = await new JiraTracker(new JiraClient(access), { ...access, readOnly: true }).whoAmI();
    return { state: 'connected', account: `${name} (${host})`, ...left, steps };
  } catch (err) {
    if (err instanceof MissingScopeError) return { state: 'not-connected', ...left, line: LINES.missingScope(err.scope), steps };
    if (refused(err)) return { state: 'not-connected', ...left, line: LINES.refusedSignIn(host), steps };
    return { ...trouble(err), ...left, steps };
  }
}

async function status(root: string): Promise<ConnectionStatus> {
  if (kept && kept.root === root && Date.now() - kept.at < KEEP_MS) return kept.status;
  let s = atlassianReady() ? await look(root).catch((): ConnectionStatus => ({ state: 'unknown', line: LINES.error, steps: signInSteps() })) : await tokenOnly(root);
  // No answer just now: the last answer stays, never a sign-out.
  if (s.state === 'unknown' && kept?.root === root) s = kept.status;
  kept = { at: Date.now(), root, status: s };
  return s;
}

/** The site for projects with no Jira site of their own, from those Atlassian gave. */
async function pickSite(_root: string, asked: string): Promise<{ line: string }> {
  if (!readAtlassianSignIn()) throw new ModuleError('squad-kit is not signed in with Atlassian. Sign in first: squad connect jira', 'sign-in');
  // Never in the middle of a refresh: it writes the same file.
  const release = await holdRefreshLock(atlassianPace().lockWaitMs);
  if (!release) throw new ModuleError('squad-kit is renewing its Atlassian sign-in just now. Try again in a moment.', 'too-many');
  try {
    const s = readAtlassianSignIn();
    if (!s) throw new ModuleError('squad-kit is not signed in with Atlassian. Sign in first: squad connect jira', 'sign-in');
    const host = siteOf(asked);
    const site = host ? grantedSite(s.sites, host) : undefined;
    if (!host || !site) throw new ModuleError(`Atlassian did not give squad-kit access to ${asked}. Pick one of: ${s.sites.map((x) => hostOf(x.url)).join(', ')}.`, 'not-found');
    writeAtlassianSignIn({ ...s, site: site.id });
    kept = null;
    return { line: `squad-kit uses ${host} for Jira on this computer.` };
  } finally {
    release();
  }
}

const SIGN_IN: NonNullable<ConnectionModule['signIn']> = {
  start: (root) => startAtlassianSignIn(readSaved(root)?.site, () => (kept = null)),
  now: atlassianSignInNow,
  cancel: cancelAtlassianSignIn,
};

const signOut = async () => {
  await signOutOfAtlassian();
  kept = null;
};

/** The sign-in parts are there only once squad-kit's Atlassian app is registered: until then, nothing half-works. */
export const jiraConnection: ConnectionModule = {
  name: 'jira',
  label: 'Jira',
  what: { en: 'Issues, sprints and boards', ar: 'المهام والسبرنتات واللوحات' },
  get how(): ConnectionModule['how'] {
    return atlassianReady() ? 'sign-in' : 'token';
  },
  tracker: jiraTracker.name,
  get next() {
    return atlassianReady() ? undefined : { en: 'Sign in with Atlassian', ar: 'سجّل الدخول بـ Atlassian' };
  },
  get codePage() {
    return atlassianReady() ? CODE_PAGE : undefined;
  },
  get ownSignIn() {
    return atlassianReady();
  },
  privateFolder: ATLASSIAN_FOLDER,
  revokeAt: {
    link: 'https://id.atlassian.com/manage-profile/apps',
    words: {
      en: 'You can also remove squad-kit from your Atlassian account, under Connected apps.',
      ar: 'وتقدر كمان تشيل squad-kit من حساب Atlassian، من Connected apps.',
    },
  },
  can: [
    { en: 'Pull stories, move them along and file bugs', ar: 'يسحب القصص ويحرّكها ويسجّل الأخطاء' },
    { en: 'Write questions, plans and pull request links on each story', ar: 'يكتب الأسئلة والخطط وروابط طلبات الدمج على كل قصة' },
    { en: 'Send a breakdown as epics and stories', ar: 'يرسل التقسيم كـ epics وstories' },
  ],
  status,
  forget() {
    kept = null;
    forgetAtlassianFailure();
  },
  get signIn() {
    return atlassianReady() ? SIGN_IN : undefined;
  },
  get signOut() {
    return atlassianReady() ? signOut : undefined;
  },
  localSignIn(root) {
    const s = readAtlassianSignIn();
    if (s) return s.account ? { as: s.account.name } : {};
    return readSaved(root)?.token ? 'token' : null;
  },
  pickSite,
};
