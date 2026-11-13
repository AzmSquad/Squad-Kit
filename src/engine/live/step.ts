import { addActivity, readTicket } from '../../board/store.js';
import { approveExpress, changeWork, needsSpec, openChange } from '../../board/actions.js';
import { scheduleSquad } from '../../board/schedule.js';
import { releaseGoingOut } from '../../board/lock.js';
import type { Ticket } from '../../board/types.js';
import * as P from '../prompts.js';
import { publishTicket } from '../publish.js';
import { isMediaNote, prepareMedia } from '../media.js';
import { budgetStop } from '../../board/budget.js';
import { howPaid } from '../../board/payment.js';
import { carriesOn } from '../interrupt.js';
import { acceptByItselfBeside, afterPullRequest, waitForLanding } from '../../board/auto.js';
import type { LiveSquad } from './squad.js';

/** The steps in which the Builder works. A small change goes into the next one of these as it starts. */
const BUILDER_PHASES = new Set(['build', 'unstick', 'fix', 'answered-builder', 'chat-carry-builder', 'review-fix', 'restore-tests', 'update-base', 'change-build']);

/** Which step runs next on a ticket, and handing a small change to the Builder. */
export const stepPart = {
  /* ── one step of a ticket ────────────────────────────── */

  async step(this: LiveSquad, id: string, phase: string): Promise<void> {
    this.update(id, (t) => {
      if (t.squad) t.squad.nextAt = new Date(Date.now() + 3_600_000).toISOString();
      // Another step than the one cut off: that interruption is over.
      if (t.interrupted && !carriesOn(t, phase)) delete t.interrupted;
    });
    // What the last board left running in squad-kit's copies is stopped first.
    await this.swept;
    // On an API key past a budget, the ticket waits for the person here, between two steps.
    if (await budgetStop(this.bp, id, phase, async () => (await howPaid(this.bp)).payment)) return;
    this.log('info', `Step ${phase} started`, id);
    switch (phase) {
      case 'analyst-read':
        return this.intake(id);
      case 'split-change':
        return this.splitAgain(id);
      case 'triage':
        return this.triage(id);
      case 'plan-write':
        return needsSpec(readTicket(this.bp, id)!) ? this.spec(id) : this.plan(id);
      case 'spec-rewrite':
        return this.spec(id, readTicket(this.bp, id)?.changeRequest);
      case 'plan-rewrite':
        return this.plan(id, readTicket(this.bp, id)?.changeRequest);
      case 'express-approve':
        approveExpress(this.bp, id);
        return;
      case 'accept':
        // Builds by itself: the squad's own Looks right, once the checks, the review and the proof passed.
        await acceptByItselfBeside(this.bp, id, this.stops.get(id)?.signal);
        return;
      case 'build':
      case 'unstick':
        return this.build(id);
      case 'pick-up':
        return this.pickedUp(id);
      case 'fix':
        return this.fixFromPerson(id);
      case 'answered-builder':
        return this.builderAnswered(id);
      case 'answered-reviewer':
        return this.review(id, true);
      case 'answered-architect':
        return this.plan(id, undefined, true);
      case 'chat-spec':
        return this.spec(id, undefined, true);
      case 'chat-design':
        return this.plan(id, undefined, false, true);
      case 'chat-carry-builder':
        return this.carryOnBuilder(id);
      case 'chat-carry-reviewer':
        return this.review(id, true, true);
      case 'chat-carry-tester':
        return this.proof(id);
      case 'change-design':
        return this.changeDesign(id);
      case 'change-build':
        return this.changeBuild(id);
      case 'test':
        return this.checks(id);
      case 'review':
        return this.review(id);
      case 'review-fix':
        return this.reviewFix(id);
      case 'restore-tests':
        return this.restoreTests(id);
      case 'update-base':
        // Builds by itself: a story landing right now goes first, so the base comes in once, with its work too.
        if (waitForLanding(this.bp, id)) return;
        return this.updateBase(id);
      case 'proof':
        return this.proof(id);
      case 'proof-fix':
        return this.proofFix(id);
      case 'publish': {
        // A release going out moves the base on the code host: the pull request merges once it is out (one lock).
        const going = releaseGoingOut(this.bp);
        if (going) {
          this.update(id, (t) => {
            t.status = `Merges once ${going} is out`;
            if (t.squad) t.squad.nextAt = new Date(Date.now() + 15_000).toISOString();
          });
          return;
        }
        const { clash } = await publishTicket(this.bp, id);
        // A clash brings in the base again; on Builds by itself a pull request waiting for its approver is a normal wait.
        if (clash) return this.pullRequestClash(id);
        afterPullRequest(this.bp, id, false);
        return;
      }
      default:
        this.update(id, (t) => (t.squad = null));
    }
  },

  /** Voice and video notes become text and pictures before any agent reads the ticket (agents cannot listen). */
  async hearNotes(this: LiveSquad, id: string): Promise<void> {
    const files = readTicket(this.bp, id)?.attachments ?? [];
    if (!files.some((f) => isMediaNote(f))) return;
    this.update(id, (t) => (t.status = 'Writing out the voice and video notes'));
    const r = await prepareMedia(this.bp, files);
    if (!r.notes.length) return;
    this.update(id, (t) => {
      t.attachments = [...new Set([...(t.attachments ?? []), ...r.added])];
      for (const n of r.notes) addActivity(t, 'squad', n);
    });
  },

  async triage(this: LiveSquad, id: string): Promise<void> {
    this.update(id, (t) => {
      const priority = t.severity === 'stops-work' ? 'high' : t.severity === 'small' ? 'low' : 'normal';
      t.priority = priority;
      const label = priority === 'high' ? 'High' : priority === 'low' ? 'Low' : 'Medium';
      addActivity(t, 'triage', `Sorted the bug. Priority: ${label}${t.foundIn ? `. Linked to ${t.foundIn}` : ''}`);
      t.status = `Sorted as ${label.toLowerCase()} priority`;
      t.stage = 'tickets';
      scheduleSquad(t, 'analyst-read', 1, 1, 0);
    });
  },

  /** Done talking with the Builder: it carries on in the same session with what you agreed, then the checks run. */
  async carryOnBuilder(this: LiveSquad, id: string): Promise<void> {
    await this.workspace(id);
    this.update(id, (x) => {
      x.stage = 'implement';
      x.live = true;
    });
    await this.runBuilder(id, P.chatCarryOnPrompt('builder'), true, 'build');
    this.update(id, (x) => {
      addActivity(x, 'builder', 'Carried on with what you agreed');
      x.stage = 'test';
      x.status = 'Running the project checks';
      x.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
      x.reviewRound = 0;
      x.proof = undefined;
      scheduleSquad(x, 'test', 0.2, 1);
    });
  },

  /* ── a change goes through the spec ──────────────────── */

  /**
   * An approved change comes in between steps. A big one sends the ticket to the Architect first; a small one goes to
   * the Builder: inside its next step when that is the Builder's, or as a step of its own before anything else.
   */
  phaseFor(this: LiveSquad, t: Ticket): string {
    const phase = t.squad!.phase;
    const work = changeWork(t);
    if (!work || phase.startsWith('change-')) return phase;
    if (work === 'design') return 'change-design';
    return openChange(t)!.size === 'big' || !BUILDER_PHASES.has(phase) ? 'change-build' : phase;
  },

  /** An approved change on a ticket where nothing runs starts now, unless the ticket waits on you for something else. */
  pickUpChange(this: LiveSquad, t: Ticket): void {
    const work = changeWork(t);
    if (!work || t.takenOver || (t.waiting && t.waiting.kind !== 'proof')) return;
    this.update(t.id, (x) => {
      const c = openChange(x);
      if (!c) return;
      // The proof waiting for you does not show the change: it comes again after. Kept, so a withdrawn change gives it back.
      if (x.waiting) c.paused = { waiting: x.waiting };
      x.waiting = null;
      x.live = true;
      scheduleSquad(x, work === 'design' ? 'change-design' : 'change-build', 0.2, 1);
    });
  },
};
