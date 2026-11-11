import type { ProofPicture, ProofShot, Ticket } from '../board/types.js';

/**
 * What the proof's pictures show, per "done when": the Tester's verdict and squad-kit's own check of all its pictures
 * (a Reviewer run), together. There are three: met; broken, a picture shows it does not work; not shown, the pictures
 * do not show all of it clearly. A "done when" with several parts or cases has one picture per part or case. The proof
 * passes only when every "done when" that shows on a screen is judged met. Only broken goes back to the Builder, and
 * after the last round it is a plain stop. Not shown goes back to the Tester, with the check's advice: a retake adds
 * the missing pictures and keeps the rest, and after the last retake it is a plain stop: a picture problem never
 * reaches the Builder. A fourth way to end, never a picture's own verdict: Not on a screen, when the Tester and the
 * check agree that it, or a part of it, cannot be shown at all, or after the last retake when pictures show a part and
 * the Tester says the rest cannot be shown. It keeps its pictures and its reason, and it does not stop the story,
 * unless every "done when" ends that way. The live squad runs the agents (engine/live.ts); these are the rules, in one
 * place.
 */

/** A proof that is no picture: squad-kit asked the product's API and saved the call (AgentWindow, ask_api). */
export const isApiProof = (file: string): boolean => file.endsWith('.api.json');

/** The most pictures one step may take, and so the most one answer of the Tester's may name. */
export const MAX_PICTURES = 40;

/** The most pictures one answer may name for one "done when": one per part or case. */
export const MAX_PICTURES_PER_DONE_WHEN = 6;

/** Rounds of screenshots that may show a "done when" broken: the first goes back to the Builder, the last stops. */
export const MAX_PROOF_ROUNDS = 2;

/** Times the Tester takes the pictures of what is not shown yet again, before a plain stop. */
export const MAX_RETAKES = 2;

/** When squad-kit's own check of the screenshots did not get through. */
export const CHECK_FAILED = 'squad-kit could not check the screenshots this time. Press Try again to try once more.';

export type Shows = NonNullable<ProofShot['shows']>;

/** What a picture can be judged: Not on a screen is what the Tester and the check agree on after that. */
export type Judged = Exclude<Shows, 'off-screen'>;

export interface CheckVerdict {
  shows: Judged;
  /** One sentence from the check, as it wrote it. */
  why: string;
  /** For not shown: exactly what to show. For the Tester, never the person. */
  advice: string;
  /** The "done when" itself says the screen stays as it was: for it, the same picture as before is the proof. */
  noChange: boolean;
  /** Said only when what is missing cannot be shown at all, with the app's data and the tools. */
  canShow?: false;
  /** With canShow false: what the pictures show and which part could not be shown, for the person. */
  canShowWhy?: string;
}

/** A "done when" that is not met yet: its number, its words and why, in plain words. */
export interface OpenRow {
  criterion: number;
  text: string;
  why: string;
}

/** The "then" of a "done when", by its number from 1, or a criterion the person added. */
export function criterionText(t: Pick<Ticket, 'criteria' | 'notes'>, n: number): string | null {
  const c = t.criteria?.[n - 1];
  if (c) {
    const text = `${c.then.charAt(0).toUpperCase()}${c.then.slice(1)}`;
    // Two can end in the same words. Each needs its own row, or one row would stand for both and one verdict would be lost.
    const alike = t.criteria!.some((o, i) => i !== n - 1 && o.then.trim() === c.then.trim());
    return alike ? `${text} (${c.given}, ${c.when})` : text;
  }
  const added = (t.notes ?? []).filter((x) => x.kind === 'criterion')[n - 1 - (t.criteria?.length ?? 0)];
  return added?.text.trim() || null;
}

/** How many "done when" a ticket has: the plan's and the person's. */
export function doneWhenCount(t: Pick<Ticket, 'criteria' | 'notes'>): number {
  return (t.criteria?.length ?? 0) + (t.notes ?? []).filter((n) => n.kind === 'criterion').length;
}

/** The numbers of the "done when" the Tester said show on no screen. */
export function offScreenNumbers(t: Pick<Ticket, 'criteria' | 'notes' | 'offScreen'>): Set<number> {
  const out = new Set<number>();
  for (let n = 1; n <= doneWhenCount(t); n += 1) if ((t.offScreen ?? []).some((o) => o.criterion === criterionText(t, n))) out.add(n);
  return out;
}

/** A verdict as squad-kit takes it. Words from before the three verdicts count too: "unclear" is not shown, "not-met" broken. */
export function verdictOf(said: unknown): Judged | null {
  if (said === 'met' || said === 'broken' || said === 'not-shown') return said;
  if (said === 'not-met') return 'broken';
  return said === 'unclear' ? 'not-shown' : null;
}

/** Which verdict stands when a check says two for one "done when". */
const WORSE: Record<Judged, number> = { met: 0, 'not-shown': 1, broken: 2 };

/**
 * The check's answer, one verdict per "done when" it was asked about. Left out or broken, its pictures cannot tell (not
 * shown), unless `given` asks for only what the check really said. A check that answered per picture all the same
 * counts by the worst of its answers, so one picture that is fine never passes the others. Can it be shown is true
 * unless the check says false, and one answer that says it can be shown is enough.
 */
export function checkVerdicts(answer: unknown, asked: number[], given = false): Map<number, CheckVerdict> {
  const out = new Map<number, CheckVerdict>();
  const line = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
  const list = (answer as { checks?: unknown } | null)?.checks;
  for (const c of Array.isArray(list) ? list : []) {
    const o = (c ?? {}) as Record<string, unknown>;
    const n = Number(o.criterion);
    if (!asked.includes(n)) continue;
    const said: CheckVerdict = { shows: verdictOf(o.shows) ?? 'not-shown', why: line(o.why), advice: line(o.advice), noChange: o.noChange === true, ...(o.canShow === false ? { canShow: false as const, canShowWhy: line(o.canShowWhy) } : {}) };
    const had = out.get(n);
    if (!had || WORSE[said.shows] > WORSE[had.shows] || (said.shows === had.shows && had.canShow === false && said.canShow !== false)) out.set(n, said);
  }
  if (!given) for (const n of asked) if (!out.has(n)) out.set(n, { shows: 'not-shown', why: '', advice: '', noChange: false });
  return out;
}

/** A reason about the picture, not about the product: what is out of view, a wrong size, a page still loading. */
const ABOUT_THE_PICTURE = new RegExp(
  [
    /\b(?:not|n't)\s+(?:\w+\s+)?(?:in|within|inside)\s+(?:the\s+|this\s+|that\s+|these\s+|those\s+|any\s+of\s+the\s+|either\s+|any\s+)?(?:pictures?|screenshots?|images?|shots?|frames?|views?)\b/,
    // "... are not in it", "... is not in any of them", said of the picture before.
    /\bnot\s+in\s+(?:it|them|any\s+of\s+them)\b/,
    /\bin\s+(?:none|neither)\s+of\s+them\b/,
    /\b(?:none|neither)\s+of\s+(?:the\s+|these\s+|those\s+)?(?:pictures?|screenshots?|images?|shots?)\b/,
    /\bno\s+(?:picture|screenshot|image|shot)\s+shows?\b/,
    /\bmissing\s+from\s+(?:the\s+|this\s+|these\s+|those\s+)?(?:pictures?|screenshots?|images?|shots?)\b/,
    /\bout\s+of\s+(?:the\s+)?(?:pictures?|screenshots?|frames?|view|shots?)\b/,
    /\b(?:pictures?|screenshots?|images?|shots?)\s+(?:\w+\s+)?(?:(?:does|did|do|can|could)\s*(?:not|n't)|cannot|fails?\s+to)\s+(?:\w+\s+)?(?:show|tell|prove|include|capture|cover)\b/,
    /\b(?:pictures?|screenshots?|images?|shots?)\s+(?:is|was|are|were)\s*(?:not|n't)\b/,
    // "The picture shows the working booking, but not the refusal": what it leaves out, not what is wrong.
    /\b(?:pictures?|screenshots?|images?|shots?)\s+(?:only\s+)?shows?\b[^.]*\bbut\s+not\b/,
    /\b(?:cannot|can't|could\s*(?:not|n't))\s+be\s+(?:seen|judged|told|confirmed)\b/,
    /\b(?:cannot|can't|could\s*(?:not|n't))\s+(?:tell|judge|confirm)\b/,
    /\b(?:i|we)\s+(?:cannot|can't|could\s*(?:not|n't))\s+see\b/,
    /\bbelow\s+the\s+(?:fold|visible\s+part)\b/,
    /\bstill\s+loading\b/,
    /\bat\s+the\s+required\b/,
  ]
    .map((r) => r.source)
    .join('|'),
  'i',
);

/** True when a "broken" has a reason drawn from what the picture shows: a sentence about the product, not about the picture. */
export function drawnFromPicture(why: string | undefined): boolean {
  return Boolean(why?.trim()) && !ABOUT_THE_PICTURE.test(why!);
}

/** Why a picture shows nothing when the after is the same as the before and the screen should change, and what to do. */
export const SAME_PICTURE = 'The after screenshot is the same as the before one, so it does not show the change.';
const SAME_ADVICE = 'Open the screen, state or data where the "done when" can be seen, not the same view as before the change, and do the steps that lead to its result.';

/**
 * The Tester's verdict and the check's, together, for all the pictures of a "done when". Broken takes a reason drawn
 * from the pictures: from the check, or from the Tester unless the check looked and says they do not show it. A broken
 * with no such reason is not shown. Met only when the check agrees. What the pictures do not show, and the check says
 * cannot be shown at all, is Not on a screen. A main after that is the very same picture as the before shows nothing,
 * unless the check says the "done when" is one where the screen stays as it was: then the same picture is the proof.
 */
export function together(tester: Pick<ProofShot, 'shows' | 'note' | 'why'>, check: CheckVerdict | undefined, same = false): { shows: Shows; why: string; advice: string } {
  const c = check ?? { shows: 'not-shown' as const, why: '', advice: '', noChange: false };
  if (c.shows === 'broken' && drawnFromPicture(c.why)) return { shows: 'broken', why: c.why, advice: '' };
  if (c.shows !== 'met' && c.canShow === false) return { shows: 'off-screen', why: c.canShowWhy || c.why, advice: '' };
  if (same && !c.noChange) return { shows: 'not-shown', why: SAME_PICTURE, advice: SAME_ADVICE };
  if (c.shows !== 'met') return { shows: 'not-shown', why: c.why, advice: c.advice };
  const said = tester.why ?? tester.note;
  if (tester.shows === 'broken' && drawnFromPicture(said)) return { shows: 'broken', why: said!, advice: '' };
  return { shows: 'met', why: '', advice: '' };
}

/**
 * A "done when" with no picture that the Tester says shows on no screen: the check judges its reason. Not on a screen
 * only when the check says it cannot be shown; else, whatever else it said, it is not shown yet and goes back.
 */
export function fromReason(reason: string, check: CheckVerdict | undefined): { shows: Shows; why: string; advice: string } {
  if (check?.canShow === false) return { shows: 'off-screen', why: check.canShowWhy || reason, advice: '' };
  return { shows: 'not-shown', why: check?.why ?? '', advice: check?.advice ?? '' };
}

/** A reason that only says the Tester did not do it is no reason. */
const NO_REASON = /\b(?:did\s*(?:not|n't)\s+try|not\s+tried|too\s+long|no\s+time|skipped\s+it)\b/i;

/**
 * After the last retake: a "done when" with pictures that show a part of it, where the Tester says the rest cannot be
 * shown, is Not on a screen with those pictures and the Tester's reason, even when the check said it could be shown.
 * The app may refuse what the rest needs (a booking whose time has started), and a story must not stop on that: the
 * person sees the reason at their check. A row whose only picture is the same as before shows no part of it, and a
 * "done when" with no picture at all still needs both voices.
 */
export function afterLastRetake(v: { shows: Shows; why: string; advice: string }, reason: string | undefined): { shows: Shows; why: string; advice: string } {
  const said = reason?.trim();
  if (v.shows !== 'not-shown' || !said || NO_REASON.test(said) || v.why === SAME_PICTURE) return v;
  return { shows: 'off-screen', why: said, advice: '' };
}

/** A picture as the Tester hands it in for a "done when". */
export interface HandedIn {
  file: string;
  page?: string;
  /** The device it was taken on: "iPhone 16 Pro". */
  device?: string;
  note?: string;
  shows: Judged;
}

/** Puts a picture in a row as its main one, with its own page and note. */
function setMain(row: ProofShot, p: ProofPicture): void {
  row.after = p.after;
  if (p.page) row.page = p.page;
  else delete row.page;
  if (p.device) row.device = p.device;
  else delete row.device;
  if (p.note) row.note = p.note;
  else delete row.note;
}

/**
 * One round's pictures of a "done when", added to its row. The first picture of an empty row is its main one and the
 * rest go beside it; what the row already has stays, so a retake adds what is missing and loses nothing. A picture the
 * very same as one the row has takes its place, since it shows nothing new. The row's verdict is the Tester's for this
 * round: the worst of these pictures, with the words of a broken one, until squad-kit's check of them all.
 */
export function addPictures(row: ProofShot, pictures: HandedIn[], same: (a: string, b: string) => boolean = (a, b) => a === b): void {
  for (const p of pictures) {
    const picture: ProofPicture = { after: p.file, ...(p.page ? { page: p.page } : {}), ...(p.device ? { device: p.device } : {}), ...(p.note ? { note: p.note } : {}) };
    if (!row.after || same(row.after, p.file)) {
      setMain(row, picture);
      continue;
    }
    const others = (row.more ??= []);
    const at = others.findIndex((m) => same(m.after, p.file));
    if (at >= 0) others[at] = picture;
    else others.push(picture);
  }
  row.shows = (['broken', 'not-shown', 'met'] as const).find((s) => pictures.some((p) => p.shows === s));
  const broken = pictures.filter((p) => p.shows === 'broken' && p.note);
  const said = broken.find((p) => drawnFromPicture(p.note)) ?? broken[0];
  if (said) row.why = said.note!;
  else delete row.why;
}

/** One of a row's other pictures becomes its main one, and the main one takes its place beside it. */
export function makeMain(row: ProofShot, at: number): void {
  const next = row.more![at]!;
  row.more![at] = { after: row.after, ...(row.page ? { page: row.page } : {}), ...(row.device ? { device: row.device } : {}), ...(row.note ? { note: row.note } : {}) };
  setMain(row, next);
}

/** A sentence that goes on after a colon: "At phone width…" becomes "at phone width…"; "RoomFlow…" stays. */
export function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? `${s.charAt(0).toLowerCase()}${s.slice(1)}` : s;
}

/** The first sentence of a text, with its full stop. */
function firstSentence(s: string): string {
  const one = s.split(/(?<=[.!?])\s+/)[0]!.trim();
  return /[.!?]$/.test(one) ? one : `${one}.`;
}

/** "3", "3 and 5", "3, 5 and 6". */
function numbersWords(rows: OpenRow[]): string {
  const n = rows.map((r) => String(r.criterion));
  return n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n.at(-1)}` : n[0]!;
}

/**
 * The plain stop after the last round: "The screenshots show "done when" 5 is not working yet: the page scrolls
 * sideways on a phone." The points name each "done when" in its own words, with why when there are several.
 */
export function brokenStop(rows: OpenRow[]): { question: string; points: string[] } {
  if (rows.length === 1) {
    const r = rows[0]!;
    return { question: `The screenshots show "done when" ${r.criterion} is not working yet: ${lowerFirst(firstSentence(r.why))}`, points: [`"Done when" ${r.criterion}: ${r.text}`] };
  }
  return { question: `The screenshots show ${rows.length} "done when" are not working yet.`, points: rows.map((r) => `"Done when" ${r.criterion}, ${r.text}: ${r.why}`) };
}

/** The plain stop after the last retake: "The squad could not show "done when" 3 on a screen. Try it yourself, or ask a question." */
export function notShownStop(rows: OpenRow[]): { question: string; points: string[] } {
  return {
    question: `The squad could not show "done when" ${numbersWords(rows)} on a screen. Try it yourself, or ask a question.`,
    points: rows.map((r) => `"Done when" ${r.criterion}, ${r.text}: ${r.why}`),
  };
}

/** One line for the Tester's retake: which "done when", what the check saw, and exactly what to show. */
export function retakeLine(n: number, text: string, why: string, advice: string): string {
  const said = why.trim().replace(/[.!?]+$/, '');
  return `The after screenshot for "done when" ${n} ("${text}") does not show it clearly yet${said ? `: ${said}` : ''}. ${advice.trim() ? `Show it like this: ${advice.trim()}` : 'Take it again so its result shows.'}`;
}

/** One line for the Tester whose reason the check did not take: it can be shown, and how. */
export function reasonRefusedLine(n: number, text: string, reason: string, why: string, advice: string): string {
  const said = why.trim().replace(/[.!?]+$/, '');
  return `You said "done when" ${n} ("${text}") cannot be shown on a screen: ${reason.trim().replace(/[.!?]+$/, '')}. squad-kit's check says it can${said ? `: ${said}` : ''}. ${advice.trim() ? `Show it like this: ${advice.trim()}` : 'Take it now.'}`;
}

/** One line for a Tester that did not say so yet, when the check says what is missing cannot be shown: it has the last word first. */
export function cannotShowLine(n: number, text: string, why: string): string {
  return `squad-kit's check says the rest of "done when" ${n} ("${text}") cannot be shown: ${why.trim().replace(/[.!?]+$/, '')}. If you see a way to show it, take it now. If you agree, put it in offScreen with which part and why. Your pictures stay.`;
}

/** One line for the Builder: which "done when", its words, and what the screenshot shows. */
export function fixLine(r: OpenRow): string {
  return `"Done when" ${r.criterion} (${r.text}): ${r.why}`;
}

/** The "done when" the proof rows show are broken, from the ticket: for "Let the Builder try again". */
export function brokenRows(t: Pick<Ticket, 'criteria' | 'notes' | 'proof'>): OpenRow[] {
  const out: OpenRow[] = [];
  for (let n = 1; n <= doneWhenCount(t); n += 1) {
    const text = criterionText(t, n);
    const row = (t.proof ?? []).find((p) => p.criterion === text && p.shows === 'broken');
    if (text && row) out.push({ criterion: n, text, why: row.why ?? row.note ?? 'The screenshot shows it does not work as written.' });
  }
  return out;
}
