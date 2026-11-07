import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { now, readMeta, readTicket, type BoardPaths } from '../board/store.js';
import type { Breakdown, BreakdownEpic, BreakdownFeature, BreakdownJob, BreakdownLevel, BreakdownQuestion, BreakdownStory, BrdRef, DecidedBy } from '../board/requirements-types.js';
import { breakdownDir, breakdownMediaDir } from '../board/requirements-paths.js';
import {
  addBreakdownActivity,
  allKeys,
  allStories,
  findItem,
  nextKey,
  readBreakdown,
  readBreakdownState,
  rewrittenStories,
  storiesIn,
  updateBreakdown,
  updateBreakdownState,
  updateJob,
} from '../board/requirements.js';
import { SKIP_CHOICE, breakdownStopped, findLoop, nextDecidedId, usualReadSeconds } from '../board/requirements-actions.js';
import { DocumentError, prepareText, textParts } from '../board/requirements-text.js';
import { withFirstStory, withoutFirstStory } from '../board/first-story.js';
import { addRun, type UsageKey } from '../board/usage.js';
import { StepError, explainError } from '../board/problem.js';
import { writeLog } from '../core/app-log.js';
import type { AgentUsage, ToolEvent } from '../modules/ai-tool/types.js';
import { aiTool } from '../modules/registry.js';
import { readAgent } from './agents.js';
import { personLevels, resolveLevel } from './levels.js';
import { LimitReached, limitText } from './usage-limit.js';
import { CapReached } from './caps.js';
import { TECHNICAL_STOP, ownWords } from './plain-stop.js';
import * as B from './breakdown-prompts.js';
import { sleepMark, sleptSince } from './interrupt.js';

/**
 * The Analyst's work on a breakdown, as a stored job: what it does next lives in this computer's state file
 * (BreakdownState.job), so the live squad picks it up again after a restart and the board shows how far it got.
 * Steps: text (no AI), read (questions only for real gaps and clashes), reply ("Ask about this"), draft (an outline,
 * then the stories of each epic, saved one epic at a time) and redo (one part with the person's words).
 *
 * The run itself comes from the caller: the live squad runs the Analyst read only, with the breakdown's folder beside
 * the project; tests pass a fake.
 */

/** One run of the Analyst for the job. */
export interface AnalystAsk {
  /** The Analyst's step, for its model level and the cost: questions while reading, spec while writing. */
  step: 'questions' | 'spec';
  prompt: string;
  schema?: object;
  /** A new conversation with this id; the read starts one, the rest carry on in it. */
  sessionId?: string;
  resume?: string;
  timeoutMs: number;
  /** How many times the person pressed Give it more on this step: each time doubles its caps. */
  more?: number;
  onTool?(e: ToolEvent): void;
  onText?(text: string): void;
}

export interface AnalystAnswer {
  text: string;
  structured?: unknown;
  sessionId?: string;
  usage?: AgentUsage;
}

export interface BreakdownJobDeps {
  run(ask: AnalystAsk): Promise<AnalystAnswer>;
  /** Asked before every run: the words when this month's budget holds it, so nothing is cut in half. */
  budgetHold?(): Promise<string | null>;
  /** Aborted on Stop, and when the board closes. */
  signal?: AbortSignal;
}

const MINUTE = 60_000;
/** The longest a first read of a document may take, writing its outline or stories, and answering about a question. */
export const BRD_READ_MS = 30 * MINUTE;
export const BRD_WRITE_MS = 15 * MINUTE;
const BRD_ANSWER_MS = 5 * MINUTE;

/** The most a read of a very long document may take. */
export const LONGEST_READ_MS = 4 * 60 * MINUTE;

/** A long document gets twice its usual read: never less than BRD_READ_MS, never more than four hours. */
export function readLimitMs(source: Pick<Breakdown['source'], 'kind' | 'pages'>): number {
  const usual = usualReadSeconds(source.kind === 'pdf' ? { pages: source.pages ?? 0, parts: 0 } : { parts: source.pages ?? 1 });
  return Math.min(LONGEST_READ_MS, Math.max(BRD_READ_MS, usual * 2000));
}

/** Said after a read that stopped: its conversation may not carry on (retryBreakdown), so what it read is not kept. */
const READ_AGAIN = ' Try again reads the document from the first page, and uses your AI again.';

/** "Ask about this" got no answer, in the words a ticket's question gets (engine/live.ts). */
const NO_ANSWER = 'Could not answer this time. Ask again in a moment.';

class Stopped extends Error {}

/** This month's budget holds the next run. Its message is the plain reason. */
class HeldAtBudget extends Error {}

/** What the Analyst used, on its model level, for the breakdown's own line. */
function usageKey(bp: BoardPaths, step: string): UsageKey {
  try {
    const agent = readAgent(bp, 'analyst');
    const lv = resolveLevel({ role: 'analyst', step, quality: readMeta(bp).quality }, agent.levels, personLevels());
    return { role: 'analyst', step, level: lv.level, model: lv.model || aiTool(agent.tool)?.modelFor(lv.level) || '' };
  } catch {
    return { role: 'analyst', step, level: 'strongest', model: '' };
  }
}

/* ── Turning the Analyst's answer into parts ───────────── */

function cleanRef(r: B.RefOut | undefined): BrdRef | undefined {
  if (!r) return undefined;
  const page = Number(r.page);
  const out: BrdRef = {
    ...(r.section?.toString().trim() ? { section: r.section.toString().trim() } : {}),
    ...(r.title?.toString().trim() ? { title: r.title.toString().trim() } : {}),
    ...(Number.isFinite(page) && page > 0 ? { page: Math.round(page) } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

function cleanSize(s: string | undefined): BreakdownStory['size'] {
  const v = String(s ?? '').trim().toUpperCase();
  return v === 'S' || v === 'L' ? v : 'M';
}

function story(o: B.StoryOut, key: string): BreakdownStory {
  return {
    key,
    title: String(o.title ?? '').trim() || 'Untitled story',
    story: String(o.story ?? '').trim(),
    criteria: (o.criteria ?? [])
      .map((c) => ({ given: String(c.given ?? '').trim(), when: String(c.when ?? '').trim(), then: String(c.then ?? '').trim() }))
      .filter((c) => c.given && c.when && c.then)
      .slice(0, 6),
    size: cleanSize(o.size),
    dependsOn: [],
    ...(cleanRef(o.ref) ? { ref: cleanRef(o.ref) } : {}),
  };
}

/** The keys an answer used, to the keys squad-kit gave; needs follow them, or name stories already in the breakdown. */
function resolveNeeds(b: Breakdown, made: { s: BreakdownStory; needs: string[] }[], map: Map<string, string>): void {
  const known = new Set(allStories(b).map((x) => x.story.key));
  for (const { s, needs } of made) {
    const out = (needs ?? [])
      .map((n) => String(n).trim().toUpperCase())
      .map((n) => map.get(n) ?? (known.has(n) ? n : ''))
      .filter((n) => n && n !== s.key);
    s.dependsOn = [...new Set(out)];
  }
}

/** A loop the Analyst made in the needs is cut where it closes: a story never waits forever. */
function cutLoops(b: Breakdown): number {
  let cut = 0;
  for (let loop = findLoop(b); loop && cut < 50; loop = findLoop(b)) {
    const from = findItem(b, loop[loop.length - 2]!)?.story;
    if (!from) break;
    from.dependsOn = from.dependsOn.filter((n) => n !== loop[loop.length - 1]);
    cut += 1;
  }
  return cut;
}

function addDecided(b: Breakdown, list: B.DecidedOut[] | undefined, map: Map<string, string>, byOf: (d: B.DecidedOut) => DecidedBy): number {
  let n = 0;
  for (const d of list ?? []) {
    const text = String(d.text ?? '').trim();
    if (!text || b.decided.some((x) => x.text === text)) continue;
    const raw = d.item ? String(d.item).trim().toUpperCase() : '';
    const item = map.get(raw) ?? (raw && findItem(b, raw) ? raw : undefined);
    b.decided.push({ id: nextDecidedId(b.decided), text, by: byOf(d), at: now(), ...(item ? { item } : {}) });
    n += 1;
  }
  return n;
}

/** Answered questions shape the breakdown ("from your answer"); a skipped one, or none, is the Analyst's own choice. */
function byFor(b: Breakdown) {
  return (d: B.DecidedOut): DecidedBy => {
    const q = d.question ? b.questions.find((x) => x.id === String(d.question).trim().toLowerCase()) : undefined;
    return q?.answer && q.answer.choice !== SKIP_CHOICE ? 'answer' : 'analyst';
  };
}

/* ── Where the document is ──────────────────────────────── */

function documentFiles(bp: BoardPaths, b: Breakdown): B.DocumentFiles {
  const dir = breakdownDir(bp, b.id);
  const media = breakdownMediaDir(bp, b.id);
  // The Analyst must never be paid to read nothing, or to guess from a name.
  if (b.source.kind === 'pdf' ? !fs.existsSync(path.join(dir, b.source.file)) : !textParts(dir).length) throw new DocumentError(`The document of ${b.id} is no longer in its folder. Add the BRD again.`);
  return {
    kind: b.source.kind,
    ...(b.source.kind === 'pdf' ? { pdf: path.join(dir, b.source.file), ...(b.source.pages ? { pages: b.source.pages } : {}) } : {}),
    parts: textParts(dir).map((p) => path.join(dir, p)),
    ...(fs.existsSync(media) && fs.readdirSync(media).length ? { media } : {}),
    extra: (b.source.extra ?? []).map((f) => path.join(dir, f)),
  };
}

/** Which part or pages a tool call read: "text/part-03.md" is part 3; a PDF read with pages "18-25" reached page 25. */
export function readUpTo(e: ToolEvent, kind: Breakdown['source']['kind']): number {
  const file = [e.input.file_path, e.input.path].find((p): p is string => typeof p === 'string') ?? '';
  if (kind !== 'pdf') return Number(/part-(\d+)\.md$/.exec(file)?.[1] ?? 0);
  if (!/\.pdf$/i.test(file)) return 0;
  const pages = String(e.input.pages ?? '');
  const nums = pages.match(/\d+/g)?.map(Number) ?? [];
  return nums.length ? Math.max(...nums) : 0;
}

/** "Found so far: 3 epics, 6 features." in the Analyst's words, the last one said. */
export function foundSoFar(text: string): { epics: number; features: number } | null {
  const all = [...text.matchAll(/found so far:\s*(\d+)\s*epics?,?\s*(?:and\s*)?(\d+)\s*features?/gi)];
  const m = all.at(-1);
  return m ? { epics: Number(m[1]), features: Number(m[2]) } : null;
}

/* ── The job ────────────────────────────────────────────── */

interface Ctx {
  bp: BoardPaths;
  id: string;
  deps: BreakdownJobDeps;
  project: string;
}

function goOn(ctx: Ctx): void {
  if (ctx.deps.signal?.aborted || readBreakdownState(ctx.bp, ctx.id).job?.status === 'stopping') throw new Stopped();
}

function setNow(ctx: Ctx, text: string, more: Partial<BreakdownJob> = {}): void {
  updateJob(ctx.bp, ctx.id, (j) => {
    if (j.status === 'stopping') return;
    Object.assign(j, { now: text, ...more });
  });
}

/** One run of the Analyst; what it used goes on the breakdown's own line, and its conversation is kept for the next. */
async function ask(ctx: Ctx, a: AnalystAsk): Promise<AnalystAnswer> {
  goOn(ctx);
  const held = await ctx.deps.budgetHold?.();
  if (held) throw new HeldAtBudget(held);
  const more = readBreakdownState(ctx.bp, ctx.id).capRaise ?? 0;
  const key = usageKey(ctx.bp, a.step);
  const kept = (run: { sessionId?: string; usage?: AgentUsage }) =>
    updateBreakdownState(ctx.bp, ctx.id, (s) => {
      s.usage = addRun(s.usage, key, run.usage);
      // ACP may give a conversation a new id: the next step carries on in the one this run ended in.
      const session = run.sessionId ?? a.sessionId;
      if (session && (a.sessionId || a.resume || !s.sessions?.read)) s.sessions = { ...s.sessions, read: session };
    });
  let r: AnalystAnswer;
  try {
    r = await ctx.deps.run({ ...a, ...(more ? { more } : {}) });
  } catch (err) {
    // Stopped at a cap: what it used counts, and Give it more carries on in its conversation.
    if (err instanceof CapReached && err.run) kept(err.run);
    throw err;
  }
  kept(r);
  if (more) updateBreakdownState(ctx.bp, ctx.id, (s) => delete s.capRaise);
  goOn(ctx);
  return r;
}

function counts(b: Breakdown): NonNullable<BreakdownJob['found']> {
  return { epics: b.epics.length, features: b.epics.reduce((n, e) => n + e.features.length, 0), stories: allStories(b).length };
}

/** text: the document into text parts (no AI). Then the read follows at once. */
async function textStep(ctx: Ctx, b: Breakdown): Promise<boolean> {
  setNow(ctx, 'Turning the document into text');
  const p = prepareText(breakdownDir(ctx.bp, ctx.id), b.source);
  updateBreakdown(ctx.bp, ctx.id, (x) => {
    x.source.pages = p.pages ?? (p.parts || undefined);
    if (p.pictures !== undefined) x.source.pictures = p.pictures;
  });
  updateBreakdownState(ctx.bp, ctx.id, (s) => {
    s.job = { step: 'read', status: 'running', startedAt: now(), now: 'Reading the document', at: { done: 0, of: p.pages ?? p.parts, unit: b.source.kind === 'pdf' ? 'page' : 'part' }, usualSeconds: usualReadSeconds(p) };
    addBreakdownActivity(s, 'squad', 'Turned the document into text');
  });
  return true;
}

/** read: what it asks for, the epics and features in it, the questions that matter and the small things decided. */
async function readStep(ctx: Ctx, b: Breakdown, job: BreakdownJob): Promise<boolean> {
  const docs = documentFiles(ctx.bp, b);
  const unit = b.source.kind === 'pdf' ? 'page' : 'part';
  const of = b.source.kind === 'pdf' ? (b.source.pages ?? 0) : docs.parts.length;
  let done = 0;
  let said = '';
  let found = { epics: 0, features: 0 };
  setNow(ctx, 'Reading the document', { at: { done: 0, of, unit } });
  // Give it more: the read carries on in its conversation, and what it read is not paid for again.
  const session = job.more ? readBreakdownState(ctx.bp, ctx.id).sessions?.read : undefined;
  const r = await ask(ctx, {
    step: 'questions',
    prompt: session ? B.carryOnPrompt() : B.readPrompt(ctx.project, b, docs),
    schema: B.READ_SCHEMA,
    ...(session ? { resume: session } : { sessionId: randomUUID() }),
    timeoutMs: readLimitMs(b.source),
    onTool: (e) => {
      const n = Math.min(of || Infinity, readUpTo(e, b.source.kind));
      if (n > done) {
        done = n;
        setNow(ctx, 'Reading the document', { at: { done, of, unit } });
      }
    },
    onText: (t) => {
      said = (said + t).slice(-4000);
      const f = foundSoFar(said);
      if (f && (f.epics !== found.epics || f.features !== found.features)) {
        found = f;
        setNow(ctx, 'Reading the document', { found: { ...f, stories: 0 } });
      }
    },
  });
  const out = r.structured as B.ReadAnswer;
  const questions: BreakdownQuestion[] = (out.questions ?? []).slice(0, B.MAX_QUESTIONS).map((q, i) => {
    const options = (q.options ?? []).map((o) => String(o).trim()).filter(Boolean).slice(0, 4);
    const typed = q.typedOption?.trim();
    const refs = (q.refs ?? []).map(cleanRef).filter((x): x is BrdRef => Boolean(x));
    return {
      id: `q${i + 1}`,
      from: 'analyst',
      kind: q.kind === 'clash' ? 'clash' : 'gap',
      text: String(q.text ?? '').trim(),
      options,
      ...(typed && options.includes(typed) ? { inputOption: typed } : {}),
      ...(refs.length ? { refs } : {}),
      ...(q.impact?.trim() ? { impact: q.impact.trim() } : {}),
    };
  });
  const epics = (out.epics ?? []).length;
  const features = (out.epics ?? []).reduce((n, e) => n + (e.features?.length ?? 0), 0);
  let decided = 0;
  const after = updateBreakdown(ctx.bp, ctx.id, (x) => {
    x.summary = String(out.summary ?? '').trim() || x.summary;
    x.questions = questions;
    decided = addDecided(x, out.decided, new Map(), () => 'analyst');
    x.status = questions.length ? 'questions' : 'drafting';
  });
  updateBreakdownState(ctx.bp, ctx.id, (s) => {
    addBreakdownActivity(s, 'analyst', `Read the document: found ${epics} ${epics === 1 ? 'epic' : 'epics'} and ${features} ${features === 1 ? 'feature' : 'features'}${decided ? `, and decided ${decided} small ${decided === 1 ? 'thing' : 'things'} itself` : ''}`);
    if (questions.length) addBreakdownActivity(s, 'analyst', `Has ${questions.length} ${questions.length === 1 ? 'question' : 'questions'} for you`);
    s.job = questions.length
      ? { step: 'read', status: 'done', found: { epics, features, stories: 0 }, at: { done: of, of, unit } }
      : { step: 'draft', status: 'running', startedAt: now(), now: 'Writing the outline: epics and features', found: { epics, features, stories: 0 } };
  });
  return after.status === 'drafting';
}

/** reply: "Ask about this" on one question, in the read's conversation. */
async function replyStep(ctx: Ctx, b: Breakdown, job: BreakdownJob): Promise<boolean> {
  const q = b.questions.find((x) => x.id === job.question);
  const done = () => updateJob(ctx.bp, ctx.id, (j) => Object.assign(j, { status: 'done', now: undefined }));
  if (!q) {
    done();
    return false;
  }
  const said = [...(q.thread ?? [])].reverse().find((m) => m.who === 'you')?.text ?? '';
  const session = readBreakdownState(ctx.bp, ctx.id).sessions?.read;
  const context = session ? '' : `You are the Analyst who read the business requirements document below and asked the person questions about it.\n\n${B.documentText(b, documentFiles(ctx.bp, b))}`;
  const r = await ask(ctx, { step: 'questions', prompt: B.replyPrompt(q, b.questions.indexOf(q) + 1, said, context), ...(session ? { resume: session } : {}), timeoutMs: BRD_ANSWER_MS });
  updateBreakdown(ctx.bp, ctx.id, (x) => {
    const y = x.questions.find((z) => z.id === q.id);
    if (!y) return;
    y.thread = [...(y.thread ?? []), { who: 'analyst', text: r.text.trim() || 'I have nothing to add: pick the option closest to what you mean.', at: now() }];
    y.thinking = false;
  });
  done();
  return false;
}

/** draft: the outline first, then each epic's stories, saved one epic at a time so a restart carries on. */
async function draftStep(ctx: Ctx, b0: Breakdown): Promise<boolean> {
  const docs = documentFiles(ctx.bp, b0);
  let session = readBreakdownState(ctx.bp, ctx.id).sessions?.read;
  if (!b0.epics.length) {
    setNow(ctx, 'Writing the outline: epics and features');
    const r = await ask(ctx, { step: 'spec', prompt: B.outlinePrompt(ctx.project, b0, docs, SKIP_CHOICE, Boolean(session)), schema: B.OUTLINE_SCHEMA, ...(session ? { resume: session } : {}), timeoutMs: BRD_WRITE_MS });
    session = readBreakdownState(ctx.bp, ctx.id).sessions?.read;
    const out = r.structured as B.OutlineAnswer;
    const b = updateBreakdown(ctx.bp, ctx.id, (x) => {
      if (out.summary?.trim()) x.summary = out.summary.trim();
      x.epics = (out.epics ?? []).map((e) => ({
        key: nextKey(x, 'epic'),
        title: String(e.title ?? '').trim() || 'Untitled epic',
        ...(e.goal?.trim() ? { goal: e.goal.trim() } : {}),
        ...(cleanRef(e.ref) ? { ref: cleanRef(e.ref) } : {}),
        features: (e.features ?? []).map((f) => ({
          key: nextKey(x, 'feature'),
          title: String(f.title ?? '').trim() || 'Untitled feature',
          ...(f.summary?.trim() ? { summary: f.summary.trim() } : {}),
          ...(cleanRef(f.ref) ? { ref: cleanRef(f.ref) } : {}),
          stories: [],
        })),
        stories: [],
      }));
      x.leftOut = (out.leftOut ?? []).map((l) => ({ text: String(l.text ?? '').trim(), why: String(l.why ?? '').trim(), ...(cleanRef(l.ref) ? { ref: cleanRef(l.ref) } : {}) })).filter((l) => l.text);
      const by = byFor(x);
      addDecided(x, out.decided, new Map(), by);
      // A question the person let the Analyst decide is always written down, even when its answer said nothing of it.
      for (const q of x.questions) {
        if (q.answer?.choice !== SKIP_CHOICE) continue;
        const named = (out.decided ?? []).some((d) => String(d.question ?? '').trim().toLowerCase() === q.id);
        if (!named) x.decided.push({ id: nextDecidedId(x.decided), text: `${q.text} The Analyst chose: ${q.options[0] ?? 'its own best guess'}.`, by: 'analyst', at: now() });
      }
    });
    if (!b.epics.length) throw new StepError('The Analyst found no epics in the document.');
    updateBreakdownState(ctx.bp, ctx.id, (s) => {
      addBreakdownActivity(s, 'analyst', `Wrote the outline: ${b.epics.length} ${b.epics.length === 1 ? 'epic' : 'epics'} and ${counts(b).features} features`);
      if (s.job) s.job.found = counts(b);
    });
  }
  for (;;) {
    goOn(ctx);
    const b = readBreakdown(ctx.bp, ctx.id)!;
    const i = b.epics.findIndex((e) => !e.stories.length && !e.features.some((f) => f.stories.length));
    if (i < 0) break;
    const epic = b.epics[i]!;
    setNow(ctx, `Writing the stories of ${epic.title} (epic ${i + 1} of ${b.epics.length})`, { found: counts(b) });
    const first = b.next.story;
    const r = await ask(ctx, { step: 'spec', prompt: B.storiesPrompt(ctx.project, b, epic, i + 1, b.epics.length, first, docs, SKIP_CHOICE, Boolean(session)), schema: B.STORIES_SCHEMA, ...(session ? { resume: session } : {}), timeoutMs: BRD_WRITE_MS });
    session = readBreakdownState(ctx.bp, ctx.id).sessions?.read;
    const out = r.structured as B.StoriesAnswer;
    let made = 0;
    const after = updateBreakdown(ctx.bp, ctx.id, (x) => {
      const e = x.epics.find((y) => y.key === epic.key);
      if (!e) return;
      const map = new Map<string, string>();
      const list: { s: BreakdownStory; needs: string[]; feature?: string }[] = [];
      for (const o of out.stories ?? []) {
        const key = nextKey(x, 'story');
        if (o.key) map.set(String(o.key).trim().toUpperCase(), key);
        list.push({ s: story(o, key), needs: o.needs ?? [], feature: o.feature ? String(o.feature).trim().toUpperCase() : undefined });
      }
      for (const { s, feature } of list) {
        const f = e.features.find((y) => y.key === feature);
        (f ? f.stories : e.stories).push(s);
      }
      resolveNeeds(x, list, map);
      cutLoops(x);
      addDecided(x, out.decided, map, byFor(x));
      made = list.length;
    });
    if (!made) throw new StepError(`The Analyst wrote no stories for ${epic.title}.`);
    updateBreakdownState(ctx.bp, ctx.id, (s) => {
      addBreakdownActivity(s, 'analyst', `Wrote ${made} ${made === 1 ? 'story' : 'stories'} for ${epic.title}`);
      if (s.job) s.job.found = counts(after);
    });
  }
  const b = updateBreakdown(ctx.bp, ctx.id, (x) => {
    withFirstStory(ctx.bp, x);
    x.status = 'ready';
    delete x.error;
  });
  const c = counts(b);
  updateBreakdownState(ctx.bp, ctx.id, (s) => {
    s.job = { step: 'draft', status: 'done', found: c };
    addBreakdownActivity(s, 'analyst', `The breakdown is ready for you: ${c.epics} epics, ${c.features} features and ${c.stories} stories`);
  });
  return false;
}

/* ── Redo one part ──────────────────────────────────────── */

interface Merge {
  b: Breakdown;
  /** Keys of the part being redone, by level: these may be kept. */
  own: Set<string>;
  map: Map<string, string>;
  used: Set<string>;
  made: { s: BreakdownStory; needs: string[] }[];
}

/** The key a part keeps (its own, inside the part being redone) or the new one it gets. */
function keyFor(m: Merge, raw: string | undefined, level: BreakdownLevel): string {
  const k = String(raw ?? '').trim().toUpperCase();
  const prefix = { epic: 'E-', feature: 'F-', story: 'S-' }[level];
  if (k.startsWith(prefix) && m.own.has(k) && !m.used.has(k)) {
    m.used.add(k);
    m.map.set(k, k);
    return k;
  }
  const fresh = nextKey(m.b, level);
  m.used.add(fresh);
  if (k) m.map.set(k, fresh);
  return fresh;
}

/** A story that started: its ticket is on the board. It is its ticket's now, and changes there. */
function hasStarted(bp: BoardPaths, s: BreakdownStory): boolean {
  const t = s.ticket ? readTicket(bp, s.ticket) : null;
  return Boolean(t && !t.deleting);
}

/** The started stories of a part stay exactly as they are, wherever the answer left them. */
function startedIn(bp: BoardPaths, stories: BreakdownStory[]): Map<string, BreakdownStory> {
  return new Map(stories.filter((s) => hasStarted(bp, s)).map((s) => [s.key, structuredClone(s)]));
}

function andWords(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
}

function mergeStories(m: Merge, outs: B.StoryOut[] | undefined, started: Map<string, BreakdownStory>): BreakdownStory[] {
  return (outs ?? []).map((o) => {
    const k = keyFor(m, o.key, 'story');
    const kept = started.get(k);
    if (kept) {
      started.delete(k);
      return kept;
    }
    const s = story(o, k);
    m.made.push({ s, needs: o.needs ?? [] });
    return s;
  });
}

function mergeFeature(m: Merge, o: B.FeatureOut, started: Map<string, BreakdownStory>): BreakdownFeature {
  const key = keyFor(m, o.key, 'feature');
  return {
    key,
    title: String(o.title ?? '').trim() || 'Untitled feature',
    ...(o.summary?.trim() ? { summary: o.summary.trim() } : {}),
    ...(cleanRef(o.ref) ? { ref: cleanRef(o.ref) } : {}),
    stories: mergeStories(m, o.stories, started),
  };
}

function mergeEpic(m: Merge, o: B.EpicOut, started: Map<string, BreakdownStory>): BreakdownEpic {
  const key = keyFor(m, o.key, 'epic');
  return {
    key,
    title: String(o.title ?? '').trim() || 'Untitled epic',
    ...(o.goal?.trim() ? { goal: o.goal.trim() } : {}),
    ...(cleanRef(o.ref) ? { ref: cleanRef(o.ref) } : {}),
    features: (o.features ?? []).map((f) => mergeFeature(m, f, started)),
    stories: mergeStories(m, o.stories, started),
  };
}

/** The old part's trackers and tickets stay with the keys that stay. */
function keepLinks(before: Breakdown, after: Breakdown): void {
  const old = new Map<string, { tracker?: BreakdownStory['tracker']; ticket?: string }>();
  for (const e of before.epics) {
    old.set(e.key, { tracker: e.tracker });
    for (const f of e.features) old.set(f.key, { tracker: f.tracker });
  }
  for (const { story: s } of allStories(before)) old.set(s.key, { tracker: s.tracker, ticket: s.ticket });
  const keep = (x: { key: string; tracker?: BreakdownStory['tracker'] }) => {
    const o = old.get(x.key);
    if (o?.tracker && !x.tracker) x.tracker = o.tracker;
  };
  for (const e of after.epics) {
    keep(e);
    for (const f of e.features) keep(f);
  }
  for (const { story: s } of allStories(after)) {
    keep(s);
    const o = old.get(s.key);
    if (o?.ticket && !s.ticket) s.ticket = o.ticket;
  }
}

/** A story redo on a story that started: it changes on its ticket, never here. */
function startedWords(s: BreakdownStory): string {
  return `${s.key} started as ${s.ticket}: change it there.`;
}

/**
 * redo: one part (or the whole breakdown) rewritten with the person's words; what stays keeps its key. A story that
 * started is never rewritten: a redo of that story fails plainly, and a redo of the part around it keeps it as it is,
 * with a line in the activity. A Decided entry the person changed stays, even when the part it was about is gone.
 */
async function redoStep(ctx: Ctx, b: Breakdown, job: BreakdownJob): Promise<boolean> {
  const whole = job.item === b.id;
  const target = whole ? null : findItem(b, job.item ?? '');
  if (!whole && !target) throw new StepError(`${job.item} is no longer in the breakdown.`);
  if (target?.story && hasStarted(ctx.bp, target.story)) throw new StepError(startedWords(target.story));
  const session = readBreakdownState(ctx.bp, ctx.id).sessions?.read;
  const level = target?.level;
  const schema = whole ? B.WHOLE_REDO_SCHEMA : level === 'epic' ? B.EPIC_REDO_SCHEMA : level === 'feature' ? B.FEATURE_REDO_SCHEMA : B.STORY_REDO_SCHEMA;
  setNow(ctx, `Redoing ${whole ? 'the breakdown' : target!.item.key}`);
  const r = await ask(ctx, { step: 'spec', prompt: B.redoPrompt(ctx.project, whole ? withoutFirstStory(b) : b, target?.item ?? null, job.ask ?? '', documentFiles(ctx.bp, b), Boolean(session)), schema, ...(session ? { resume: session } : {}), timeoutMs: BRD_WRITE_MS });
  const out = r.structured as { story?: B.StoryOut; feature?: B.FeatureOut; epic?: B.EpicOut; epics?: B.EpicOut[]; leftOut?: B.OutlineAnswer['leftOut']; summary?: string; decided?: B.DecidedOut[] };
  let cut = 0;
  let kept: BreakdownStory[] = [];
  let rewritten: string[] = [];
  updateBreakdown(ctx.bp, ctx.id, (x) => {
    const before = structuredClone(x);
    const t = whole ? null : findItem(x, job.item!);
    if (!whole && !t) return;
    // Started while the Analyst worked (the queue and Start wait for a redo, but a ticket may come from elsewhere).
    if (t?.story && hasStarted(ctx.bp, t.story)) throw new StepError(startedWords(t.story));
    const inside = t ? [t.item.key, ...storiesIn(t).map((s) => s.key), ...(t.level === 'epic' ? t.epic.features.map((f) => f.key) : [])] : allKeys(x);
    const m: Merge = { b: x, own: new Set(inside), map: new Map(), used: new Set(), made: [] };
    const started = startedIn(ctx.bp, t ? storiesIn(t) : allStories(x).map((p) => p.story));
    kept = [...started.values()];
    if (whole) {
      x.epics = (out.epics ?? []).map((e) => mergeEpic(m, e, started));
      if (out.leftOut) x.leftOut = out.leftOut.map((l) => ({ text: String(l.text ?? '').trim(), why: String(l.why ?? '').trim(), ...(cleanRef(l.ref) ? { ref: cleanRef(l.ref) } : {}) })).filter((l) => l.text);
      if (out.summary?.trim()) x.summary = out.summary.trim();
      // A started story the answer left out goes back under its first epic: it is being built.
      if (started.size && x.epics[0]) x.epics[0].stories.push(...started.values());
    } else if (t!.level === 'epic' && out.epic) {
      const e = mergeEpic(m, { ...out.epic, key: t!.item.key }, started);
      e.stories.push(...started.values());
      x.epics.splice(x.epics.indexOf(t!.epic), 1, e);
    } else if (t!.level === 'feature' && out.feature) {
      const f = mergeFeature(m, { ...out.feature, key: t!.item.key }, started);
      f.stories.push(...started.values());
      t!.epic.features.splice(t!.epic.features.indexOf(t!.feature!), 1, f);
    } else if (t!.level === 'story' && out.story) {
      const s = story({ ...out.story }, t!.item.key);
      m.made.push({ s, needs: out.story.needs ?? [] });
      t!.list.splice(t!.list.indexOf(t!.item), 1, s);
    }
    keepLinks(before, x);
    resolveNeeds(x, m.made, m.map);
    // Parts that are gone leave the other stories' needs and their Decided entries. An entry the person changed stays,
    // on the part that was redone.
    const left = new Set(allKeys(x));
    for (const { story: s } of allStories(x)) s.dependsOn = s.dependsOn.filter((n) => left.has(n));
    const redone = t && left.has(t.item.key) ? t.item.key : undefined;
    x.decided = x.decided.flatMap((d) => {
      if (!d.item || left.has(d.item)) return [d];
      if (!d.changed) return [];
      const { item: _gone, ...rest } = d;
      return [redone ? { ...rest, item: redone } : rest];
    });
    cut = cutLoops(x);
    addDecided(x, out.decided, m.map, () => 'analyst');
    withFirstStory(ctx.bp, x);
    // After the approval, what it wrote waits for the person: nobody has read it, and building it costs real money.
    if (x.status === 'approved') rewritten = rewrittenStories(before, x);
  });
  updateBreakdownState(ctx.bp, ctx.id, (s) => {
    s.job = { step: 'redo', status: 'done', item: job.item, ...(job.ask ? { ask: job.ask } : {}) };
    if (rewritten.length) s.rewritten = [...new Set([...(s.rewritten ?? []), ...rewritten])];
    addBreakdownActivity(s, 'analyst', `Redid ${whole ? 'the breakdown' : job.item}${cut ? `, and took away ${cut} ${cut === 1 ? 'need' : 'needs'} that went round in a loop` : ''}`);
    if (kept.length) {
      const one = kept.length === 1;
      addBreakdownActivity(s, 'squad', `Kept ${andWords(kept.map((k) => k.key))} as ${one ? 'it is' : 'they are'}: ${one ? 'it' : 'they'} started as ${andWords(kept.map((k) => k.ticket!))}. Change ${one ? 'it' : 'them'} there`);
    }
  });
  return false;
}

/* ── Running it ─────────────────────────────────────────── */

const STEPS: Record<BreakdownJob['step'], (ctx: Ctx, b: Breakdown, job: BreakdownJob) => Promise<boolean>> = {
  text: textStep,
  read: readStep,
  reply: replyStep,
  draft: draftStep,
  redo: redoStep,
};

/** A run that did not get through: the usage limit and the budget hold the job, Stop parks it, anything else is said in plain words. */
function failed(ctx: Ctx, job: BreakdownJob, err: unknown): void {
  const { bp, id } = ctx;
  if (err instanceof LimitReached || err instanceof HeldAtBudget) {
    updateBreakdownState(bp, id, (s) => {
      if (!s.job || s.job.status === 'stopping') return;
      s.job.status = 'pending';
      s.job.now = err instanceof LimitReached ? limitText(err.pause) : err.message;
      if (err instanceof HeldAtBudget) s.job.heldFor = 'budget';
    });
    return;
  }
  const state = readBreakdownState(bp, id);
  if (state.job?.status === 'stopping') {
    breakdownStopped(bp, id);
    return;
  }
  // The board closed: the step starts again when it opens.
  if (ctx.deps.signal?.aborted || err instanceof Stopped) return;
  // Only squad-kit's own plain words reach the person (engine/plain-stop.ts), as in a ticket's stop: anything else is
  // one plain sentence, and its exact words go to the app log for engineers.
  const capped = err instanceof CapReached;
  const own = ownWords(err) ?? (err instanceof DocumentError || capped ? (err as Error).message : null);
  const { what, detail } = explainError(err);
  writeLog({ level: own ? 'warn' : 'error', ...(ctx.project ? { project: ctx.project } : {}), text: `${id}: the Analyst's ${job.step} step stopped: ${[what, detail].filter(Boolean).join('\n')}` });
  // A read that did not get through starts over on Try again, and the person pays for it again: they are told so.
  const plain = `${own ?? TECHNICAL_STOP}${job.step === 'read' && !capped && !(err instanceof DocumentError) ? READ_AGAIN : ''}`;
  if (job.step === 'reply') {
    updateBreakdown(bp, id, (x) => {
      const q = x.questions.find((y) => y.id === job.question);
      if (!q) return;
      q.thinking = false;
      q.thread = [...(q.thread ?? []), { who: 'squad', text: own ? `Could not answer: ${own}` : NO_ANSWER, at: now() }];
    });
  } else if (job.step !== 'redo') {
    updateBreakdown(bp, id, (x) => {
      x.status = 'failed';
      x.error = plain;
    });
  }
  updateBreakdownState(bp, id, (s) => {
    if (s.job) {
      s.job.status = 'failed';
      // "The Analyst could not answer your question." needs no technical sentence after it.
      if (job.step === 'reply' && !own) delete s.job.error;
      else s.job.error = plain;
      delete s.job.now;
      if (capped) s.job.capped = true;
    }
    addBreakdownActivity(s, 'analyst', job.step === 'reply' ? (own ? `Could not answer your question: ${own}` : 'Could not answer your question this time') : `${job.step === 'redo' ? `Could not redo ${job.item}` : 'Stopped'}: ${plain}`);
  });
}

/**
 * Runs the breakdown's job from where it is: a step waiting or cut off by a restart starts again, and the read goes
 * straight on to the draft when it has no questions. Ends when the job is done, waits for the person, or fails.
 */
export async function runBreakdownJob(bp: BoardPaths, id: string, deps: BreakdownJobDeps): Promise<void> {
  const ctx: Ctx = { bp, id, deps, project: readMeta(bp).project };
  const mark = sleepMark();
  for (let steps = 0; steps < 6; steps += 1) {
    const job = readBreakdownState(bp, id).job;
    const b = readBreakdown(bp, id);
    if (!b || !job || (job.status !== 'pending' && job.status !== 'running')) return;
    updateJob(bp, id, (j) => {
      j.status = 'running';
      j.startedAt ??= now();
      delete j.error;
      delete j.heldFor;
    });
    try {
      if (!(await STEPS[job.step](ctx, b, job))) return;
    } catch (err) {
      // The computer slept and the run did not get through: that says nothing about the document, so the step starts
      // again by itself, as a ticket's does.
      if (sleptSince(mark) && !(err instanceof LimitReached) && !(err instanceof HeldAtBudget) && !(err instanceof Stopped) && !(err instanceof CapReached)) {
        updateBreakdownState(bp, id, (s) => {
          if (!s.job || s.job.status === 'stopping') return;
          s.job.status = 'pending';
          s.job.now = 'The computer slept, so this step starts again';
        });
        return;
      }
      failed(ctx, job, err);
      return;
    }
  }
}
