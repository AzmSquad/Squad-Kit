import fs from 'node:fs';
import path from 'node:path';
import { listTickets, now, readMeta, readTicket, updateTicket, type BoardPaths } from './store.js';
import { BoardActionError, MAX_UPLOADS, MAX_UPLOAD_BYTES, createTicket, saveUploads, type AnswerInput, type UploadedFile } from './actions.js';
import type { Criterion, Ticket } from './types.js';
import type { Breakdown, BreakdownEpic, BreakdownFeature, BreakdownJob, BreakdownLevel, BreakdownSource, BreakdownState, BreakdownStory, Decided, StorySize } from './requirements-types.js';
import { breakdownDir } from './requirements-paths.js';
import {
  addBreakdownActivity,
  allStories,
  approveProblems,
  breakdownId,
  findItem,
  isBreakdownMine,
  itemKey,
  jobBusy,
  nextBreakdownId,
  nextKey,
  ownerOfBreakdown,
  placeWords,
  readBreakdownState,
  redoHolding,
  refWords,
  removeBreakdown,
  requireBreakdown,
  requireItem,
  storiesIn,
  storyMerged,
  updateBreakdown,
  updateBreakdownState,
  writeBreakdown,
  writeBreakdownState,
  findLoop,
  loopWords,
  type FoundItem,
} from './requirements.js';
import { DocumentError, kindOf, prepareText, type PreparedText } from './requirements-text.js';
import { isMerged } from './depends.js';
import { withFirstStory } from './first-story.js';
import { linkTickets } from './requirements-sync.js';

/**
 * What a person does with a breakdown, one function each, so the board and the terminal do exactly the same: add a
 * document, stop or retry the Analyst, answer its questions, edit the tree, approve it, and start one story.
 * Nothing is built or sent anywhere before Approve.
 */

/** The approve checks live with the breakdown's view; the page and the terminal use the same ones. */
export { approveProblems, findLoop } from './requirements.js';

/** The answer that lets the Analyst decide; it becomes a Decided for you entry. */
export const SKIP_CHOICE = 'Skip: let the Analyst decide';

const STOPPED_WORDS = 'You stopped the Analyst. Nothing is lost: Try again carries on from where it was.';

function who(bp: BoardPaths): string {
  return readMeta(bp).user.name;
}

/** Only the person who added a breakdown changes it; everyone else sees it (ADR-001). */
function mine(bp: BoardPaths, id: string): Breakdown {
  const b = requireBreakdown(bp, id);
  if (!isBreakdownMine(b, readMeta(bp))) throw new BoardActionError(`${b.id} is ${ownerOfBreakdown(b)}'s. Only they can change it.`);
  return b;
}

/** The job is busy: what to tell a person who wants to start another. */
function busyWords(b: Breakdown, job: BreakdownJob | undefined): string | null {
  if (!jobBusy(job)) return null;
  if (job!.step === 'redo') return `The Analyst is redoing ${job!.item === b.id ? 'the breakdown' : job!.item}. Try again when it is done, or stop it.`;
  if (job!.step === 'reply') return 'The Analyst is answering your question. Try again in a moment.';
  return `The Analyst is working on ${b.id} now. Try again when it is done, or stop it.`;
}

function setJob(bp: BoardPaths, id: string, job: BreakdownJob, line?: { who: 'you' | 'analyst' | 'squad'; text: string }): void {
  updateBreakdownState(bp, id, (s) => {
    s.job = job;
    if (line) addBreakdownActivity(s, line.who, line.text);
  });
}

/* ── Add ────────────────────────────────────────────────── */

export interface AddBreakdownInput {
  /** The document, as base64, the way a ticket's files are sent. */
  file?: UploadedFile;
  /** Pasted text instead of a file. */
  text?: string;
  /** What to call it; the document's name when left out. */
  name?: string;
  /** Screen mockups and other files that go with it. */
  with?: UploadedFile[];
}

/** "usually about 8 min for 31 pages": a simple guess from the length, about 15 seconds a page. */
export function usualReadSeconds(p: Pick<PreparedText, 'pages' | 'words' | 'parts'>): number {
  if (p.pages) return 60 + 15 * p.pages;
  return 60 + Math.round((p.words ?? p.parts * 3500) / 30);
}

function firstHeading(text: string): string | undefined {
  return /^#{1,3}\s+(.+)$/m.exec(text)?.[1]?.replace(/[*_`]/g, '').trim().slice(0, 80) || undefined;
}

/** What the person sees on the Reading screen once the text is ready. */
function textLine(kind: BreakdownSource['kind'], p: PreparedText): string {
  if (kind === 'pdf') return `Kept the PDF as it is for the Analyst to read: ${p.pages} ${p.pages === 1 ? 'page' : 'pages'}`;
  const parts = p.parts > 1 ? `, in ${p.parts} parts` : '';
  if (kind === 'docx') return `Turned the Word file into text${parts}. Kept the headings${p.pictures ? `, tables and ${p.pictures} ${p.pictures === 1 ? 'picture' : 'pictures'}` : ' and tables'}`;
  return `Saved the text${parts}`;
}

/**
 * Adds a BRD: the document goes into `.squad/requirements/BR-n/source/`, its text into `text/` (and a Word file's
 * pictures into `media/`), and the Analyst's read waits for the squad. An unreadable or empty document saves nothing.
 */
export function addBreakdown(bp: BoardPaths, input: AddBreakdownInput): Breakdown {
  const meta = readMeta(bp);
  const text = input.text?.trim() ? input.text : undefined;
  if (!input.file && !text) throw new BoardActionError('Add the BRD as a file, or paste its text.');
  const extra = input.with ?? [];
  if ((input.file ? 1 : 0) + extra.length > MAX_UPLOADS) throw new BoardActionError(`Add at most ${MAX_UPLOADS} files.`);
  const kind: BreakdownSource['kind'] | null = input.file ? kindOf(input.file.name) : 'pasted';
  if (!kind) throw new BoardActionError('squad-kit reads PDF, Word (.docx), Markdown and text files. Save the BRD as one of those, or paste the text.');
  if (text && Buffer.byteLength(text) > MAX_UPLOAD_BYTES) throw new BoardActionError('The pasted text is larger than 10 MB.');
  const id = nextBreakdownId(bp);
  const dir = breakdownDir(bp, id);
  const sourceDir = path.join(dir, 'source');
  let source: BreakdownSource;
  let prepared: PreparedText;
  try {
    let file: string;
    if (input.file) file = saveUploads(sourceDir, [input.file])[0]!;
    else {
      fs.mkdirSync(sourceDir, { recursive: true });
      file = path.join(sourceDir, 'pasted.md');
      fs.writeFileSync(file, text!);
    }
    const others = saveUploads(sourceDir, extra);
    const rel = (f: string) => path.relative(dir, f).split(path.sep).join('/');
    prepared = prepareText(dir, { file: rel(file), kind });
    source = {
      file: rel(file),
      name: input.file ? path.basename(file) : 'Pasted text',
      kind,
      bytes: fs.statSync(file).size,
      ...(prepared.pages ? { pages: prepared.pages } : prepared.parts ? { pages: prepared.parts } : {}),
      ...(prepared.pictures ? { pictures: prepared.pictures } : {}),
      ...(others.length ? { extra: others.map(rel) } : {}),
      addedBy: meta.user.name,
      addedAt: now(),
    };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    if (err instanceof DocumentError || err instanceof BoardActionError) throw err;
    throw new BoardActionError(`squad-kit could not save the BRD: ${(err as Error).message}`);
  }
  const title = input.name?.trim().slice(0, 120) || (input.file ? path.basename(source.name, path.extname(source.name)) : firstHeading(text!)) || 'Pasted BRD';
  const b: Breakdown = {
    id,
    title,
    status: 'reading',
    source,
    questions: [],
    epics: [],
    decided: [],
    leftOut: [],
    createdAt: now(),
    createdBy: meta.user.name,
    owner: meta.user.name,
    next: { epic: 1, feature: 1, story: 1 },
  };
  writeBreakdown(bp, b);
  const s: BreakdownState = { activity: [] };
  addBreakdownActivity(s, 'you', `Added ${source.name}${source.extra?.length ? ` with ${source.extra.length} more ${source.extra.length === 1 ? 'file' : 'files'}` : ''}`);
  addBreakdownActivity(s, 'squad', textLine(kind, prepared));
  s.job = {
    step: 'read',
    status: 'pending',
    now: 'Waiting for the Analyst',
    ...(prepared.pages || prepared.parts ? { at: { done: 0, of: prepared.pages ?? prepared.parts, unit: kind === 'pdf' ? 'page' : 'part' } } : {}),
    usualSeconds: usualReadSeconds(prepared),
  };
  writeBreakdownState(bp, id, s);
  return b;
}

/* ── The Analyst's job ──────────────────────────────────── */

/** Stop: a job waiting to run stops at once; a running one ends its run first (the live squad sees "stopping"). */
export function stopBreakdown(bp: BoardPaths, id: string): Breakdown {
  const b = mine(bp, id);
  const job = readBreakdownState(bp, b.id).job;
  if (!jobBusy(job)) throw new BoardActionError(`The Analyst is not working on ${b.id} now.`);
  if (job!.status === 'pending') return breakdownStopped(bp, b.id, true);
  updateBreakdownState(bp, b.id, (s) => {
    if (s.job) s.job.status = 'stopping';
    addBreakdownActivity(s, 'you', 'Stopped the Analyst');
  });
  return requireBreakdown(bp, b.id);
}

/**
 * The job has stopped: the breakdown waits for Try again, with nothing lost. A stopped reply or redo leaves the
 * breakdown as it was. Called by the squad once the run has ended; does nothing for a job that is not stopping.
 */
export function breakdownStopped(bp: BoardPaths, id: string, waiting = false): Breakdown {
  const s = readBreakdownState(bp, id);
  const job = s.job;
  if (!job || (job.status !== 'stopping' && !(waiting && job.status === 'pending'))) return requireBreakdown(bp, id);
  const b = updateBreakdown(bp, id, (x) => {
    if (job.step === 'reply') {
      const q = x.questions.find((y) => y.id === job.question);
      if (q) {
        q.thinking = false;
        q.thread = [...(q.thread ?? []), { who: 'squad', text: 'You stopped this answer. Ask again, or answer the question.', at: now() }];
      }
    } else if (job.step !== 'redo') {
      x.status = 'failed';
      x.error = STOPPED_WORDS;
    }
  });
  updateBreakdownState(bp, id, (st) => {
    if (!st.job) return;
    st.job.status = 'failed';
    st.job.error = job.step === 'redo' ? 'You stopped the redo. The part is as it was.' : job.step === 'reply' ? 'You stopped the answer.' : STOPPED_WORDS;
    delete st.job.now;
    if (waiting) addBreakdownActivity(st, 'you', 'Stopped the Analyst');
  });
  return b;
}

/** Try again: the step that failed or was stopped runs again; what was done before it is kept. */
export function retryBreakdown(bp: BoardPaths, id: string): Breakdown {
  const b = mine(bp, id);
  const s = readBreakdownState(bp, b.id);
  const job = s.job;
  if (jobBusy(job)) throw new BoardActionError(busyWords(b, job)!);
  if (b.status !== 'failed' && job?.status !== 'failed') throw new BoardActionError(`${b.id} did not stop. Nothing to try again.`);
  const step: BreakdownJob['step'] = job && job.status === 'failed' ? job.step : b.epics.length ? 'draft' : 'read';
  const stopped = job?.error === STOPPED_WORDS;
  const next = updateBreakdown(bp, b.id, (x) => {
    delete x.error;
    if (step === 'text' || step === 'read') x.status = 'reading';
    else if (step === 'draft') x.status = 'drafting';
    else if (x.status === 'failed') x.status = x.epics.length ? 'ready' : 'reading';
    if (step === 'reply') {
      const q = x.questions.find((y) => y.id === job?.question);
      if (q) q.thinking = true;
    }
  });
  updateBreakdownState(bp, b.id, (st) => {
    st.job = {
      step,
      status: 'pending',
      now: 'Waiting for the Analyst',
      ...(job?.at && (step === 'read' || step === 'text') ? { at: { ...job.at, done: 0 } } : {}),
      ...(job?.usualSeconds ? { usualSeconds: job.usualSeconds } : {}),
      ...(job?.item ? { item: job.item } : {}),
      ...(job?.ask ? { ask: job.ask } : {}),
      ...(job?.question ? { question: job.question } : {}),
    };
    // A run that failed may have left a conversation that cannot carry on: the next one starts fresh.
    if (!stopped && st.sessions) delete st.sessions.read;
    addBreakdownActivity(st, 'you', 'Asked the Analyst to try again');
  });
  return next;
}

/* ── Questions ──────────────────────────────────────────── */

function draftNext(bp: BoardPaths, id: string, line: string): void {
  setJob(bp, id, { step: 'draft', status: 'pending', now: 'Waiting for the Analyst' }, { who: 'you', text: line });
}

/**
 * The person's answers. Each question needs one: an option, "Other" with their own words, or Skip (the Analyst
 * decides and writes it down). Then the Analyst drafts.
 */
export function answerBreakdown(bp: BoardPaths, id: string, answers: Record<string, AnswerInput>): Breakdown {
  const b0 = mine(bp, id);
  if (b0.status !== 'questions' || !b0.questions.length) throw new BoardActionError(`${b0.id} has no open questions.`);
  const busy = busyWords(b0, readBreakdownState(bp, b0.id).job);
  if (busy) throw new BoardActionError(busy);
  let skipped = 0;
  const b = updateBreakdown(bp, b0.id, (x) => {
    for (const q of x.questions) {
      const a = answers[q.id] ?? q.answer;
      if (!a?.choice) throw new BoardActionError(`Question "${q.text}" still needs an answer, or ${SKIP_CHOICE}.`);
      if (a.choice !== SKIP_CHOICE && a.choice !== 'Other' && !q.options.includes(a.choice)) throw new BoardActionError(`"${a.choice}" is not a choice for "${q.text}".`);
      if (a.choice === 'Other' && !a.value?.trim()) throw new BoardActionError(`Write your own answer to "${q.text}".`);
      q.answer = { choice: a.choice, ...(a.value?.trim() ? { value: a.value.trim() } : {}) };
      q.thinking = false;
      if (a.choice === SKIP_CHOICE) skipped += 1;
    }
    x.status = 'drafting';
  });
  const answered = b.questions.length - skipped;
  draftNext(bp, b.id, [answered ? `Answered ${answered} ${answered === 1 ? 'question' : 'questions'}` : '', skipped ? `let the Analyst decide ${skipped}` : ''].filter(Boolean).join(' and ').replace(/^l/, 'L'));
  return b;
}

/** "Skip: let the Analyst decide" for every question still open. Each one becomes a Decided for you entry. */
export function skipBreakdownQuestions(bp: BoardPaths, id: string): Breakdown {
  const b = mine(bp, id);
  if (b.status !== 'questions') throw new BoardActionError(`${b.id} has no open questions.`);
  return answerBreakdown(bp, b.id, Object.fromEntries(b.questions.filter((q) => !q.answer).map((q) => [q.id, { choice: SKIP_CHOICE }])));
}

/** "Ask about this" on one question: the Analyst answers in the same conversation, beside the questions. */
export function askAboutQuestion(bp: BoardPaths, id: string, qid: string, text: string): Breakdown {
  const ask = text.trim();
  if (!ask) throw new BoardActionError('Write what you want to ask.');
  const b0 = mine(bp, id);
  if (b0.status !== 'questions') throw new BoardActionError(`${b0.id} has no open questions.`);
  const q0 = b0.questions.find((q) => q.id === qid.trim().toLowerCase());
  if (!q0) throw new BoardActionError(`${b0.id} has no question ${qid}.`);
  const busy = busyWords(b0, readBreakdownState(bp, b0.id).job);
  if (busy) throw new BoardActionError(busy);
  const b = updateBreakdown(bp, b0.id, (x) => {
    const q = x.questions.find((y) => y.id === q0.id)!;
    q.thread = [...(q.thread ?? []), { who: 'you', text: ask, at: now() }];
    q.thinking = true;
  });
  setJob(bp, b.id, { step: 'reply', status: 'pending', question: q0.id, now: 'Answering your question' });
  return b;
}

/* ── Edits ──────────────────────────────────────────────── */

/** The tree can be changed once the Analyst has written it, and after approval too, for stories not started. */
function editable(bp: BoardPaths, id: string, key?: string): Breakdown {
  const b = mine(bp, id);
  if (b.status !== 'ready' && b.status !== 'approved') {
    throw new BoardActionError(b.status === 'questions' ? `Answer the Analyst's questions first: then it writes the breakdown.` : `You can change ${b.id} once the Analyst has written it.`);
  }
  const job = readBreakdownState(bp, b.id).job;
  if (jobBusy(job) && job!.step === 'redo') {
    const target = job!.item === b.id ? null : findItem(b, job!.item ?? '');
    const inside = !target || !key || target.item.key === itemKey(key) || storiesIn(target).some((s) => s.key === itemKey(key)) || (target.level === 'epic' && target.epic.features.some((f) => f.key === itemKey(key)));
    if (inside) throw new BoardActionError(`The Analyst is redoing ${target ? target.item.key : 'the breakdown'}. Wait for it, or stop it.`);
  }
  return b;
}

/** A story that started is its ticket's now: it changes there. */
function notStarted(bp: BoardPaths, s: BreakdownStory): void {
  if (s.ticket && readTicket(bp, s.ticket)) throw new BoardActionError(`${s.key} started as ${s.ticket}. Change it on ${s.ticket}.`);
}

function cleanCriteria(list: Criterion[] | undefined): Criterion[] {
  const out = (list ?? []).map((c) => ({ given: String(c?.given ?? '').trim(), when: String(c?.when ?? '').trim(), then: String(c?.then ?? '').trim() }));
  if (out.some((c) => !c.given || !c.when || !c.then)) throw new BoardActionError('Each "done when" check needs its given, when and then.');
  return out;
}

function cleanSize(size: string): StorySize {
  const s = size.trim().toUpperCase();
  if (s !== 'S' && s !== 'M' && s !== 'L') throw new BoardActionError('A size is S, M or L.');
  return s;
}

/** The keys a story needs, each a story in the breakdown and never itself. */
function cleanNeeds(b: Breakdown, key: string, needs: string[]): string[] {
  const out = [...new Set(needs.map(itemKey).filter(Boolean))];
  for (const n of out) {
    if (n === key) throw new BoardActionError('A story cannot need itself.');
    if (findItem(b, n)?.level !== 'story') throw new BoardActionError(`${n} is not a story in ${b.id}.`);
  }
  return out;
}

export interface ItemPatch {
  title?: string;
  /** Epics. */
  goal?: string;
  /** Features. */
  summary?: string;
  /** Stories: "As a …, I want …, so that …". */
  story?: string;
  criteria?: Criterion[];
  size?: string;
  /** Stories: the keys of the stories it needs merged first. */
  needs?: string[];
}

const FIELDS: Record<BreakdownLevel, (keyof ItemPatch)[]> = {
  epic: ['title', 'goal'],
  feature: ['title', 'summary'],
  story: ['title', 'story', 'criteria', 'size', 'needs'],
};

function applyPatch(b: Breakdown, f: FoundItem, patch: ItemPatch): void {
  const wrong = (Object.keys(patch) as (keyof ItemPatch)[]).filter((k) => patch[k] !== undefined && !FIELDS[f.level].includes(k));
  if (wrong.length) throw new BoardActionError(`${f.item.key} is ${f.level === 'epic' ? 'an epic' : `a ${f.level}`}: it has no ${wrong.join(' or ')}.`);
  if (patch.title !== undefined) {
    if (!patch.title.trim()) throw new BoardActionError('A title cannot be empty.');
    f.item.title = patch.title.trim();
  }
  if (patch.goal !== undefined) (f.item as BreakdownEpic).goal = patch.goal.trim() || undefined;
  if (patch.summary !== undefined) (f.item as BreakdownFeature).summary = patch.summary.trim() || undefined;
  const s = f.story;
  if (!s) return;
  if (patch.story !== undefined) s.story = patch.story.trim();
  if (patch.criteria !== undefined) {
    const c = cleanCriteria(patch.criteria);
    if (!c.length) throw new BoardActionError('A story needs at least one "done when" check.');
    s.criteria = c;
  }
  if (patch.size !== undefined) s.size = cleanSize(patch.size);
  if (patch.needs !== undefined) {
    s.dependsOn = cleanNeeds(b, s.key, patch.needs);
    const loop = findLoop(b);
    if (loop) throw new BoardActionError(loopWords(loop));
  }
}

/** Changes an epic (title, goal), a feature (title, summary) or a story (title, story, done when, size, needs). */
export function editItem(bp: BoardPaths, id: string, key: string, patch: ItemPatch): Breakdown {
  const b0 = editable(bp, id, key);
  const f0 = requireItem(b0, key);
  if (f0.story) notStarted(bp, f0.story);
  const b = updateBreakdown(bp, b0.id, (x) => applyPatch(x, requireItem(x, key), patch));
  updateBreakdownState(bp, b.id, (s) => addBreakdownActivity(s, 'you', `Edited ${itemKey(key)}`));
  return b;
}

export interface NewItemInput extends ItemPatch {
  /** The epic or feature it goes under; left out for an epic. */
  under?: string;
  /** Under an epic, a feature instead of a story. */
  level?: BreakdownLevel;
  /** Put it before this part instead of at the end. */
  before?: string;
}

/** Adds an epic (nothing under), a feature (under an epic, as a feature) or a story (under an epic or a feature). */
export function addItem(bp: BoardPaths, id: string, input: NewItemInput): { breakdown: Breakdown; key: string } {
  const b0 = editable(bp, id, input.under);
  const title = input.title?.trim();
  if (!title) throw new BoardActionError('A new part needs a title.');
  let key = '';
  const b = updateBreakdown(bp, b0.id, (x) => {
    const under = input.under ? requireItem(x, input.under) : null;
    const level: BreakdownLevel = input.level ?? (!under ? 'epic' : 'story');
    if (level === 'epic' && under) throw new BoardActionError('An epic sits at the top: leave out where it goes under.');
    if (level === 'feature' && under?.level !== 'epic') throw new BoardActionError('A feature goes under an epic.');
    if (level === 'story' && (!under || under.level === 'story')) throw new BoardActionError('A story goes under a feature or an epic.');
    key = nextKey(x, level);
    const item: BreakdownEpic | BreakdownFeature | BreakdownStory =
      level === 'epic'
        ? { key, title, features: [], stories: [] }
        : level === 'feature'
          ? { key, title, stories: [] }
          : { key, title, story: '', criteria: [], size: 'M', dependsOn: [] };
    const list = (level === 'epic' ? x.epics : level === 'feature' ? under!.epic.features : under!.level === 'feature' ? under!.feature!.stories : under!.epic.stories) as (typeof item)[];
    const at = input.before ? list.findIndex((y) => y.key === itemKey(input.before!)) : -1;
    if (input.before && at < 0) throw new BoardActionError(`${itemKey(input.before)} is not in the same place, so it cannot go before it.`);
    list.splice(at < 0 ? list.length : at, 0, item);
    const { title: _t, under: _u, level: _l, before: _b, ...rest } = input;
    applyPatch(x, requireItem(x, key), rest);
  });
  updateBreakdownState(bp, b.id, (s) => addBreakdownActivity(s, 'you', `Added ${key} ${title}`));
  return { breakdown: b, key };
}

/**
 * Moves a story to another feature or epic, a feature to another epic, or any part before another one in the same
 * list (`before`).
 */
export function moveItem(bp: BoardPaths, id: string, key: string, to: { under?: string; before?: string }): Breakdown {
  if (!to.under && !to.before) throw new BoardActionError('Say where it goes: under a feature or an epic, or before another part.');
  const b0 = editable(bp, id, key);
  requireItem(b0, key);
  if (to.under) editable(bp, id, to.under);
  const b = updateBreakdown(bp, b0.id, (x) => {
    const f = requireItem(x, key);
    const under = to.under ? requireItem(x, to.under) : null;
    let list: (BreakdownEpic | BreakdownFeature | BreakdownStory)[];
    if (f.level === 'epic') {
      if (under) throw new BoardActionError('An epic sits at the top: it can only move before another epic.');
      list = x.epics;
    } else if (f.level === 'feature') {
      if (under && under.level !== 'epic') throw new BoardActionError('A feature goes under an epic.');
      list = (under ?? f).epic.features;
    } else {
      if (under?.level === 'story') throw new BoardActionError('A story goes under a feature or an epic.');
      list = under ? (under.level === 'feature' ? under.feature!.stories : under.epic.stories) : f.list;
    }
    const at = to.before ? list.findIndex((y) => y.key === itemKey(to.before!)) : -1;
    if (to.before && at < 0) throw new BoardActionError(`${itemKey(to.before)} is not ${under ? `under ${under.item.key}` : `beside ${f.item.key}`}, so it cannot go before it.`);
    if (to.before && itemKey(to.before) === f.item.key) return;
    f.list.splice(f.list.indexOf(f.item), 1);
    const place = to.before ? list.findIndex((y) => y.key === itemKey(to.before!)) : list.length;
    list.splice(place, 0, f.item);
  });
  updateBreakdownState(bp, b.id, (s) => addBreakdownActivity(s, 'you', `Moved ${itemKey(key)}${to.under ? ` under ${itemKey(to.under)}` : ''}${to.before ? ` before ${itemKey(to.before)}` : ''}`));
  return b;
}

/** Takes a part out, with everything under it, and out of every other story's needs. A started story stays. */
export function removeItem(bp: BoardPaths, id: string, key: string): Breakdown {
  const b0 = editable(bp, id, key);
  const f0 = requireItem(b0, key);
  if (storiesIn(f0).some((s) => s.setsUp)) throw new BoardActionError(FIRST_STORY_STAYS);
  const started = storiesIn(f0).filter((s) => s.ticket && readTicket(bp, s.ticket));
  if (started.length) {
    const first = started[0]!;
    throw new BoardActionError(f0.level === 'story' ? `${first.key} started as ${first.ticket}, so it stays in the breakdown.` : `${f0.item.key} has stories that started (${started.map((s) => `${s.key} as ${s.ticket}`).join(', ')}), so it stays. Move them out first.`);
  }
  const b = updateBreakdown(bp, b0.id, (x) => {
    const f = requireItem(x, key);
    const gone = new Set([f.item.key, ...storiesIn(f).map((s) => s.key), ...(f.level === 'epic' ? f.epic.features.map((y) => y.key) : [])]);
    f.list.splice(f.list.indexOf(f.item), 1);
    for (const { story } of allStories(x)) story.dependsOn = story.dependsOn.filter((n) => !gone.has(n));
    x.decided = x.decided.filter((d) => !d.item || !gone.has(d.item));
  });
  updateBreakdownState(bp, b.id, (s) => addBreakdownActivity(s, 'you', `Removed ${itemKey(key)} ${f0.item.title}`));
  return b;
}

const FIRST_STORY_STAYS = 'The project has no code yet, and the other stories build on this one, so it stays. You can change its words.';

/** "Ask the Analyst to redo this": one part rewritten with the person's words. Its key, and the keys of what stays, stay. */
export function redoItem(bp: BoardPaths, id: string, key: string, ask: string): Breakdown {
  const words = ask.trim();
  if (!words) throw new BoardActionError('Say what the Analyst should change.');
  const whole = breakdownId(key) === breakdownId(id);
  const b = editable(bp, id, whole ? undefined : key);
  const busy = busyWords(b, readBreakdownState(bp, b.id).job);
  if (busy) throw new BoardActionError(busy);
  const k = whole ? b.id : requireItem(b, key).item.key;
  const f = whole ? null : requireItem(b, key);
  if (f && storiesIn(f).some((s) => s.setsUp)) throw new BoardActionError('squad-kit wrote this story itself, so the Analyst does not redo it. You can change its words.');
  if (f?.story) notStarted(bp, f.story);
  setJob(bp, b.id, { step: 'redo', status: 'pending', item: k, ask: words, now: `Redoing ${whole ? 'the breakdown' : k}` }, { who: 'you', text: `Asked the Analyst to redo ${whole ? 'the breakdown' : k}: ${words}` });
  return b;
}

export function renameBreakdown(bp: BoardPaths, id: string, title: string): Breakdown {
  const name = title.trim();
  if (!name) throw new BoardActionError('A breakdown needs a name.');
  const b0 = mine(bp, id);
  const b = updateBreakdown(bp, b0.id, (x) => (x.title = name.slice(0, 120)));
  updateBreakdownState(bp, b.id, (s) => addBreakdownActivity(s, 'you', `Renamed it to ${b.title}`));
  return b;
}

/* ── Approve ────────────────────────────────────────────── */

/** Approve breakdown: every story has its done-when, every need is a story here, and no needs go round in a loop. */
export function approveBreakdown(bp: BoardPaths, id: string): Breakdown {
  const b0 = mine(bp, id);
  if (b0.status === 'approved') throw new BoardActionError(`${b0.id} is approved already.`);
  if (b0.status === 'questions') throw new BoardActionError(`Answer the Analyst's questions first: then it writes the breakdown.`);
  if (b0.status !== 'ready') throw new BoardActionError(`${b0.id} is not ready to approve yet.`);
  const busy = busyWords(b0, readBreakdownState(bp, b0.id).job);
  if (busy) throw new BoardActionError(busy);
  const problems = approveProblems(b0);
  if (problems.length) throw new BoardActionError(`${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''} Fix it, then approve.`);
  const by = who(bp);
  const b = updateBreakdown(bp, b0.id, (x) => {
    // A story the person added needs the first one too.
    withFirstStory(bp, x);
    x.status = 'approved';
    x.approved = { by, at: now() };
  });
  updateBreakdownState(bp, b.id, (s) => addBreakdownActivity(s, 'you', `Approved the breakdown: ${allStories(b).length} stories`));
  return b;
}

/* ── Decided for you ────────────────────────────────────── */

/**
 * Changes a Decided for you entry of the breakdown. Before its story starts, the change is recorded and the Analyst
 * redoes the part it is about. Once its story has a ticket, it changes on the ticket.
 */
export function changeDecided(bp: BoardPaths, id: string, did: string, text: string): Breakdown {
  const words = text.trim();
  if (!words) throw new BoardActionError('Say what you want instead.');
  const b0 = mine(bp, id);
  const d = b0.decided.find((x) => x.id === did.trim().toLowerCase());
  if (!d) {
    for (const { story } of allStories(b0)) {
      if (story.ticket && readTicket(bp, story.ticket)?.decided?.some((x) => x.id === did.trim().toLowerCase())) throw new BoardActionError(`Change it on ${story.ticket}.`);
    }
    throw new BoardActionError(`${b0.id} has no ${did}.`);
  }
  if (d.ticket) throw new BoardActionError(`Change it on ${d.ticket}.`);
  const about = d.item ? findItem(b0, d.item) : null;
  if (about?.story?.ticket && readTicket(bp, about.story.ticket)) throw new BoardActionError(`Change it on ${about.story.ticket}.`);
  const redo = b0.status === 'ready' || b0.status === 'approved';
  if (redo) {
    const busy = busyWords(b0, readBreakdownState(bp, b0.id).job);
    if (busy) throw new BoardActionError(busy);
  }
  const by = who(bp);
  const b = updateBreakdown(bp, b0.id, (x) => {
    const e = x.decided.find((y) => y.id === d.id)!;
    e.changed = { text: words, by, at: now() };
  });
  const target = about ? about.item.key : b.id;
  const ask = `Change this decision: "${d.text}". Instead: "${words}".`;
  if (redo) setJob(bp, b.id, { step: 'redo', status: 'pending', item: target, ask, now: `Redoing ${target === b.id ? 'the breakdown' : target}` }, { who: 'you', text: `Changed ${d.id}: ${words}` });
  else updateBreakdownState(bp, b.id, (s) => addBreakdownActivity(s, 'you', `Changed ${d.id}: ${words}`));
  return b;
}

/** The next free id for a Decided entry in a list: d1, d2 … */
export function nextDecidedId(list: Pick<Decided, 'id'>[]): string {
  const n = Math.max(0, ...list.map((d) => Number(/^d(\d+)$/.exec(d.id)?.[1] ?? 0)));
  return `d${n + 1}`;
}

/* ── Delete ─────────────────────────────────────────────── */

/** Deletes a breakdown and its document. Not while its stories build, and not while the Analyst works on it. */
export function deleteBreakdown(bp: BoardPaths, id: string): { ok: true; id: string } {
  const b = mine(bp, id);
  const building = allStories(b).filter(({ story }) => {
    const t = story.ticket ? readTicket(bp, story.ticket) : null;
    return t && !t.deleting && !t.archived && !isMerged(t);
  });
  if (building.length) throw new BoardActionError(`${b.id} has stories building (${building.map(({ story }) => `${story.key} as ${story.ticket}`).join(', ')}). Wait until they merge, or delete those tickets first.`);
  const job = readBreakdownState(bp, b.id).job;
  if (job && (job.status === 'running' || job.status === 'stopping')) throw new BoardActionError(`The Analyst is working on ${b.id}. Stop it first.`);
  removeBreakdown(bp, b.id);
  return { ok: true, id: b.id };
}

/* ── Start one story ────────────────────────────────────── */

function andWords(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
}

/**
 * A live ticket made for this story before, that the story does not name yet: a start cut off between making the
 * ticket and saving it on the story.
 */
function madeBefore(bp: BoardPaths, b: Breakdown, key: string): Ticket | undefined {
  return listTickets(bp).find((t) => t.breakdown?.id === b.id && t.breakdown.item === key && !t.deleting && !t.archived);
}

/**
 * Starts one story of an approved breakdown as a ticket on the Builds by itself track: its story and done-when come
 * approved with the breakdown, the small choices made about it come along, and it depends on the tickets of the
 * stories it needs. Only once everything it needs is merged, and not while the Analyst redoes the part it is in. A
 * story already sent to the tracker links its ticket to its item, so the item moves forward as a pulled ticket's does.
 * A ticket made for the story by a start that was cut off is used again, never made twice. `by`: the squad, when
 * Build continuously starts it.
 */
export function startStory(bp: BoardPaths, id: string, key: string, opts: { by?: 'you' | 'squad' } = {}): Ticket {
  const b = mine(bp, id);
  if (b.status !== 'approved' || !b.approved) throw new BoardActionError(`Approve ${b.id} first. Nothing is built before the breakdown is approved.`);
  const f = requireItem(b, key);
  if (f.level !== 'story') throw new BoardActionError(`Only a story starts. ${f.item.key} is ${f.level === 'epic' ? 'an epic' : 'a feature'}.`);
  const story = f.story!;
  const had = story.ticket ? readTicket(bp, story.ticket) : null;
  if (had && !had.deleting) throw new BoardActionError(`${story.key} started already, as ${had.id}.`);
  const ticketsOfNeeds = () => story.dependsOn.map((n) => findItem(b, n)?.story?.ticket).filter((t): t is string => Boolean(t && readTicket(bp, t)));
  const before = madeBefore(bp, b, story.key);
  if (before) {
    const deps = ticketsOfNeeds();
    if (deps.length && !before.dependsOn?.length) updateTicket(bp, before.id, (t) => (t.dependsOn = deps));
    const after = updateBreakdown(bp, b.id, (x) => {
      const s = findItem(x, story.key)?.story;
      if (s) s.ticket = before.id;
      for (const d of x.decided) if (d.item === story.key && !d.ticket) d.ticket = before.id;
    });
    if (story.tracker) linkTickets(bp, after);
    updateBreakdownState(bp, b.id, (s) => addBreakdownActivity(s, 'squad', `${story.key} has its ticket ${before.id} from a start that was cut off: it carries on there`));
    return readTicket(bp, before.id) ?? before;
  }
  const redo = redoHolding(b, readBreakdownState(bp, b.id).job, story.key);
  if (redo) throw new BoardActionError(`The Analyst is redoing ${redo}. ${story.key} can start once the redo is done.`);
  if (!story.criteria.length) throw new BoardActionError(`${story.key} has no "done when" yet. Add one first.`);
  const waits = story.dependsOn.filter((n) => {
    const need = findItem(b, n)?.story;
    return need && !storyMerged(bp, need);
  });
  if (waits.length) throw new BoardActionError(`${story.key} starts after ${andWords(waits)} ${waits.length === 1 ? 'merges' : 'merge'}.`);
  const place = { story, epic: f.epic, ...(f.feature ? { feature: f.feature } : {}) };
  const decided = b.decided.filter((d) => d.item === story.key && !d.ticket).map((d, i) => ({ ...d, id: `d${i + 1}` }));
  const ask = [
    story.story || story.title,
    `From ${b.id} › ${placeWords(place)}.`,
    `In the BRD: ${[refWords(story.ref), b.source.name].filter(Boolean).join(', in ')}.`,
  ].join('\n\n');
  const ticket = createTicket(bp, {
    title: story.title,
    ask,
    fromBreakdown: { id: b.id, item: story.key, story: story.story || story.title, criteria: story.criteria, approvedBy: b.approved.by, ...(decided.length ? { decided } : {}), ...(story.setsUp ? { setsUp: true } : {}) },
  });
  const deps = ticketsOfNeeds();
  if (deps.length) updateTicket(bp, ticket.id, (t) => (t.dependsOn = deps));
  const after = updateBreakdown(bp, b.id, (x) => {
    const s = findItem(x, story.key)?.story;
    if (s) s.ticket = ticket.id;
    for (const d of x.decided) if (d.item === story.key && !d.ticket) d.ticket = ticket.id;
  });
  // Sent already: the ticket gets the story's item as its source, and the move to Active is queued as for any ticket.
  if (story.tracker) linkTickets(bp, after);
  updateBreakdownState(bp, b.id, (s) => addBreakdownActivity(s, opts.by ?? 'you', `Started ${story.key} as ${ticket.id}`));
  return readTicket(bp, ticket.id) ?? ticket;
}
