import type { LeadCard, LeadContext, LeadSource, LeadStep, LeadTurn, NeedsYouItem, ProofKind, SquadNowItem } from '../api/types';

/**
 * The Squad lead's words on the board, worked out from the API's shapes: the one line of an answer's work, where a
 * question was asked from, the question an "Ask the lead" button fills in, and where a source or a check-in opens.
 */

const ID = /^[A-Z][A-Z0-9]*-\d+$/;

/** "a, b and c". */
export function andList(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

/**
 * The work trace in one line, for the folded header: "Read 2 stories, 1 decision and 3 files, searched the code twice,
 * then looked at the app in its own copy". Empty when it did nothing worth saying.
 */
export function traceSummary(trace: LeadStep[]): string {
  const files = new Set<string>();
  let stories = 0;
  let decisions = 0;
  let searches = 0;
  let pictures = 0;
  let board = false;
  let log = false;
  let guide = false;
  let notes = false;
  let found = false;
  let history = false;
  let app = false;
  let refused = false;
  for (const s of trace) {
    const t = s.text;
    if (s.kind === 'code') {
      if (/^Searched the code|^Looked for files/.test(t)) searches++;
      else if (/^Looked at the code's history/.test(t)) history = true;
      else if (/^Read (?!a file outside)/.test(t)) files.add(t.slice(5));
      else if (/^Ran a read command/.test(t)) files.add(t);
      else if (/^Looked in /.test(t)) searches++;
    } else if (s.kind === 'story') {
      if (/^Read decision|^Read the decisions/.test(t)) decisions++;
      else stories++;
    } else if (s.kind === 'board') board = true;
    else if (s.kind === 'log') log = true;
    else if (s.kind === 'guide') guide = true;
    else if (s.kind === 'notes' && /^Found it in/.test(t)) found = true;
    else if (s.kind === 'notes' && !/^Saved what it learned/.test(t)) notes = true;
    else if (s.kind === 'app') {
      app = true;
      const took = /^Took (a|\d+) pictures?/.exec(t);
      if (took) pictures += took[1] === 'a' ? 1 : Number(took[1]);
    } else if (s.kind === 'refused') refused = true;
  }
  const read = [
    ...(stories ? [count(stories, 'story', 'stories')] : []),
    ...(decisions ? [count(decisions, 'decision')] : []),
    ...(files.size ? [count(files.size, 'file')] : []),
    ...(board ? ['the board'] : []),
    ...(log ? ["squad-kit's log"] : []),
    ...(guide ? ["squad-kit's guide"] : []),
    ...(notes ? ['its notes'] : []),
  ];
  const parts = [
    ...(found ? ["found it in squad-kit's notes"] : []),
    ...(read.length ? [`read ${andList(read)}`] : []),
    ...(searches ? [`searched the code ${times(searches)}`] : []),
    ...(history ? ["looked at the code's history"] : []),
  ];
  const look = pictures ? `took ${count(pictures, 'picture')} in its own copy of the app` : app ? 'looked at the app in its own copy' : '';
  let line = parts.length > 1 ? `${parts.slice(0, -1).join(', ')}, ${parts[parts.length - 1]}` : (parts[0] ?? '');
  if (look) line = line ? `${line}, then ${look}` : look;
  if (refused) line = line ? `${line}. squad-kit refused part of the ask` : 'squad-kit refused the ask itself';
  // squad-kit keeps its small s.
  return line && !line.startsWith('squad-kit') ? line[0]!.toUpperCase() + line.slice(1) : line;
}

/** "16 s", "2 min 5 s". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
}

/** "$0.29", "under $0.01". */
export function dollars(usd: number): string {
  return usd < 0.005 ? 'under $0.01' : `$${usd.toFixed(2)}`;
}

/** The body without the headline it starts with: an answer from a note says its first sentence only once. */
export function bodyAfter(headline: string, body: string): string {
  const h = headline.trim();
  const b = body.trim();
  if (!b || b === h) return '';
  return b.startsWith(h) ? b.slice(h.length).trim() : b;
}

/** The small line under an answer: its time and cost, or how squad-kit answered it at once with no AI. */
export function turnMeta(turn: Pick<LeadTurn, 'answer' | 'seconds' | 'costUsd'>): string {
  switch (turn.answer?.by) {
    case 'note':
      return "From squad-kit's notes, at once. No cost.";
    case 'record':
      return "From the story's live record, at once. No cost.";
    case 'refusal':
    case 'limit':
      return 'squad-kit answered this itself. No cost.';
  }
  const parts = [...(turn.seconds !== undefined ? [duration(turn.seconds)] : []), turn.costUsd !== undefined ? dollars(turn.costUsd) : 'cost not reported'];
  return parts.join(' · ');
}

const PROBLEM_WORDS: Record<Extract<LeadContext, { from: 'problem' }>['problem'], string> = {
  slow: 'taking longer than usual',
  stuck: 'looks stuck',
  waiting: 'waits for you',
  error: 'stopped',
};

/** Where a question is asked from, as the ask box shows it: "About RO-9: it looks stuck", "From RoomFlow web, on /app". */
export function chipWords(ctx: LeadContext): string {
  switch (ctx.from) {
    case 'app':
      return `From ${ctx.app ?? 'your app'}, on ${ctx.path === '/' ? 'its first page' : ctx.path}`;
    case 'story':
      return `About ${ctx.story}`;
    case 'problem':
      return ctx.story ? `About ${ctx.story}: it ${PROBLEM_WORDS[ctx.problem]}` : 'About an error on the board';
    default:
      return ctx.page ? `From the board, on ${ctx.page}` : 'From the board';
  }
}

/** Where a question was asked from, for the small chip under it: "Asked from RoomFlow web, on /app". */
export function contextWords(ctx: LeadContext): string {
  const w = chipWords(ctx);
  return `Asked ${w[0]!.toLowerCase()}${w.slice(1)}`;
}

/** The question an "Ask the lead" button fills in, so the person never has to describe the problem. */
export function problemQuestion(problem: Extract<LeadContext, { from: 'problem' }>['problem'], story: string): string {
  switch (problem) {
    case 'slow':
      return `Why is ${story} taking longer than usual?`;
    case 'stuck':
      return `Why does ${story} look stuck, and what should I do?`;
    case 'waiting':
      return `What does ${story} need from me, and what do you recommend?`;
    case 'error':
      return `Why did ${story} stop, and what should I do?`;
  }
}

/** The sidebar's page names, for "Asked from the board, on Releases". */
const PAGES: Record<string, string> = {
  overview: 'Overview',
  requirements: 'Requirements',
  board: 'Board',
  backlog: 'Backlog',
  inbox: 'Waiting for you',
  conversations: 'Conversations',
  releases: 'Releases',
  architecture: 'Architecture',
  bugs: 'Bugs',
  harness: 'Harness',
  tools: 'Tools',
  settings: 'Settings',
  lead: 'Squad lead',
};

/** Where ⌘K was pressed: the open story when there is one, else the page. `path` is the board's own, under the project. */
export function pageContext(path: string, search: Record<string, unknown> = {}): LeadContext {
  const ticket = typeof search.ticket === 'string' && ID.test(search.ticket) ? search.ticket : undefined;
  const proof = /^\/tickets\/([^/]+)\/proof/.exec(path)?.[1];
  const story = ticket ?? (proof && ID.test(decodeURIComponent(proof)) ? decodeURIComponent(proof) : undefined);
  if (story) return { from: 'story', story };
  const page = PAGES[path.split('/')[1] ?? ''];
  return page ? { from: 'board', page } : { from: 'board' };
}

/** The address of an app as a page path: "/app" from "http://localhost:5000/app", "/" when there is none. */
export function appPath(address?: string): string {
  if (!address) return '/';
  try {
    return new URL(address).pathname || '/';
  } catch {
    return '/';
  }
}

/** Where a board link opens: a story's drawer (at a tab), its proof page, or a page. Null when the board has no place for it. */
export type BoardPlace =
  | { to: '/board'; ticket: string; tab?: 'story' | 'plan' | 'proof' }
  | { to: '/tickets/$id/proof'; id: string }
  | { to: '/architecture'; adr: string }
  | { to: '/releases' };

/** A "Needs you" item's or an Open card's own place: "/tickets/MA-7/proof", "/board?ticket=MA-9&tab=plan". */
export function placeOf(open: string): BoardPlace | null {
  const proof = /^\/tickets\/([^/?#]+)\/proof/.exec(open)?.[1];
  if (proof) return { to: '/tickets/$id/proof', id: decodeURIComponent(proof) };
  const m = /^\/board\?(?:.*&)?ticket=([^&#]+)/.exec(open)?.[1];
  const tab = /^\/board\?(?:.*&)?tab=(story|plan|proof)(?:[&#]|$)/.exec(open)?.[1] as 'story' | 'plan' | 'proof' | undefined;
  if (m) return { to: '/board', ticket: decodeURIComponent(m), ...(tab ? { tab } : {}) };
  return null;
}

/** Where a source opens on the board: a story, a decision, the releases. A file, a note or the guide has no page. */
export function sourcePlace(s: LeadSource): BoardPlace | null {
  if (s.kind === 'story' && ID.test(s.ref)) return { to: '/board', ticket: s.ref };
  if (s.kind === 'decision') return { to: '/architecture', adr: s.ref };
  if (s.kind === 'release') return { to: '/releases' };
  return null;
}

/** The chip's words for a file source: its name and line, without the folders. */
export function fileLabel(ref: string): string {
  return ref.split('/').pop() ?? ref;
}

export const PROOF_NAME: Record<ProofKind, string> = { screen: 'Screen', api: 'API', data: 'Data', test: 'Test' };

/** "On its own" or "Needs your OK", from the card's level. */
export function levelName(card: Pick<LeadCard, 'level'>): string {
  return card.level === 1 ? 'On its own' : 'Needs your OK';
}

/** The low-risk actions "Always allow" may cover, and only those. */
export function canAlwaysAllow(card: LeadCard): boolean {
  return card.kind === 'board_action' && Boolean(card.allowAlways) && ['more_time', 'pictures_again', 'start_app', 'morning_brief'].includes(card.action);
}

/** The main button of a "Needs you" item: the proof opens as "Open the proof", the rest open the story. */
export function openLabel(item: Pick<NeedsYouItem, 'kind'>): string {
  switch (item.kind) {
    case 'proof':
      return 'Open the proof';
    case 'spec':
      return 'Review the spec';
    case 'plan':
      return 'Review the plan';
    case 'questions':
    case 'ask':
      return 'Answer';
    default:
      return 'Open it';
  }
}

/** The problem an item on the "Needs you" rail is, for its "Ask about it". */
export function problemOf(item: Pick<NeedsYouItem, 'kind'>): Extract<LeadContext, { from: 'problem' }>['problem'] {
  return item.kind === 'slow' ? 'slow' : item.kind === 'looks-stuck' ? 'stuck' : item.kind === 'stuck' ? 'error' : 'waiting';
}

/**
 * Three questions to start with, from the project when it can: its app's sign-in, a slow or stuck story, a story at
 * work, then what is left before the release.
 */
export function exampleQuestions(o: { apps?: string[]; needsYou?: Pick<NeedsYouItem, 'story' | 'kind'>[]; squadNow?: Pick<SquadNowItem, 'story' | 'slow'>[] }): string[] {
  const app = o.apps?.[0];
  const slow = o.squadNow?.find((s) => s.slow)?.story ?? o.needsYou?.find((n) => n.kind === 'slow' || n.kind === 'looks-stuck')?.story;
  const stopped = o.needsYou?.find((n) => n.kind === 'stuck')?.story;
  const working = o.squadNow?.[0]?.story;
  const story = slow ? `Why is ${slow} slow?` : stopped ? `Why did ${stopped} stop?` : working ? `What is ${working} doing now?` : 'Which story added the sign-in page?';
  return [app ? `How do I sign in to ${app}?` : 'How do I sign in to the app?', story, "What's left before the release?"];
}
