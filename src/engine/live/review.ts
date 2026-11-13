import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { addActivity, listDecisions } from '../../board/store.js';
import { wayOptions } from '../../board/actions.js';
import { scheduleSquad } from '../../board/schedule.js';
import type { Ticket } from '../../board/types.js';
import { alsoChangedLine, cleanAlsoChanged } from '../../board/also-changed.js';
import * as P from '../prompts.js';
import { answerLists, checklistAsk, checklistsFor } from '../../board/additions.js';
import { copiesOf, workFolder } from '../copies.js';
import { workSoFar } from '../handover.js';
import { clearStaleStop } from '../../board/stale-stop.js';
import { MAX_REVIEW_ROUNDS, REVIEW_STEP_MS } from './limits.js';
import type { AgentAsk } from './shared.js';
import type { LiveSquad } from './squad.js';
import { readAnswer, recordRound } from '../review-record/notes.js';
import { fixRound } from '../review-record/fix-round.js';

/** The Reviewer's step, and the Builder fixing what it found. */
export const reviewPart = {
  /** "Let the Builder fix the notes" after the last review round: fix them, then the checks and two more rounds. */
  async reviewFix(this: LiveSquad, id: string): Promise<void> {
    const t = await this.workspace(id);
    this.update(id, (x) => {
      x.stage = 'implement';
      x.live = true;
      x.status = 'Builder is fixing the review notes';
      x.tries = 0;
      x.reviewRound = 0;
    });
    await fixRound(this.bp, id, () => this.runBuilder(id, P.reviewFixPrompt(t.reviewNotes ?? []), Boolean(t.sessions?.build)));
    this.update(id, (x) => {
      addActivity(x, 'builder', 'Fixed the review notes');
      x.reviewNotes = undefined;
      x.stage = 'test';
      x.status = 'Running the project checks';
      scheduleSquad(x, 'test', 0.2, 1);
    });
  },

  /**
   * The review. The app squad-kit started for the Reviewer's look at the pages runs on when it approves, for the
   * proof (afterReview); any other way out stops it.
   */
  async review(this: LiveSquad, id: string, answered = false, carry = false): Promise<void> {
    try {
      await this.reviewOnce(id, answered, carry);
    } finally {
      await this.afterReview(id).catch(() => this.dropKept(id));
    }
  },

  async reviewOnce(this: LiveSquad, id: string, answered: boolean, carry: boolean): Promise<void> {
    this.goOn(id);
    const meta = this.meta();
    const t0 = this.update(id, (x) => {
      x.stage = 'review';
      x.live = true;
      if (answered && x.sessions?.review) return;
      x.reviewRound = (x.reviewRound ?? 0) + 1;
      x.sessions = { ...x.sessions, review: x.reviewRound === 1 || !x.sessions?.review ? randomUUID() : x.sessions.review };
      addActivity(x, 'reviewer', `Reading the changes (round ${x.reviewRound} of ${MAX_REVIEW_ROUNDS})`);
    });
    const round = t0.reviewRound!;
    const goOn = answered && Boolean(t0.sessions?.review);
    await this.writeChanges(t0);
    // The Reviewer may look at the app's pages, and the app runs in the ticket's copy: what it changes there goes back.
    const rc = this.appOf(t0)?.repo.commands ?? {};
    const lanes = rc.start?.trim() && rc.url?.trim() ? await this.watchCopies(t0, true) : [];
    const worked: string[] = [];
    for (const c of goOn ? [] : copiesOf(meta, t0)) if (c.baseCommit) worked.push(...(await workSoFar(c.dir, c.baseCommit)).map((f) => (t0.storyDir ? `${c.repo.path}/${f}` : f)));
    const lists = goOn ? [] : checklistsFor(this.bp, 'reviewer');
    const r = await this.runAgent({
        role: 'reviewer',
        step: 'review',
      ticket: id,
      cwd: workFolder(t0)!,
      ...(round > 1 || goOn ? { resume: t0.sessions!.review } : { sessionId: t0.sessions!.review }),
      prompt: goOn
        ? carry
          ? P.chatCarryOnPrompt('reviewer')
          : P.answerPrompt(t0.agentQuestion ?? { text: '' }, 'reviewer')
        : `${P.reviewPrompt(meta, listDecisions(this.bp), t0, round, this.ctx(t0), worked)}${checklistAsk(lists)}`,
      addDirs: this.extraDirs(t0),
      permissions: ['read', 'git-read'],
      schema: P.REVIEW_SCHEMA,
      timeoutMs: REVIEW_STEP_MS,
      onTool: this.watcher(id, 'reviewer', workFolder(t0)!),
    }).finally(() => this.keepLanes(id, 'reviewer', lanes));
    const out = r.structured as { approved: boolean; summary: string; comments: string[]; alsoChanged?: string[]; question?: AgentAsk; checklist?: { n?: unknown; answer?: unknown; why?: unknown }[] };
    const said = readAnswer(out, workFolder(t0));
    this.askIfNeeded(id, 'reviewer', out.question);
    this.saveDecided(id, 'reviewer', out);
    if (goOn) this.update(id, (x) => (x.agentQuestion = undefined));
    // Each round reads the whole change, so its list replaces the last one.
    const also = cleanAlsoChanged(out.alsoChanged);
    this.update(id, (x) => {
      if (also.length) {
        x.alsoChanged = also;
        addActivity(x, 'reviewer', alsoChangedLine(also));
      } else delete x.alsoChanged;
      // A no on a list that is on is a review finding, like any other.
      const noes = answerLists(this.bp, x, lists, out.checklist);
      if (noes.length) {
        out.approved = false;
        out.comments = [...(out.comments ?? []), ...noes.map((n) => `Your team's checklist "${n.list}" asks: ${n.question} The answer is no${n.why ? `: ${n.why}` : '.'}`)];
      }
      recordRound(x, out, said);
    });
    if (out.approved) {
      this.update(id, (x) => {
        x.gates = { ...(x.gates ?? { checks: 'pass', proof: 'pending' }), review: 'pass', reviewBy: `a second ${this.toolLabel('reviewer')} session` } as Ticket['gates'];
        x.reviewAsked = undefined;
        clearStaleStop(x);
        addActivity(x, 'reviewer', `Approved: ${out.summary}`);
        x.status = 'Recording the proof';
        scheduleSquad(x, 'proof', 0.2, 1);
      });
      return;
    }
    // Review notes count as a failed Builder run: in a project with no tests they are the only sign of one.
    this.update(id, (x) => (x.fails = (x.fails ?? 0) + 1));
    // The engine never waves a review through: after the last round, you decide.
    if (round >= MAX_REVIEW_ROUNDS) {
      this.update(id, (x) => {
        x.live = false;
        x.squad = null;
        x.reviewNotes = out.comments;
        x.gates = { ...(x.gates ?? { checks: 'pass', proof: 'pending' }), review: 'fail', reviewBy: `a second ${this.toolLabel('reviewer')} session` } as Ticket['gates'];
        x.retryPhase = 'review-fix';
        x.status = `Review still open after ${round} rounds`;
        addActivity(x, 'reviewer', `Still asks for ${out.comments.length} ${out.comments.length === 1 ? 'fix' : 'fixes'} after ${round} rounds: ${out.comments.join(' ')}`);
        // Its notes are the Reviewer's own words, often about code: they are in the activity and the details.
        x.stuck = {
          gate: 'review',
          question: `The Reviewer still asks for ${out.comments.length === 1 ? 'a change' : `${out.comments.length} changes`} after ${round} rounds.`,
          ...(out.comments.length ? { detail: out.comments.map((c) => `- ${c}`).join('\n') } : {}),
          options: wayOptions({ gate: 'review', copy: Boolean(x.worktree && fs.existsSync(x.worktree)) }),
        };
        x.waiting = { kind: 'stuck', summary: 'The review is still open and needs one decision' };
      });
      return;
    }
    this.goOn(id);
    this.update(id, (x) => {
      x.reviewNotes = out.comments;
      // The next round sees these again, with the whole change.
      x.reviewAsked = out.comments;
      addActivity(x, 'reviewer', `Asked for ${out.comments.length} ${out.comments.length === 1 ? 'fix' : 'fixes'}: ${out.comments.join(' ')}`);
      x.stage = 'implement';
      x.status = `Builder is fixing ${out.comments.length} review comments`;
    });
    await fixRound(this.bp, id, () => this.runBuilder(id, P.reviewFixPrompt(out.comments), true));
    this.update(id, (x) => {
      addActivity(x, 'builder', 'Fixed the review comments');
      x.reviewNotes = undefined;
      x.stage = 'test';
      scheduleSquad(x, 'test', 0.2, 1);
    });
  },
};
