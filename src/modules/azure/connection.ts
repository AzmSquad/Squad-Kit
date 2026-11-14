import type { ConnectionModule, ConnectionStatus, GuideStep, Words } from '../connection/types.js';
import { git } from '../../engine/git.js';
import { ModuleError } from '../errors.js';
import { Azure, parseAzureRemote } from './client.js';
import { AZ_FOLDER, azAccounts, azVersion, forgetAzVersion, signInLeft } from './az.js';
import { cancelMicrosoftSignIn, microsoftSignInNow, signOutOfMicrosoft, startMicrosoftSignIn } from './device-sign-in.js';
import { azurePlace } from './sign-in.js';
import { forgetTenants, orgTenant } from './tenant.js';
import { azureTracker } from './tracker.js';
import { bearerFor, forgetMicrosoftTokens, microsoftToken, personalOrg, refusedFor } from './token.js';

/**
 * Azure DevOps on the Connections page (ADR-011): "Sign in with Microsoft" through Microsoft's own tool, az, kept in
 * squad-kit's own folder, with a pasted token as the other way. A token saved for the project wins. An organization of
 * personal Microsoft accounts says plainly that it needs a token. What az or Azure DevOps answers is kept a minute; not
 * reaching them (offline, a proxy, an outage) is never taken as a sign-in problem, and Disconnect stays possible while a
 * sign-in is left in squad-kit's folder, with az or without.
 */

const KEEP_MS = 60_000;
let kept: { at: number; root: string; status: ConnectionStatus } | null = null;

const TOKEN_STEPS: GuideStep[] = [
  { text: { en: 'On Azure DevOps, open User settings, then Personal access tokens.', ar: 'في Azure DevOps افتح User settings ثم Personal access tokens.' } },
  { text: { en: 'Make a new token with Work Items and Code: read, write and manage.', ar: 'سوّ رمز جديد فيه Work Items وCode: قراءة وكتابة وإدارة.' } },
  { text: { en: 'Paste it with your organization and project, then press Save and check.', ar: 'الصقه مع اسم المنظمة والمشروع، واضغط احفظ وافحص.' }, command: 'squad config set tracker' },
];

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
  tokenFailed: { en: 'The token saved in Settings did not work. Paste a new one there.', ar: 'الرمز المحفوظ في الإعدادات ما اشتغل. الصق رمز جديد هناك.' },
  personal: (org: string): Words => ({
    en: personalOrg(org),
    ar: `هذي المنظمة، ${org}، تستخدم حسابات Microsoft شخصية، فتحتاج رمز. الصقه في الإعدادات.`,
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
    en: `squad-kit could not find the organization ${org} on Azure DevOps. Check its name in Settings.`,
    ar: `squad-kit ما لقى المنظمة ${org} في Azure DevOps. تأكد من اسمها في الإعدادات.`,
  }),
  noAccess: (who: string | undefined, org: string): Words => ({
    en: `${who ? `Signed in as ${who}, which` : 'The Microsoft account signed in'} has no access to ${org}. Sign in with the Microsoft account that owns ${org}.`,
    ar: `${who ? `مسجّل باسم ${who}، وهذا الحساب` : 'حساب Microsoft المسجّل'} ما يوصل لـ ${org}. سجّل الدخول بحساب Microsoft اللي يملك ${org}.`,
  }),
  ended: { en: 'The Microsoft sign-in has ended. Sign in with Microsoft again.', ar: 'انتهى تسجيل الدخول بـ Microsoft. سجّل الدخول مرة ثانية.' },
};

/** The organization and project this project works with, and its saved token; else its own Azure remote's. */
function placeOf(root: string): { organization?: string; project?: string; pat?: string } {
  const p = azurePlace(root);
  if (p?.organization) return p;
  // Through the engine's one git runner (git-safety); a folder with no repo answers nothing.
  const where = parseAzureRemote(git(root, ['config', '--get', 'remote.origin.url'], { allowFail: true }).trim());
  return where ? { organization: where.organization, project: where.project } : {};
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

async function look(root: string): Promise<ConnectionStatus> {
  const { organization: org, project, pat } = placeOf(root);
  const accounts = azAccounts();
  const who = accounts[0]?.user;
  // A sign-in left in squad-kit's folder can always be ended, whatever else is true here: with a token, with az gone.
  const left: Pick<ConnectionStatus, 'signedIn'> = signInLeft() ? { signedIn: who ? { as: who } : {} } : {};
  // A saved token wins: it is the person's own choice for this project.
  if (pat && org) {
    try {
      const account = await new Azure({ organization: org, project: project ?? '', pat }).whoAmI();
      return { state: 'connected', account, by: 'token', ...left, steps: TOKEN_STEPS };
    } catch (err) {
      if (refused(err)) return { state: 'not-connected', by: 'token', ...left, line: LINES.tokenFailed, steps: TOKEN_STEPS };
      return { ...trouble(err, org), by: 'token', ...left, steps: TOKEN_STEPS };
    }
  }
  const tenant = org ? await orgTenant(org) : null;
  // An organization of personal accounts needs a token, whatever is on this computer: its steps, never installing az.
  if (org && tenant?.kind === 'personal') return { state: 'not-connected', by: 'token', ...left, line: LINES.personal(org), steps: TOKEN_STEPS };
  const found = await azVersion();
  if (!found) return { state: 'missing', ...left, steps: signInSteps(null) };
  if (org && tenant?.kind === 'not-found') return { state: 'not-connected', ...left, line: LINES.notFound(org), steps: signInSteps(found) };
  const t = await microsoftToken(tenant?.kind === 'entra' ? tenant.tenant : undefined);
  if (!t.ok) {
    if (t.why === 'missing') return { state: 'missing', ...left, steps: signInSteps(null) };
    if (t.why === 'no-answer') return { state: 'unknown', ...left, line: LINES.offline, steps: signInSteps(found, who) };
    if (t.why === 'signed-out') return { state: 'not-connected', ...left, steps: signInSteps(found) };
    // Signed in, but Microsoft gives no token for this directory: the account is not in it, or the sign-in ended.
    const outside = org && tenant?.kind === 'entra' && !accounts.some((a) => a.tenant.toLowerCase() === tenant.tenant);
    return { state: 'not-connected', ...left, line: outside ? LINES.noAccess(who, org) : LINES.ended, steps: signInSteps(found) };
  }
  if (!org) return { state: 'connected', account: who ?? 'Microsoft', ...left, steps: signInSteps(found, who) };
  try {
    const name = await new Azure({ organization: org, project: project ?? '', bearer: () => bearerFor(org), refused: (token) => refusedFor(org, token) }).whoAmI();
    return { state: 'connected', account: name, ...left, steps: signInSteps(found, who) };
  } catch (err) {
    if (refused(err)) return { state: 'not-connected', ...left, line: LINES.noAccess(who, org), steps: signInSteps(found) };
    return { ...trouble(err, org), ...left, steps: signInSteps(found, who) };
  }
}

async function status(root: string): Promise<ConnectionStatus> {
  if (kept && kept.root === root && Date.now() - kept.at < KEEP_MS) return kept.status;
  let s = await look(root).catch((): ConnectionStatus => ({ state: 'unknown', steps: signInSteps(null) }));
  // No answer just now: the last answer stays, never a sign-out.
  if (s.state === 'unknown' && kept?.root === root) s = kept.status;
  kept = { at: Date.now(), root, status: s };
  return s;
}

/** Check again: az, the organization's directory and the token are all asked afresh. */
function forget(): void {
  kept = null;
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
    start: (root) => startMicrosoftSignIn(placeOf(root).organization, () => (kept = null)),
    now: microsoftSignInNow,
    cancel: cancelMicrosoftSignIn,
  },
  signOut: () => signOutOfMicrosoft(),
};
