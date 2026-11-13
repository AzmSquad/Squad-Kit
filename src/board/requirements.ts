import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { listReleases, listTickets, now, readMeta, readableTicket, recordProblemWords, ticketProblem, type BoardPaths, type BrokenRecord } from './store.js';
import { BoardActionError } from './actions.js';
import type { Activity, Actor, BoardMeta, Payment, Release, Ticket } from './types.js';
import type {
  Breakdown,
  BreakdownEpic,
  BreakdownEstimate,
  BreakdownFeature,
  BreakdownJob,
  BreakdownLevel,
  BreakdownRow,
  BreakdownState,
  BreakdownStory,
  BreakdownView,
  Decided,
  StoryProgress,
  StorySize,
} from './requirements-types.js';
import { breakdownDir, breakdownFile, breakdownStateFile, requirementsDir } from './requirements-paths.js';
import { sameName } from './owner.js';
import { isMerged } from './depends.js';
import { workSeconds } from './cost.js';
import { totalOf } from './usage.js';
import { howPaid } from './payment.js';
import { parallelLimit } from '../core/settings.js';
import { sendTargetOf } from './requirements-tracker.js';
import { mergeWait, mergeWaitWords } from './auto.js';
import { hasMergeMarks, isPlain, wrongField, type FieldShape } from './shape.js';

/**
 * The breakdowns' files (ADR-001). The project's part of each one is `.squad/requirements/BR-1/breakdown.yaml`, next
 * to its document; what only this computer needs (the Analyst's job, the build switch, the activity, what it used) is
 * `~/.squad-kit/projects/<id>/requirements/BR-1.yaml`. Only the person who added a breakdown has its squad run its jobs.
 */

/* ── Files ──────────────────────────────────────────────── */

/** Write through a temp file, so the board and a terminal command never see half a file. Unchanged files stay. */
function writeFile(file: string, text: string): void {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function dumpYaml(data: unknown): string {
  return yaml.dump(JSON.parse(JSON.stringify(data)), { lineWidth: 110, noRefs: true });
}

/** Reads are kept by the file's change time, so the live loop can look every second without parsing every time. */
const cache = new Map<string, { stamp: string; value: unknown }>();

function readYaml<T>(file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  const st = fs.statSync(file);
  const stamp = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(file);
  if (hit?.stamp === stamp) return structuredClone(hit.value) as T;
  const value = yaml.load(fs.readFileSync(file, 'utf8')) as T;
  cache.set(file, { stamp, value });
  return structuredClone(value);
}

/* ── Breakdowns ─────────────────────────────────────────── */

const ID = /^BR-(\d{1,9})$/;

/** "br-1" → "BR-1". */
export function breakdownId(id: string): string {
  return id.trim().toUpperCase();
}

function idNumber(id: string): number {
  return Number(ID.exec(id)?.[1] ?? 0);
}

/** A breakdown file that reads, with the lists it may leave out filled in. */
function fill(b: Breakdown): Breakdown {
  b.questions ??= [];
  b.epics ??= [];
  b.decided ??= [];
  b.leftOut ??= [];
  b.next ??= { epic: 1, feature: 1, story: 1 };
  for (const e of b.epics) {
    e.features ??= [];
    e.stories ??= [];
    for (const f of e.features) f.stories ??= [];
  }
  for (const s of allStories(b)) {
    s.story.criteria ??= [];
    s.story.dependsOn ??= [];
  }
  return b;
}

/** A file named in breakdown.yaml: inside the breakdown's own source/ folder, or nothing. */
function sourcePath(f: unknown): string | null {
  if (typeof f !== 'string' || !f.startsWith('source/') || f.includes('\\') || f.includes('\0')) return null;
  return f.split('/').some((x) => !x || x === '.' || x === '..') ? null : f;
}

const STATUSES = new Set<string>(['reading', 'questions', 'drafting', 'ready', 'approved', 'failed']);
const KINDS = new Set<string>(['pdf', 'docx', 'markdown', 'text', 'pasted']);

const BREAKDOWN_FIELDS: Record<string, FieldShape> = { title: 'text', createdAt: 'text', createdBy: 'text', owner: 'text', summary: 'text', error: 'text', questions: 'objects', epics: 'objects', decided: 'objects', leftOut: 'objects', next: 'object', approved: 'object' };
const QUESTION_FIELDS: Record<string, FieldShape> = { id: 'text', text: 'text', options: 'texts', inputOption: 'text', thread: 'objects' };
const DECIDED_FIELDS: Record<string, FieldShape> = { id: 'text', text: 'text', item: 'text', ticket: 'text', changed: 'object' };
const EPIC_FIELDS: Record<string, FieldShape> = { key: 'text', title: 'text', goal: 'text', summary: 'text', features: 'objects', stories: 'objects', ref: 'object', tracker: 'object' };
const STORY_FIELDS: Record<string, FieldShape> = { key: 'text', title: 'text', story: 'text', criteria: 'objects', size: 'text', dependsOn: 'texts', ref: 'object', ticket: 'text', tracker: 'object', setsUp: 'yes-no' };

function first(list: unknown[], check: (x: Record<string, unknown>) => string | null): string | null {
  for (const x of list) {
    const wrong = check(x as Record<string, unknown>);
    if (wrong) return wrong;
  }
  return null;
}

/** A part of the tree: the key and title the pages always read, then its fields. */
function partProblem(x: Record<string, unknown>, fields: Record<string, FieldShape>): string | null {
  if (typeof x.key !== 'string' || !x.key) return 'A part of the tree has no key.';
  if (typeof x.title !== 'string') return `${x.key} has no title.`;
  const wrong = wrongField(x, fields);
  return wrong && `${x.key}: ${wrong}`;
}

function storyProblem(x: Record<string, unknown>): string | null {
  return partProblem(x, STORY_FIELDS) ?? first((x.criteria as unknown[] | undefined) ?? [], (c) => (['given', 'when', 'then'].every((k) => c[k] === undefined || typeof c[k] === 'string') ? null : `${x.key}: a "done when" is not in the right form.`));
}

/** What the pages need from a breakdown file, or why it does not have it. What it may leave out is filled in after. */
function breakdownShapeProblem(b: Record<string, unknown>): string | null {
  if (!b.id) return 'It has no id.';
  if (!isPlain(b.source)) return 'It does not say which document it came from.';
  if (!sourcePath(b.source.file)) return "The document it names is not in its own source folder.";
  if (typeof b.source.name !== 'string' || !KINDS.has(String(b.source.kind))) return "It does not say what the document is.";
  if (typeof b.title !== 'string' || !b.title) return 'It has no title.';
  if (!STATUSES.has(String(b.status))) return `"${String(b.status)}" is not a state of a breakdown.`;
  const wrong = wrongField(b, BREAKDOWN_FIELDS);
  if (wrong) return wrong;
  if (b.source.extra !== undefined && !Array.isArray(b.source.extra)) return '"extra" is not in the right form.';
  return (
    first((b.questions as unknown[] | undefined) ?? [], (q) => wrongField(q, QUESTION_FIELDS) ?? (typeof q.text === 'string' ? null : 'A question has no words.')) ??
    first((b.decided as unknown[] | undefined) ?? [], (d) => wrongField(d, DECIDED_FIELDS)) ??
    first((b.leftOut as unknown[] | undefined) ?? [], (l) => (typeof l.text === 'string' ? null : 'A left out item has no words.')) ??
    first((b.epics as unknown[] | undefined) ?? [], (e) =>
      partProblem(e, EPIC_FIELDS) ??
      first((e.stories as unknown[] | undefined) ?? [], storyProblem) ??
      first((e.features as unknown[] | undefined) ?? [], (f) => partProblem(f, EPIC_FIELDS) ?? first((f.stories as unknown[] | undefined) ?? [], storyProblem)),
    )
  );
}

const looked = new Map<string, { stamp: string; problem: string | null }>();

/** Why the breakdown's own file cannot be read, for engineers, or null. One look per change of the file: the live loop asks every second. */
function breakdownFileProblem(bp: BoardPaths, key: string): string | null {
  const file = breakdownFile(bp, key);
  if (!fs.existsSync(file)) return null;
  const st = fs.statSync(file);
  const stamp = `${st.mtimeMs}:${st.size}`;
  const hit = looked.get(file);
  if (hit?.stamp === stamp) return hit.problem;
  let problem: string | null;
  try {
    if (hasMergeMarks(fs.readFileSync(file, 'utf8'))) problem = 'It still has the marks of a merge in it.';
    else {
      const b = readYaml<unknown>(file);
      problem = isPlain(b) ? breakdownShapeProblem(b) : 'It is not a breakdown.';
    }
  } catch (err) {
    problem = (err as Error).message;
  }
  looked.set(file, { stamp, problem });
  return problem;
}

/**
 * A breakdown by its id, or null when it is not there or its file cannot be read (breakdownProblem says so).
 * breakdown.yaml is shared in git, so what it says about itself is checked: its id is always its folder's name, and the
 * files it names must sit in its own source/ folder (else it does not read).
 */
export function readBreakdown(bp: BoardPaths, id: string): Breakdown | null {
  const key = breakdownId(id);
  if (!ID.test(key) || breakdownFileProblem(bp, key)) return null;
  try {
    const b = readYaml<Breakdown>(breakdownFile(bp, key));
    if (!b) return null;
    b.id = key;
    if (b.source.extra) b.source.extra = b.source.extra.filter((f) => sourcePath(f));
    return fill(b);
  } catch {
    return null;
  }
}

/** The plain words when this breakdown's file cannot be read, else null. */
export function breakdownProblem(bp: BoardPaths, id: string): string | null {
  const key = breakdownId(id);
  return ID.test(key) && breakdownFileProblem(bp, key) ? recordProblemWords('breakdown', key) : null;
}

export function requireBreakdown(bp: BoardPaths, id: string): Breakdown {
  const b = readBreakdown(bp, id);
  if (!b) throw new BoardActionError(breakdownProblem(bp, id) ?? `No breakdown ${breakdownId(id)} in this project.`);
  return b;
}

/** Breakdowns whose file cannot be read, so they are never silently gone from the Requirements page. */
export function brokenBreakdowns(bp: BoardPaths): BrokenRecord[] {
  const dir = requirementsDir(bp);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((d) => ID.test(d))
    .flatMap((d) => {
      const detail = breakdownFileProblem(bp, d);
      return detail ? [{ kind: 'breakdown' as const, id: d, problem: recordProblemWords('breakdown', d), file: path.relative(bp.root, breakdownFile(bp, d)), detail }] : [];
    })
    .sort((a, b) => idNumber(a.id) - idNumber(b.id));
}

/** Every breakdown in the project, oldest first. */
export function listBreakdowns(bp: BoardPaths): Breakdown[] {
  const dir = requirementsDir(bp);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((d) => ID.test(d))
    .map((d) => readBreakdown(bp, d))
    .filter((b): b is Breakdown => Boolean(b))
    .sort((a, b) => idNumber(a.id) - idNumber(b.id));
}

export function writeBreakdown(bp: BoardPaths, b: Breakdown): void {
  if (b.source.kind !== 'pdf') dropPages(b);
  writeFile(breakdownFile(bp, b.id), dumpYaml(b));
}

/** Only a PDF has fixed pages. In a Word, Markdown or pasted document a page number is a guess, so places keep only their section. */
function dropPages(b: Breakdown): void {
  const refs = [
    ...b.questions.flatMap((q) => q.refs ?? []),
    ...b.leftOut.map((l) => l.ref),
    ...b.epics.flatMap((e) => [e.ref, ...e.stories.map((s) => s.ref), ...e.features.flatMap((f) => [f.ref, ...f.stories.map((s) => s.ref)])]),
  ];
  for (const r of refs) if (r) delete r.page;
}

/** Read, change and save one breakdown. */
export function updateBreakdown(bp: BoardPaths, id: string, change: (b: Breakdown) => void): Breakdown {
  const b = requireBreakdown(bp, id);
  change(b);
  writeBreakdown(bp, b);
  return b;
}

/** The next free name, BR-1, BR-2 …: after every breakdown in the project and on this computer, so none is given twice. */
export function nextBreakdownId(bp: BoardPaths): string {
  const taken = [requirementsDir(bp), path.dirname(breakdownStateFile(bp, 'BR-1'))]
    .filter((d) => fs.existsSync(d))
    .flatMap((d) => fs.readdirSync(d).map((f) => idNumber(f.replace(/\.yaml$/, ''))));
  return `BR-${Math.max(0, ...taken) + 1}`;
}

/** Removes a breakdown from both homes: its folder with the document, and this computer's part. */
export function removeBreakdown(bp: BoardPaths, id: string): void {
  fs.rmSync(breakdownDir(bp, breakdownId(id)), { recursive: true, force: true });
  fs.rmSync(breakdownStateFile(bp, breakdownId(id)), { force: true });
}

/* ── This computer's part ───────────────────────────────── */

const STATE_FIELDS: Record<string, FieldShape> = { job: 'object', sessions: 'object', build: 'object', sync: 'object', usage: 'objects', budgetOk: 'text' };

/**
 * This computer's part. What cannot be read is dropped, never thrown: the breakdown itself is safe in the project, and
 * one left waiting on a job that is gone has Try again (`lost`).
 */
export function readBreakdownState(bp: BoardPaths, id: string): BreakdownState {
  if (!ID.test(breakdownId(id))) return { activity: [] };
  try {
    const raw = readYaml<unknown>(breakdownStateFile(bp, breakdownId(id)));
    if (raw === undefined) return { activity: [] };
    if (!isPlain(raw) || wrongField(raw, STATE_FIELDS)) throw new Error('not its shape');
    const s = raw as unknown as BreakdownState;
    return { ...s, activity: Array.isArray(s.activity) ? s.activity : [] };
  } catch {
    return { activity: [], lost: true };
  }
}

export function writeBreakdownState(bp: BoardPaths, id: string, state: BreakdownState): void {
  const { lost: _lost, ...kept } = state;
  writeFile(breakdownStateFile(bp, breakdownId(id)), dumpYaml(kept));
}

export function updateBreakdownState(bp: BoardPaths, id: string, change: (s: BreakdownState) => void): BreakdownState {
  const s = readBreakdownState(bp, id);
  change(s);
  writeBreakdownState(bp, id, s);
  return s;
}

/** The newest 200 lines are kept. */
const KEEP_ACTIVITY = 200;

/** One line of what happened to a breakdown, newest first. */
export function addBreakdownActivity(s: BreakdownState, who: Actor, text: string): void {
  s.activity = [{ at: now(), who, text } satisfies Activity, ...(s.activity ?? [])].slice(0, KEEP_ACTIVITY);
}

export function logBreakdown(bp: BoardPaths, id: string, who: Actor, text: string): void {
  updateBreakdownState(bp, id, (s) => addBreakdownActivity(s, who, text));
}

/** The Analyst's job changed in place, when there is one. */
export function updateJob(bp: BoardPaths, id: string, change: (j: BreakdownJob, s: BreakdownState) => void): BreakdownState {
  return updateBreakdownState(bp, id, (s) => {
    if (s.job) change(s.job, s);
  });
}

/** A job that is waiting to run, running, or being stopped. */
export function jobBusy(job: BreakdownJob | undefined): boolean {
  return job?.status === 'pending' || job?.status === 'running' || job?.status === 'stopping';
}

/** The breakdowns whose job this computer's squad runs now: mine, with a job waiting, running or being stopped. */
export function breakdownJobs(bp: BoardPaths, meta: Pick<BoardMeta, 'user'>): { id: string; job: BreakdownJob }[] {
  const dir = path.dirname(breakdownStateFile(bp, 'BR-1'));
  if (!fs.existsSync(dir)) return [];
  const out: { id: string; job: BreakdownJob }[] = [];
  for (const f of fs.readdirSync(dir)) {
    const id = f.replace(/\.yaml$/, '');
    if (!ID.test(id)) continue;
    const job = readBreakdownState(bp, id).job;
    if (!job || !jobBusy(job)) continue;
    const b = readBreakdown(bp, id);
    if (b && isBreakdownMine(b, meta)) out.push({ id, job });
  }
  return out;
}

/* ── Owner ──────────────────────────────────────────────── */

export function ownerOfBreakdown(b: Pick<Breakdown, 'owner' | 'createdBy'>): string {
  return b.owner?.trim() || b.createdBy;
}

/** Only the person who added it has their squad read, build and send it (ADR-001). */
export function isBreakdownMine(b: Pick<Breakdown, 'owner' | 'createdBy'>, meta: Pick<BoardMeta, 'user'>): boolean {
  return sameName(ownerOfBreakdown(b), meta.user?.name);
}

/* ── Keys and the tree ──────────────────────────────────── */

const PREFIX: Record<BreakdownLevel, string> = { epic: 'E', feature: 'F', story: 'S' };

/** "s-4" → "S-4". */
export function itemKey(key: string): string {
  return key.trim().toUpperCase();
}

/** The level a key names, from its letter. */
export function levelOf(key: string): BreakdownLevel | null {
  const m = /^([EFS])-\d+$/.exec(itemKey(key));
  return m ? (({ E: 'epic', F: 'feature', S: 'story' }) as const)[m[1] as 'E' | 'F' | 'S'] : null;
}

/** The next key of a level, from `next`. A removed key is never given again. */
export function nextKey(b: Breakdown, level: BreakdownLevel): string {
  const used = new Set(allKeys(b));
  let key = `${PREFIX[level]}-${b.next[level]}`;
  while (used.has(key)) {
    b.next[level] += 1;
    key = `${PREFIX[level]}-${b.next[level]}`;
  }
  b.next[level] += 1;
  return key;
}

export interface StoryPlace {
  story: BreakdownStory;
  epic: BreakdownEpic;
  feature?: BreakdownFeature;
}

/** Every story, in the tree's order: each epic's features and their stories, then the stories straight under it. */
export function allStories(b: Pick<Breakdown, 'epics'>): StoryPlace[] {
  return (b.epics ?? []).flatMap((epic) => [
    ...(epic.features ?? []).flatMap((feature) => (feature.stories ?? []).map((story) => ({ story, epic, feature }))),
    ...(epic.stories ?? []).map((story) => ({ story, epic })),
  ]);
}

export function allKeys(b: Pick<Breakdown, 'epics'>): string[] {
  return (b.epics ?? []).flatMap((e) => [e.key, ...(e.features ?? []).map((f) => f.key)]).concat(allStories(b).map((s) => s.story.key));
}

export interface FoundItem {
  level: BreakdownLevel;
  item: BreakdownEpic | BreakdownFeature | BreakdownStory;
  epic: BreakdownEpic;
  feature?: BreakdownFeature;
  story?: BreakdownStory;
  /** The list the item sits in, so it can be moved or taken out. */
  list: (BreakdownEpic | BreakdownFeature | BreakdownStory)[];
}

/** An epic, feature or story by its key. */
export function findItem(b: Breakdown, key: string): FoundItem | null {
  const k = itemKey(key);
  for (const epic of b.epics) {
    if (epic.key === k) return { level: 'epic', item: epic, epic, list: b.epics };
    for (const feature of epic.features) {
      if (feature.key === k) return { level: 'feature', item: feature, epic, feature, list: epic.features };
      const story = feature.stories.find((s) => s.key === k);
      if (story) return { level: 'story', item: story, epic, feature, story, list: feature.stories };
    }
    const story = epic.stories.find((s) => s.key === k);
    if (story) return { level: 'story', item: story, epic, story, list: epic.stories };
  }
  return null;
}

export function requireItem(b: Breakdown, key: string): FoundItem {
  const f = findItem(b, key);
  if (!f) throw new BoardActionError(`${b.id} has no ${itemKey(key)}.`);
  return f;
}

/** The stories inside an epic or a feature, or the story itself. */
export function storiesIn(f: FoundItem): BreakdownStory[] {
  if (f.level === 'story') return [f.story!];
  if (f.level === 'feature') return f.feature!.stories;
  return [...f.epic.features.flatMap((x) => x.stories), ...f.epic.stories];
}

/**
 * A redo waiting or running rewrites a part: the words for that part ("E-2", or "the breakdown" for a whole redo) when
 * the story is inside it, else null. Such a story does not start until the redo is done, so the redo never rewrites a
 * story that is being built.
 */
export function redoHolding(b: Breakdown, job: BreakdownJob | undefined, key: string): string | null {
  if (!jobBusy(job) || job!.step !== 'redo') return null;
  if (job!.item === b.id) return 'the breakdown';
  const target = findItem(b, job!.item ?? '');
  return target && storiesIn(target).some((s) => s.key === itemKey(key)) ? target.item.key : null;
}

/** The stories no ticket has yet that a redo made or changed: on an approved breakdown nobody has read them yet. */
export function rewrittenStories(before: Pick<Breakdown, 'epics'>, after: Pick<Breakdown, 'epics'>): string[] {
  const words = (s: BreakdownStory) => JSON.stringify([s.title, s.story, s.criteria, s.size, s.dependsOn]);
  const was = new Map(allStories(before).map(({ story }) => [story.key, words(story)]));
  return allStories(after).filter(({ story }) => !story.ticket && was.get(story.key) !== words(story)).map(({ story }) => story.key);
}

/** The stories rewritten since the person last said to build, that can still start. */
export function unreadStories(b: Pick<Breakdown, 'epics'>, state: Pick<BreakdownState, 'rewritten'>): string[] {
  return allStories(b).filter(({ story }) => !story.ticket && state.rewritten?.includes(story.key)).map(({ story }) => story.key);
}

/** One writing run of the Analyst on this breakdown, from what its runs used so far; at least a dollar. */
function wholeRedoCost(state: Pick<BreakdownState, 'usage'>): number {
  const lines = (state.usage ?? []).filter((l) => l.step === 'spec' && typeof l.costUsd === 'number');
  const runs = lines.reduce((n, l) => n + l.runs, 0);
  const each = runs ? lines.reduce((n, l) => n + (l.costUsd ?? 0), 0) / runs : 0;
  return Math.round(Math.max(1, each) * 10) / 10;
}

/** Said before a change that redoes the whole breakdown: what it does, and the rough cost. */
export function wholeRedoWords(state: Pick<BreakdownState, 'usage'>): string {
  return `This decision is not about one part, so the Analyst rewrites the whole breakdown. Stories that started stay as they are. That uses about $${wholeRedoCost(state).toFixed(2)} of AI at API prices.`;
}

/** "Payments › Invoices and refunds › S-14", for a ticket's link back and the terminal. */
export function placeWords(p: StoryPlace): string {
  return [p.epic.title, p.feature?.title, p.story.key].filter(Boolean).join(' › ');
}

/** "3.4 Holding a slot, page 7". */
export function refWords(ref: Pick<NonNullable<BreakdownStory['ref']>, 'section' | 'title' | 'page'> | undefined): string {
  if (!ref) return '';
  const where = [ref.section, ref.title].filter(Boolean).join(' ');
  return [where, ref.page ? `page ${ref.page}` : ''].filter(Boolean).join(', ');
}

/* ── Approve checks ─────────────────────────────────────── */

/** "S-4 needs S-6, which needs S-4": the first loop in the stories' needs, as its keys, or null. */
export function findLoop(b: Pick<Breakdown, 'epics'>): string[] | null {
  const needs = new Map(allStories(b).map(({ story }) => [story.key, story.dependsOn]));
  const state = new Map<string, 'open' | 'done'>();
  const trail: string[] = [];
  const visit = (k: string): string[] | null => {
    if (state.get(k) === 'done') return null;
    if (state.get(k) === 'open') return [...trail.slice(trail.indexOf(k)), k];
    state.set(k, 'open');
    trail.push(k);
    for (const n of needs.get(k) ?? []) {
      if (!needs.has(n)) continue;
      const loop = visit(n);
      if (loop) return loop;
    }
    trail.pop();
    state.set(k, 'done');
    return null;
  };
  for (const k of needs.keys()) {
    const loop = visit(k);
    if (loop) return loop;
  }
  return null;
}

export function loopWords(loop: string[]): string {
  return `That makes a loop: ${loop.slice(0, -1).map((k, i) => `${k} needs ${loop[i + 1]}`).join(', ')}. Take one need away.`;
}

/** What stops the breakdown from being approved, in plain words; empty when it is ready. */
export function approveProblems(b: Breakdown): string[] {
  const stories = allStories(b);
  if (!stories.length) return [`${b.id} has no stories yet. Add one, or ask the Analyst to.`];
  const out: string[] = [];
  const keys = new Set(stories.map((s) => s.story.key));
  for (const { story } of stories) {
    if (!story.criteria.length) out.push(`${story.key} has no "done when" yet.`);
    for (const n of story.dependsOn) if (!keys.has(n)) out.push(`${story.key} needs ${n}, which is not in ${b.id}.`);
  }
  const loop = findLoop(b);
  if (loop) out.push(loopWords(loop));
  return out;
}

/* ── Story progress ─────────────────────────────────────── */

function clockWords(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `at ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `on ${d.getDate()} ${d.toLocaleString('en', { month: 'short' })}`;
}

/** "RO-22", "RO-22 and RO-23", "RO-22, RO-23 and RO-24". */
export function andWords(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
}

/** Why a ticket waits for the person, as one of the stop tags. */
export function stopOf(t: Ticket): NonNullable<StoryProgress['stop']> {
  if (t.agentQuestion && !t.agentQuestion.answer && t.agentQuestion.kind) return t.agentQuestion.kind;
  const gate = t.waiting?.kind === 'stuck' ? t.stuck?.gate : undefined;
  if (gate === 'checks' || gate === 'review' || gate === 'proof') return 'check';
  return 'other';
}

const STOP_WORDS: Record<NonNullable<StoryProgress['stop']>, string> = {
  gap: 'missing in the BRD',
  clash: 'two parts clash',
  check: 'a check failed',
  other: '',
};

/** The tickets of the stories, read once. */
function ticketsOf(bp: BoardPaths, b: Breakdown): Map<string, Ticket> {
  const out = new Map<string, Ticket>();
  for (const { story } of allStories(b)) {
    if (!story.ticket) continue;
    const t = readableTicket(bp, story.ticket);
    if (t && !t.deleting) out.set(story.key, t);
  }
  return out;
}

function releasedIn(releases: Release[], id: string): Release | undefined {
  return releases.find((r) => r.status === 'released' && r.tickets.includes(id));
}

/** True when the story's change is in the base branch: its ticket is merged or released. */
export function storyMerged(bp: BoardPaths, s: BreakdownStory): boolean {
  if (!s.ticket) return false;
  const t = readableTicket(bp, s.ticket);
  return Boolean(t && isMerged(t));
}

/**
 * Where each story is, from its ticket. With no ticket yet: once the breakdown is approved, waiting for the stories
 * it needs (Build continuously on or not); else not started, or next while Build continuously is on. A story whose
 * ticket a person deleted starts again only when they press Start. A story whose accepted change waits for a pull
 * request's approver, or for the person's own checkout, needs someone, and so does a ticket whose file cannot be read.
 */
export function storyProgress(bp: BoardPaths, b: Breakdown, state: BreakdownState): StoryProgress[] {
  const tickets = ticketsOf(bp, b);
  const releases = listReleases(bp);
  const merged = (key: string) => {
    const t = tickets.get(key);
    return Boolean(t && isMerged(t));
  };
  return allStories(b).map(({ story }): StoryProgress => {
    const t = tickets.get(story.key);
    if (!t) {
      if (story.ticket && ticketProblem(bp, story.ticket)) return { key: story.key, state: 'needs-you', line: 'Its file could not be read. An engineer can look at it', ticket: story.ticket, stop: 'other' };
      const waitsOn = story.dependsOn.filter((k) => !merged(k));
      if (waitsOn.length && (b.status === 'approved' || state.build?.on)) return { key: story.key, state: 'waits', line: `Waits for ${andWords(waitsOn)} to merge`, waitsOn };
      if (story.ticket) return { key: story.key, state: 'not-started', line: 'Its ticket was deleted. Press Start to build it again' };
      if (!state.build?.on) return { key: story.key, state: 'not-started', line: 'Not started' };
      if (state.rewritten?.includes(story.key)) return { key: story.key, state: 'waits', line: 'Rewritten after you approved. Read it, then press Build continuously' };
      const redo = redoHolding(b, state.job, story.key);
      if (redo) return { key: story.key, state: 'waits', line: `Waits for the Analyst to redo ${redo}` };
      return { key: story.key, state: 'next', line: 'Next in line' };
    }
    const r = releasedIn(releases, t.id);
    if (r || t.stage === 'done') return { key: story.key, state: 'released', line: r ? `Released in ${r.version}` : 'Released', ticket: t.id };
    if (isMerged(t)) return { key: story.key, state: 'merged', line: t.mergedAt ? `Merged ${clockWords(t.mergedAt)}` : 'Merged', ticket: t.id };
    const wait = mergeWait(t);
    if (wait) return { key: story.key, state: 'needs-you', line: mergeWaitWords(wait), ticket: t.id, stop: 'other' };
    if (t.waiting) {
      const stop = stopOf(t);
      return { key: story.key, state: 'needs-you', line: `Needs you: ${STOP_WORDS[stop] || t.waiting.summary.replace(/^./, (c) => c.toLowerCase())}`, ticket: t.id, stop };
    }
    return { key: story.key, state: 'building', line: t.status || 'Building', ticket: t.id };
  });
}

/* ── Estimate ───────────────────────────────────────────── */

/**
 * How much a story of each size is against this project's usual finished ticket. M is the usual ticket; a small story
 * is a bit over half of one; a large one nearly twice.
 */
export const SIZE_FACTOR: Record<StorySize, number> = { S: 0.6, M: 1, L: 1.8 };

/** With no finished tickets yet: a usual (M) story, as a rough guess. About 45 minutes of the squad's work and $4. */
export const ROUGH_STORY = { minutes: 45, costUsd: 4 };

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/**
 * "24 stories, about $140 and 6 hours, 2 at a time", for the stories not merged yet: this project's finished tickets
 * (merged or released) give the usual cost and time of one ticket, scaled by each story's size. The time is shared by
 * the stories that build at once. Dollars only when the person pays per use.
 */
export function estimateBreakdown(bp: BoardPaths, b: Breakdown, payment: Payment, opts: { tickets?: Ticket[]; parallel?: number } = {}): BreakdownEstimate {
  const finished = (opts.tickets ?? listTickets(bp)).filter((t) => isMerged(t) && !t.deleting);
  const costs = finished.map((t) => totalOf(t.usage).costUsd).filter((c): c is number => typeof c === 'number' && c > 0);
  const minutes = finished.map((t) => (workSeconds(t) ?? 0) / 60).filter((m) => m > 0);
  const basedOn = finished.filter((t) => (totalOf(t.usage).costUsd ?? 0) > 0 || (workSeconds(t) ?? 0) > 0).length;
  const perCost = costs.length ? mean(costs) : ROUGH_STORY.costUsd;
  const perMinutes = minutes.length ? mean(minutes) : ROUGH_STORY.minutes;
  const left = allStories(b).filter(({ story }) => !storyMerged(bp, story));
  const factor = left.reduce((s, { story }) => s + (SIZE_FACTOR[story.size] ?? 1), 0);
  const parallel = opts.parallel ?? parallelLimit(readMeta(bp).parallel);
  return {
    stories: left.length,
    ...(payment === 'api-key' ? { costUsd: Math.round(perCost * factor * 100) / 100 } : {}),
    minutes: Math.round((perMinutes * factor) / parallel),
    parallel,
    basedOn,
    rough: basedOn === 0,
    payment,
  };
}

/* ── The view ───────────────────────────────────────────── */

/**
 * The Decided for you list: the breakdown's own entries, and what the squad decided on the tickets of its stories,
 * each with its ticket. An entry copied onto a ticket when its story started shows as the ticket's copy (its id is
 * the ticket's), since it changes there now.
 */
export function decidedView(bp: BoardPaths, b: Breakdown): Decided[] {
  const onTickets = new Map<string, Decided[]>();
  for (const { story } of allStories(b)) {
    const t = story.ticket ? readableTicket(bp, story.ticket) : null;
    if (t?.decided?.length) onTickets.set(t.id, t.decided.map((d) => ({ ...d, item: d.item ?? story.key, ticket: t.id })));
  }
  const shown = new Set<Decided>();
  const out = b.decided.map((d) => {
    const copy = d.ticket ? onTickets.get(d.ticket)?.find((x) => x.at === d.at && x.text === d.text) : undefined;
    if (!copy) return d;
    shown.add(copy);
    return copy;
  });
  for (const list of onTickets.values()) out.push(...list.filter((x) => !shown.has(x)));
  return out;
}

/** The tracker a breakdown can be sent to: the project's, only when its module can create items. */
export function sendTarget(bp: BoardPaths): BreakdownView['tracker'] {
  return sendTargetOf(bp);
}

function countsOf(b: Breakdown, progress: StoryProgress[]): BreakdownView['counts'] {
  return {
    epics: b.epics.length,
    features: b.epics.reduce((n, e) => n + e.features.length, 0),
    stories: progress.length,
    merged: progress.filter((p) => p.state === 'merged' || p.state === 'released').length,
    building: progress.filter((p) => p.state === 'building').length,
    needsYou: progress.filter((p) => p.state === 'needs-you').length,
  };
}

/**
 * The Analyst is said to be working on it, and this computer holds no job for it (its file was damaged or lost): it would
 * wait for good. It shows as stopped instead, with Try again.
 */
function strandedWords(b: Breakdown, state: BreakdownState, meta: Pick<BoardMeta, 'user'>): string | null {
  if ((b.status !== 'reading' && b.status !== 'drafting') || state.job || !isBreakdownMine(b, meta)) return null;
  return "squad-kit lost track of the Analyst's work on this computer, so it stopped. Your document is safe. Press Try again.";
}

/** A breakdown as the board shows it, with how the person pays (for the estimate's dollars). */
export function breakdownView(bp: BoardPaths, id: string, payment: Payment): BreakdownView {
  const read = requireBreakdown(bp, id);
  const state = readBreakdownState(bp, read.id);
  const meta = readMeta(bp);
  const stranded = strandedWords(read, state, meta);
  const b: Breakdown = stranded ? { ...read, status: 'failed', error: stranded } : read;
  const progress = storyProgress(bp, b, state);
  const tracker = sendTarget(bp);
  return {
    ...b,
    decided: decidedView(bp, b),
    state,
    estimate: estimateBreakdown(bp, b, payment),
    progress,
    counts: countsOf(b, progress),
    ...(tracker ? { tracker } : {}),
    mine: isBreakdownMine(b, meta),
    // What stops Approve breakdown, while there is something to approve.
    problems: b.status === 'ready' ? approveProblems(b) : [],
    ...(b.status === 'ready' || b.status === 'approved' ? { wholeRedo: wholeRedoWords(state) } : {}),
  };
}

/** The same, finding out how the person pays first. */
export async function viewBreakdown(bp: BoardPaths, id: string): Promise<BreakdownView> {
  requireBreakdown(bp, id);
  return breakdownView(bp, id, (await howPaid(bp)).payment);
}

/** The Requirements list. */
export function breakdownRows(bp: BoardPaths): BreakdownRow[] {
  const meta = readMeta(bp);
  return listBreakdowns(bp).map((b) => {
    const state = readBreakdownState(bp, b.id);
    const counts = countsOf(b, storyProgress(bp, b, state));
    return {
      id: b.id,
      title: b.title,
      status: strandedWords(b, state, meta) ? 'failed' : b.status,
      source: { name: b.source.name, kind: b.source.kind },
      counts,
      building: Boolean(state.build?.on) || counts.building > 0,
      createdAt: b.createdAt,
      owner: ownerOfBreakdown(b),
    };
  });
}

/** A breakdown of mine whose Analyst waits for answers: it shows in Waiting for you beside the tickets. */
export interface BreakdownWait {
  id: string;
  title: string;
  /** The questions still open. */
  questions: number;
  /** When it started waiting, as near as the activity says. */
  since: string;
}

/** My breakdowns with questions for me, for Waiting for you on every page and `squad inbox`. */
export function breakdownWaits(bp: BoardPaths, meta: Pick<BoardMeta, 'user'> = readMeta(bp)): BreakdownWait[] {
  return listBreakdowns(bp)
    .filter((b) => b.status === 'questions' && isBreakdownMine(b, meta))
    .map((b) => ({ b, open: b.questions.filter((q) => !q.answer).length }))
    .filter(({ open }) => open > 0)
    .map(({ b, open }) => ({ id: b.id, title: b.title, questions: open, since: readBreakdownState(bp, b.id).activity[0]?.at ?? b.createdAt }));
}

/** A job waiting to run says why it waits (the usage limit, this month's budget), until it starts. */
export function holdBreakdownJob(bp: BoardPaths, id: string, text: string): void {
  updateJob(bp, id, (j) => {
    if (j.status === 'pending' && j.now !== text) j.now = text;
  });
}
