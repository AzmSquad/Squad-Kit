import { now } from '../board/store.js';
import type { Breakdown, BreakdownJob, BreakdownStory, Decided, DecidedBy } from '../board/requirements-types.js';
import type { Criterion } from '../board/types.js';
import { addBreakdownActivity, allStories, andWords, findItem, findLoop, readBreakdown, readBreakdownState, rewrittenStories, storiesIn, updateBreakdown, updateBreakdownState } from '../board/requirements.js';
import { SKIP_CHOICE, nextDecidedId } from '../board/requirements-actions.js';
import { withFirstStory } from '../board/first-story.js';
import { WROTE_DONE_WHEN, readCopy, sectionOf } from '../board/epic-text.js';
import { breakdownDir } from '../board/requirements-paths.js';
import { StepError } from '../board/problem.js';
import { ask, documentFiles, goOn, setNow, type Ctx } from './breakdown-run.js';
import { FILL_BATCH, FILL_SCHEMA, fillPrompt, type FillAnswer } from './epic-prompts.js';

/**
 * The Analyst's fill for a run from the tracker (ADR-013), in place of a draft: per story, a "done when" when the tracker
 * has none, a size, and the needs the tracker lacks, each written down under Decided for you with its reason. Its parts
 * stay the tracker's: a key the Analyst names that is not in the run is refused, never added. A batch at a time, saved
 * as it goes, so a restart carries on. A redo fills the stories of one part again with the person's words.
 */

/** The Analyst wrote this story's "done when" (a Decided entry says so), so a redo may write it again. */
function wroteFor(b: Pick<Breakdown, 'decided'>, key: string): boolean {
  return b.decided.some((d) => d.item === key && d.text.startsWith(WROTE_DONE_WHEN));
}

/**
 * The stories to fill: a redo's part, or the new stories added to the run (their keys, as "S-7,S-8"); the ones left from
 * a fill cut off; or every story not started yet.
 */
function targetKeys(b: Breakdown, job: BreakdownJob): string[] {
  const open = (list: BreakdownStory[]) => list.filter((s) => !s.ticket).map((s) => s.key);
  if (job.step === 'redo') {
    if (job.item === b.id) return open(allStories(b).map((p) => p.story));
    const f = findItem(b, job.item ?? '');
    const added = (job.item ?? '').split(',').filter((k) => findItem(b, k)?.story);
    if (!f && !added.length) throw new StepError(`${job.item} is no longer in the run.`);
    return f ? open(storiesIn(f)) : open(added.map((k) => findItem(b, k)!.story!));
  }
  if (job.item !== undefined) return job.item.split(',').filter((k) => findItem(b, k)?.story);
  return open(allStories(b).map((p) => p.story));
}

function cleanCriteria(list: FillAnswer['stories'][number]['criteria']): Criterion[] {
  return (list ?? [])
    .map((c) => ({ given: String(c?.given ?? '').trim(), when: String(c?.when ?? '').trim(), then: String(c?.then ?? '').trim() }))
    .filter((c) => c.given && c.when && c.then)
    .slice(0, 6);
}

function cleanSize(s: unknown): BreakdownStory['size'] {
  const v = String(s ?? '').trim().toUpperCase();
  return v === 'S' || v === 'L' ? v : 'M';
}

interface Tally {
  stories: number;
  criteria: number;
  needs: number;
  refused: Set<string>;
  /** The questions the Analyst named in a Decided entry. */
  questions: Set<string>;
}

/** Puts one batch's answer into the run: only into the stories asked for, never a new part. */
function applyFill(x: Breakdown, keys: string[], out: FillAnswer, redo: boolean, tally: Tally): void {
  const asked = new Set(keys);
  const inRun = new Set(allStories(x).map((p) => p.story.key));
  const refOf = (k: string) => findItem(x, k)?.story?.tracker?.ref ?? k;
  const decide = (text: string, item: string | undefined, by: DecidedBy = 'analyst') => {
    if (!text || x.decided.some((d) => d.text === text)) return;
    x.decided.push({ id: nextDecidedId(x.decided), text, by, at: now(), ...(item ? { item } : {}) } satisfies Decided);
  };
  for (const o of out.stories ?? []) {
    const key = String(o.key ?? '').trim().toUpperCase();
    const s = asked.has(key) ? findItem(x, key)?.story : undefined;
    if (!s) {
      if (key) tally.refused.add(key);
      continue;
    }
    tally.stories += 1;
    const criteria = cleanCriteria(o.criteria);
    if (criteria.length && (!s.criteria.length || (redo && wroteFor(x, key)))) {
      if (!wroteFor(x, key)) {
        decide(`${WROTE_DONE_WHEN} ${refOf(key)}: the tracker had none, so the Analyst wrote ${criteria.length} from its own words.`, key);
        tally.criteria += 1;
      }
      s.criteria = criteria;
    }
    s.size = cleanSize(o.size);
    for (const n of o.needs ?? []) {
      const need = String(n?.key ?? '').trim().toUpperCase();
      const why = String(n?.why ?? '').trim();
      if (!inRun.has(need) || need === key || s.dependsOn.includes(need)) continue;
      s.dependsOn.push(need);
      // A need that would make stories wait for each other for good is not added.
      if (findLoop(x)) {
        s.dependsOn.pop();
        continue;
      }
      s.needsFrom = { ...s.needsFrom, [need]: 'analyst' };
      decide(`${refOf(key)} needs ${refOf(need)}: ${why || 'it cannot work or be tested without it'}`, key);
      tally.needs += 1;
    }
  }
  for (const d of out.decided ?? []) {
    const item = String(d.item ?? '').trim().toUpperCase();
    const q = d.question ? x.questions.find((y) => y.id === String(d.question).trim().toLowerCase()) : undefined;
    if (q) tally.questions.add(q.id);
    decide(String(d.text ?? '').trim(), inRun.has(item) ? item : undefined, q?.answer && q.answer.choice !== SKIP_CHOICE ? 'answer' : 'analyst');
  }
}

/** A question the person let the Analyst decide is always written down, even when its answer said nothing of it. */
function skippedWrittenDown(x: Breakdown, named: Set<string>): void {
  for (const q of x.questions) {
    if (q.answer?.choice !== SKIP_CHOICE || named.has(q.id)) continue;
    x.decided.push({ id: nextDecidedId(x.decided), text: `${q.text} The Analyst chose: ${q.options[0] ?? 'its own best guess'}.`, by: 'analyst', at: now() });
  }
}

const counts = (b: Breakdown) => ({ epics: b.epics.length, features: b.epics.reduce((n, e) => n + e.features.length, 0), stories: allStories(b).length });

/** fill (a draft or a redo of a run from the tracker): the stories filled in a batch at a time. */
export async function fillStep(ctx: Ctx, b0: Breakdown, job: BreakdownJob, timeoutMs: number): Promise<boolean> {
  const redo = job.step === 'redo';
  let keys = targetKeys(b0, job);
  const docs = documentFiles(ctx.bp, b0);
  const before = structuredClone(b0);
  const total = keys.length;
  const of = Math.max(1, Math.ceil(total / FILL_BATCH));
  const tally: Tally = { stories: 0, criteria: 0, needs: 0, refused: new Set(), questions: new Set() };
  let session = readBreakdownState(ctx.bp, ctx.id).sessions?.read;
  for (let n = 1; keys.length; n += 1) {
    goOn(ctx);
    const batch = keys.slice(0, FILL_BATCH);
    const b = readBreakdown(ctx.bp, ctx.id)!;
    const doing = !redo ? `Filling in the stories: ${total - keys.length} of ${total} done` : job.ask ? `Filling in ${job.item === b.id ? 'the run' : job.item} again` : 'Filling in the new stories';
    setNow(ctx, doing, { found: counts(b) });
    const copy = readCopy(breakdownDir(ctx.bp, ctx.id));
    const sections = batch.map((k) => findItem(b, k)?.story).map((st) => (st?.tracker ? `### ${st.key} ${st.tracker.ref} ${st.title}\n\n${sectionOf(copy, st.tracker.ref) ?? st.story}` : '')).filter(Boolean).join('\n\n');
    const prompt = fillPrompt(ctx.project, b, batch, docs, { n, of, sections, resumed: Boolean(session), skip: SKIP_CHOICE, mayRewrite: (s) => wroteFor(b, s.key), ...(redo && job.ask ? { ask: job.ask } : {}) });
    const r = await ask(ctx, { step: 'spec', prompt, schema: FILL_SCHEMA, ...(session ? { resume: session } : {}), timeoutMs });
    session = readBreakdownState(ctx.bp, ctx.id).sessions?.read;
    const was = tally.stories;
    updateBreakdown(ctx.bp, ctx.id, (x) => applyFill(x, batch, r.structured as FillAnswer, redo, tally));
    if (tally.stories === was) throw new StepError(`The Analyst filled in none of ${andWords(batch.slice(0, 3))}${batch.length > 3 ? ' and the others' : ''}.`);
    keys = keys.slice(batch.length);
    // Saved as it goes: a restart fills in only the stories left.
    if (!redo) setNow(ctx, 'Filling in the stories', { item: keys.join(',') });
  }
  let rewritten: string[] = [];
  const after = updateBreakdown(ctx.bp, ctx.id, (x) => {
    skippedWrittenDown(x, tally.questions);
    withFirstStory(ctx.bp, x);
    if (x.status === 'approved') rewritten = rewrittenStories(before, x);
    else {
      x.status = 'ready';
      delete x.error;
    }
  });
  const c = counts(after);
  updateBreakdownState(ctx.bp, ctx.id, (s) => {
    s.job = redo ? { step: 'redo', status: 'done', item: job.item, ...(job.ask ? { ask: job.ask } : {}) } : { step: 'draft', status: 'done', found: c };
    if (rewritten.length) s.rewritten = [...new Set([...(s.rewritten ?? []), ...rewritten])];
    const wrote = tally.criteria ? `, wrote "done when" for ${tally.criteria}` : '';
    const needs = tally.needs ? `, added ${tally.needs} ${tally.needs === 1 ? 'need' : 'needs'} the tracker lacked` : '';
    addBreakdownActivity(s, 'analyst', `Filled in ${tally.stories} ${tally.stories === 1 ? 'story' : 'stories'}${wrote}${needs}`);
    if (tally.refused.size) addBreakdownActivity(s, 'squad', `Left out what the Analyst named that is not in the run: ${andWords([...tally.refused])}. A run from the tracker keeps its stories as they are`);
    if (after.status !== 'approved') addBreakdownActivity(s, 'analyst', `The run is ready for you: ${c.stories} ${c.stories === 1 ? 'story' : 'stories'}. Approve it, and each builds and merges by itself`);
    else if (rewritten.length) addBreakdownActivity(s, 'analyst', `${andWords(rewritten)} ${rewritten.length === 1 ? 'is' : 'are'} ready for you to read. Then press Build continuously`);
  });
  return false;
}
