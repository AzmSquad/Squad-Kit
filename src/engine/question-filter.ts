/**
 * Who answers an agent's question (decision 3 of the agent's room plan). The person answers every question that fills
 * a gap in the business, or settles a clash between two requirements. A technical question never reaches them: it
 * goes back to the agent, which decides it or calls i_am_stuck. Some asks are not allowed at all (changing
 * squad-kit's settings or protected files, handing over a secret, changing git history): they are refused and logged,
 * never shown. The filter reads the words of the question, its choices and everything shown with it, as a person
 * reads them (look-alike letters and hidden characters do not hide a word); it never trusts the agent's label.
 */

export type QuestionVerdict =
  | { pass: true }
  | { pass: false; kind: 'technical'; why: string }
  | { pass: false; kind: 'not-allowed'; what: NotAllowed; why: string };

/** What an agent asked the person to do that nobody may ask of them. */
export type NotAllowed = 'settings' | 'secret' | 'history';

/** What the agent is told when its question is technical. */
export const TECHNICAL_BACK = 'This is technical. Decide it yourself, or call i_am_stuck.';

/**
 * How many times a step's question goes back to its agent before the step stops: a technical one always, and one
 * that is not allowed in a run with no window to count its refusals (a breakdown, the project read).
 */
export const TECHNICAL_TRIES = 2;

/** The plain activity line for a refused ask. */
export function refusedAskLine(who: string, what: NotAllowed): string {
  if (what === 'settings') return `The ${who} asked to change squad-kit's settings. squad-kit refused, and did not bother you with it.`;
  if (what === 'secret') return `The ${who} asked for a password or a key. squad-kit refused, and did not bother you with it.`;
  return `The ${who} asked to change the history of the code. squad-kit refused, and did not bother you with it.`;
}

/** What the agent is told when its ask is refused. */
export function refusedAskBack(what: NotAllowed): string {
  const why =
    what === 'settings'
      ? "Nobody may ask the person to change squad-kit's settings, its .squad folder or the files agents load as instructions."
      : what === 'secret'
        ? 'Nobody may ask the person for a password, a key, a token or any other secret.'
        : 'Nobody may ask the person to change git history: squad-kit does all the git.';
  return `squad-kit refused your question. ${why} Decide it yourself, or call i_am_stuck if something technical is in your way.`;
}

/* ── the words as a person reads them ─────────────────── */

/** Letters of other alphabets drawn like Latin ones: "pаssword" with a Cyrillic а reads as "password". */
const LOOK_ALIKES: Record<string, string> = {
  // Cyrillic
  а: 'a', в: 'b', е: 'e', ё: 'e', з: '3', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  ѕ: 's', і: 'i', ї: 'i', ј: 'j', ԁ: 'd', ԛ: 'q', ԝ: 'w', һ: 'h', ӏ: 'l', ɡ: 'g', ү: 'y',
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X', Ѕ: 'S', І: 'I', Ј: 'J', Ԁ: 'D', Ү: 'Y',
  // Greek
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', γ: 'y', ω: 'w',
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X',
  // Quotes and dashes as people type them.
  '‘': "'", '’': "'", 'ʼ': "'", '“': '"', '”': '"', '‐': '-', '‑': '-', '‒': '-', '–': '-', '−': '-',
};
const LOOK_ALIKE = new RegExp(`[${Object.keys(LOOK_ALIKES).join('')}]`, 'g');

/** Characters that show nothing: zero-width spaces and joiners, direction marks, soft hyphens, marks on letters, fillers. */
const INVISIBLE = /[\p{Cf}\p{Mn}\p{Me}ᅟᅠㅤﾠ⠀]/gu;

/**
 * The words as a person reads them, for the checks only: styled and full-width letters folded (NFKC), invisible
 * characters taken out, letters of other alphabets that look Latin read as Latin, and the spaces made plain.
 */
export function readable(text: string): string {
  return text
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(LOOK_ALIKE, (c) => LOOK_ALIKES[c] ?? c)
    .replace(/[^\S\n]+/g, ' ')
    .trim();
}

/** The sentences of a text: a check reads each one on its own, so words from two sentences never make one ask. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?؟])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ── what nobody may ask of the person ────────────────── */

/** Asks to change something. */
const CHANGE =
  /\b(edit(s|ed|ing)?|chang(e|es|ed|ing)|set|sets|updat(e|es|ed|ing)|modif(y|ies|ied|ying)|add(s|ed|ing)?|remov(e|es|ed|ing)|delet(e|es|ed|ing)|replac(e|es|ed|ing)|turn(s|ed|ing)? (it |them |this |that )?(on|off)|switch(es|ed|ing)? (it |them |this |that )?(on|off)|enabl(e|es|ed|ing)|disabl(e|es|ed|ing)|adjust(s|ed|ing)?|(re)?configur(e|es|ed|ing)|tweak(s|ed|ing)?|allow(s|ed|ing)?|white-?list|allow-?list|loosen|relax|lift|bypass|skip|unlock|open up|grant|raise|increase|extend|widen|put|write|rewrite)\b/i;

/**
 * squad-kit's own things: its folder, the files AI tools load as instructions, its settings and checks, the hosts the
 * squad may reach, the guard around the agents, and the project's commands squad-kit runs. Each one names squad-kit's
 * thing itself, so "the squad settings for the team" or "the permission list for each role" stay the business's own.
 */
const SQUAD_THINGS: RegExp[] = [
  /(^|[\s"'`(/\\])\.squad\b/i,
  /\b(CLAUDE(\.local)?|AGENTS|GEMINI)\.md\b|(^|[\s"'`(/\\])\.(claude|cursor|codex|gemini)\b|\.cursorrules\b|\bcopilot-instructions\b|\bsecrets\.ya?ml\b/i,
  /\bsquad-?kit'?s?\s+(own\s+)?(settings?|config(uration)?|rules|checks?|guard|sandbox|hosts?|permissions?|commands?|files?|folder|limits?|options?)\b/i,
  /\b(allowed|permitted|allow-?listed|white-?listed)\s+(hosts?|sites?|websites?|domains?)\b|\b(hosts?|domains?)\s+list\b|\b(hosts?|sites?|websites?|domains?|addresses)\s+(that\s+)?(the\s+)?(squad|agents?)\s+(may|can|is allowed to|are allowed to)\s+(reach|use|open|visit|access|call)\b/i,
  /\b(the|squad-?kit'?s|its|this|that|your|my)\s+(guard|sandbox)\b(?!\s+(role|roles|desk|station|shifts?|team|users?|staff|booth|post|rota|schedule|on duty))|\b(sandboxed|seatbelt|bubblewrap)\b/i,
  /\b(start|test|tests|check|checks|build|setup|lint)\s+commands?\b/i,
  /\b(allow|let|permit)\s+(the\s+)?(squad|agents?|me|us)\s+(to\s+)?(reach|open|run|use|access|write|read|install|call|launch|start)\b/i,
];

/** Settings as a place in squad-kit, with its capital: "in Settings". The app's own "booking settings page" is not it. */
const SETTINGS_PLACE = /\b(in|into|from|under|via|through|on|open|opens|opening|to)\s+(the\s+)?(squad-?kit'?s?\s+)?Settings\b/;

/** Asked of the person: "please …", "can you …", "you could …", or an order at the start of a sentence. */
const ASKED =
  /\b(please|kindly|can you|could you|would you|will you|you (can|could|should|need to|must|have to|'ll need to|will need to|may want to|might want to)|i need you to|we need you to|(do|would) you mind)\b|^(please,?\s+)?(edit|change|set|update|modify|add|remove|delete|replace|turn|switch|enable|disable|adjust|configure|tweak|allow|grant|open|go|run|type|paste|force|rebase|squash|amend|revert|reset|push|drop|cherry-pick|rewrite|undo|give|send|share|tell|enter|provide)\b/i;

/** The history of the code, never the business's own: "the history of a booking", "cherry-pick which orders ship". */
const HISTORY: RegExp[] = [
  /\bforce[- ]?push(es|ed|ing)?\b|\bpush\s+(--force(-with-lease)?|-f)\b|\bgit\s+(push|reset|rebase|commit|merge|checkout|switch|stash|clean|tag|branch|revert|cherry-pick|filter-branch|filter-repo|reflog|gc|prune)\b/i,
  /\brebas(e|es|ed|ing)\b[^.?!\n]{0,40}\b(onto|branch(es)?|commits?|main|master|origin|upstream|history|git|interactive)\b|\b(branch(es)?|commits?)\b[^.?!\n]{0,40}\brebas(e|ed|ing)\b/i,
  /\breset\s+--hard\b|\bhard reset\b[^.?!\n]{0,30}\b(branch|commits?|main|master|repo)\b/i,
  /\b(amend|squash|drop|revert|cherry-?pick|remove|delete|rewrite|undo|edit|reorder|split)\s+((the|that|this|those|these|my|your|its|last|latest|previous|old|a|some|all|two|three|\d+)\s+)*commits?\b/i,
  /\b(rewrite|rewriting|change|changing|edit|alter|clean( up)?|squash)\s+((the|its|this|our|your)\s+)?(git|commit|code'?s?|branch'?s?|repo(sitory)?'?s?)\s+history\b|\bhistory of (the|this|its) (code|branch|commits|repo(sitory)?)\b/i,
  /\b(delete|remove|drop|rename|reset|force|overwrite)\s+((the|this|that|a|my|your|its)\s+)?((git|remote|feature|ticket'?s?|story'?s?|work|main|master|base)\s+)?branch(es)?\b(?!\s+(offices?|managers?|staff|locations?|names?|list|address(es)?|codes?|levels?|of|in|at|for|from|near|that|which|where|hours|opening|accounts?|network|teams?|directors?|employees?))/i,
];

/** A value nobody may hand over, as the last word of what is asked for: "the Stripe test key", "your API token". */
const SECRET_WORD = /^(passwords?|passcodes?|passphrases?|pins?|keys?|api-?keys?|apikeys?|tokens?|secrets?|credentials?|creds|logins?|log-ins?|sign-ins?|signins?)$/i;
/** "details" or "info" of a sign-in: "the database login details". */
const SIGN_IN_WORD = /^(logins?|log-ins?|sign-ins?|signins?|account|access|admin|credential|password)$/i;
/** Words that end what is asked for: "the wording for the password reset email" asks for the wording. */
const ENDS_THING = new Set(
  'for of about on in at with to from by that which who whose and or so if when because here there now please first again than as into is are was were be via over under using after before while where how why then but'.split(' '),
);
/** Handing something over, asked of the person. */
const GIVE =
  /(?:^|\b(?:please|kindly|just)\s*,?\s+|\b(?:can|could|would|will) you\s+(?:please\s+|also\s+|just\s+|kindly\s+)?|\byou (?:can|could|should|need to|must|have to)\s+(?:also\s+|just\s+)?|\b(?:i|we) need you to\s+)(?:paste|send|share|give|provide|tell|enter|type|supply|post|reveal|hand over|copy|put|drop|forward|email|dm|text|add|input|fill in)\s+/gi;
/** Having or needing it: "do you have the API key?", "I need the database password", "can I get the token?". */
const HAVE =
  /\b(?:do|can|could|would) you\s+(?:please\s+)?(?:still\s+)?(?:have|know|remember)\s+|\b(?:i|we)(?:'d| would| will|'ll)?\s+(?:need|want|require)\s+|\b(?:can|could|may) (?:i|we)\s+(?:please\s+)?(?:get|have|borrow|use|see)\s+/gi;
/** A secret to hand over: "a token I can paste", "the key for me to send". */
const SECRET_TO_HAND = /\b(passwords?|pins?|keys?|tokens?|logins?|credentials?|secrets?)\s+(?:(?:for (?:me|us)\s+)?to (?:paste|send|share|copy)|(?:that\s+)?(?:i|we) (?:can|could|should|may) (?:paste|use|copy|try))\b/i;
/** Asking what it is: "what's the Stripe test key?", "where is the admin password?". */
const WHAT = /\b(?:what(?:'s|s| is| are| was| were)|where(?:'s| is| are| can i find| do i find| can i get| do i get)|which is)\s+/gi;
/** Where secrets are kept: "paste the values from your .env file". */
const SECRET_PLACE = /(^|[\s"'`(/])\.env\b|\bsecrets?\.ya?ml\b|\bkeychain\b|\bpassword manager\b/i;

/** What is asked for right after an ask, as its words, up to the first word that ends it. */
function thingAsked(rest: string): string[] {
  const words = rest.split(/\s+/).filter(Boolean);
  let i = 0;
  // "send me your token", "share with us the key", "tell me what the password is".
  if (/^(me|us|it|over|in)$/i.test(words[i] ?? '')) i += 1;
  if (/^(to|with)$/i.test(words[i] ?? '') && /^(me|us)$/i.test(words[i + 1] ?? '')) i += 2;
  if (/^what$/i.test(words[i] ?? '')) i += 1;
  const thing: string[] = [];
  for (; i < words.length && thing.length < 6; i += 1) {
    const raw = words[i]!;
    const word = raw.replace(/^["'`(]+|["'`).,;:!?]+$/g, '');
    if (!word || ENDS_THING.has(word.toLowerCase())) break;
    thing.push(word);
    if (/[.,;:!?)]$/.test(raw)) break;
  }
  return thing;
}

/** True when what is asked for is a secret value: its last word is one, like "key" in "the Stripe test key". */
function isSecretThing(thing: string[]): boolean {
  const last = thing[thing.length - 1] ?? '';
  const before = thing[thing.length - 2] ?? '';
  if (SECRET_WORD.test(last)) return true;
  if (/^(details|info|information)$/i.test(last) && SIGN_IN_WORD.test(before)) return true;
  return /^connection$/i.test(before) && /^strings?$/i.test(last);
}

/** True when a sentence asks the person to hand over a secret. "What are the password rules?" asks for rules. */
function asksForSecret(s: string): boolean {
  if (SECRET_TO_HAND.test(s) && (ASKED.test(s) || /\b(i|we|me|us)\b/i.test(s))) return true;
  for (const re of [GIVE, HAVE, WHAT]) {
    re.lastIndex = 0;
    for (let m = re.exec(s); m; m = re.exec(s)) {
      if (isSecretThing(thingAsked(s.slice(m.index + m[0].length)))) return true;
      if (re === GIVE && SECRET_PLACE.test(s)) return true;
      if (m[0].length === 0) re.lastIndex += 1;
    }
  }
  return false;
}

/*
 * The same checks in Arabic, for a story written in Arabic: its agents ask in Arabic. There is no word boundary around
 * Arabic letters here, so a word is found with what joins to it ("وكلمة المرور"). The marks on letters are gone by now
 * (readable), so these are written without them. Each needs its own words, so a business question passes.
 */

/** A secret value. A room's key or a password's rules are not: the words right after the ask are the secret itself. */
const AR_SECRET = '(?:ال)?(?:كلم(?:ة|ات) (?:ال)?(?:مرور|سر)|رقم (?:ال)?سري|رمز (?:ال)?(?:دخول|سري|وصول)|مفتاح (?:ال)?(?:API|واجهة|وصول|دخول|سري)|توكن|بيانات (?:ال)?(?:دخول|اعتماد)|API[- ]?key|token|password)';
const AR_GIVE = '(?:^|من فضلك\\s+|رجاء\\s+|يرجى\\s+|هل يمكنك\\s+|هل تستطيع\\s+|أرجو\\s+)(?:أعطني|أعطنا|أرسل|زودني|زودنا|شارك|الصق|أدخل|اكتب|قدم|انسخ|أخبرني|إعطائي|إرسال|تزويدي|تزويدنا|مشاركة)(?:\\s+(?:لي|لنا|إلي|إلينا|معي|معنا|ب))?\\s*';
const AR_HAVE = '(?:هل لديك|هل عندك|هل تعرف|هل تملك|أحتاج(?:\\s+إلى)?|نحتاج(?:\\s+إلى)?|أريد|نريد)\\s+';
const AR_WHAT = '(?:ما هي|ما هو|ما|أين هي|أين هو|أين)\\s+';
const AR_ASKS_SECRET = new RegExp(`(?:${AR_GIVE}|${AR_HAVE}|${AR_WHAT})${AR_SECRET}`);

/** Asks to change something. Read together with squad-kit's own things, so "other" (the same letters as "change") does no harm. */
const AR_CHANGE = /(?:غير|عدل|حدث|أضف|احذف|أزل|بدل|فعل|عطل|اسمح|ارفع|افتح|اكتب في|تغيير|تعديل|تحديث|إضافة|حذف|تفعيل|تعطيل)/;
const AR_SQUAD_THINGS = /(?:إعدادات|ملفات|مجلد|قواعد|فحوصات|حدود|صلاحيات|حارس)\s+squad-?kit/i;

/**
 * What a text asks the person to do that nobody may ask of them, or null. In a question every sentence counts; in a
 * reply in a talk (`reply`) only what it asks the person to do, never what it only explains.
 */
function notAllowedIn(text: string, reply: boolean): { what: NotAllowed; why: string } | null {
  for (const s of sentences(text)) {
    const asked = ASKED.test(s);
    if (asksForSecret(s) || AR_ASKS_SECRET.test(s)) return { what: 'secret', why: 'asks the person for a secret' };
    if (AR_CHANGE.test(s) && AR_SQUAD_THINGS.test(s)) return { what: 'settings', why: "asks the person to change squad-kit's settings or protected files" };
    const changes = CHANGE.test(s) && (!reply || asked);
    if (changes && SQUAD_THINGS.some((re) => re.test(s))) return { what: 'settings', why: "asks the person to change squad-kit's settings or protected files" };
    if (changes && asked && SETTINGS_PLACE.test(s)) return { what: 'settings', why: "asks the person to change squad-kit's settings" };
    if ((!reply || asked) && HISTORY.some((re) => re.test(s))) return { what: 'history', why: 'asks the person to change git history' };
  }
  return null;
}

/* ── what is technical ────────────────────────────────── */

/** Signs a question is about the computer, not the business. Each needs its own words, so a business question passes. */
const TECHNICAL: RegExp[] = [
  // Settings and config files, the project's own files, and squad-kit's own things.
  /\b(config(uration)? files?|settings files?|package\.json|tsconfig|dockerfile|docker-compose|makefile|\.env\b|\.ya?ml\b|\.toml\b|\.ini\b|\.json\b)/i,
  ...SQUAD_THINGS,
  // Ports, processes, the network on this computer ("which port does the ship use" is the business's own).
  /\bports? \d{2,5}\b|\bport (number|is (in use|taken|busy|blocked)|in use)\b|\b(busy|free|open|another|a different) port\b|\bon port\b|\blisten(s|ing)? on\b|\blocalhost\b|\b127\.0\.0\.1\b|\b0\.0\.0\.0\b|:\d{4,5}\b/i,
  /\b(pids?|process id|kill( the)? (process|server|app)|running process(es)?|background process(es)?|dev server|web server)\b/i,
  // Permissions on this computer, the guard around the agent.
  /\b(permission denied|file permissions?|eacces|eperm|sudo|chmod|chown|root access|admin rights)\b/i,
  /\bpermissions? (to|for) (run|write|read|execute|install|access|use)\b[^.?!\n]{0,30}\b(files?|folders?|director(y|ies)|commands?|terminal|shell|scripts?|browser|tools?|ports?|network|internet|disk)\b/i,
  /\b(sandbox(ed)?|seatbelt|bubblewrap|mach port|bootstrap_check_in|sigtrap)\b/i,
  // Commands and the terminal ("the payment terminal", "pay from the terminal in the shop", "voice commands").
  /\b(run|type|enter|paste|execute|start|launch|use)\b[^.?!\n]{0,40}\b(in|into|from|inside) (a |the |your |my )?terminal\b|\b(open|launch) (a |the |your |my )?(new )?terminal\b|\bterminal (window|app|command|session|tab|emulator)s?\b/i,
  /\b(command line|command prompt|shell (command|script)s?|bash|zsh|powershell|cli)\b/i,
  /\b(run|execute|type|enter|paste) ((the|this|a|that|these|those|following|my|your) )?((shell|terminal|cli) )?(commands?|scripts?)\b|\b(shell|terminal|cli|bash|git|npm|pnpm|yarn) commands?\b|\b(npm|pnpm|yarn|npx|pip|pip3|brew|apt|apt-get|dotnet|mvn|gradle|cargo|go get|composer)\b/i,
  // Environment variables, installs.
  /\b(environment variables?|env vars?)\b/i,
  /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b/,
  /\b(install(ed|ing|s)?|reinstall|upgrade|downgrade) (the |a |an )?(browser|chromium|chrome|playwright|package|packages|dependenc(y|ies)|node|python|library|libraries|module|sdk|driver|plugin|tool)\b/i,
  /\b(playwright|chromium|headless|webdriver|puppeteer|selenium)\b/i,
  // File paths.
  /(^|[\s"'`(])(~\/|\.\.?\/|\/(Users|home|private|tmp|var|etc|opt|usr)\/|[A-Za-z]:\\)/,
  /\b[\w.-]+\/[\w./-]*\.(m?[jt]sx?|json|py|ya?ml|toml|sh|md|lock|cfg|ini|cs|java|rb|go|php|html|css)\b/i,
  // The agent's own tools and git ("stash items in a wishlist" is the business's own).
  /\bmcp\b|\bi_am_stuck\b/i,
  /\bgit\b|\bpull request\b|\bgit stash\b|\bstash(ed|ing)? ((the|my|your|these|those|its|all|local|uncommitted) )?(changes|work|edits)\b|\bmerge conflict\b|\bcommit (the|these|my|this) changes\b/i,
  // The same in Arabic ("القاعدة" alone or "المنفذ" alone can be the business's own: each here is about the computer).
  /مل(?:ف|فات) (?:ال)?(?:إعدادات|تكوين)|متغير(?:ات)? (?:ال)?بيئة/,
  /(?:رقم )?(?:ال)?منفذ \d{2,5}|رقم (?:ال)?منفذ|خادم (?:ال)?(?:تطوير|ويب)|(?:ال)?عملية الجارية/,
  /صلاحيات (?:ال)?مل(?:ف|فات)|صلاحية (?:ال)?ملف|تم رفض الإذن/,
  /(?:نافذة|سطر|موجه) (?:ال)?أوامر|(?:في |إلى |من )(?:ال)?طرفية/,
  /(?:شغل|نفذ|اكتب|الصق|تشغيل|تنفيذ)\s+(?:هذا\s+|هذه\s+)?(?:ال)?(?:أمر|أوامر|سكربت|برنامج النصي)/,
  /(?:ثبت|تثبيت|حدث|تحديث)\s+(?:ال)?(?:متصفح|حزم(?:ة)?|مكتب(?:ة|ات)|إضافة|أداة|حزمة)/,
  /طلب(?:ات)? (?:ال)?سحب|تعارض (?:ال)?دمج|مستودع (?:ال)?كود|(?:ال)?فرع (?:الرئيسي )?في (?:ال)?مستودع/,
];

/** The text an agent shows the person with a question, in one piece: the question, its choices, why, where from, what it changes. */
export function askText(q: { text?: unknown; options?: unknown; why?: unknown; sources?: unknown; refs?: unknown; impact?: unknown }): string {
  const named = (x: unknown): unknown[] => (Array.isArray(x) ? x.flatMap((s) => (s && typeof s === 'object' ? [(s as { text?: unknown }).text, (s as { title?: unknown }).title, (s as { section?: unknown }).section] : [s])) : []);
  const parts = [q.text, ...(Array.isArray(q.options) ? q.options : []), q.why, ...named(q.sources), ...named(q.refs), q.impact];
  return parts.filter((x): x is string => typeof x === 'string' && x.trim() !== '').join('\n');
}

/** Who answers a question an agent asked the person: the person, the agent itself, or nobody. */
export function judgeQuestion(q: { text?: unknown; options?: unknown; why?: unknown; sources?: unknown; refs?: unknown; impact?: unknown }): QuestionVerdict {
  const text = readable(askText(q));
  if (!text) return { pass: true };
  const no = notAllowedIn(text, false);
  if (no) return { pass: false, kind: 'not-allowed', ...no };
  const hit = TECHNICAL.find((re) => re.test(text));
  if (hit) return { pass: false, kind: 'technical', why: `technical: ${(hit.exec(text)?.[0] ?? '').trim().slice(0, 60)}` };
  return { pass: true };
}

/**
 * An agent's reply in a talk with the person (a chat, the review chat, Ask a question): only an ask that is not
 * allowed is refused. Technical words are fine there, because the person asked.
 */
export function judgeReply(text: string): { pass: true } | { pass: false; kind: 'not-allowed'; what: NotAllowed; why: string } {
  const no = notAllowedIn(readable(text ?? ''), true);
  return no ? { pass: false, kind: 'not-allowed', ...no } : { pass: true };
}

/** The plain line a reply that asked for what is not allowed is replaced with. */
export function refusedReplyLine(who: string, what: NotAllowed): string {
  const asked = what === 'settings' ? "to change squad-kit's settings" : what === 'secret' ? 'for a password or a key' : 'to change the history of the code';
  return `The ${who}'s answer asked you ${asked}, so squad-kit left it out. Ask again, or ask in other words.`;
}

/** One question an agent asked, wherever its answer keeps it. */
export interface AskedQuestion {
  /** Where it is in the answer, for the agent: "question", "questions[2]". */
  at: string;
  text: string;
  options?: string[];
  why?: string;
  /** Where it comes from (Builds by itself), and the sections it is about (a breakdown): the person reads them too. */
  sources?: unknown[];
  refs?: unknown[];
  /** What the answer changes (a breakdown). */
  impact?: string;
}

/**
 * The questions in an agent's answer for the person: the one `question` of the Architect, Builder and Reviewer, and
 * the Analyst's `questions`. Empty when it asked none.
 */
export function questionsIn(answer: unknown): AskedQuestion[] {
  const a = answer as { question?: unknown; questions?: unknown } | null | undefined;
  if (!a || typeof a !== 'object') return [];
  const one = (q: unknown, at: string): AskedQuestion[] => {
    const x = q as { text?: unknown; options?: unknown; why?: unknown; sources?: unknown; refs?: unknown; impact?: unknown } | null;
    if (!x || typeof x.text !== 'string' || !x.text.trim()) return [];
    return [
      {
        at,
        text: x.text,
        ...(Array.isArray(x.options) ? { options: x.options.filter((o): o is string => typeof o === 'string') } : {}),
        ...(typeof x.why === 'string' ? { why: x.why } : {}),
        ...(Array.isArray(x.sources) ? { sources: x.sources } : {}),
        ...(Array.isArray(x.refs) ? { refs: x.refs } : {}),
        ...(typeof x.impact === 'string' ? { impact: x.impact } : {}),
      },
    ];
  };
  return [...one(a.question, 'question'), ...(Array.isArray(a.questions) ? a.questions.flatMap((q, i) => one(q, `questions[${i}]`)) : [])];
}

/**
 * The first question of an answer that may not reach the person, with what to tell its agent. Null when all may.
 * `settles` names questions the engine answers itself first (a busy port in the Builder's way): left to it.
 */
export function stoppedQuestion(answer: unknown, settles?: (q: AskedQuestion) => boolean): { q: AskedQuestion; verdict: Exclude<QuestionVerdict, { pass: true }> } | null {
  for (const q of questionsIn(answer)) {
    const verdict = judgeQuestion(q);
    if (!verdict.pass && verdict.kind === 'technical' && settles?.(q)) continue;
    if (!verdict.pass) return { q, verdict };
  }
  return null;
}

/** What goes back to the agent, in its same conversation, about a question that may not reach the person. */
export function questionBackPrompt(found: { q: AskedQuestion; verdict: Exclude<QuestionVerdict, { pass: true }> }): string {
  const said = `Your ${found.q.at === 'question' ? 'question' : `question (${found.q.at})`}: "${found.q.text.slice(0, 300)}"`;
  const back = found.verdict.kind === 'technical' ? TECHNICAL_BACK : refusedAskBack(found.verdict.what);
  return `${said}\n${back}\nThen carry on and hand in your answer again${found.q.at === 'question' ? ' without that question' : ' without that question in it'}. Ask the person only about the business: a gap (something missing that changes what gets built) or a clash (two requirements that disagree).`;
}
