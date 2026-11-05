import type {
  BrdRef,
  BreakdownEpic,
  BreakdownEstimate,
  BreakdownFeature,
  BreakdownJob,
  BreakdownLevel,
  BreakdownRow,
  BreakdownStatus,
  BreakdownStory,
  BreakdownView,
  Decided,
  LeftOut,
  SendLevelCount,
  StoryProgress,
  StoryState,
} from '../api/requirements-types';
import type { Criterion } from '../api/types';

/**
 * The words and shapes of the Requirements page, worked out from a breakdown: the status chip, the estimate, the
 * Analyst's steps, the tree's places and the map's boxes. No React here, so the tests can read it as it is.
 */

/** The answer that lets the Analyst decide a question itself (the server's SKIP_CHOICE). */
export const SKIP_CHOICE = 'Skip: let the Analyst decide';

export type Tone = 'ok' | 'you' | 'bug' | 'plain';

const STATUS_WORDS: Record<BreakdownStatus, string> = {
  reading: 'Analyst reading',
  questions: 'Questions for you',
  drafting: 'Analyst writing the breakdown',
  ready: 'Ready for you to approve',
  approved: 'Approved',
  failed: 'Stopped',
};

const STATUS_TONE: Record<BreakdownStatus, Tone> = { reading: 'ok', questions: 'you', drafting: 'ok', ready: 'you', approved: 'ok', failed: 'bug' };

/** The chip beside a breakdown's name: "Ready for you to approve", "Building continuously", "Paused". */
export function statusChip(v: Pick<BreakdownView, 'status' | 'counts'> & { state?: Partial<BreakdownView['state']>; building?: boolean }): { text: string; tone: Tone } {
  if (v.status !== 'approved') return { text: STATUS_WORDS[v.status], tone: STATUS_TONE[v.status] };
  if (v.counts.stories > 0 && v.counts.merged === v.counts.stories) return { text: 'Built', tone: 'ok' };
  const build = v.state?.build;
  if (build?.on) return { text: 'Building continuously', tone: 'ok' };
  if (build) return { text: 'Paused', tone: 'plain' };
  if (v.building) return { text: 'Building', tone: 'ok' };
  return { text: 'Approved', tone: 'ok' };
}

/** The status chip of a row in the list. */
export function rowChip(r: BreakdownRow): { text: string; tone: Tone } {
  return statusChip({ status: r.status, counts: r.counts, building: r.building });
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function countWords(c: Pick<BreakdownView['counts'], 'epics' | 'features' | 'stories'>): string {
  return `${plural(c.epics, 'epic')}, ${plural(c.features, 'feature')}, ${plural(c.stories, 'story', 'stories')}`;
}

/* ── The estimate ───────────────────────────────────────── */

/** "45 min", "1 hour", "6 hours", "2.5 hours", as the terminal says it. */
export function timeWords(minutes: number): string {
  if (minutes < 90) return `${Math.max(1, Math.round(minutes))} min`;
  const h = Math.round(minutes / 30) / 2;
  return `${h} ${h === 1 ? 'hour' : 'hours'}`;
}

/** "$140", "$4", "under $1". */
export function money(usd: number): string {
  return usd > 0 && usd < 1 ? 'under $1' : `$${Math.round(usd)}`;
}

/** What the estimate rests on: "based on 9 finished tickets", or "a rough guess" with no finished tickets yet. */
export function basisWords(e: Pick<BreakdownEstimate, 'rough' | 'basedOn'>): string {
  return e.rough ? 'a rough guess: no finished tickets yet' : `based on ${plural(e.basedOn, 'finished ticket')}`;
}

/** The cost and the time, each when there is one: no dollars for a subscription. */
export function estimateBits(e: BreakdownEstimate): { cost?: string; time: string } {
  return { ...(e.costUsd !== undefined ? { cost: money(e.costUsd) } : {}), time: timeWords(e.minutes) };
}

/** "About $140 and 6 hours to build, 2 at a time (based on 9 finished tickets)", before anything is built. */
export function estimateLine(e: BreakdownEstimate): string {
  if (!e.stories) return 'Every story is merged.';
  const { cost, time } = estimateBits(e);
  return `About ${cost ? `${cost} and ` : ''}${time} to build, ${e.parallel} at a time (${basisWords(e)})`;
}

/** "20 stories, about $140 and 6 hours, 2 at a time, based on 9 finished tickets", beside Build continuously. */
export function buildEstimate(e: BreakdownEstimate): string {
  if (!e.stories) return 'Every story is merged.';
  const { cost, time } = estimateBits(e);
  return `${plural(e.stories, 'story', 'stories')}, about ${cost ? `${cost} and ` : ''}${time}, ${e.parallel} at a time, ${basisWords(e)}`;
}

/** "About 3 hours and $60 left", while it builds: the estimate counts only the stories not merged yet. */
export function leftWords(e: BreakdownEstimate): string {
  if (!e.stories) return 'Every story is merged';
  const { cost, time } = estimateBits(e);
  return `About ${time}${cost ? ` and ${cost}` : ''} left`;
}

/* ── The Analyst at work ────────────────────────────────── */

export function jobBusy(job: BreakdownJob | undefined): boolean {
  return Boolean(job && (job.status === 'pending' || job.status === 'running' || job.status === 'stopping'));
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Page 18 of 31", "Part 2 of 5": the page or part being read, so the first one reads "Part 1 of 5", never "Part 0". */
export function atWords(at: BreakdownJob['at']): string {
  return at ? `${cap(at.unit)} ${Math.max(1, Math.min(at.done, at.of || at.done))} of ${at.of}` : '';
}

/** "Found 3 epics and 6 features so far." */
export function foundWords(found: BreakdownJob['found']): string {
  if (!found || (!found.epics && !found.features && !found.stories)) return '';
  const parts = [plural(found.epics, 'epic'), plural(found.features, 'feature'), ...(found.stories ? [plural(found.stories, 'story', 'stories')] : [])];
  return `Found ${parts.length === 3 ? `${parts[0]}, ${parts[1]} and ${parts[2]}` : parts.join(' and ')} so far.`;
}

function minutesWords(seconds: number): string {
  return seconds < 60 ? 'less than a minute' : `${Math.round(seconds / 60)} min`;
}

/** "4 min so far, usually about 8 min for 31 pages". */
export function clockWords(job: BreakdownJob | undefined, now = Date.now()): string {
  if (!job) return '';
  const since = job.startedAt ? Math.max(0, (now - Date.parse(job.startedAt)) / 1000) : null;
  const usual = job.usualSeconds ? `usually about ${minutesWords(job.usualSeconds)}${job.at?.of ? ` for ${plural(job.at.of, job.at.unit)}` : ''}` : '';
  return [since !== null ? `${minutesWords(since)} so far` : '', usual].filter(Boolean).join(', ');
}

export type StepState = 'done' | 'now' | 'todo' | 'failed';

export interface ReadStep {
  key: 'text' | 'read' | 'questions' | 'draft';
  title: string;
  sub: string;
  state: StepState;
  /** How far the read is, for its bar. */
  bar?: { done: number; of: number };
}

function textStep(v: Pick<BreakdownView, 'source'>): Pick<ReadStep, 'title' | 'sub'> {
  const s = v.source;
  const pics = s.pictures ? `, tables and ${plural(s.pictures, 'picture')}, so the Analyst sees the mockups too` : ' and tables';
  if (s.kind === 'docx') return { title: 'Turned the Word file into text', sub: `Kept the headings${pics}.` };
  if (s.kind === 'pdf') return { title: 'Kept the PDF as it is', sub: `The Analyst reads ${s.pages ? `its ${plural(s.pages, 'page')}` : 'it'} directly, pictures and all.` };
  if (s.kind === 'pasted') return { title: 'Saved the pasted text', sub: s.pages && s.pages > 1 ? `In ${s.pages} parts, so the Analyst reads it part by part.` : 'The Analyst reads it as you pasted it.' };
  return { title: 'Saved the text', sub: s.pages && s.pages > 1 ? `In ${s.pages} parts, so the Analyst reads it part by part.` : 'The Analyst reads it as it is.' };
}

/**
 * The Analyst's four steps for the reading card: the document turned into text, the read with its page or part, the
 * questions, then the epics, features and stories. Each is done, now, still to come, or where it stopped.
 */
export function readSteps(v: Pick<BreakdownView, 'status' | 'source' | 'questions' | 'state'>): ReadStep[] {
  const job = v.state.job;
  const step = job?.step;
  const failed = v.status === 'failed';
  const order: ReadStep['key'][] = ['text', 'read', 'questions', 'draft'];
  // Where the Analyst is: the step that runs, or the one that stopped.
  const at: ReadStep['key'] =
    v.status === 'questions' ? 'questions' : v.status === 'drafting' || step === 'draft' ? 'draft' : step === 'text' ? 'text' : v.status === 'ready' || v.status === 'approved' ? 'draft' : 'read';
  const index = order.indexOf(at);
  const done = v.status === 'ready' || v.status === 'approved';
  const state = (k: ReadStep['key']): StepState => {
    const i = order.indexOf(k);
    if (done || i < index) return 'done';
    if (i > index) return 'todo';
    return failed ? 'failed' : 'now';
  };
  const reading = at === 'read' && job ? [atWords(job.at), foundWords(job.found)].filter(Boolean) : [];
  const waitLine = job?.status === 'pending' && job.now ? job.now : '';
  const asked = v.questions.length;
  return [
    { key: 'text', ...textStep(v), state: state('text') },
    {
      key: 'read',
      title: 'Reading the document',
      sub:
        state('read') === 'now'
          ? waitLine && !job?.at?.done
            ? `${waitLine}.`
            : reading.length
              ? `${reading[0]}${reading[1] ? `. ${reading[1]}` : '.'}`
              : 'Starting to read.'
          : state('read') === 'failed'
            ? 'It stopped here. Nothing it found is lost.'
            : state('read') === 'done'
              ? 'Read the whole document.'
              : 'Page by page, writing down the epics and features it finds.',
      state: state('read'),
      ...(at === 'read' && job?.at?.of ? { bar: { done: job.at.done, of: job.at.of } } : {}),
    },
    {
      key: 'questions',
      title: 'Questions for you',
      sub:
        state('questions') === 'done' && index > 2
          ? asked
            ? `${plural(asked, 'question')}, answered.`
            : 'None: the BRD was clear.'
          : 'Only when something is missing or two parts clash. Small things it decides and writes down.',
      state: state('questions'),
    },
    {
      key: 'draft',
      title: 'Writing the epics, features and stories',
      sub:
        state('draft') === 'now' && job?.now
          ? `${job.now}.${foundWords(job.found) ? ` ${foundWords(job.found)}` : ''}`
          : 'Each story gets "done when" checks, its size, what it needs first, and where it comes from in the BRD.',
      state: state('draft'),
    },
  ];
}

/* ── Places in the document ─────────────────────────────── */

/** "3.4 Holding a slot, page 7". */
export function refWords(ref: BrdRef | undefined): string {
  if (!ref) return '';
  const where = [ref.section, ref.title].filter(Boolean).join(' ');
  return [where, ref.page ? `page ${ref.page}` : ''].filter(Boolean).join(', ');
}

/** "From BR-03", "From section 7": where a story comes from, on its row in the tree. */
export function fromWords(section: string): string {
  return /^\d/.test(section.trim()) ? `From section ${section.trim()}` : `From ${section.trim()}`;
}

/** "4.2, page 18": the short form a question card shows. */
export function refShort(ref: BrdRef): string {
  return [ref.section ?? ref.title, ref.page ? `page ${ref.page}` : ''].filter(Boolean).join(', ');
}

/* ── The tree ───────────────────────────────────────────── */

export interface Found {
  level: BreakdownLevel;
  item: BreakdownEpic | BreakdownFeature | BreakdownStory;
  epic: BreakdownEpic;
  feature?: BreakdownFeature;
  story?: BreakdownStory;
}

export interface StoryPlace {
  story: BreakdownStory;
  epic: BreakdownEpic;
  feature?: BreakdownFeature;
}

/** Every story, in the order of the tree. */
export function allStories(v: Pick<BreakdownView, 'epics'>): StoryPlace[] {
  return v.epics.flatMap((epic) => [...epic.features.flatMap((feature) => feature.stories.map((story) => ({ story, epic, feature }))), ...epic.stories.map((story) => ({ story, epic }))]);
}

export function findPart(v: Pick<BreakdownView, 'epics'>, key: string | undefined): Found | null {
  if (!key) return null;
  for (const epic of v.epics) {
    if (epic.key === key) return { level: 'epic', item: epic, epic };
    for (const feature of epic.features) {
      if (feature.key === key) return { level: 'feature', item: feature, epic, feature };
      const story = feature.stories.find((s) => s.key === key);
      if (story) return { level: 'story', item: story, epic, feature, story };
    }
    const story = epic.stories.find((s) => s.key === key);
    if (story) return { level: 'story', item: story, epic, story };
  }
  return null;
}

/** The stories under an epic (in its features and straight under it) or a feature. */
export function storiesUnder(item: BreakdownEpic | BreakdownFeature): BreakdownStory[] {
  return 'features' in item ? [...item.features.flatMap((f) => f.stories), ...item.stories] : item.stories;
}

/** "Online booking › Book and hold a slot": where a part sits. */
export function placeWords(f: Found): string {
  if (f.level === 'epic') return '';
  return [f.epic.title, f.level === 'story' ? f.feature?.title : undefined].filter(Boolean).join(' › ');
}

/** "2 features, 7 stories" for an epic, "3 stories" for a feature. */
export function sizeWords(item: BreakdownEpic | BreakdownFeature): string {
  const stories = plural(storiesUnder(item).length, 'story', 'stories');
  return 'features' in item && item.features.length ? `${plural(item.features.length, 'feature')}, ${stories}` : stories;
}

/** Where a part can move: a story under any feature or straight under any epic, a feature under another epic. */
export function moveTargets(v: Pick<BreakdownView, 'epics'>, f: Found): { key: string; label: string }[] {
  if (f.level === 'epic') return [];
  if (f.level === 'feature') return v.epics.map((e) => ({ key: e.key, label: `${e.key} ${e.title}` }));
  return v.epics.flatMap((e) => [
    ...e.features.map((x) => ({ key: x.key, label: `${e.title} › ${x.title}` })),
    { key: e.key, label: `${e.title}, straight under the epic` },
  ]);
}

/** The key of what a part sits under now: its feature, or its epic. */
export function parentKey(f: Found): string | undefined {
  if (f.level === 'epic') return undefined;
  if (f.level === 'feature') return f.epic.key;
  return f.feature?.key ?? f.epic.key;
}

const MERGED: StoryState[] = ['merged', 'released'];

export function isMergedState(s: StoryState | undefined): boolean {
  return Boolean(s && MERGED.includes(s));
}

/** How many of these stories are merged: "5 of 7". */
export function mergedOf(stories: BreakdownStory[], progress: Map<string, StoryProgress>): { done: number; of: number } {
  return { done: stories.filter((s) => isMergedState(progress.get(s.key)?.state)).length, of: stories.length };
}

/** The progress bar's parts: merged, building, needs you, and the rest. */
export function barParts(c: BreakdownView['counts']): { merged: number; building: number; needsYou: number; rest: number } {
  const rest = Math.max(0, c.stories - c.merged - c.building - c.needsYou);
  return { merged: c.merged, building: c.building, needsYou: c.needsYou, rest };
}

/** The stories that need this one and are not merged yet: "S-16 waits for it". */
export function waitingOn(v: Pick<BreakdownView, 'epics' | 'progress'>, key: string): string[] {
  const progress = new Map(v.progress.map((p) => [p.key, p]));
  return allStories(v)
    .filter(({ story }) => story.dependsOn.includes(key) && !isMergedState(progress.get(story.key)?.state))
    .map(({ story }) => story.key);
}

/** The stories a story needs that are not merged yet: it can start only once they are. */
export function needsLeft(v: Pick<BreakdownView, 'epics' | 'progress'>, story: BreakdownStory): string[] {
  const progress = new Map(v.progress.map((p) => [p.key, p]));
  return story.dependsOn.filter((k) => !isMergedState(progress.get(k)?.state));
}

/** The tag of a stop, in the plan's words. */
export function stopTag(stop: StoryProgress['stop']): string {
  return stop === 'clash' ? 'Two parts clash' : stop === 'gap' ? 'Missing in the BRD' : stop === 'check' ? 'A check failed' : 'Needs you';
}

/** The first sentence of a longer text, for a one-line headline. */
export function firstSentence(text: string): string {
  const m = /^(.+?[.?!])(\s|$)/.exec(text.trim());
  return (m ? m[1]! : text).trim();
}

/** The epics and features to open at first: the one with the chosen part, and those with stories that need a look. */
export function openAtFirst(v: Pick<BreakdownView, 'epics' | 'progress'>, selected?: string): Set<string> {
  const open = new Set<string>();
  const progress = new Map(v.progress.map((p) => [p.key, p.state]));
  const live: StoryState[] = ['building', 'needs-you', 'next', 'waits'];
  const anyLive = v.progress.some((p) => live.includes(p.state));
  const sel = findPart(v, selected);
  v.epics.forEach((e, i) => {
    const hasSel = sel?.epic.key === e.key;
    const hasLive = storiesUnder(e).some((s) => live.includes(progress.get(s.key)!));
    if (hasSel || (anyLive ? hasLive : i === 0)) open.add(e.key);
    for (const f of e.features) {
      const fLive = f.stories.some((s) => live.includes(progress.get(s.key)!));
      if (sel?.feature?.key === f.key || sel?.item.key === f.key || (anyLive ? fLive : i === 0)) open.add(f.key);
    }
  });
  return open;
}

/* ── Decided for you ────────────────────────────────────── */

const BY: Record<Decided['by'], string> = { analyst: 'Analyst', architect: 'Architect', builder: 'Builder', tester: 'Tester', reviewer: 'Reviewer', answer: 'from your answer' };

/** "S-4 · Analyst", "S-14 · RO-31 · Architect", "S-10 · from your answer". */
export function decidedWho(d: Decided): string {
  return [d.item, d.ticket, BY[d.by] ?? d.by].filter(Boolean).join(' · ');
}

/* ── Send to the tracker ────────────────────────────────── */

/** "User Story" → "User stories", "Product Backlog Item" → "Product backlog items", "Epic" → "Epics". */
export function pluralType(type: string): string {
  const words = type.trim().split(/\s+/);
  const last = words.pop() ?? '';
  const many = /[^aeiou]y$/i.test(last) ? `${last.slice(0, -1)}ies` : /s$/i.test(last) ? last : `${last}s`;
  const all = [...words, many].map((w, i) => (i === 0 ? cap(w.toLowerCase()) : w.toLowerCase()));
  return all.join(' ');
}

/** "new" on the first send; later "2 new, 1 changed", or "no changes". */
export function sendCountWords(c: SendLevelCount, first: boolean): string {
  if (first || (c.new === c.all && c.all > 0)) return 'new';
  const parts = [c.new ? `${c.new} new` : '', c.changed ? `${c.changed} changed` : ''].filter(Boolean);
  return parts.length ? parts.join(', ') : 'no changes';
}

/** A real example of a need for the links line: "S-5 needs S-4". */
export function needExample(v: Pick<BreakdownView, 'epics'>): string | null {
  const s = allStories(v).find(({ story }) => story.dependsOn.length);
  return s ? `${s.story.key} needs ${s.story.dependsOn[0]}` : null;
}

/** What the Send dialog said it sends ("Send 30 items", "20 links"), kept while the send runs. */
export interface SendPlanned {
  items: number;
  links: number;
  /** The send it belongs to: state.sync.at once the squad has it. */
  at?: string;
}

type Count = { done: number; of: number };
type SyncNow = { done: number; of: number; at?: string; items?: Count; links?: Count };

/** Where a send is, in the dialog's own units: its items first, then the links between stories. */
export interface SendStep {
  /** unknown: the units cannot be told apart, so only the bar shows. */
  phase: 'items' | 'links' | 'unknown';
  done?: number;
  of: number;
  /** The whole send, for the bar. */
  pct: number;
}

/**
 * A send's progress in the units the Send dialog used: "14 of 30 items", then "adding the 20 links". The squad counts
 * the items and then each story's links in one `done of`; separate `items` or `links` counts win when it gives them.
 */
export function sendStep(sync: SyncNow | undefined, planned?: SendPlanned | null): SendStep {
  if (!sync) return { phase: 'unknown', of: 0, pct: 0 };
  const pct = (d: number, o: number) => (o > 0 ? Math.min(100, Math.round((d / o) * 100)) : 5);
  const plan = planned && (!planned.at || !sync.at || planned.at === sync.at) ? planned : null;
  const links = sync.links;
  const itemsOf = sync.items?.of ?? plan?.items ?? (links ? sync.of : undefined);
  if (itemsOf === undefined) return { phase: 'unknown', of: sync.of, pct: pct(sync.done, sync.of) };
  const itemsDone = sync.items?.done ?? Math.min(sync.done, itemsOf);
  const linksOf = links?.of ?? plan?.links ?? 0;
  const whole = sync.items || links ? pct(itemsDone + (links?.done ?? 0), itemsOf + (links?.of ?? 0)) : pct(sync.done, sync.of);
  if (itemsDone >= itemsOf && linksOf > 0) return { phase: 'links', ...(links ? { done: links.done } : {}), of: linksOf, pct: whole };
  return { phase: 'items', done: itemsDone, of: itemsOf, pct: whole };
}

/** "14 of 30 items", "adding the 20 links", or nothing when only the bar can tell. */
export function sendStepWords(s: SendStep): string {
  if (s.phase === 'links') return s.done === undefined ? `adding the ${plural(s.of, 'link')}` : `adding the links, ${s.done} of ${s.of}`;
  if (s.phase === 'items') return `${s.done} of ${plural(s.of, 'item')}`;
  return '';
}

/* ── Building ───────────────────────────────────────────── */

/**
 * Every story merged: "All 20 stories are merged and wait in the next release." `release`: some still wait for the
 * person to send the release out. Null while some stories are not merged.
 */
export function builtWords(v: Pick<BreakdownView, 'counts' | 'progress'>): { text: string; release: boolean } | null {
  const n = v.counts.stories;
  if (!n || v.counts.merged < n) return null;
  const all = n === 1 ? 'The story is merged' : `All ${n} stories are merged`;
  const out = v.progress.length > 0 && v.progress.every((p) => p.state === 'released');
  return out ? { text: `${all} and went out in a release.`, release: false } : { text: `${all} and ${n === 1 ? 'waits' : 'wait'} in the next release.`, release: true };
}

/** What a changed Decided for you entry became, from the reply: a small change on its ticket, or a new linked one. */
export function changedWords(ticket: string, became: string | undefined): string {
  if (!became) return `Changed on ${ticket}.`;
  if (/^c\d+$/.test(became)) return `It became a small change on ${ticket}. The Analyst writes it into the spec.`;
  return `${ticket} is merged, so it became a new ticket, ${became}, linked to it.`;
}

/** The text of a card without its first sentence when that sentence only says the title again. */
export function afterTitle(text: string, title: string): string {
  const t = text.trim();
  const head = title.trim().replace(/[.!]$/, '').toLowerCase();
  if (!head || !t.toLowerCase().startsWith(head)) return t;
  const rest = t.slice(head.length).replace(/^[.!]?\s*/, '');
  return rest || t;
}

/* ── Done when, on Save ─────────────────────────────────── */

const blank = (s: string) => !s.trim();

/** A check with some parts written and some empty: it needs the rest, or to be removed. */
export function halfCheck(c: Pick<Criterion, 'given' | 'when' | 'then'>): boolean {
  const parts = [c.given, c.when, c.then];
  return parts.some(blank) && !parts.every(blank);
}

/** The checks a Save keeps: empty ones go. Half-filled ones stay, for the person to finish. */
export function keptChecks<T extends Pick<Criterion, 'given' | 'when' | 'then'>>(list: T[]): T[] {
  return list.filter((c) => ![c.given, c.when, c.then].every(blank));
}

/** "Add the part that was left out: A mobile app for parties (8 Later phases, page 5)." */
export function leftOutAsk(l: LeftOut): string {
  return `Add the part that was left out: ${l.text}${l.ref ? ` (${refWords(l.ref)})` : ''}.`;
}

/* ── The sidebar ────────────────────────────────────────── */

/** What waits for the person on the Requirements page: their breakdowns with questions, and stories that need them. */
export function requirementsWaiting(rows: BreakdownRow[], me?: string): number {
  const mine = (r: BreakdownRow) => !me || r.owner.trim().toLowerCase() === me.trim().toLowerCase();
  return rows.filter(mine).reduce((n, r) => n + (r.status === 'questions' ? 1 : 0) + r.counts.needsYou, 0);
}

/* ── The map ────────────────────────────────────────────── */

export interface MapBox {
  key: string;
  level: BreakdownLevel;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  /** Which row of epics it is in, from 0. A long breakdown wraps into rows. */
  row: number;
  /** Stories: where they are. */
  state?: StoryState;
  /** Epics and features: how many of their stories are merged. */
  done?: { done: number; of: number };
}

export interface MapLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface MapLayout {
  boxes: MapBox[];
  lines: MapLine[];
  width: number;
  height: number;
}

/** Sizes on the map. A feature and a story box hold two lines of title, so titles are not cut. */
export const MAP = { col: 172, gap: 14, epicGap: 44, pad: 24, epicH: 74, featY: 160, featH: 72, storyY: 258, storyH: 44, storyStep: 50, popW: 300, popH: 150, rowWidth: 1600 } as const;

/**
 * The map: each epic on top, its features in a row under it, and each feature's stories stacked under the feature.
 * Stories straight under an epic get a column of their own. Lines join each part to the one above it. Epics sit side
 * by side and wrap into a new row past `rowWidth`, so a long breakdown stays readable instead of one endless line.
 */
export function mapLayout(v: Pick<BreakdownView, 'epics' | 'progress'>, rowWidth: number = MAP.rowWidth): MapLayout {
  const { col, gap, epicGap, pad, epicH, featY, featH, storyY, storyH, storyStep } = MAP;
  const progress = new Map(v.progress.map((p) => [p.key, p]));
  const boxes: MapBox[] = [];
  const lines: MapLine[] = [];
  const busY = epicH + (featY - epicH) / 2;
  let x = pad;
  let row = 0;
  let top = pad;
  let bottom = pad + featY + featH;
  let width = pad * 2 + col;
  const stack = (stories: BreakdownStory[], left: number, y: number) => {
    stories.forEach((s, i) => {
      boxes.push({ key: s.key, level: 'story', row, x: left, y: y + i * storyStep, w: col, h: storyH, title: s.title, state: progress.get(s.key)?.state ?? 'not-started' });
    });
    if (stories.length) bottom = Math.max(bottom, y + (stories.length - 1) * storyStep + storyH);
  };
  for (const e of v.epics) {
    const columns: ({ kind: 'feature'; f: BreakdownFeature } | { kind: 'stories' })[] = [...e.features.map((f) => ({ kind: 'feature' as const, f })), ...(e.stories.length ? [{ kind: 'stories' as const }] : [])];
    const n = Math.max(1, columns.length);
    const span = n * col + (n - 1) * gap;
    if (x > pad && x + span + pad > rowWidth) {
      row += 1;
      x = pad;
      top = bottom + epicGap;
      bottom = top + featY + featH;
    }
    const mid = x + span / 2;
    boxes.push({ key: e.key, level: 'epic', row, x, y: top, w: span, h: epicH, title: e.title, done: mergedOf(storiesUnder(e), progress) });
    const centers = columns.map((_, i) => x + i * (col + gap) + col / 2);
    if (centers.length) {
      lines.push({ x1: mid, y1: top + epicH, x2: mid, y2: top + busY });
      lines.push({ x1: Math.min(mid, centers[0]!), y1: top + busY, x2: Math.max(mid, centers.at(-1)!), y2: top + busY });
    }
    columns.forEach((c, i) => {
      const left = x + i * (col + gap);
      const cx = centers[i]!;
      if (c.kind === 'feature') {
        lines.push({ x1: cx, y1: top + busY, x2: cx, y2: top + featY });
        boxes.push({ key: c.f.key, level: 'feature', row, x: left, y: top + featY, w: col, h: featH, title: c.f.title, done: mergedOf(c.f.stories, progress) });
        if (c.f.stories.length) lines.push({ x1: cx, y1: top + featY + featH, x2: cx, y2: top + storyY });
        stack(c.f.stories, left, top + storyY);
      } else {
        // Stories straight under the epic hang from the epic's line.
        lines.push({ x1: cx, y1: top + busY, x2: cx, y2: top + storyY });
        stack(e.stories, left, top + storyY);
      }
    });
    width = Math.max(width, x + span + pad);
    x += span + epicGap;
  }
  return { boxes, lines, width, height: bottom + pad };
}

/** The look of a story's box on the map: merged, building, needs you, or not started yet. */
export function chipKind(state: StoryState | undefined): 'm' | 'b' | 'y' | 'w' {
  if (isMergedState(state)) return 'm';
  if (state === 'building') return 'b';
  if (state === 'needs-you') return 'y';
  return 'w';
}

/**
 * Where the needs-you note sits on the map: under its story's column, below every box it would cover, so no story is
 * hidden by it. `height`: the map's height with the note in it.
 */
export function popPlace(layout: Pick<MapLayout, 'boxes' | 'width' | 'height'>, box: Pick<MapBox, 'x' | 'y' | 'h' | 'row'>): { left: number; top: number; height: number } {
  const left = Math.max(MAP.pad / 2, Math.min(box.x, layout.width - MAP.popW - MAP.pad / 2));
  const right = left + MAP.popW;
  const under = layout.boxes.filter((b) => b.level !== 'epic' && b.row === box.row && b.x < right && b.x + b.w > left).map((b) => b.y + b.h);
  const top = Math.max(box.y + box.h, ...under) + 14;
  return { left, top, height: Math.max(layout.height, top + MAP.popH + MAP.pad) };
}

/** The scale that fits the whole map in the room it has, never bigger than its own size. */
export function fitScale(layout: Pick<MapLayout, 'width' | 'height'>, room: { width: number; height: number }): number {
  if (!room.width || !room.height) return 1;
  const s = Math.min(room.width / layout.width, room.height / layout.height, 1);
  return Math.max(0.3, Math.round(s * 100) / 100);
}

/** The scale the map opens at: its full width when that stays readable, else readable and dragged to see the rest. */
export function firstScale(layout: Pick<MapLayout, 'width'>, room: { width: number }): number {
  if (!room.width) return 1;
  return Math.max(0.6, Math.min(1, Math.round((room.width / layout.width) * 100) / 100));
}
