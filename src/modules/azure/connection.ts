import type { ConnectionModule, ConnectionStatus } from '../connection/types.js';
import { azureTracker } from './tracker.js';

/**
 * Azure DevOps on the Connections page: today a token the person makes on Azure DevOps and pastes, saved on this computer
 * only (the tracker's own settings). Signing in with Microsoft comes next and is only shown as coming.
 */

const KEEP_MS = 60_000;
let kept: { at: number; root: string; status: ConnectionStatus } | null = null;

const STEPS: ConnectionStatus['steps'] = [
  { text: { en: 'On Azure DevOps, open User settings, then Personal access tokens.', ar: 'في Azure DevOps افتح User settings ثم Personal access tokens.' } },
  { text: { en: 'Make a new token with Work Items and Code: read, write and manage.', ar: 'سوّ رمز جديد فيه Work Items وCode: قراءة وكتابة وإدارة.' } },
  { text: { en: 'Paste it with your organization and project, then press Save and check.', ar: 'الصقه مع اسم المنظمة والمشروع، واضغط احفظ وافحص.' }, command: 'squad config set tracker' },
];

async function status(root: string): Promise<ConnectionStatus> {
  if (kept && kept.root === root && Date.now() - kept.at < KEEP_MS) return kept.status;
  const tracker = azureTracker.open(root);
  let s: ConnectionStatus = { state: 'not-connected', steps: STEPS };
  if (tracker) {
    const account = await tracker.whoAmI().catch(() => null);
    if (account) s = { state: 'connected', account, steps: STEPS };
  }
  kept = { at: Date.now(), root, status: s };
  return s;
}

export const azureConnection: ConnectionModule = {
  name: 'azure',
  label: 'Azure DevOps',
  what: { en: 'Boards and Repos', ar: 'Boards وRepos' },
  how: 'token',
  tracker: azureTracker.name,
  next: { en: 'Sign in with Microsoft', ar: 'سجّل الدخول بـ Microsoft' },
  can: [
    { en: 'Pull stories, move them along and file bugs', ar: 'يسحب القصص ويحرّكها ويسجّل الأخطاء' },
    { en: 'Open a pull request for each finished story', ar: 'يفتح طلب دمج لكل قصة تخلص' },
  ],
  status,
  forget: () => (kept = null),
};
