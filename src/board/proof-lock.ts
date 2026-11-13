import type { Criterion } from './types.js';
import type { CriterionProof, ProofKind } from './proof-kind.js';

/**
 * squad-kit's own rules for how a "done when" is proved. They are code, never an agent's word:
 *
 * 1. A line about what someone sees keeps its picture: squad-kit locks it to Screen.
 * 2. A story that changes screen files keeps at least one picture: when no line is Screen, the line most about a screen
 *    is locked to Screen (lockForScreens, at the proof, from the files the story changed).
 *
 * A lock only ever adds a picture. An agent's answer never unlocks a line, and the person changes any other line's
 * kind before approving the spec (board/prove.ts).
 *
 * A project with no app to start (a command-line tool, a library: board/apps.ts hasAppToStart) has nothing to show, call
 * or act on, so it has no lock, and a Screen, API call or Data line is proved by a test instead. `app` false says so.
 */

/** In the order the menu shows them. */
export const PROOF_KINDS: ProofKind[] = ['screen', 'data', 'api', 'test', 'none'];

export const KIND_NAMES: Record<ProofKind, string> = { screen: 'Screen', api: 'API call', data: 'Data', test: 'Test', none: 'Not on a screen' };

/** The rule's own words under a locked line. */
export const SEES_WHY = 'About what someone sees, so it needs a picture';
export const SCREENS_WHY = 'The story changes a screen, so one line keeps a picture';
/** What the menu says on a locked line. */
export const LOCK_NOTE = 'Screen needs a picture. squad-kit keeps it when a line is about what someone sees.';
/** Why a line is a test on a project with no app. */
export const NO_APP_WHY = 'This project has no app to start, so a test proves it';
/** The kinds a project with no app can use. */
export const NO_APP_KINDS: ProofKind[] = ['test', 'none'];

/** Words that are about what someone sees, whatever else the line says. */
const SEES = /\b(?:see|sees|seeing|seen|saw|visible|invisible|on (?:the|a|my|his|her|their|your) (?:screen|page)|on screen|onscreen|screens?|pages?|buttons?|clicks?|clicked|taps?|tapped|pop-?ups?|dialogs?|modals?|toasts?|banners?|tooltips?|headings?|scroll(?:s|ed|ing)?|highlighted|greyed|grayed|looks?)\b/i;
/** Words that are about a screen only when nothing in the line points away from one. */
const MAYBE = /\b(?:shows?|shown|showing|displays?|displayed|appears?|message|list|form|icon|colou?r|badge|label)\b/i;
/** Words that point away from a screen: an API, the stored data, a job or a message sent elsewhere. */
const AWAY = /\b(?:api|endpoint|call|request|response|json|status code|http|database|db|table|rows?|columns?|records?|saved|stored|logs?|logged|jobs?|queue|e-?mails?|sms|webhooks?|cron|migrations?)\b/i;
/** The same in Arabic: no word edges there, so by the letters. */
const SEES_AR = /(?:يشوف|تشوف|أشوف|نشوف|يشوفون|يشوفوا|يرى|ترى|أرى|نرى|يظهر|تظهر|يبان|تبان|الشاشة|شاشة|الصفحة|صفحة|الزر|زر |يضغط|أضغط|تضغط|نافذة)/;
const MAYBE_AR = /(?:يعرض|تعرض|رسالة|قائمة|أيقونة|لون)/;
const AWAY_AR = /(?:API|قاعدة البيانات|جدول|يتحفظ|تتحفظ|يحفظ|تحفظ|يتخزن|سجل|طلب|إيميل|بريد)/;

/** True when the line is about what someone sees: its result ("then"), never its action, so "when I click Pay" alone is not. */
export function aboutWhatSomeoneSees(c: Pick<Criterion, 'then'>): boolean {
  const then = c.then ?? '';
  if (SEES.test(then) || SEES_AR.test(then)) return true;
  return (MAYBE.test(then) && !AWAY.test(then)) || (MAYBE_AR.test(then) && !AWAY_AR.test(then));
}

/** How much a line is about a screen, for rule 2: its whole sentence. */
function screenScore(c: Criterion): number {
  const text = `${c.given} ${c.when} ${c.then}`;
  return [SEES, MAYBE, SEES_AR, MAYBE_AR].filter((r) => r.test(text)).length - (AWAY.test(text) || AWAY_AR.test(text) ? 1 : 0);
}

/** A kind a project with no app cannot use becomes a test. */
function withoutApp(p: CriterionProof): CriterionProof {
  return NO_APP_KINDS.includes(p.kind) ? { kind: p.kind, ...(p.why ? { why: p.why } : {}) } : { kind: 'test', why: NO_APP_WHY };
}

/** Rule 1 on one line: one about what someone sees is Screen, locked, with the rule's words when it had no reason of its own for a picture. */
export function lockLine(c: Criterion, app = true): Criterion {
  if (!app) return c.proof ? { ...c, proof: withoutApp(c.proof) } : c;
  if (!c.proof || !aboutWhatSomeoneSees(c)) return c;
  const why = c.proof.kind === 'screen' && c.proof.why ? c.proof.why : SEES_WHY;
  return { ...c, proof: { kind: 'screen', why, locked: true } };
}

/** Rule 1 on every line. A line squad-kit locked before stays locked. */
export function withLocks(criteria: Criterion[], app = true): Criterion[] {
  return criteria.map((c) => (c.proof?.locked && app ? { ...c, proof: { ...c.proof, kind: 'screen' } } : lockLine(c, app)));
}

/**
 * Rule 2: the story changed screen files and no line is Screen. The line most about a screen becomes Screen, locked;
 * with none, the first line that is not Not on a screen. Null when nothing changes.
 */
export function lockForScreens(criteria: Criterion[], changesScreens: boolean): { criteria: Criterion[]; line: number } | null {
  if (!changesScreens || !criteria.some((c) => c.proof) || criteria.some((c) => (c.proof?.kind ?? 'screen') === 'screen')) return null;
  const scores = criteria.map(screenScore);
  const best = Math.max(...scores);
  let at = best > 0 ? scores.indexOf(best) : criteria.findIndex((c) => c.proof?.kind !== 'none');
  if (at < 0) at = 0;
  const out = criteria.map((c, i) => (i === at ? { ...c, proof: { kind: 'screen' as const, why: SCREENS_WHY, locked: true } } : c));
  return { criteria: out, line: at + 1 };
}

/** A file of what people see: a page, a component, a template or a style. Tests and stories of components are not. */
export function isScreenFile(file: string): boolean {
  const f = file.replace(/\\/g, '/');
  if (/(^|\/)(__tests__|tests?|e2e|spec|cypress|playwright)\//i.test(f) || /\.(test|spec|stories)\.[a-z]+$/i.test(f)) return false;
  return /\.(tsx|jsx|vue|svelte|astro|html?|css|scss|sass|less|cshtml|razor|erb|hbs|ejs|pug|xaml|xib|storyboard)$/i.test(f);
}

/** An agent's proposal for one line, taken only in squad-kit's shape: a known kind and one plain line. Never a lock. */
export function cleanProof(raw: unknown): CriterionProof | undefined {
  const o = (raw ?? {}) as Record<string, unknown>;
  const kind = PROOF_KINDS.find((k) => k === o.kind);
  if (!kind) return undefined;
  const why = typeof o.why === 'string' ? o.why.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  // Not on a screen with no reason is no proof at all: the line keeps a picture, as before.
  if (kind === 'none' && !why) return { kind: 'screen' };
  return { kind, ...(why ? { why } : {}) };
}

/**
 * The criteria an agent wrote, with its proposed proof cleaned and the locks on. When it proposed none for any line
 * (an older answer), the lines stay as they were: proved as before. A line it left out is Screen, as before.
 */
export function proposedProofs(criteria: { given: string; when: string; then: string; proof?: unknown }[], app = true): Criterion[] {
  const proposed = criteria.map((c) => cleanProof(c.proof));
  if (!proposed.some(Boolean)) return criteria.map(({ given, when, then }) => ({ given, when, then }));
  return withLocks(criteria.map(({ given, when, then }, i) => ({ given, when, then, proof: proposed[i] ?? { kind: 'screen' } })), app);
}

/** A line's words changed by hand: its kind stays, and the rule looks at it again. */
export function keepProof(old: Criterion | undefined, next: Criterion, app = true): Criterion {
  if (!old?.proof) return next;
  const { locked: _locked, ...rest } = old.proof;
  return lockLine({ ...next, proof: rest.kind === 'screen' && old.proof.locked && rest.why === SEES_WHY ? { kind: 'screen' } : rest }, app);
}

/**
 * A line as a change writes it (Ask for changes, after the spec's approval): the kind the Analyst gave, else the one
 * the line had; a new line on a spec with kinds is Screen when it gave none. squad-kit's locks stay on.
 */
export function changedLine(old: Criterion | undefined, said: unknown, words: { given: string; when: string; then: string }, kinds: boolean, app = true): Criterion {
  const proof = cleanProof(said) ?? (old?.proof ? { kind: old.proof.kind, ...(old.proof.why ? { why: old.proof.why } : {}) } : kinds ? { kind: 'screen' as const } : undefined);
  if (!proof) return words;
  if (old?.proof?.locked && app) return { ...words, proof: { kind: 'screen', why: old.proof.why ?? SEES_WHY, locked: true } };
  return lockLine({ ...words, proof }, app);
}

/** True when a change gives a line another kind. */
export function kindChanged(a: Criterion | undefined, b: Criterion | undefined): boolean {
  return Boolean(a?.proof || b?.proof) && (a?.proof?.kind ?? 'screen') !== (b?.proof?.kind ?? 'screen');
}

/** A line's words on the change card, with its kind when the change gives it another one. */
export function withKindWords(words: string, c: Criterion, other: Criterion | undefined): string {
  return kindChanged(c, other) ? `${words} Proved by: ${KIND_NAMES[c.proof?.kind ?? 'screen']}.` : words;
}
