import type { ConnectionModule, ConnectionStatus } from '../connection/types.js';
import { jiraTracker } from './module.js';
import { movedWords, readSaved } from './settings.js';

/**
 * Jira on the Connections page: today an API token the person makes on their Atlassian account and pastes in Settings
 * with the site and their email, saved on this computer only. Signing in with Atlassian comes next and is only shown
 * as coming.
 */

const KEEP_MS = 60_000;
let kept: { at: number; root: string; status: ConnectionStatus } | null = null;

const STEPS: ConnectionStatus['steps'] = [
  {
    text: { en: 'Open your Atlassian account’s API tokens page and sign in.', ar: 'افتح صفحة رموز API في حسابك على Atlassian وسجّل الدخول.' },
    link: 'https://id.atlassian.com/manage-profile/security/api-tokens',
  },
  {
    text: {
      en: 'Press Create API token (the plain one, not “with scopes”). Give it a name, like squad-kit, and the longest expiry.',
      ar: 'اضغط Create API token العادي، مو اللي فيه scopes. سمّه مثلاً squad-kit واختر أطول مدة.',
    },
  },
  { text: { en: 'Copy the token. Atlassian shows it only once.', ar: 'انسخ الرمز. Atlassian يعرضه مرة وحدة بس.' } },
  {
    text: { en: 'Paste it with your Jira site and email on the Settings page, then press Save and check.', ar: 'الصقه مع موقع Jira وإيميلك في صفحة الإعدادات، واضغط احفظ وافحص.' },
    command: 'squad config set tracker',
  },
];

async function status(root: string): Promise<ConnectionStatus> {
  if (kept && kept.root === root && Date.now() - kept.at < KEEP_MS) return kept.status;
  const tracker = jiraTracker.open(root);
  const moved = readSaved(root)?.moved;
  let s: ConnectionStatus = { state: 'not-connected', steps: moved ? [{ text: movedWords(moved) }, ...STEPS] : STEPS };
  if (tracker) {
    const account = await tracker.whoAmI().catch(() => null);
    if (account) s = { state: 'connected', account, steps: STEPS };
  }
  kept = { at: Date.now(), root, status: s };
  return s;
}

export const jiraConnection: ConnectionModule = {
  name: 'jira',
  label: 'Jira',
  what: { en: 'Issues, sprints and boards', ar: 'المهام والسبرنتات واللوحات' },
  how: 'token',
  tracker: jiraTracker.name,
  next: { en: 'Sign in with Atlassian', ar: 'سجّل الدخول بـ Atlassian' },
  can: [
    { en: 'Pull stories, move them along and file bugs', ar: 'يسحب القصص ويحرّكها ويسجّل الأخطاء' },
    { en: 'Write questions, plans and pull request links on each story', ar: 'يكتب الأسئلة والخطط وروابط طلبات الدمج على كل قصة' },
    { en: 'Send a breakdown as epics and stories', ar: 'يرسل التقسيم كـ epics وstories' },
  ],
  status,
  forget: () => (kept = null),
};
