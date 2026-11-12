import { BoardActionError } from './actions.js';
import { requireTicket, type BoardPaths } from './store.js';
import type { Ticket } from './types.js';

/**
 * A short mark of what a story waits on the person for, right now: its kind and the thing itself (the proof's rows and
 * pictures, the spec's words, the plan's steps, the agent's question). A new proof round, a rewritten spec or a new
 * question is a new mark. A decision card in a chat carries the mark it was made with, and a press sends it back: the
 * board's own action then runs only on the thing the person saw.
 */
export function waitKey(t: Pick<Ticket, 'waiting' | 'proof' | 'proofRound' | 'gates' | 'story' | 'criteria' | 'steps' | 'decision' | 'questions' | 'agentQuestion' | 'specApproved'>): string | undefined {
  const w = t.waiting;
  if (!w) return undefined;
  switch (w.kind) {
    case 'proof':
      return `proof:${hash([t.proof?.map((p) => [p.criterion, p.before, p.after, p.shows]), t.proofRound ?? 0, t.gates])}`;
    case 'spec':
      return `spec:${hash([t.story, t.criteria])}`;
    case 'plan':
      return `plan:${hash([t.story, t.criteria, t.steps?.map((s) => s.title), t.decision?.title, t.decision?.options, Boolean(t.specApproved)])}`;
    case 'questions':
      return `questions:${hash(t.questions?.map((q) => [q.id, q.text, q.options]))}`;
    case 'ask':
      return `ask:${hash([t.agentQuestion?.at, t.agentQuestion?.text])}`;
    default:
      return `${w.kind}:${hash(w.summary)}`;
  }
}

/** The mark as a field of the story the board's pages read, left out when nothing waits. */
export function withKey(t: Ticket): { waitKey?: string } {
  const key = waitKey(t);
  return key ? { waitKey: key } : {};
}

/** FNV-1a over the JSON, as 8 hex digits: enough to tell two versions of one story's wait apart. */
function hash(v: unknown): string {
  const s = JSON.stringify(v ?? null);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * A press from a decision card: the story must still wait on what the card showed. Left out (the board's own
 * buttons), nothing is checked here: the action checks the rest itself, as always.
 */
export function expectWait(bp: BoardPaths, id: string, expect: unknown): void {
  if (typeof expect !== 'string' || !expect) return;
  const t = requireTicket(bp, id);
  if (!t.waiting) throw new BoardActionError(`${t.id} no longer waits for you: it was already decided on the board.`);
  if (waitKey(t) !== expect) throw new BoardActionError(`${t.id} changed since this card was made. Open it to see it as it is now.`);
}
