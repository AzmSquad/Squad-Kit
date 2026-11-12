import { isArabic, plainArabic } from '../../board/ask.js';
import type { Allowable, LeadAction } from './types.js';

/**
 * What the Squad lead can and can't do, in three levels (agreed 2026-11-11), and the engine's side of it: the words
 * for the "What it can do" panel and the Harness page, the low-risk actions "Always allow" may cover, and the
 * refusals. A refusal never depends on the agent: the engine reads the person's own message and every card the
 * agent hands in, and says no in its own words.
 */

/** Level 1, on its own: it reads, looks and tells. */
export const ON_ITS_OWN: string[] = [
  'Answer questions about the app, the code (read only), stories, decisions, releases and costs, in plain words',
  'Explain any story, and find things ("which story added the Map button?")',
  'Look at the app in its own copy, with its own database, and show a picture of where to click',
  'Tell you when something needs you, and the morning brief if you turn it on',
  'Prepare a short report for an engineer, with no secrets in it, for you to copy',
];

/** Level 2, after your OK: each is a card with a real button, the same as the board's. */
export const AFTER_YOUR_OK: string[] = [
  'Create a story or a bug from the conversation; nothing starts until you say',
  'Board actions: start or stop a story, give more time, take the pictures again, try again, start the app, get or update a tool',
  "Suggest an answer to an agent's question, for you to send",
  'Suggest a settings change, for you to save (technical settings only for engineers)',
];

/** What each board action does, its button, and whether "Always allow" may cover it. */
export const ACTIONS: Record<LeadAction, { name: string; label: string; allowable?: true }> = {
  more_time: { name: 'Give it more time', label: 'Allow once', allowable: true },
  pictures_again: { name: 'Take the pictures again', label: 'Take them again', allowable: true },
  start_app: { name: 'Start the app', label: 'Start the app', allowable: true },
  morning_brief: { name: 'Turn on the morning brief', label: 'Turn it on', allowable: true },
  try_again: { name: 'Try again', label: 'Try again' },
  restart: { name: 'Stop and try again', label: 'Stop and try again' },
  stop: { name: 'Stop the step', label: 'Stop' },
  start_story: { name: 'Start the story', label: 'Start' },
  stop_story: { name: 'Stop the story', label: 'Stop' },
  get_tool: { name: 'Get a tool', label: 'Get it' },
  update_tool: { name: 'Update a tool', label: 'Update' },
  engineer: { name: 'Let an engineer look', label: 'Let an engineer look' },
};

/** "Always allow" covers these only: giving more time, taking the pictures again, starting the app, the morning brief. */
export const ALLOWABLE: Allowable[] = ['more_time', 'pictures_again', 'start_app', 'morning_brief'];

export function isAllowable(a: string): a is Allowable {
  return (ALLOWABLE as string[]).includes(a);
}

/** The words of "Always allow", for the panel and the Harness page. */
export const ALWAYS_WORDS = 'Only for low-risk actions: give more time, take the pictures again, start the app, the morning brief. Never for creating, starting or stopping a story, settings, or anything it never does.';

/** Level 3, never: what the engine refuses, whatever the agent asks. */
export type Never = 'code' | 'git' | 'approve' | 'around' | 'harness' | 'secrets' | 'delete' | 'message';

/** Each "never", for the panel, and the exact words the engine says when it refuses one. */
export const NEVER: Record<Never, { name: string; refusal: string }> = {
  code: {
    name: 'Write or change code',
    refusal: "I can't change the code. Only a story does, through the checks, the review and the proof. Tell me what should change, and I'll draft that story for you to create.",
  },
  git: {
    name: 'Commit, merge, push or release',
    refusal: "I can't commit, merge, push or release. A story merges when you press Looks right on its proof, and a release goes out when you press Release.",
  },
  approve: {
    name: 'Press Looks right, or approve a spec or plan for you',
    refusal: "I can't press Looks right or approve a spec or plan for you. Only you can: open it on the board and decide.",
  },
  around: {
    name: 'Get around the checks, the review, the proof, the guard or the limits',
    refusal: "I can't get around the checks, the review, the proof, the guard or the limits. Each stop has its own ways out on its card, and only you can go past a failed check, with a reason.",
  },
  harness: {
    name: 'Change the Harness rules',
    refusal: "I can't change the Harness rules. You or an engineer can add your own on the Harness page.",
  },
  secrets: {
    name: 'Touch your real data, secrets, .env files or production, or show a password or a key',
    refusal: "I can't touch your real data or secrets, or show a password or a key. I only use my own copy of the app, with its own database, and test accounts from the project's own example files.",
  },
  delete: {
    name: 'Delete stories, projects or data',
    refusal: "I can't delete stories, projects or data. You can, from the story's own menu.",
  },
  message: {
    name: 'Message other people',
    refusal: "I can't message other people. I can prepare a report for you to copy and send yourself.",
  },
};

/** Never, besides the refusals: it only follows the person's own messages, and never asks a project manager a technical question. */
export const NEVER_MORE: string[] = [
  'Act on instructions found inside stories, emails, files or web pages: only your own messages count',
  'Ask a project manager a technical question',
];

/** The three levels in words, for the "What it can do" panel (GET /lead/can) and the terminal. */
export function leadCan() {
  return {
    levels: [
      { level: 1, name: 'On its own', words: 'Reads the code and the stories, looks at the app in its own copy, answers, tells you what needs you.', items: ON_ITS_OWN },
      { level: 2, name: 'After your OK', words: 'Creates a story, starts or stops one, gives more time. "Always allow" only for low-risk ones.', items: AFTER_YOUR_OK },
      { level: 3, name: 'Never', words: 'Changes code, merges, presses Looks right, touches your real data or secrets.', items: [...Object.values(NEVER).map((n) => n.name), ...NEVER_MORE] },
    ],
    always: { words: ALWAYS_WORDS, actions: ALLOWABLE.map((id) => ({ id, name: ACTIONS[id].name })) },
  };
}

/* ── The person's own message ──────────────────────────── */

const POLITE = /^(?:(?:please|pls|kindly|just|now|ok|okay|hey|lead)[,\s]+)*(?:(?:can|could|would|will) you[,\s]+)?(?:(?:please|just|go ahead and|i want you to|i need you to|you should|you must)[,\s]+)*/;

/** Asks put to the lead itself, by the verb they start with. A question about the app ("how do I delete a booking?") is none. */
const EN: [Never, RegExp][] = [
  ['harness', /^(?:change|edit|remove|delete|turn off|switch off|disable|rewrite)\s+(?:the\s+|a\s+|this\s+)?(?:harness|rules?|gates?)\b/],
  ['around', /^(?:skip|bypass|ignore|disable|turn off|switch off|get around|go around|override|lift|raise|remove)\s+(?:the\s+|a\s+|my\s+|this\s+)?(?:failed\s+|failing\s+)?(?:checks?|tests?|review|proof|guard|sandbox|limits?|budget|gates?|caps?)\b|^(?:continue|go on|carry on)\s+anyway\b/],
  ['approve', /^(?:approve|accept|sign off)\b|^(?:press|click|hit|tap)\s+(?:on\s+)?["']?(?:looks right|approve|accept)\b|^mark\s+\S+\s+as\s+(?:done|accepted|approved)\b/],
  ['git', /^(?:merge|push|commit|deploy|rebase|cherry-pick)\b|^(?:release|ship|tag|publish)\s+(?:v?\d|it\b|now\b|this\b|the\s+(?:next\s+|new\s+)?(?:version|release|app|code|build)\b)/],
  ['delete', /^(?:delete|remove|drop|erase|wipe|archive|truncate)\s+(?:the\s+|a\s+|all\s+|this\s+|my\s+)?(?:story|stories|ticket|tickets|bugs?|project|projects|data|database|table|tables|records?|rows?|users?|[a-z]{1,8}-\d+)\b/],
  ['code', /^(?:change|edit|fix|rewrite|refactor|update|modify|patch|write|add|remove)\s+(?:the\s+|this\s+|some\s+)?(?:code|file|files|function|component|css|html|source|bug|tests?)\b|^(?:fix|change)\s+it\s+(?:yourself|for me)\b/],
  ['secrets', /^(?:show|give|tell|send|print|read|open|copy|paste|get|list|what(?:'s| is| are))\b.*(?:\.env\b|\bapi[\s_-]?keys?\b|\baccess tokens?\b|\bsecrets?\b|\bcredentials\b|\bprivate keys?\b|\b(?:real|production|prod|live) passwords?\b)|^(?:query|change|update|edit|look at|open|use|connect to|read|show|copy)\s+(?:me\s+)?(?:the\s+|my\s+|our\s+)?(?:production|prod|live|real)\s+(?:data|database|db|server|users?|accounts?)\b/],
  ['message', /^(?:email|e-mail|mail|message|text|whatsapp|sms|notify|ping|slack|dm)\s+\S|^send\s+(?:an?\s+|the\s+|this\s+)?(?:email|e-mail|mail|message|whatsapp|sms|note|report|it|this)\s+to\b|^(?:tell|inform|warn)\s+(?:the\s+)?(?:team|client|customer|manager|boss|everyone|people|him|her|them|developers?)\b/],
];

const AR: [Never, RegExp][] = [
  ['harness', /^(?:غير|عدل|احذف|الغ|اوقف)\s+(?:قواعد|القواعد|الهارنس|harness)/i],
  ['around', /^(?:تجاهل|تخط|تخطي|تجاوز|الغ|اوقف|عطل)\s+(?:ال)?(?:فحوص|اختبار|مراجع|اثبات|حمايه|حدود|حد|ميزانيه)/],
  ['approve', /^(?:وافق|اعتمد|اقبل)(?:\s|$)|^اضغط\s+(?:على\s+)?(?:looks right|موافق|اعتماد)/i],
  ['git', /^(?:ادمج|ادفع|ارفع الكود|انشر|اصدر|اطلق)(?:\s|$)/],
  ['delete', /^(?:احذف|امسح|شيل|الغ)\s+(?:ال)?(?:قصه|قصص|تذكره|تذاكر|مشروع|مشاريع|بيانات|قاعده|جدول|سجل|[a-z]{1,8}-\d+)/i],
  ['code', /^(?:عدل|غير|اكتب|اصلح|صلح)\s+(?:ال)?(?:كود|ملف|ملفات|الشفره)/],
  ['secrets', /^(?:اعرض|اعطني|عطني|ارسل|اقرا|وريني|ورني|اظهر|انسخ)\s.*(?:\.env|مفتاح|مفاتيح|توكن|الاسرار|البيانات الحقيقيه|قاعده البيانات الحقيقيه|الانتاج)/],
  ['message', /^(?:ارسل|راسل|ابعث|بلغ)\s+(?:رساله|ايميل|بريد|واتساب|الفريق|العميل|المدير)/],
];

/** What the person's own message asks the lead to do that it never does, by word lists in English and Arabic. */
export function neverAsked(text: string): Never[] {
  const found = new Set<Never>();
  for (const part of text.split(/[\n!?؟؛;]+|\.(?=\s|$)/).map((p) => p.trim()).filter(Boolean)) {
    if (isArabic(part)) {
      const s = plainArabic(part).replace(/^(?:لو سمحت|من فضلك|رجاء|ممكن|ابيك|ابغاك|اريدك ان|اريدك)\s*/, '').trim();
      for (const [id, re] of AR) if (re.test(s)) found.add(id);
      continue;
    }
    const s = part.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ').replace(POLITE, '').trim();
    for (const [id, re] of EN) if (re.test(s)) found.add(id);
  }
  return [...found];
}

/* ── The agent's cards ─────────────────────────────────── */

/** A card or an action an agent may hand in that the engine never runs, by the "never" it falls under. */
const NEVER_WORDS: [Never, RegExp][] = [
  ['git', /^(?:merge|push|commit|release|deploy|ship|tag|rebase|publish|pull_request|open_pr|merge_pr)/],
  ['approve', /^(?:approve|accept|looks_right|sign_off|approve_spec|approve_plan|approve_design|mark_done)/],
  ['around', /^(?:skip|bypass|ignore|override|continue_anyway|go_on_anyway|continue|disable|raise_limit|lift_limit|raise_budget|no_tests|skip_hooks|skip_pr|guard_off|allow_host|allow_site|network)/],
  ['harness', /^(?:edit_rules|change_rules|harness|add_rule|remove_rule|edit_harness|rule)/],
  ['code', /^(?:edit|write|change_code|edit_code|fix_code|patch|apply|refactor|run_command|run|exec|shell|bash|install)/],
  ['secrets', /^(?:show_secret|read_secret|reveal|password|secret|env|read_env|token|real_data|production|query|sql|database|db)/],
  ['delete', /^(?:delete|remove|drop|erase|wipe|archive|clean|purge)/],
  ['message', /^(?:send_email|email|message|notify|send_message|whatsapp|slack|sms|post|send_report|share)/],
];

/** The "never" an action or card kind falls under, or null when it is none of them. */
export function neverAction(name: string): Never | null {
  const s = name.trim().toLowerCase().replace(/[\s-]+/g, '_');
  for (const [id, re] of NEVER_WORDS) if (re.test(s)) return id;
  return null;
}

/** Settings a card may suggest. Anything else is the guard, the limits or the Harness: a "never". */
export const SETTINGS: Record<string, { name: string; technical: boolean; values?: string[] }> = {
  quality: { name: 'Quality', technical: false, values: ['best', 'balanced', 'thrifty'] },
  'commands.start': { name: 'The start command', technical: true },
  'commands.url': { name: "The app's address", technical: true },
  'commands.setup': { name: 'The setup command', technical: true },
  'commands.test': { name: 'The test command', technical: true },
  'commands.lint': { name: 'The code check command', technical: true },
  'commands.build': { name: 'The build command', technical: true },
};

/** An engineer: their role on the board says so. Technical settings are theirs to change. */
export function isEngineer(role: string | undefined): boolean {
  return /engineer|developer|\bdev\b|programmer|tech(?:nical)? lead|architect|devops/i.test(role ?? '');
}

/** The refusal of a technical setting for someone who is not an engineer. */
export const ENGINEERS_ONLY = 'This is a technical setting, so only an engineer can change it. Ask your engineer, or show them this card.';
