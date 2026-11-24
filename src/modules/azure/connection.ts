import type { ConnectionModule, ConnectionStatus, GuideStep, Words } from '../connection/types.js';
import { git } from '../../engine/git.js';
import { ModuleError } from '../errors.js';
import { Azure } from './client.js';
import { parseAzureRemote } from './hosts.js';
import { AZ_FOLDER, azAccounts, azVersion, forgetAzVersion, signInLeft } from './az.js';
import { cancelMicrosoftSignIn, microsoftSignInNow, signOutOfMicrosoft, startMicrosoftSignIn } from './device-sign-in.js';
import { addressAsk, pickAzurePlace, placeWords, saveAzureToken, storiesFromAzure, tokenAsk, tokenSteps } from './connect-place.js';
import { forgetReach, projectThere, reachable, type AzureProjectRef } from './reach.js';
import { azurePlace } from './sign-in.js';
import { forgetTenants, orgTenant } from './tenant.js';
import { azureTracker } from './tracker.js';
import { bearerFor, forgetMicrosoftTokens, microsoftToken, refusedFor } from './token.js';

/**
 * Azure DevOps on the Connections page (ADR-011): "Sign in with Microsoft" through Microsoft's own tool, az, kept in
 * squad-kit's own folder, with a pasted token as the other way. A token saved for the project wins. An organization of
 * personal Microsoft accounts says plainly that it needs a token. What az or Azure DevOps answers is kept a minute; not
 * reaching them (offline, a proxy, an outage) is never taken as a sign-in problem, and Disconnect stays possible while a
 * sign-in is left in squad-kit's folder, with az or without. For a project whose stories come from Azure Boards, the row
 * says Connected only once squad-kit reaches the project itself: right after the sign-in it lists the projects the
 * account reaches to pick from, takes a pasted address, and takes a token on the same row (connect-place.ts).
 */

const KEEP_MS = 60_000;
let kept: { at: number; root: string; status: ConnectionStatus } | null = null;
/** Moves on with every change (a sign-in, a pick, a token): an answer asked for before it is never kept. */
let generation = 0;

/** Forget the row and what the sign-in reaches: the next status asks afresh. */
function reset(): void {
  kept = null;
  generation++;
  forgetReach();
}

/** The install command Microsoft gives for this computer: Homebrew on a Mac, winget on Windows; Linux has its page. */
function installCommand(): string | undefined {
  if (process.platform === 'darwin') return 'brew install azure-cli';
  if (process.platform === 'win32') return 'winget install --exact --id Microsoft.AzureCLI';
  return undefined;
}

function signInSteps(found: string | null, who?: string): GuideStep[] {
  const command = installCommand();
  return [
    {
      text: { en: "Install Microsoft's Azure tool", ar: 'ثبّت أداة Azure من Microsoft' },
      ...(command ? { command } : {}),
      page: '/tools#az',
      ...(found ? { done: { en: `Found az ${found}`, ar: `لقينا az ${found}` } } : {}),
    },
    {
      text: { en: 'Sign in with Microsoft from a terminal', ar: 'سجّل الدخول بـ Microsoft من الطرفية' },
      command: 'squad connect azure',
      ...(who ? { done: { en: `Signed in as ${who}`, ar: `مسجّل باسم ${who}` } } : {}),
    },
  ];
}

const LINES = {
  tokenFailed: { en: 'The saved token did not work: it may have ended. Make a new one with the steps below and paste it here.', ar: 'الرمز المحفوظ ما اشتغل، يمكن انتهى. سوّ رمز جديد بالخطوات تحت والصقه هنا.' },
  personal: (org: string): Words => ({
    en: `This organization, ${org}, uses personal Microsoft accounts, so it needs a token. Make one with the steps below and paste it here.`,
    ar: `هذي المنظمة، ${org}، تستخدم حسابات Microsoft شخصية، فتحتاج رمز. سوّه بالخطوات تحت والصقه هنا.`,
  }),
  pick: (who?: string): Words => ({
    en: `${who ? `Signed in as ${who}. ` : ''}Pick the project your stories come from.`,
    ar: `${who ? `مسجّل باسم ${who}. ` : ''}اختر المشروع اللي تجي منه قصصك.`,
  }),
  noneReached: (who?: string): Words => ({
    en: `${who ? `Signed in as ${who}, but this account` : 'This Microsoft account'} reaches no Azure DevOps project. Paste your board's address, or sign in with the account your team uses.`,
    ar: `${who ? `مسجّل باسم ${who}، بس هذا الحساب` : 'حساب Microsoft هذا'} ما يوصل لأي مشروع في Azure DevOps. الصق عنوان لوحتك، أو سجّل بالحساب اللي يستخدمه فريقك.`,
  }),
  noProjectToken: (org: string, project: string): Words => ({
    en: `squad-kit could not find the project ${project} in ${org} with the saved token. Fix the address in the token form below, with your token.`,
    ar: `squad-kit ما لقى المشروع ${project} في ${org} بالرمز المحفوظ. صحّح العنوان في نموذج الرمز تحت، مع رمزك.`,
  }),
  noProject: (org: string, project: string): Words => ({
    en: `squad-kit could not find the project ${project} in ${org}. Pick the right one, or paste its address.`,
    ar: `squad-kit ما لقى المشروع ${project} في ${org}. اختر الصحيح، أو الصق عنوانه.`,
  }),
  error: {
    en: 'Azure DevOps answered with an error just now. Press Check again in a moment; an engineer can see why in the log.',
    ar: 'Azure DevOps رد بخطأ الحين. اضغط افحص مرة ثانية بعد شوي؛ والمهندس يقدر يشوف السبب في السجل.',
  },
  offline: {
    en: 'Azure DevOps or Microsoft could not be reached just now. Check the network; squad-kit asks again in a minute.',
    ar: 'ما قدرنا نوصل لـ Azure DevOps أو Microsoft الحين. تأكد من الشبكة؛ squad-kit يسأل مرة ثانية بعد دقيقة.',
  },
  notFound: (org: string): Words => ({
    en: `squad-kit could not find the organization ${org} on Azure DevOps. Paste your board's address again.`,
    ar: `squad-kit ما لقى المنظمة ${org} في Azure DevOps. الصق عنوان لوحتك مرة ثانية.`,
  }),
  noAccess: (who: string | undefined, org: string): Words => ({
    en: `${who ? `Signed in as ${who}, which` : 'The Microsoft account signed in'} has no access to ${org}. Sign in with the Microsoft account that owns ${org}.`,
    ar: `${who ? `مسجّل باسم ${who}، وهذا الحساب` : 'حساب Microsoft المسجّل'} ما يوصل لـ ${org}. سجّل الدخول بحساب Microsoft اللي يملك ${org}.`,
  }),
  ended: { en: 'The Microsoft sign-in has ended. Sign in with Microsoft again.', ar: 'انتهى تسجيل الدخول بـ Microsoft. سجّل الدخول مرة ثانية.' },
};

/**
 * The organization and project this project works with, and its saved token; else its own Azure remote's. `asks`: its
 * stories come (or may come) from Azure Boards, so the row asks for the place until squad-kit reaches it; a project on
 * another tracker, or with none and its code on Azure Repos, keeps the row about the sign-in alone.
 */
function placeOf(root: string): { organization?: string; project?: string; pat?: string; asks: boolean } {
  const p = azurePlace(root);
  if (p?.organization) return { ...p, asks: true };
  // Through the engine's one git runner (git-safety); a folder with no repo answers nothing.
  const where = parseAzureRemote(git(root, ['config', '--get', 'remote.origin.url'], { allowFail: true }).trim());
  if (where) return { organization: where.organization, project: where.project, ...(p?.pat ? { pat: p.pat } : {}), asks: Boolean(p) };
  return { ...(p?.pat ? { pat: p.pat } : {}), asks: storiesFromAzure(root) };
}

/** Only a sign-in Azure DevOps or Microsoft refused is a sign-in problem. */
const refused = (err: unknown) => err instanceof ModuleError && err.kind === 'sign-in';

/**
 * Any other trouble, said as what it is: not reaching them (offline, too many calls, their own outage) waits and is asked
 * again; no such organization says so; anything else is an error an engineer can read in the log.
 */
function trouble(err: unknown, org: string): Pick<ConnectionStatus, 'state' | 'line'> {
  const e = err instanceof ModuleError ? err : null;
  if (e?.kind === 'not-found' || e?.status === 404) return { state: 'not-connected', line: LINES.notFound(org) };
  if (e?.kind === 'offline' || e?.kind === 'too-many' || (e?.status ?? 0) >= 500) return { state: 'unknown', line: LINES.offline };
  return { state: 'unknown', line: LINES.error };
}

/** The list to pick from (only the organization's projects when it is known), and the words over it. */
async function pickFrom(token: string, who: string | undefined, org?: string): Promise<Pick<ConnectionStatus, 'state' | 'line' | 'pick'>> {
  let list: AzureProjectRef[];
  try {
    list = await reachable(token);
  } catch (err) {
    if (err instanceof ModuleError && (err.kind === 'offline' || err.kind === 'too-many')) return { state: 'unknown', line: LINES.offline };
    list = [];
  }
  const mine = org ? list.filter((p) => p.organization.toLowerCase() === org.toLowerCase()) : list;
  if (!mine.length) return { state: 'not-connected', line: LINES.noneReached(who) };
  return { state: 'not-connected', line: LINES.pick(who), pick: mine.map((p) => ({ site: `${p.organization}/${p.project}`, name: p.project, where: p.organization })) };
}

async function look(root: string): Promise<ConnectionStatus> {
  const { organization: org, project, pat, asks } = placeOf(root);
  const accounts = azAccounts();
  const who = accounts[0]?.user;
  const here = asks && org && project ? placeWords({ organization: org, project }) : undefined;
  // A sign-in left in squad-kit's folder can always be ended, whatever else is true here: with a token, with az gone.
  const left: Pick<ConnectionStatus, 'signedIn'> = signInLeft() ? { signedIn: who ? { as: who } : {} } : {};
  // The place's address, pasted, and a token on the row: only for a project whose stories come from Azure Boards.
  const address = (now?: string): Pick<ConnectionStatus, 'address'> => (asks ? { address: addressAsk(now) } : {});
  const token = (open = false): Pick<ConnectionStatus, 'token'> =>
    asks ? { token: tokenAsk({ ...(org ? { org } : {}), ...(org && project ? { address: `dev.azure.com/${org}/${project}` } : {}), open }) } : {};
  // A saved token wins: it is the person's own choice for this project.
  if (pat && org) {
    const steps = tokenSteps(org);
    try {
      const account = await new Azure({ organization: org, project: project ?? '', pat }).whoAmI();
      if (asks && project && !(await projectThere({ pat }, { organization: org, project }))) {
        return { state: 'not-connected', by: 'token', ...left, line: LINES.noProjectToken(org, project), ...address(), ...token(true), steps };
      }
      return { state: 'connected', account, by: 'token', ...left, ...address(here), ...token(), steps };
    } catch (err) {
      if (refused(err)) return { state: 'not-connected', by: 'token', ...left, line: LINES.tokenFailed, ...address(), ...token(true), steps };
      return { ...trouble(err, org), by: 'token', ...left, ...address(), ...token(), steps };
    }
  }
  const tenant = org ? await orgTenant(org) : null;
  // An organization of personal accounts needs a token, whatever is on this computer: its steps, never installing az.
  // The board shows no second address box beside the token form then; the terminal still takes --site.
  if (org && tenant?.kind === 'personal') return { state: 'not-connected', by: 'token', ...left, line: LINES.personal(org), ...address(), ...token(true), steps: tokenSteps(org) };
  const found = await azVersion();
  if (!found) return { state: 'missing', ...left, ...token(), steps: signInSteps(null) };
  if (org && tenant?.kind === 'not-found') return { state: 'not-connected', ...left, line: LINES.notFound(org), ...address(), ...token(), steps: signInSteps(found) };
  const t = await microsoftToken(tenant?.kind === 'entra' ? tenant.tenant : undefined);
  if (!t.ok) {
    if (t.why === 'missing') return { state: 'missing', ...left, ...token(), steps: signInSteps(null) };
    if (t.why === 'no-answer') return { state: 'unknown', ...left, line: LINES.offline, steps: signInSteps(found, who) };
    if (t.why === 'signed-out') return { state: 'not-connected', ...left, ...token(), steps: signInSteps(found) };
    // Signed in, but Microsoft gives no token for this directory: the account is not in it, or the sign-in ended.
    const outside = org && tenant?.kind === 'entra' && !accounts.some((a) => a.tenant.toLowerCase() === tenant.tenant);
    return { state: 'not-connected', ...left, line: outside ? LINES.noAccess(who, org) : LINES.ended, ...address(), ...token(), steps: signInSteps(found) };
  }
  // Signed in, and the place is not known yet: never Connected. The projects the account reaches, to pick from.
  if (!org || !project) {
    if (!asks) return { state: 'connected', account: who ?? 'Microsoft', ...left, steps: signInSteps(found, who) };
    return { ...(await pickFrom(t.token, who, org)), ...left, ...address(), ...token(), steps: signInSteps(found, who) };
  }
  const auth = { bearer: () => bearerFor(org), refused: (tk: string) => refusedFor(org, tk) };
  try {
    const name = await new Azure({ organization: org, project, ...auth }).whoAmI();
    if (asks && !(await projectThere(auth, { organization: org, project }))) {
      const list = await pickFrom(t.token, who, org);
      return { state: 'not-connected', ...left, line: LINES.noProject(org, project), ...(list.pick ? { pick: list.pick } : {}), ...address(), ...token(), steps: signInSteps(found, who) };
    }
    return { state: 'connected', account: name, ...left, ...address(here), steps: signInSteps(found, who) };
  } catch (err) {
    if (refused(err)) return { state: 'not-connected', ...left, line: LINES.noAccess(who, org), ...address(), ...token(), steps: signInSteps(found) };
    return { ...trouble(err, org), ...left, ...address(), ...token(), steps: signInSteps(found, who) };
  }
}

async function status(root: string): Promise<ConnectionStatus> {
  if (kept && kept.root === root && Date.now() - kept.at < KEEP_MS) return kept.status;
  const asked = generation;
  let s = await look(root).catch((): ConnectionStatus => ({ state: 'unknown', steps: signInSteps(null) }));
  // Something changed on the way (a pick, a token, a sign-in): this answer is old. Ask again.
  if (asked !== generation) return status(root);
  // No answer just now: the last answer stays, never a sign-out.
  if (s.state === 'unknown' && kept?.root === root) s = kept.status;
  kept = { at: Date.now(), root, status: s };
  return s;
}

/** Check again: az, the organization's directory and the token are all asked afresh. */
function forget(): void {
  reset();
  forgetAzVersion();
  forgetTenants();
  forgetMicrosoftTokens();
}

export const azureConnection: ConnectionModule = {
  name: 'azure',
  label: 'Azure DevOps',
  what: { en: 'Boards and Repos', ar: 'Boards وRepos' },
  how: 'sign-in',
  tracker: azureTracker.name,
  codePage: {
    name: 'Microsoft',
    then: { en: 'pick your work account and press Continue', ar: 'اختر حساب العمل واضغط Continue' },
    foot: {
      en: "This sign-in is squad-kit's own, kept apart from any other Azure sign-in on this computer. squad-kit uses it for Azure DevOps only, and you can take it back at any time.",
      ar: 'هذا التسجيل خاص بـ squad-kit، منفصل عن أي تسجيل Azure ثاني على هذا الجهاز. squad-kit يستخدمه لـ Azure DevOps بس، وتقدر تسحبه في أي وقت.',
    },
  },
  ownSignIn: true,
  privateFolder: AZ_FOLDER,
  can: [
    { en: 'Pull stories, move them along and file bugs', ar: 'يسحب القصص ويحرّكها ويسجّل الأخطاء' },
    { en: 'Open a pull request for each finished story', ar: 'يفتح طلب دمج لكل قصة تخلص' },
  ],
  repoName(remoteUrl) {
    const where = parseAzureRemote(remoteUrl);
    return where ? `${where.project}/${where.repo}` : null;
  },
  status,
  forget,
  signIn: {
    // A new sign-in may be another account: what it reaches is asked afresh too.
    start: (root) => startMicrosoftSignIn(placeOf(root).organization, reset),
    now: microsoftSignInNow,
    cancel: cancelMicrosoftSignIn,
  },
  signOut: () => signOutOfMicrosoft(),
  async pickSite(root, site) {
    const r = await pickAzurePlace(root, site);
    reset();
    return r;
  },
  async saveToken(root, input) {
    const r = await saveAzureToken(root, input);
    reset();
    return r;
  },
};
