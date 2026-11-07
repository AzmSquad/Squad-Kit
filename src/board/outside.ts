import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BoardActionError, approve, needsSpec, openChange, refuseWhileSaving, saveDesignDecision, shipped } from './actions.js';
import { waitsAtReview } from './at-review.js';
import { NO_DOCS, hasDesign, hasSpec, leaveForOutside } from './outside-step.js';
import { squadAlive } from './lock.js';
import { isMine, ownerOf } from './owner.js';
import { scheduleSquad } from './schedule.js';
import { addActivity, readMeta, requireTicket, ticketDir, updateTicket, type BoardPaths } from './store.js';
import type { BoardMeta, LeftForOutside, Ticket } from './types.js';
import { copiesOf } from '../engine/copies.js';
import { gitLater } from '../engine/git.js';
import { workSoFar } from '../engine/handover.js';

/**
 * A story worked on in a conversation in any AI tool, outside squad-kit. It leaves at any step and comes back at any step.
 * squad-kit trusts only what it ran itself: what comes back carries a label, and the person's Check runs the checks, the
 * review and the proof, as Give back does. A story that comes back with nothing changed is as it was, with no label.
 */

/** The documents a conversation writes, as they are now. Notes are the person's, and the ticket's file is squad-kit's. */
function docsHash(bp: BoardPaths, id: string): string {
  const said = ['spec.md', 'design.md', 'questions.md', 'proof.md'].flatMap((f) => {
    try {
      return [f, fs.readFileSync(path.join(ticketDir(bp, id), f), 'utf8')];
    } catch {
      return [];
    }
  });
  return said.length ? createHash('sha256').update(said.join('\0')).digest('hex').slice(0, 16) : NO_DOCS;
}

/** A file bigger than this counts by its size and time, so a huge file is never read whole. */
const MOST_HASHED = 20 * 1024 * 1024;

/**
 * Whether the story's copies hold code, and a hash of that code as it is now, file by file: work is often not committed.
 * Git can take a while on a huge project, so never on the page's own time.
 */
async function workOf(meta: BoardMeta, t: Ticket): Promise<{ built: boolean; hash: string }> {
  const hash = createHash('sha256');
  let built = false;
  for (const c of copiesOf(meta, t)) {
    if (!c.baseCommit || !fs.existsSync(c.dir)) continue;
    const files = (await workSoFar(c.dir, c.baseCommit)).sort();
    if (!files.length) continue;
    built = true;
    hash.update(await gitLater(c.dir, ['rev-parse', 'HEAD'], { allowFail: true }));
    for (const file of files) {
      hash.update(`\0${file}\0`);
      try {
        const full = path.join(c.dir, file);
        const seen = await fs.promises.stat(full);
        hash.update(seen.size > MOST_HASHED ? `${seen.size}:${seen.mtimeMs}` : await fs.promises.readFile(full));
      } catch {
        // Deleted: its name says so.
      }
    }
  }
  return { built, hash: built ? hash.digest('hex').slice(0, 16) : 'none' };
}

function refuseLeaving(bp: BoardPaths, t: Ticket, meta: BoardMeta): void {
  if (t.takenOver) throw new BoardActionError(`${t.id} is yours already. Give it back first.`);
  if (!isMine(t, meta)) throw new BoardActionError(`${t.id} is ${ownerOf(t)}'s. Only they can move it.`);
  if (t.deleting) throw new BoardActionError(`${t.id} is being deleted.`);
  if (t.archived) throw new BoardActionError(`${t.id} is archived.`);
  if (shipped(t)) throw new BoardActionError(`${t.id} is accepted already. Report a bug or add a new ticket instead.`);
  if (t.chat?.open && !t.chat.beside) throw new BoardActionError(`${t.id} has a chat open. Finish the talk first.`);
  const change = openChange(t);
  if (change) throw new BoardActionError(`${t.id} has a change still open (${change.id}). Settle it first.`);
  // A running step would go on writing after this: it finishes, or you stop it first. With no squad alive, nothing runs.
  if (squadAlive(bp) && (t.live || t.squad || t.stopRequested || t.questions?.some((q) => q.thinking))) throw new BoardActionError(`${t.id} is working right now. Wait until it needs you, or press Stop first.`);
}

/** The squad stops on the story, and a conversation outside squad-kit has it. Pressed again, it stays out. */
export async function workOutside(bp: BoardPaths, id: string): Promise<Ticket> {
  refuseWhileSaving(bp, id);
  const meta = readMeta(bp);
  if (meta.engine !== 'live') throw new BoardActionError('The sample board has no real project to work on outside.');
  const before = requireTicket(bp, id);
  if (before.takenOver?.free) return before;
  refuseLeaving(bp, before, meta);
  const work = await workOf(meta, before);
  const docs = docsHash(bp, id);
  return updateTicket(bp, id, (t) => {
    if (t.takenOver?.free) return;
    refuseLeaving(bp, t, meta);
    leaveForOutside(t, meta.user.name, new Date().toISOString(), { docs, work: work.hash });
    addActivity(t, 'you', 'Moved it to a conversation outside squad-kit. The squad waits');
  });
}

/** As it was when it left: nothing happened, so nothing is on its record. */
function asItWas(t: Ticket, left: LeftForOutside): void {
  t.stage = left.stage;
  t.status = left.status;
  t.waiting = left.waiting;
  t.live = false;
  if (left.phase && !left.waiting) {
    t.live = true;
    scheduleSquad(t, left.phase, 0.2, 1);
  }
  addActivity(t, 'you', 'Brought it back. Nothing changed outside');
}

const BUILT_OUTSIDE = 'Built outside squad-kit, and squad-kit has not checked it';

/** Back from outside: the story goes to its real step, and nothing it did not run counts as passed. */
export async function bringBack(bp: BoardPaths, id: string): Promise<Ticket> {
  const meta = readMeta(bp);
  // A file the board cannot read stops here, and the words say which one.
  const before = requireTicket(bp, id);
  if (!before.takenOver?.free) throw new BoardActionError(`${before.id} is not in a conversation outside squad-kit.`);
  const work = await workOf(meta, before);
  const docs = docsHash(bp, id);
  const approvedBy = `${meta.user.name} (outside squad-kit)`;
  let approveDesign = false;
  const back = updateTicket(bp, id, (t) => {
    const taken = t.takenOver;
    const left = taken?.free;
    if (!taken || !left) throw new BoardActionError(`${t.id} is back already.`);
    t.takenOver = undefined;
    t.stopRequested = undefined;
    t.retryOnStop = undefined;
    t.waiting = null;
    t.squad = null;
    if (docs === left.docs && work.hash === left.work && !left.approved) return asItWas(t, left);
    t.outside = t.outside ? { ...t.outside, checked: undefined } : { ...(left.from ? { from: left.from } : {}), by: taken.by, at: taken.at };
    t.stuck = undefined;
    t.agentQuestion = undefined;
    t.retryPhase = undefined;
    t.tries = 0;
    t.reviewRound = 0;
    t.reviewNotes = undefined;
    t.proof = undefined;
    t.offScreen = undefined;
    t.proofRound = undefined;
    t.live = false;
    if (work.built) {
      if (left.designApproved) t.decision = t.decision && { ...t.decision, adr: t.decision.adr ?? saveDesignDecision(bp, t, approvedBy) };
      t.steps = t.steps?.map((s) => ({ ...s, status: 'done' as const }));
      t.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
      t.stage = 'review';
      t.status = 'Back from outside. squad-kit has not checked it';
      t.waiting = { kind: 'proof', summary: BUILT_OUTSIDE };
      addActivity(t, 'you', 'Brought it back with code built outside squad-kit');
    } else if (hasDesign(t)) {
      t.stage = 'specs';
      addActivity(t, 'you', 'Brought it back with a design written outside squad-kit');
      if (left.designApproved) {
        approveDesign = true;
        t.status = 'Design approved in the conversation';
        t.waiting = { kind: 'plan', summary: 'The design was approved in the conversation' };
      } else if (t.track === 'express' || t.track === 'auto') {
        t.live = true;
        t.status = 'Approving the plan';
        scheduleSquad(t, 'express-approve', 0.2, 1);
      } else {
        t.status = 'Design ready for you';
        t.waiting = { kind: 'plan', summary: 'The design was written outside squad-kit: is this how to build it?' };
      }
    } else if (hasSpec(t)) {
      t.stage = 'specs';
      addActivity(t, 'you', 'Brought it back with a spec written outside squad-kit');
      if (needsSpec(t)) {
        t.status = 'Spec ready for you';
        t.waiting = { kind: 'spec', summary: 'The spec was written outside squad-kit: is this what you want?' };
      } else {
        t.live = true;
        t.status = 'Architect is writing the design';
        scheduleSquad(t, 'plan-write', 0.2, 1);
      }
    } else {
      t.stage = 'tickets';
      t.live = true;
      t.status = 'Analyst is reading the ticket';
      addActivity(t, 'you', 'Brought it back. The squad carries on from the start');
      scheduleSquad(t, 'analyst-read', 0.2, 1);
    }
  });
  // An approval the person gave in the conversation: as if pressed here, so the decision is saved and the build starts.
  return approveDesign ? approve(bp, back.id) : back;
}

/** The person said yes in the conversation: squad-kit keeps that, as it keeps a press on the board. */
export function recordApproval(bp: BoardPaths, id: string, what: 'spec' | 'design'): Ticket {
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    const left = t.takenOver?.free;
    if (!left) throw new BoardActionError(`${t.id} is not in a conversation outside squad-kit.`);
    if (what === 'spec' ? !hasSpec(t) : !hasDesign(t)) throw new BoardActionError(`${t.id} has no ${what} written yet, so there is nothing to approve.`);
    t.specApproved ??= { by: `${meta.user.name} (outside squad-kit)`, at: new Date().toISOString() };
    left.approved = true;
    if (what === 'design') left.designApproved = true;
    addActivity(t, 'you', `Approved the ${what} in the conversation outside squad-kit`);
  });
}

/** The tiny button: the checks, the review and the proof, by squad-kit. What they find goes the way it does on any story. */
export function checkOutside(bp: BoardPaths, id: string): Ticket {
  refuseWhileSaving(bp, id);
  return updateTicket(bp, id, (t) => {
    if (!t.outside) throw new BoardActionError(`${t.id} was not worked on outside squad-kit.`);
    if (t.takenOver) throw new BoardActionError(`${t.id} is still in the conversation. Bring it back first.`);
    if (shipped(t)) throw new BoardActionError(`${t.id} is accepted already.`);
    if (!waitsAtReview(t)) throw new BoardActionError(`${t.id} has no built work waiting to be checked right now.`);
    if (!t.criteria?.length) throw new BoardActionError(`${t.id} has no "Done when" list in its spec.md, so there is nothing to check it against. Add one first.`);
    t.outside = { ...t.outside, checked: undefined };
    t.waiting = null;
    t.stuck = undefined;
    t.agentQuestion = undefined;
    t.retryPhase = undefined;
    t.tries = 0;
    t.reviewRound = 0;
    t.reviewNotes = undefined;
    t.proof = undefined;
    t.proofRound = undefined;
    t.live = true;
    t.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
    t.stage = 'test';
    t.status = 'Running the project checks on the work done outside';
    addActivity(t, 'you', 'Asked squad-kit to check the work done outside');
    scheduleSquad(t, 'test', 0.2, 1);
  });
}
