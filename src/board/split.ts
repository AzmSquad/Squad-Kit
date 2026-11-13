import fs from 'node:fs';
import path from 'node:path';
import { BoardActionError, MAX_UPLOAD_BYTES, MAX_UPLOADS, WAITS_TO_START, addNote, createTicket, type NewTicketInput, type UploadedFile } from './actions.js';
import { addBreakdown } from './requirements-actions.js';
import { andWords } from './requirements.js';
import { kindOf, wordCount } from './requirements-text.js';
import type { Breakdown } from './requirements-types.js';
import { scheduleSquad, questionWords } from './schedule.js';
import { addActivity, now, readMeta, requireTicket, updateTicket, type BoardPaths } from './store.js';
import type { ChatMessage, ProofKind, Question, SplitSuggestion, StorySplit, Ticket } from './types.js';
import { expectWait } from './wait-key.js';
import { checkSize, type SizeCheck } from '../engine/story-size.js';
import { writtenInArabic } from '../engine/prompts.js';
import type { TicketDraft } from '../engine/draft.js';

/**
 * A story too big for one: the Analyst's suggestion waits on the story ('split'), and only the person decides (ADR-004).
 * Split into its parts (the first keeps the story's id, the others wait in Tickets with "depends on"), Keep as one,
 * Change the split (the Analyst writes it again from their note), or Send to Requirements. The New ticket dialog and
 * the Squad lead's card make their stories through the same functions, before anything exists. Each choice is one call
 * here, the same for the board, REST and the terminal.
 */

/** The line a story's card shows while the suggestion waits. */
export function splitStatus(s: SplitSuggestion): string {
  return s.size === 'brd' ? 'Too big for one story' : 'The Analyst suggests a split';
}

function waitingFor(s: SplitSuggestion): string {
  return s.size === 'brd' ? 'Too big for one story: the Analyst suggests Requirements' : `The Analyst suggests splitting it into ${s.parts.length} stories`;
}

/**
 * The Analyst's first read found it too big: the suggestion waits for the person, with the questions it asked about the
 * story as it is, kept for Keep as one. Changes `t` in place (inside the live squad's update).
 */
export function holdForSplit(t: Ticket, s: SplitSuggestion, questions: Question[]): void {
  t.split = { ...t.split, suggestion: s, ...(questions.length ? { questions } : {}) };
  delete t.split.change;
  t.stage = 'tickets';
  t.live = false;
  t.squad = null;
  t.status = splitStatus(s);
  t.waiting = { kind: 'split', summary: waitingFor(s) };
  addActivity(t, 'analyst', s.size === 'brd' ? 'Found it too big for one story: a whole requirements document' : `Suggested splitting it into ${s.parts.length} stories`);
}

/** squad-kit's own count of a story's size: its ask (the title sums it up), its own lists and its documents. */
export function storySize(t: Ticket): SizeCheck {
  const b = t.brief;
  const files = (t.attachments ?? []).filter((f) => kindOf(f) && fs.existsSync(f) && fs.statSync(f).size <= MAX_UPLOAD_BYTES).map((f) => ({ name: path.basename(f), data: fs.readFileSync(f) }));
  return checkSize({ text: t.ask, lists: [...(b?.criteria ?? []), ...(b?.rules ?? []), ...(b?.edgeCases ?? [])], files });
}

/**
 * The size to judge at a story's first step, or null: clearly one story, already judged or decided, a part of a split,
 * a bug, a story from a breakdown, or one pulled from a tracker (its work item would be resolved by part 1 alone).
 */
export function sizeAtStart(t: Ticket): SizeCheck | null {
  if (t.split?.decided || t.split?.checked || t.split?.from || t.breakdown || t.kind === 'bug' || (t.track && t.track !== 'full') || t.source.type !== 'manual') return null;
  const check = storySize(t);
  return check.size === 'one' ? null : check;
}

/* ── The parts become stories ───────────────────────────── */

/** What the parts are made from: the story or text as the person wrote it, and what every part shares. */
export interface PartsFrom {
  title: string;
  ask: string;
  kind?: Ticket['kind'];
  priority?: Ticket['priority'];
  /** Its "done when" lines. Each part takes the ones the Analyst gave it; the first part also every one given to none. */
  criteria?: string[];
  proofs?: ProofKind[];
  rules?: string[];
  edgeCases?: string[];
  files?: UploadedFile[];
  /** "Write new tests" was off: no part writes new tests either. */
  noNewTests?: boolean;
}

/** The longest part of the whole text each part keeps under its own line. */
const WHOLE_TEXT = 4000;

/** A part's ask: its own line, where it comes from, and the whole text as the person wrote it, for the Analyst to read. */
function partAsk(line: string, src: PartsFrom, ids: string[]): string {
  const ar = writtenInArabic(src);
  const whole = src.ask.trim().length > WHOLE_TEXT ? `${src.ask.trim().slice(0, WHOLE_TEXT)}…` : src.ask.trim();
  const where = ar
    ? `جزء من «${src.title}» بعد تقسيمها إلى ${ids.join('، ')}. يُبنى هذا الجزء فقط.`
    : `One part of "${src.title}", split into ${andWords(ids)}. Build only this part.`;
  const was = whole && whole !== line ? `\n\n${ar ? 'النص كله كما كُتب:' : 'The whole text, as it was written:'}\n${whole}` : '';
  return `${line}\n\n${where}${was}`;
}

/**
 * The "done when" lines of part `i`: the person's own lines the Analyst gave it, then the ones it wrote for the part.
 * A line given to no part goes to none: each part's Analyst writes what it is missing, and the whole text keeps it.
 */
function partCriteria(s: SplitSuggestion, src: PartsFrom, i: number): { criteria: string[]; proofs?: ProofKind[] } {
  const all = src.criteria ?? [];
  const p = s.parts[i]!;
  const given = (p.criteria ?? []).filter((n) => n >= 1 && n <= all.length);
  const own = (p.doneWhen ?? []).filter((d) => d.trim());
  const proofs = own.length === 0 && src.proofs?.length === all.length ? given.map((n) => src.proofs![n - 1]!) : undefined;
  return { criteria: [...given.map((n) => all[n - 1]!), ...own], ...(proofs?.length ? { proofs } : {}) };
}

/**
 * Every part after it is made: its ask with where it comes from, "depends on" the parts it needs, its record, and on a
 * part that waits, the line its card shows. `ids[0]` is the first part.
 */
function linkParts(bp: BoardPaths, ids: string[], s: SplitSuggestion, src: PartsFrom, o: { lead?: string; was?: StorySplit['was'] }): Ticket[] {
  const by = readMeta(bp).user.name;
  const at = now();
  return s.parts.map((p, i) =>
    updateTicket(bp, ids[i]!, (t) => {
      t.ask = partAsk(p.line || p.title, src, ids);
      const deps = p.needs.map((n) => ids[n - 1]!).filter(Boolean);
      if (deps.length) t.dependsOn = deps;
      t.split = i === 0 ? { ...t.split, decided: { choice: 'split', by, at, made: ids }, ...(o.was ? { was: o.was } : {}) } : { from: ids[0]! };
      if (t.waitsToStart) t.status = deps.length ? `Waits for ${andWords(deps)}` : WAITS_TO_START;
      if (o.lead) t.lead = o.lead;
      addActivity(t, 'you', i === 0 ? `Split "${src.title}" into ${s.parts.length} stories: ${andWords(ids)}` : `Made from the split of "${src.title}" (${ids[0]}). Nothing starts until you press Start`);
    }),
  );
}

/**
 * New stories for parts `from` and on: each waits on the board until the person starts it, unless it is the first and
 * `startFirst`. Each has a key from `key`, the suggestion's time and its number, so a press sent again after a failure
 * part-way gets the parts it made, never a second set.
 */
function newParts(bp: BoardPaths, s: SplitSuggestion, src: PartsFrom, from: number, o: { startFirst?: boolean; key: string }): Ticket[] {
  return s.parts.slice(from).map((p, k) => {
    const i = from + k;
    return createTicket(bp, {
      title: p.title,
      ask: p.line || p.title,
      kind: src.kind ?? 'feature',
      priority: src.priority ?? 'normal',
      ...partCriteria(s, src, i),
      rules: src.rules ?? [],
      edgeCases: src.edgeCases ?? [],
      ...(src.files?.length ? { files: src.files } : {}),
      ...(src.noNewTests ? { noNewTests: true } : {}),
      ...(i === 0 && o.startFirst ? {} : { waitsToStart: true }),
      key: `${o.key}:${s.at}:${i + 1}`,
    });
  });
}

/**
 * Create N stories, before any exists: from the New ticket dialog (the first starts at once, as any new story) or the
 * Squad lead's card (every one waits for Start). The parts after the first wait in Tickets with "depends on". `key`: the
 * draft or the card it comes from.
 */
export function createParts(bp: BoardPaths, s: SplitSuggestion, src: PartsFrom, o: { startFirst: boolean; key: string; lead?: string }): Ticket[] {
  if (s.size !== 'few' || s.parts.length < 2) throw new BoardActionError('There is no split to make: create it as one story, or send it to Requirements.');
  const made = newParts(bp, s, src, 0, o);
  return linkParts(bp, made.map((t) => t.id), s, src, { ...(o.lead ? { lead: o.lead } : {}) });
}

/**
 * A draft from the New ticket dialog or the terminal, as the parts' source: the pasted text is the whole ask. Its "done
 * when" lines are for the whole text, so no part takes them: each part has its own.
 */
export function partsFromDraft(d: TicketDraft, text: string, files: UploadedFile[]): PartsFrom {
  return { title: d.title, ask: text.trim() || d.ask, kind: d.kind, priority: d.priority, rules: d.rules, edgeCases: d.edgeCases, files };
}

/* ── Send to Requirements ──────────────────────────────── */

/** Under this many words, pasted text that comes with a document is a note about it, not the document. */
const NOTE_WORDS = 300;

/**
 * Send to Requirements: a breakdown from the text and files, the same as adding a BRD on the Requirements page. A Word,
 * PDF, Markdown or text file is the document when the text is only a note about it, and the note goes with it. `name`
 * names pasted text; a document keeps its own name.
 */
export function sendToRequirements(bp: BoardPaths, input: { text: string; files?: UploadedFile[]; name?: string }): Breakdown {
  const text = input.text?.trim() ?? '';
  const files = input.files ?? [];
  const docs = files.filter((f) => kindOf(f.name));
  const textIsIt = !docs.length || checkSize({ text }).size === 'brd' || wordCount(text) >= NOTE_WORDS;
  if (textIsIt) return addBreakdown(bp, { text, with: files.slice(0, MAX_UPLOADS), ...(input.name ? { name: input.name } : {}) });
  const main = docs.reduce((a, b) => (b.data.length > a.data.length ? b : a));
  const rest = files.filter((f) => f !== main);
  const note = text ? [{ name: 'message.md', data: Buffer.from(text).toString('base64') }] : [];
  return addBreakdown(bp, { file: main, with: [...rest, ...note].slice(0, MAX_UPLOADS - 1) });
}

/* ── One story anyway ──────────────────────────────────── */

/** What a story made as one anyway keeps, for the person and every agent. */
export const AS_ONE_ANYWAY = 'Made as one story on purpose, though it reads like a whole requirements document: it is slower, costs more and is harder to check than its parts would be.';

/**
 * "Create as one story": the ticket as written, with the size already judged, so its first step asks no more. `kept`:
 * the person pressed it over a suggestion; `brd` over a whole requirements document, which keeps a short warning.
 */
export function createSized(bp: BoardPaths, input: NewTicketInput, sized: 'checked' | 'kept' | 'brd'): Ticket {
  const split: StorySplit = sized === 'checked' ? { checked: now() } : { decided: { choice: 'keep', by: readMeta(bp).user.name, at: now() } };
  const t = createTicket(bp, { ...input, split });
  return sized === 'brd' ? addNote(bp, t.id, { text: AS_ONE_ANYWAY, kind: 'note' }) : t;
}

/* ── A story that waits on its split ───────────────────── */

export interface SplitChoice {
  /** split: into its parts. keep: one story. change: the Analyst writes it again from `note`. requirements: a breakdown. */
  choice: 'split' | 'keep' | 'change' | 'requirements';
  note?: string;
  /** The mark of what a decision card showed (board/wait-key.ts): the story must still wait on it. */
  expect?: string;
}

/** The person's choice on a story's split suggestion. Nothing changes before this. */
export function decideSplit(bp: BoardPaths, id: string, input: SplitChoice): Ticket {
  expectWait(bp, id, input.expect);
  const t0 = requireTicket(bp, id);
  const s = t0.split?.suggestion;
  if (t0.waiting?.kind !== 'split' || !s) throw new BoardActionError(`${t0.id} has no split waiting for you.`);
  // Only what the card offers: a split has Split, Keep and Change; a whole document has Send to Requirements and Keep.
  const offered = s.size === 'few' ? ['split', 'keep', 'change'] : ['requirements', 'keep'];
  if (!offered.includes(input.choice)) {
    throw new BoardActionError(s.size === 'few' ? `${t0.id} has a split waiting: split it, keep it as one, or change the split.` : `${t0.id} is a whole requirements document: send it to Requirements, or keep it as one story.`);
  }
  switch (input.choice) {
    case 'split':
      return splitStory(bp, t0, s);
    case 'keep':
      return keepAsOne(bp, t0.id, s);
    case 'change':
      return changeSplit(bp, t0.id, input.note ?? '');
    case 'requirements':
      return storyToRequirements(bp, t0);
    default:
      throw new BoardActionError('Choose split, keep, change or requirements.');
  }
}

/** A story's files, as uploads again, for its parts or a breakdown. Ones gone from the disk, or too big, are left out. */
function filesOf(t: Ticket): UploadedFile[] {
  return (t.attachments ?? [])
    .filter((f) => fs.existsSync(f) && fs.statSync(f).size <= MAX_UPLOAD_BYTES)
    .slice(0, MAX_UPLOADS)
    .map((f) => ({ name: path.basename(f), data: fs.readFileSync(f).toString('base64') }));
}

/** A story as the parts' source. Its own "done when" lines stay in the whole text each part reads. */
function sourceOf(t: Ticket): PartsFrom {
  const own = t.brief?.criteria ?? [];
  return {
    title: t.title,
    ask: own.length ? `${t.ask}\n\nDone when:\n${own.map((c) => `- ${c}`).join('\n')}` : t.ask,
    kind: t.kind,
    priority: t.priority,
    criteria: t.brief?.criteria ?? [],
    ...(t.brief?.proofs ? { proofs: t.brief.proofs } : {}),
    rules: t.brief?.rules ?? [],
    edgeCases: t.brief?.edgeCases ?? [],
    files: filesOf(t),
    ...(t.noNewTests ? { noNewTests: true } : {}),
  };
}

/** Split: the first part keeps the story's id with its own title; the others wait in Tickets. The Analyst reads part 1 again. */
function splitStory(bp: BoardPaths, t0: Ticket, s: SplitSuggestion): Ticket {
  const src = sourceOf(t0);
  const rest = newParts(bp, s, src, 1, { key: t0.id });
  const ids = [t0.id, ...rest.map((t) => t.id)];
  const first = s.parts[0]!;
  const meta = readMeta(bp);
  const mine = partCriteria(s, src, 0);
  updateTicket(bp, t0.id, (t) => {
    t.title = first.title;
    if (t.brief || mine.criteria.length) t.brief = { rules: [], edgeCases: [], ...t.brief, criteria: mine.criteria, ...(mine.proofs ? { proofs: mine.proofs } : {}) };
    if (t.brief && !mine.proofs) delete t.brief.proofs;
    delete t.split?.questions;
    t.waiting = null;
    t.questions = [];
    t.live = true;
    t.status = 'Analyst is reading the ticket';
    scheduleSquad(t, 'analyst-read', 0.5, meta.speed);
  });
  return linkParts(bp, ids, s, src, { was: { title: t0.title, ask: t0.ask } })[0]!;
}

/** Keep as one: the questions asked beside the suggestion wait now, or the spec is written when there were none. */
function keepAsOne(bp: BoardPaths, id: string, s: SplitSuggestion): Ticket {
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    const questions = t.split?.questions ?? [];
    t.split = { ...t.split, decided: { choice: 'keep', by: meta.user.name, at: now() } };
    delete t.split.questions;
    t.waiting = null;
    addActivity(t, 'you', 'Kept it as one story');
    if (s.size === 'brd') {
      // A whole document was read for its size only: the Analyst reads it again as one story, with its questions.
      t.notes = [...(t.notes ?? []), { at: now(), by: meta.user.name, kind: 'note', text: AS_ONE_ANYWAY }];
      t.live = true;
      t.status = 'Analyst is reading the ticket';
      scheduleSquad(t, 'analyst-read', 0.5, meta.speed);
    } else if (questions.length) {
      t.questions = questions;
      t.stage = 'specs';
      t.live = false;
      t.status = `${questionWords(questions.length)} for you`;
      t.waiting = { kind: 'questions', summary: `${questionWords(questions.length)} from the Analyst and Architect` };
    } else {
      t.questions = [];
      t.stage = 'specs';
      t.live = true;
      t.status = 'Spec writer is writing the plan';
      scheduleSquad(t, 'plan-write', 0.5, meta.speed);
    }
  });
}

/** Change the split: the Analyst writes it again from the person's note, in the same conversation. */
function changeSplit(bp: BoardPaths, id: string, note: string): Ticket {
  const words = note.trim();
  if (!words) throw new BoardActionError('Say how to split it: one line is enough.');
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    t.split = { ...t.split, change: words };
    t.waiting = null;
    t.live = true;
    t.status = 'The Analyst is changing the split';
    addActivity(t, 'you', `Asked for another split: ${words}`);
    scheduleSquad(t, 'split-change', 0.2, meta.speed);
  });
}

/** Send to Requirements: the story's text and files become a breakdown; the story stops and waits in Tickets. */
function storyToRequirements(bp: BoardPaths, t0: Ticket): Ticket {
  const brief = t0.brief;
  const lines = [...(brief?.criteria ?? []), ...(brief?.rules ?? []), ...(brief?.edgeCases ?? [])];
  const b = sendToRequirements(bp, { text: `# ${t0.title}\n\n${t0.ask}${lines.length ? `\n\n${lines.map((l) => `- ${l}`).join('\n')}` : ''}`, files: filesOf(t0), name: t0.title });
  const meta = readMeta(bp);
  return updateTicket(bp, t0.id, (t) => {
    t.split = { ...t.split, decided: { choice: 'requirements', by: meta.user.name, at: now(), breakdown: b.id } };
    t.waiting = null;
    t.live = false;
    t.squad = null;
    t.waitsToStart = true;
    t.status = `Sent to Requirements as ${b.id}`;
    addActivity(t, 'you', `Sent it to Requirements as ${b.id}. It waits here: delete it, or start it to build it as one story`);
  });
}

/* ── A big text in a talk beside the work ──────────────── */

/**
 * The whole document pasted into a story's talk, sent to Requirements from the hint under it: `at` names the message,
 * else the newest such one. Sent once; the message keeps the breakdown, so its hint links to it from then on.
 */
export function chatToRequirements(bp: BoardPaths, id: string, at?: string): { breakdown: { id: string } } {
  const t = requireTicket(bp, id);
  const mine = (t.chat?.messages ?? []).filter((m) => m.who === 'you' && m.big === 'brd');
  const m = at ? mine.find((x) => x.at === at) : mine.at(-1);
  if (!m) throw new BoardActionError(`${t.id} has no whole document in its talk to send. A text of a few stories goes in New ticket, which suggests a split.`);
  if (m.breakdown) return { breakdown: { id: m.breakdown } };
  const b = sendToRequirements(bp, { text: m.text });
  updateTicket(bp, id, (x) => {
    const kept = x.chat?.messages.find((y) => y.who === 'you' && y.at === m.at);
    if (kept) kept.breakdown = b.id;
    addActivity(x, 'you', `Sent a document from the talk to Requirements as ${b.id}`);
  });
  return { breakdown: { id: b.id } };
}

/**
 * A text pasted into a story's talk that looks like several stories or a whole requirements document: the board
 * shows a hint under it, with no AI. A talk changes nothing on the story.
 */
export function bigText(text: string): ChatMessage['big'] | undefined {
  const size = checkSize({ text }).size;
  return size === 'few' || size === 'brd' ? size : undefined;
}
