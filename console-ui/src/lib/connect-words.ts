import type { ConnectionRow } from '../api/contribution-types';
import type { Lang } from './first-story';

/**
 * The Connections page's words, in the board's two languages. Each tool's own name, what it brings and its guide come
 * from the engine's modules (in both languages), so these words name no product.
 */

export const CONNECT = {
  en: {
    head: 'Connections',
    sub: 'The outside tools this project works with. Sign in once; squad-kit keeps no password.',
    state: { connected: 'Connected', 'not-connected': 'Not connected', missing: 'Not connected', unknown: 'No answer', soon: 'Coming next' },
    unknownLine: (label: string) => `${label}'s own tool did not answer just now. Press Check again in a moment.`,
    signedInAs: 'Signed in as',
    disconnect: 'Disconnect',
    guide: "Can't use the button? Do it step by step",
    check: 'Check again',
    toolPage: 'Get it on the Tools page',
    stepFoot: (tool: string, label: string) => `squad-kit asks ${tool}'s tool for the sign-in each time it calls ${label}, and stores nothing.`,
    ownFoot: (tool: string) => `squad-kit keeps its ${tool} sign-in in its own folder on this computer, apart from yours.`,
    soonLine: 'Coming in a next version.',
    tokenLine: (next?: string) => `Today: a token you paste.${next ? ` Next: ${next}.` : ''}`,
    nextTag: 'Next version',
    tokenInSettings: (label: string) => `${label} connects with a token you paste in Settings, where you choose this project's tracker.`,
    byToken: 'Connected with the token saved in Settings. It is used before any sign-in.',
    useToken: 'Use a token instead',
    tokenOther: 'Paste a token in Settings, where you choose this project\'s tracker.',
    openSettings: 'Open Settings',
    connectedNow: (label: string) => `${label} is connected`,
    forWhat: (r: NonNullable<ConnectionRow['for']>) =>
      r.self && r.into && r.into.toLowerCase() !== r.repo.toLowerCase()
        ? `For this fork: pull requests into ${r.into}, and the owner's comments back here.`
        : r.self
          ? `Pull requests into ${r.into ?? r.repo}, and the owner's comments back here.`
          : `For ${r.repo}: squad-kit opens its pull requests and merges them when you say Looks right.`,
    code: {
      head: (label: string) => `Sign in with ${label}`,
      sub: (label: string, then = 'press Authorize') => `Open ${label}, type this code there, then ${then}.`,
      copy: 'Copy code',
      copied: 'Code copied',
      open: (label: string) => `Open ${label}`,
      wait: (label: string) => `Waiting for you to approve on ${label}…`,
      cancel: 'Cancel',
      starting: (label: string) => `Asking ${label}'s tool for a code…`,
      foot: (label: string) => `squad-kit gets permission to push your branches and open pull requests. You can take it back on ${label} at any time.`,
      again: 'Try again',
      close: 'Close',
      lost: 'The sign-in stopped before it finished. Try again.',
    },
    off: {
      head: (label: string) => `Disconnect ${label}?`,
      body: (label: string, account: string) =>
        `This signs ${label}'s own tool out on this computer, as ${account}, for every app that uses it, not only squad-kit. You can sign in again at any time.`,
      own: (label: string, account?: string) =>
        `This signs squad-kit out of ${label} on this computer${account ? `, as ${account}` : ''}. Your other sign-ins on this computer stay as they are. You can sign in again at any time.`,
      yes: 'Disconnect',
      no: 'Keep it',
    },
  },
  ar: {
    head: 'الاتصالات',
    sub: 'الأدوات الخارجية اللي يشتغل معها المشروع. سجّل مرة وحدة، وsquad-kit ما يحفظ أي كلمة سر.',
    state: { connected: 'متصل', 'not-connected': 'غير متصل', missing: 'غير متصل', unknown: 'ما رد', soon: 'قريباً' },
    unknownLine: (label: string) => `أداة ${label} ما ردت الحين. اضغط افحص مرة ثانية بعد شوي.`,
    signedInAs: 'مسجّل باسم',
    disconnect: 'افصل',
    guide: 'الزر ما اشتغل؟ اتبع الخطوات',
    check: 'افحص مرة ثانية',
    toolPage: 'خذها من صفحة الأدوات',
    stepFoot: (tool: string, label: string) => `squad-kit يطلب التسجيل من أداة ${tool} كل مرة يكلّم ${label}، وما يحفظ شيء.`,
    ownFoot: (tool: string) => `squad-kit يحفظ تسجيل دخوله بـ ${tool} في مجلده الخاص على هذا الجهاز، منفصل عن تسجيلاتك.`,
    soonLine: 'في نسخة قادمة.',
    tokenLine: (next?: string) => `اليوم: رمز تلصقه.${next ? ` قريباً: ${next}.` : ''}`,
    nextTag: 'النسخة القادمة',
    tokenInSettings: (label: string) => `${label} يتصل برمز تلصقه في الإعدادات، مكان ما تختار متتبّع المشروع.`,
    byToken: 'متصل بالرمز المحفوظ في الإعدادات، وهو المستخدم قبل أي تسجيل دخول.',
    useToken: 'استخدم رمز بدال التسجيل',
    tokenOther: 'الصق رمز في الإعدادات، مكان ما تختار متتبّع المشروع.',
    openSettings: 'افتح الإعدادات',
    connectedNow: (label: string) => `${label} متصل`,
    forWhat: (r: NonNullable<ConnectionRow['for']>) =>
      r.self && r.into && r.into.toLowerCase() !== r.repo.toLowerCase()
        ? `لهذه النسخة: طلبات دمج إلى ${r.into}، وتعليقات المالك ترجع هنا.`
        : r.self
          ? `طلبات دمج إلى ${r.into ?? r.repo}، وتعليقات المالك ترجع هنا.`
          : `لـ ${r.repo}: squad-kit يفتح طلبات الدمج ويدمجها لما تقول تمام.`,
    code: {
      head: (label: string) => `سجّل الدخول بـ ${label}`,
      sub: (label: string, then = 'اضغط Authorize') => `افتح ${label}، اكتب هذا الرمز هناك، وبعدين ${then}.`,
      copy: 'انسخ الرمز',
      copied: 'انتسخ الرمز',
      open: (label: string) => `افتح ${label}`,
      wait: (label: string) => `بانتظار موافقتك على ${label}…`,
      cancel: 'إلغاء',
      starting: (label: string) => `نطلب رمز من أداة ${label}…`,
      foot: (label: string) => `squad-kit ياخذ إذن يرفع فروعك ويفتح طلبات الدمج. تقدر تسحب الإذن من ${label} في أي وقت.`,
      again: 'جرّب مرة ثانية',
      close: 'إغلاق',
      lost: 'التسجيل وقف قبل ما يخلص. جرّب مرة ثانية.',
    },
    off: {
      head: (label: string) => `تفصل ${label}؟`,
      body: (label: string, account: string) => `هذا يسجّل خروج أداة ${label} الرسمية على هذا الجهاز، باسم ${account}، لكل تطبيق يستخدمها، مو بس squad-kit. تقدر تسجّل الدخول مرة ثانية في أي وقت.`,
      own: (label: string, account?: string) =>
        `هذا يسجّل خروج squad-kit من ${label} على هذا الجهاز${account ? `، باسم ${account}` : ''}. باقي تسجيلاتك على هذا الجهاز تبقى مثل ما هي. تقدر تسجّل الدخول مرة ثانية في أي وقت.`,
      yes: 'افصل',
      no: 'خلّه',
    },
  },
} satisfies Record<Lang, unknown>;
