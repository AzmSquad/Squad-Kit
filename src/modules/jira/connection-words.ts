import type { GuideStep, Words } from '../connection/types.js';
import { hostOf, type AtlassianSite } from './atlassian-store.js';
import { notGranted } from './atlassian-sign-in.js';
import type { EndedWhy } from './atlassian-store.js';
import { endedReason } from './atlassian-token.js';
import { missingScopeWords } from './client.js';

/** Jira's words on the Connections page, in English and Arabic: the token's steps, the sign-in's, and each case's line. */

export const TOKEN_STEPS: GuideStep[] = [
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

export function signInSteps(who?: string): GuideStep[] {
  return [
    {
      text: { en: 'Sign in with Atlassian from a terminal', ar: 'سجّل الدخول بـ Atlassian من الطرفية' },
      command: 'squad connect jira',
      ...(who ? { done: { en: `Signed in as ${who}`, ar: `مسجّل باسم ${who}` } } : {}),
    },
    {
      text: {
        en: "Open the link it shows, pick your Jira site on Atlassian's page and press Accept",
        ar: 'افتح الرابط اللي يطلع، اختر موقع Jira في صفحة Atlassian واضغط Accept',
      },
    },
  ];
}

export const SIGN_IN_FOOT: Words = {
  en: "squad-kit gets to read and update the site's Jira issues, boards and sprints as you. It keeps this sign-in in its own folder on this computer, and you can take it back at any time under Connected apps on your Atlassian account.",
  ar: 'squad-kit ياخذ إذن يقرأ ويحدّث مهام Jira ولوحاته وسبرنتاته في الموقع باسمك. يحفظ هذا التسجيل في مجلده الخاص على هذا الجهاز، وتقدر تسحبه في أي وقت من Connected apps في حساب Atlassian.',
};

export const LINES = {
  tokenFailed: { en: 'The API token saved in Settings did not work. Paste a new one there.', ar: 'رمز API المحفوظ في الإعدادات ما اشتغل. الصق رمز جديد هناك.' },
  /** Atlassian ended the sign-in: it refused the token, or squad-kit lost a renewal's answer. */
  ended: (why: EndedWhy | null): Words =>
    why === 'lost'
      ? {
          en: `${endedReason('lost')} Sign in with Atlassian again.`,
          ar: 'squad-kit فقد رد Atlassian وهو يجدد تسجيل دخولك، فـ Atlassian ما عاد يقبله. سجّل الدخول بـ Atlassian مرة ثانية.',
        }
      : {
          en: `${endedReason('refused')} Sign in with Atlassian again.`,
          ar: 'Atlassian أنهى تسجيل دخول squad-kit: ما انستخدم 90 يوم، أو انشال من Connected apps. سجّل الدخول بـ Atlassian مرة ثانية.',
        },
  missingScope: (scope: string): Words => ({
    en: missingScopeWords(scope),
    ar: `Jira رفض هذا الطلب: تطبيق squad-kit في Atlassian ناقصه إذن (${scope})، أو مدير الموقع شال وصول squad-kit. اسأل المدير، أو بلّغ فريق squad-kit.`,
  }),
  notGranted: (site: string, got: AtlassianSite[]): Words => ({
    en: notGranted(site, got),
    ar: `Atlassian ما أعطى squad-kit وصول لـ ${site}، موقع Jira لهذا المشروع${got.length ? ` (أعطاه ${got.map((s) => hostOf(s.url)).join('، ')})` : ''}. سجّل الدخول بـ Atlassian مرة ثانية واختر ${site} في صفحة Atlassian.`,
  }),
  noSite: {
    en: "Atlassian gave squad-kit no Jira site. Sign in again, and pick your Jira site on Atlassian's page.",
    ar: 'Atlassian ما أعطى squad-kit أي موقع Jira. سجّل الدخول مرة ثانية واختر موقع Jira في صفحة Atlassian.',
  },
  pick: (n: number): Words => ({ en: `Atlassian gave squad-kit ${n} Jira sites. Pick the one for this project.`, ar: `Atlassian أعطى squad-kit ${n} مواقع Jira. اختر موقع هذا المشروع.` }),
  refusedSignIn: (site: string): Words => ({
    en: `Jira on ${site} did not accept squad-kit's Atlassian sign-in. Sign in with Atlassian again.`,
    ar: `Jira في ${site} ما قبل تسجيل دخول squad-kit بـ Atlassian. سجّل الدخول مرة ثانية.`,
  }),
  offline: {
    en: 'Jira or Atlassian could not be reached just now. Check the network; squad-kit asks again in a minute.',
    ar: 'ما قدرنا نوصل لـ Jira أو Atlassian الحين. تأكد من الشبكة؛ squad-kit يسأل مرة ثانية بعد دقيقة.',
  },
  error: {
    en: 'Jira answered with an error just now. Press Check again in a moment; an engineer can see why in the log.',
    ar: 'Jira رد بخطأ الحين. اضغط افحص مرة ثانية بعد شوي؛ والمهندس يقدر يشوف السبب في السجل.',
  },
};
