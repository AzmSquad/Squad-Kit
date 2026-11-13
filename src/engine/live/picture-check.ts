import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { addActivity, readTicket } from '../../board/store.js';
import { wayOptions } from '../../board/actions.js';
import { scheduleSquad } from '../../board/schedule.js';
import type { Ticket } from '../../board/types.js';
import { ownWords } from '../plain-stop.js';
import * as P from '../prompts.js';
import type { ListNo } from '../../board/additions.js';
import { workFolder } from '../copies.js';
import { explainError } from '../../board/problem.js';
import {
  CHECK_FAILED,
  MAX_PROOF_ROUNDS,
  MAX_RETAKES,
  brokenRows,
  brokenStop,
  checkVerdicts,
  fixLine,
  notShownStop,
  type CheckVerdict,
  type OpenRow,
} from '../proof-verdict.js';
import { REVIEW_STEP_MS } from './limits.js';
import type { LiveSquad } from './squad.js';

/** The picture check's verdicts, and what each one sends back. */
export const pictureCheckPart = {
  /** One short Reviewer run for all the pictures: met, broken or not shown once per "done when", in one plain sentence. */
  async checkPictures(this: LiveSquad, id: string, pictures: P.PictureToCheck[]): Promise<Map<number, CheckVerdict>> {
    if (!pictures.length) return new Map();
    const t = this.update(id, (x) => {
      x.status = 'Reviewer is checking the screenshots';
      x.live = true;
    });
    const asked = pictures.map((p) => p.criterion);
    const full = (file: string) => path.join(this.bp.proofDir, file);
    const r = await this.runAgent({
      role: 'reviewer',
      step: 'proof-check',
      // At the level the project's Quality setting gives a review.
      levelStep: 'review',
      ticket: id,
      cwd: workFolder(t)!,
      sessionId: randomUUID(),
      prompt: P.proofCheckPrompt(t, pictures.map((p) => ({ ...p, ...(p.file ? { file: full(p.file) } : {}), ...(p.more ? { more: p.more.map((m) => ({ ...m, file: full(m.file) })) } : {}) }))),
      // The pictures are in the proof folder, which the check may read.
      addDirs: [...this.extraDirs(t), this.bp.proofDir],
      permissions: ['read'],
      schema: P.PROOF_CHECK_SCHEMA,
      // Up to 40 pictures to open and read.
      timeoutMs: REVIEW_STEP_MS,
      check: (answer) => {
        const left = asked.filter((n) => !checkVerdicts(answer, asked, true).has(n));
        return left.length ? `checks has no verdict for "done when" ${left.join(', ')}` : null;
      },
      onTool: this.watcher(id, 'reviewer', workFolder(t)!),
    });
    return checkVerdicts(r.structured, asked);
  },

  /** squad-kit could not check the screenshots (the Reviewer's run did not get through): a plain stop with Try again. */
  checkStop(this: LiveSquad, id: string, err: unknown): void {
    const e = explainError(err);
    this.log('warn', `Could not check the screenshots: ${[e.what, e.detail].filter(Boolean).join(': ')}`, id);
    this.update(id, (x) => {
      x.live = false;
      x.squad = null;
      delete x.clock;
      x.stage = 'review';
      x.retryPhase = 'proof';
      x.gates = { ...(x.gates ?? { checks: 'pass', review: 'pass' }), proof: 'fail' } as Ticket['gates'];
      x.status = 'The screenshots are not checked yet';
      addActivity(x, 'reviewer', 'Could not check the screenshots this time');
      x.stuck = {
        gate: 'proof',
        question: ownWords(err) ?? CHECK_FAILED,
        detail: [e.what, e.detail].filter(Boolean).join('\n'),
        options: wayOptions({ gate: 'proof' }),
      };
      x.waiting = { kind: 'stuck', summary: 'The screenshots are not checked yet: needs one decision' };
    });
  },

  /**
   * The screenshots show a "done when" does not work. The first round goes back to the Builder with what they show,
   * like review notes, and the checks, the review and the proof run again; after the last round it is a plain stop
   * with its ways out (Let the Builder try again, Continue anyway, Send it back to the plan). Builds by itself never
   * accepts it: the proof did not pass. What is only not shown never reaches the Builder.
   */
  async notWorking(this: LiveSquad, id: string, rows: OpenRow[], notShown: OpenRow[]): Promise<void> {
    const t0 = this.update(id, (x) => {
      x.proofRound = (x.proofRound ?? 0) + 1;
      // A "done when" that does not work is a Builder run that did not get through, as review notes are.
      x.fails = (x.fails ?? 0) + 1;
      x.gates = { ...(x.gates ?? { checks: 'pass', review: 'pass' }), proof: 'fail' } as Ticket['gates'];
    });
    const round = t0.proofRound!;
    if (round >= MAX_PROOF_ROUNDS) {
      const stop = brokenStop(rows);
      this.update(id, (x) => {
        x.live = false;
        x.squad = null;
        delete x.clock;
        x.stage = 'review';
        x.retryPhase = 'proof-fix';
        x.status = 'The screenshots show it is not working yet';
        addActivity(x, 'tester', `Still not working after ${round} rounds: ${rows.map((r) => `"done when" ${r.criterion}`).join(', ')}`);
        x.stuck = { gate: 'proof', kind: 'broken', question: stop.question, points: [...stop.points, ...notShown.map((r) => `"Done when" ${r.criterion}, ${r.text}: ${r.why}`)], options: wayOptions({ gate: 'proof', kind: 'broken' }) };
        x.waiting = { kind: 'stuck', summary: 'The screenshots show it is not working yet: needs one decision' };
      });
      return;
    }
    this.goOn(id);
    this.update(id, (x) => {
      addActivity(x, 'tester', `The screenshots show ${rows.length === 1 ? 'one "done when"' : `${rows.length} "done when"`} not working yet, so the Builder fixes ${rows.length === 1 ? 'it' : 'them'}: ${rows.map((r) => `"done when" ${r.criterion}: ${r.why}`).join(' ')}`);
      x.stage = 'implement';
      x.live = true;
      x.status = 'Builder is fixing what the screenshots show';
    });
    await this.runBuilder(id, P.proofFixPrompt(rows.map(fixLine), !readTicket(this.bp, id)?.noNewTests), true);
    this.afterProofFix(id);
  },

  /**
   * The Tester could not show a "done when" on a screen, after its last retake, or none of them can be shown (`retook`
   * false): a plain stop, and the product is not touched. The ways out are Take the screenshots again, Continue anyway
   * and Send it back to the plan.
   */
  cannotShow(this: LiveSquad, id: string, rows: OpenRow[], retook = true, noes: ListNo[] = []): void {
    const stop = rows.length ? notShownStop(rows) : { question: "The Tester still answers no on your team's checklist.", points: [] };
    const listWords = noes.map((n) => `Your team's checklist "${n.list}": ${n.question}${n.why ? ` (${n.why})` : ''}`);
    this.update(id, (x) => {
      x.live = false;
      x.squad = null;
      delete x.clock;
      x.stage = 'review';
      x.retryPhase = 'proof';
      x.gates = { ...(x.gates ?? { checks: 'pass', review: 'pass' }), proof: 'fail' } as Ticket['gates'];
      const listOnly = !rows.length;
      x.status = listOnly ? "A no on your team's checklist" : 'The screenshots do not show it yet';
      addActivity(x, 'tester', listOnly ? `The Tester still answers no on your team's checklist after ${MAX_RETAKES} more tries` : retook ? `Could not show ${rows.map((r) => `"done when" ${r.criterion}`).join(', ')} on a screen after ${MAX_RETAKES} more tries` : 'Every "done when" ended as not on a screen, so the screenshots do not show the work');
      x.stuck = { gate: 'proof', kind: 'not-shown', question: stop.question, points: [...stop.points, ...listWords], options: wayOptions({ gate: 'proof', kind: 'not-shown' }) };
      x.waiting = { kind: 'stuck', summary: `${x.status}: needs one decision` };
    });
  },

  /** "Let the Builder try again" after the screenshots still showed a "done when" not working: it fixes them, two more rounds. */
  async proofFix(this: LiveSquad, id: string): Promise<void> {
    const t = await this.workspace(id);
    const rows = brokenRows(t);
    // Nothing is broken, only not shown (a stop from before the three verdicts): the Tester takes the pictures again.
    if (!rows.length) return this.proof(id);
    this.update(id, (x) => {
      x.stage = 'implement';
      x.live = true;
      x.status = 'Builder is fixing what the screenshots show';
    });
    await this.runBuilder(id, P.proofFixPrompt(rows.map(fixLine), !t.noNewTests), Boolean(t.sessions?.build));
    this.afterProofFix(id);
  },

  /** After the Builder's fix for the proof: the checks, a fresh review and the proof run again. */
  afterProofFix(this: LiveSquad, id: string): void {
    this.update(id, (x) => {
      addActivity(x, 'builder', 'Fixed what the screenshots showed');
      // The review starts again: a fresh Reviewer reads the whole change, with its own rounds.
      x.reviewRound = 0;
      x.stage = 'test';
      x.status = 'Running the project checks';
      scheduleSquad(x, 'test', 0.2, 1);
    });
  },
};
