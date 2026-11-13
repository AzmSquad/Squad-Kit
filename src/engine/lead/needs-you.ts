import { liveNow, shortDoing, type LiveNow } from '../../board/now.js';
import { withProblem } from '../../board/problem.js';
import { listTickets, type BoardPaths } from '../../board/store.js';
import type { Ticket } from '../../board/types.js';
import { middle, readUsual } from '../../board/usual.js';
import { WHO } from '../../board/clock.js';
import { actionCard, waysOut } from './cards.js';
import { proofWords } from './proof-words.js';
import { allowsAlways } from './store.js';
import type { NeedsYouItem, NewsItem, SquadNowItem } from './types.js';
import { pressNeeded, releasedNews } from './waiting.js';

/**
 * "Needs you", "What's new" and "The squad now", for the lead's popup, its page and the phone: one call each, from the
 * board's own waiting and live data. Each item carries the lead's check-in words, made by squad-kit from the story's
 * data with no AI call: "MA-7 is ready for your check: 5 pictures, checks pass, Reviewer approved".
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Pictures in a story's proof: each row's main one and its others. */
function picturesIn(t: Ticket): number {
  return (t.proof ?? []).reduce((n, p) => n + (p.after ? 1 : 0) + (p.more?.length ?? 0), 0);
}

/** "checks pass, Reviewer approved", from the story's gates. */
function gatesWords(t: Ticket): string[] {
  const g = t.gates;
  if (!g) return [];
  const checks = g.checks === 'pass' ? 'checks pass' : g.checks === 'fail' ? 'checks did not pass' : g.checks === 'unchecked' ? 'not checked: the project has no tests' : g.checks === 'skipped' ? 'checks gone past, with a reason' : '';
  const review = g.review === 'pass' ? 'Reviewer approved' : g.review === 'fail' ? 'review notes open' : g.review === 'skipped' ? 'review gone past, with a reason' : '';
  return [checks, review].filter(Boolean);
}

/** The lead's check-in for one story that needs the person, in plain words, and the kind of item it is. */
export function checkIn(t: Ticket, now: LiveNow): Pick<NeedsYouItem, 'kind' | 'words' | 'more' | 'lowRisk'> {
  const id = t.id;
  if (t.quiet?.kind === 'stuck') return { kind: 'looks-stuck', words: `${id} looks stuck.`, more: cut(now.slow?.text ?? t.quiet.detail, 200) };
  if (now.slow?.kind === 'long' && !t.waiting) {
    return { kind: 'slow', words: `Give ${id} 10 more minutes?`, more: `${now.slow.why?.sentence ?? now.slow.text} Low risk.`, lowRisk: true };
  }
  switch (t.waiting?.kind) {
    case 'proof': {
      const rows = t.proof?.length ?? 0;
      const pics = picturesIn(t);
      const all = rows > 0 && (t.proof ?? []).every((p) => p.after);
      return { kind: 'proof', words: `${id} is ready for your check: ${[proofWords(t, pics), ...gatesWords(t)].join(', ')}.`, ...(rows ? { more: `${plural(rows, '"done when"', '"done when"')}${all ? ', all with pictures' : ''}` } : {}) };
    }
    case 'spec':
      return { kind: 'spec', words: `${id}'s spec is ready for you: ${plural(t.criteria?.length ?? 0, '"done when"', '"done when"')}.` };
    case 'plan':
      return { kind: 'plan', words: `${id}'s plan is ready for you: ${plural(t.steps?.length ?? 0, 'step')}.` };
    case 'questions': {
      const open = (t.questions ?? []).filter((q) => !q.answer).length;
      return { kind: 'questions', words: `The Analyst has ${plural(open || 1, 'question')} on ${id}.` };
    }
    case 'ask': {
      const q = t.agentQuestion;
      return { kind: 'ask', words: `The ${q ? WHO[q.from] : 'squad'} asks you something on ${id}.`, ...(q ? { more: cut(q.text, 200) } : {}) };
    }
    case 'stuck': {
      const p = withProblem(t).stuck;
      return { kind: 'stuck', words: `${id} stopped: ${cut(p?.title ?? p?.question ?? 'it needs your decision', 160)}`, ...(p?.title && p.question ? { more: cut(p.question, 200) } : {}) };
    }
    case 'release':
      return { kind: 'release', words: `${id} is ready to go out with the next release.` };
    case 'split': {
      const s = t.split?.suggestion;
      return { kind: 'split', words: s?.size === 'brd' ? `${id} is too big for one story: the Analyst suggests Requirements.` : `The Analyst suggests splitting ${id} into ${s?.parts.length ?? 'a few'} stories.` };
    }
    default: {
      const said = cut(t.waiting?.summary ?? now.sentence, 200);
      return { kind: 'other', words: said.startsWith(id) ? said : `${id}: ${said}` };
    }
  }
}

/** Where the board opens an item. */
function openOf(t: Ticket): string {
  return t.waiting?.kind === 'proof' ? `/tickets/${encodeURIComponent(t.id)}/proof` : `/board?ticket=${encodeURIComponent(t.id)}`;
}

/**
 * Everything that needs a press from the person now, with the lead's check-in words and the real ways out as cards.
 * The open stories only, as the board counts them (lead/waiting.ts); a slower step comes last, uncounted. No AI.
 */
export function needsYou(bp: BoardPaths, at = Date.now()): NeedsYouItem[] {
  const usual = readUsual(bp);
  const waiting = pressNeeded(bp);
  const seen = new Set(waiting.map((t) => t.id));
  // A slow step is no wait, but the person may give it more time: it shows too, unless "Always allow" gives it.
  const slow = listTickets(bp).filter((t) => !seen.has(t.id) && t.stage !== 'done' && !t.archived && t.quiet?.kind === 'long' && !t.waiting && !(t.quietSnoozedUntil && Date.parse(t.quietSnoozedUntil) > at));
  return [...waiting, ...slow].map((t) => {
    const now = liveNow(t, usual, at);
    const c = checkIn(t, now);
    const prefix = `now.${t.id}`;
    let cards = c.kind === 'slow' ? [actionCard(`${prefix}.more_time`, 'more_time', { story: t.id, minutes: 10, why: now.slow?.why?.sentence ?? 'It is slower than usual but still working.' })] : waysOut(t, prefix).map((x) => (x.kind === 'board_action' ? { ...x, id: `${prefix}.${x.action}` } : x));
    if (c.kind === 'slow' && allowsAlways(bp, 'more_time')) cards = cards.map((x) => ({ ...x, byItself: 'Always allow is on: squad-kit gives it more time by itself.' }));
    return { id: `${prefix}.${c.kind}`, story: t.id, title: t.title, ...c, cards, open: openOf(t) };
  });
}

/** "What's new": a released story with news, such as a decision that came after its plan. Never counted. */
export function whatsNew(bp: BoardPaths): NewsItem[] {
  return releasedNews(bp).map((t) => {
    const after = (t.outdated ?? []).map((o) => o.adr);
    const words = `${t.id} is released${t.release ? ` in ${t.release}` : ''}.${after.length ? ` ${after.join(', ')} came after its plan.` : ''}`;
    return { id: `new.${t.id}`, story: t.id, title: t.title, words, open: `/board?ticket=${encodeURIComponent(t.id)}` };
  });
}

/** Each agent at work now, what it does in a few words, and how far along its step is. */
export function squadNow(bp: BoardPaths, at = Date.now()): SquadNowItem[] {
  const usual = readUsual(bp);
  const out: SquadNowItem[] = [];
  for (const t of listTickets(bp)) {
    if (t.stage === 'done' || t.archived) continue;
    const now = liveNow(t, usual, at);
    if (now.state !== 'working') continue;
    const part = now.part;
    const progress = part ? (part.n - 1) / part.of : now.usual && now.seconds !== undefined ? now.seconds / Math.max(1, middle(now.usual) * 1.5) : undefined;
    out.push({
      story: t.id,
      title: t.title,
      who: now.who ?? 'squad-kit',
      doing: now.slow?.why?.short ?? (now.doing ? shortDoing(now.doing) : now.sentence),
      ...(progress !== undefined ? { progress: Math.round(Math.max(0.03, Math.min(0.97, progress)) * 100) / 100 } : {}),
      ...(now.slow ? { slow: true } : {}),
    });
  }
  return out;
}
