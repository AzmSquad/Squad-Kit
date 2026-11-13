import { addActivity, readTicket } from '../../board/store.js';
import { wayOptions } from '../../board/actions.js';
import type { OffScreen, ProofPicture, ProofShot, Ticket } from '../../board/types.js';
import { plainParts } from '../shots.js';
import { ownWords } from '../plain-stop.js';
import * as P from '../prompts.js';
import { repoFor } from '../repos.js';
import { runsAsProduct } from '../../board/parts.js';
import { CapReached } from '../caps.js';
import { productPlan } from '../product-run.js';
import { picturesWay } from '../phone/plan.js';
import { LimitReached } from '../usage-limit.js';
import { explainError } from '../../board/problem.js';
import { CutOff } from '../interrupt.js';
import { acceptNext } from '../../board/auto.js';
import { rowPictures } from '../../board/at-review.js';
import { clearStaleStop } from '../../board/stale-stop.js';
import { changesScreens, markCheckedOutside } from '../../board/outside-step.js';
import {
  MAX_RETAKES,
  afterLastRetake,
  cannotShowLine,
  criterionText,
  doneWhenCount,
  fromReason,
  offScreenNumbers,
  reasonRefusedLine,
  retakeLine,
  together,
  type OpenRow,
} from '../proof-verdict.js';
import { PassingTrouble, technicalWords } from './shared.js';
import type { LiveSquad } from './squad.js';
import { appNeeded, picturesNeeded, testerLines } from '../proof-kinds/lines.js';
import { kindsStop, lockScreenLines, plannedProof, provedByKind, type KindsHost } from '../proof-kinds/flow.js';
import { randomUUID } from 'node:crypto';
import { CHECK_SILENT_MS, runCommand, type CommandWatch } from '../checks.js';
import { copiesOf, workFolder } from '../copies.js';
import { PROOF_STEP_MS } from './limits.js';
import { checkedLine } from '../proof-kinds/saved.js';

/** The proof step: the Tester's screenshots and squad-kit's check of them. */
export const proofPart = {
  /**
   * The proof: the Tester's screenshots, squad-kit's own checks of each picture, then squad-kit's check of what the
   * pictures of each "done when" show together. It passes only when every "done when" that shows on a screen is judged
   * met; one the Tester and the check agree cannot be shown does not fail it, unless every one ends that way. Not shown:
   * the Tester adds what is missing, told what to show (judge), then a plain stop (cannotShow). Broken: back to the
   * Builder once, then a plain stop (notWorking). One app serves every round: the one the review kept, or the first
   * round's (screens), and it stops when the proof ends.
   */
  async proof(this: LiveSquad, id: string): Promise<void> {
    try {
      await this.proofOnce(id);
    } finally {
      // The proof is over, however it ended: the app kept for it stops (a Builder's fix stops it before it starts).
      await this.dropKept(id).catch(() => undefined);
    }
  },

  async proofOnce(this: LiveSquad, id: string): Promise<void> {
    this.listNoes.delete(id);
    const meta = this.meta();
    await lockScreenLines(this.bp, id, meta);
    const t = readTicket(this.bp, id)!;
    const rc = (this.appOf(t)?.repo ?? repoFor(meta, t)).commands;
    // A product that cannot run yet says why, instead of having nothing to show.
    // A phone app with no web version shows on squad-kit's phone, or waits for its tools: never a proof with no pictures.
    const phoneWay = (rc.start && rc.url) || !picturesNeeded(t, true) ? null : (await picturesWay(this.bp, t, false)).way;
    const canShow = (Boolean(rc.start && rc.url) || phoneWay === 'phone' || phoneWay === 'wait' || Boolean(runsAsProduct(meta) && productPlan(this.bp, meta, t).why)) && appNeeded(t, changesScreens(t) || (t.work?.asks ?? 0) > 0);
    // Why no picture was taken, in the person's words, and the exact error for engineers.
    let why = '';
    let detail = '';
    let bad: ShotProblem[] = [];
    let round: ShotRound | null = null;
    // The "before" screenshots still running beside the build end first (8 minutes at most), so both sets pair up.
    await this.beforeShotsOf.get(id);
    this.goOn(id);
    if (canShow) {
      try {
        round = await this.screens(id, 'after');
        bad = round.problems;
        // squad-kit checks every picture itself. One that proves nothing goes back to the Tester once, with why.
        if (bad.length) {
          this.update(id, (x) => addActivity(x, 'tester', `The screenshots did not pass squad-kit's check, so the Tester takes them again: ${bad.map((b) => b.text).join(' ')}`));
          const again = await this.screens(id, 'after', undefined, bad.map((b) => b.text));
          round = { ...again, sizes: { ...round.sizes, ...again.sizes } };
          // A picture that failed and was not taken again still counts against the proof.
          const rows = readTicket(this.bp, id)?.proof ?? [];
          const still = bad.filter((b) => !rows.some((p) => p.criterion === b.criterion && p.after) && !again.problems.some((a) => a.criterion === b.criterion));
          bad = [...again.problems, ...still];
        }
      } catch (err) {
        if (err instanceof LimitReached || err instanceof CapReached || err instanceof CutOff || err instanceof PassingTrouble) throw err;
        if (this.stops.get(id)?.signal.aborted) throw err;
        const e = explainError(err);
        // Only squad-kit's own plain words reach the person; the rest is for engineers.
        why = ownWords(err) ?? NO_PICTURES;
        detail = [e.what === why ? '' : e.what, e.detail ?? ''].filter(Boolean).join('\n');
        // The exact words go to the app log and the stop's details, never to the activity.
        this.log('warn', `Could not take screenshots: ${detail || why}`, id);
        this.update(id, (x) => addActivity(x, 'tester', 'Could not take the screenshots this time'));
      }
    }
    // The ticket has screens but nothing was shot, or a picture failed the check: the gate does not pass on its own. You
    // decide. A plan with screens needs at least one picture, even when the Tester says each "done when" shows on none.
    const now = readTicket(this.bp, id)!;
    const shot = (now.proof ?? []).some((p) => p.after);
    if (canShow && (!shot || bad.length)) {
      this.update(id, (x) => {
        const named = (n: number) => criterionText(x, n) ?? `"Done when" ${n}`;
        const missing = round ? missingShots(x, round) : [];
        const stuck = round?.stuck.length ? round.stuck : [];
        x.live = false;
        x.squad = null;
        delete x.clock;
        x.stage = 'review';
        x.retryPhase = 'proof';
        x.gates = { ...(x.gates ?? { checks: 'pass', review: 'pass' }), proof: 'fail' } as Ticket['gates'];
        x.status = bad.length ? 'Screenshots did not pass the check' : 'No screenshots yet';
        if (!bad.length && !why) addActivity(x, 'tester', 'No screenshots yet, so it waits for you');
        const said = round?.said ? ` The Tester says: ${round.said}` : '';
        const technical = stuck.length ? stuck.map((s) => `${s.what}${s.why ? `: ${s.why}` : ''}`).join('\n') : '';
        x.stuck = bad.length
          ? {
              gate: 'proof',
              kind: 'bad-proof',
              question: "The screenshots did not pass squad-kit's check, even after the Tester took them again, so they do not prove the work yet.",
              points: bad.map((b) => b.text),
              options: wayOptions({ gate: 'proof', kind: 'bad-proof' }),
            }
          : {
              gate: 'proof',
              // Plain words for the person; the exact errors are in the activity and the engineer details.
              question: why || (stuck.length ? STUCK_PICTURES : `The Tester took no screenshots, so the proof is not ready yet.${said}`),
              ...(!why && missing.length ? { points: missing.map((m) => `${named(m.criterion)}: ${m.why}`) } : {}),
              ...(detail || technical ? { detail: [detail, technical].filter(Boolean).join('\n') } : {}),
              options: wayOptions({ gate: 'proof' }),
            };
        x.waiting = { kind: 'stuck', summary: bad.length ? 'The screenshots did not pass the check: needs one decision' : 'No screenshots yet: needs one decision' };
      });
      return;
    }
    const other = await provedByKind(this.kindsHost(id), canShow);
    // What each picture shows: the Tester's verdict and squad-kit's own look at it, together.
    if (canShow && round && doneWhenCount(now) > 0) {
      let judged: ProofJudged;
      try {
        judged = await this.judge(id, round);
      } catch (err) {
        if (err instanceof LimitReached || err instanceof CapReached || err instanceof CutOff || err instanceof PassingTrouble) throw err;
        if (this.stops.get(id)?.signal.aborted) throw err;
        return this.checkStop(id, err);
      }
      if (judged.broken.length || other.broken.length) return this.notWorking(id, [...judged.broken, ...other.broken], [...judged.notShown, ...other.open]);
      // A Test line squad-kit could not prove is on the same card, so Continue anyway never passes it unseen.
      if (judged.notShown.length) return this.cannotShow(id, [...judged.notShown, ...other.open], true, this.listNoes.get(id));
      // Every "done when" ended as not on a screen: nothing shows the work, so the person decides.
      if (judged.offScreen.length === doneWhenCount(now)) return this.cannotShow(id, [...judged.offScreen, ...other.open], false, this.listNoes.get(id));
    }
    if (other.broken.length) return this.notWorking(id, other.broken, other.open);
    if (other.open.length) return void this.update(id, (x) => kindsStop(x, other.open));
    // A no on a team's list that is on goes the same way as a "done when" not shown.
    if (this.listNoes.get(id)?.length) return this.cannotShow(id, [], true, this.listNoes.get(id));
    this.update(id, (x) => {
      x.proof = (x.proof ?? []).filter((p) => p.after);
      const shots = x.proof;
      x.gates = { ...(x.gates ?? { checks: 'pass', review: 'pass' }), proof: 'pass' } as Ticket['gates'];
      x.proofRound = undefined;
      clearStaleStop(x);
      markCheckedOutside(x);
      if (!shots.length) {
        const proof = x.gates?.checks === 'unchecked' ? 'and no tests ran, so read the changes yourself' : 'so the checks are the proof';
        addActivity(x, 'tester', canShow ? `No screenshots were taken, ${proof}` : `No screens to show, ${proof}`);
      }
      // Builds by itself: no Looks right to wait for, the squad accepts it as its next step (board/auto.ts).
      if (x.track === 'auto') return acceptNext(x, 0.2, 1);
      x.live = false;
      x.stage = 'review';
      x.status = 'Proof ready to check';
      x.waiting = { kind: 'proof', summary: 'The proof is ready for you to check' };
      x.squad = null;
    });
  },

  /**
   * squad-kit's own look at the proof, in one short Reviewer run for all the pictures, and for what the Tester says cannot
   * be shown. Each row, over all its pictures, is met, broken, not shown or not on a screen (together, in
   * proof-verdict.ts). What is not shown, and a "done when" with no picture and no reason, go back to the Tester in its
   * own conversation, told exactly what to show, MAX_RETAKES times at most: its new pictures join the row's. Not on a
   * screen takes two voices: the check says it cannot be shown, and the Tester said so too or could not show it in its
   * last retake. Returns the rows broken, still not shown and not on a screen, in the order of the "done when" list.
   */
  /** What the proof kinds need of the squad (proof-kinds/flow.ts): a short Tester run, the story's copy and main's. */
  kindsHost(this: LiveSquad, id: string): KindsHost {
    const t = readTicket(this.bp, id)!;
    const c = copiesOf(this.meta(), t)[0];
    const dir = c?.dir ?? t.worktree!;
    const watched = (where: string, watch: CommandWatch) => (cmd: string, ms: number) => runCommand(where, cmd, ms, { silentMs: CHECK_SILENT_MS, ...watch });
    return {
      bp: this.bp,
      id,
      dir,
      testCommand: (c?.repo ?? repoFor(this.meta(), t)).commands.test?.trim() ?? '',
      update: (change) => this.update(id, change),
      tester: async (o) => (await this.runAgent({ role: 'tester', step: 'proof', ticket: id, cwd: workFolder(t)!, sessionId: randomUUID(), permissions: ['read'], addDirs: this.extraDirs(t), timeoutMs: PROOF_STEP_MS, onTool: this.watcher(id, 'tester', workFolder(t)!), ...o })).structured,
      run: watched(dir, this.guardedWatch(id, dir)),
      onMain: (use) => (c?.baseCommit ? this.inMainCopy(id, c, (main, watch) => use(main, watched(main, watch)), "the proof's test") : Promise.resolve(null)),
      log: (text) => this.log('info', text, id),
    };
  },

  async judge(this: LiveSquad, id: string, first: ShotRound): Promise<ProofJudged> {
    const sizes = { ...first.sizes };
    const rowOf = (x: Ticket, n: number) => (x.proof ?? []).find((p) => p.after && p.criterion === criterionText(x, n));
    const reasonOf = (x: Ticket, n: number) => x.offScreen?.find((o) => o.criterion === criterionText(x, n))?.why;
    const t = readTicket(this.bp, id)!;
    const numbers = testerLines(t);
    const toFile = (p: ProofPicture): P.PictureFile => ({ file: p.after, ...(p.page ? { page: p.page } : {}), ...(sizes[p.after] ? { size: sizes[p.after] } : {}), ...(p.device ? { device: p.device } : {}), ...(p.note ? { note: p.note } : {}) });
    const toCheck = (x: Ticket, which: number[]): P.PictureToCheck[] =>
      which.flatMap((n) => {
        const row = rowOf(x, n);
        const reason = reasonOf(x, n);
        const off = reason ? { offScreen: reason } : {};
        if (!row) return reason ? [{ criterion: n, ...off }] : [];
        return [{ criterion: n, ...toFile(row), ...off, ...(row.shows ? { said: SAID[row.shows] } : {}), ...(this.sameAsBefore(row) ? { same: true } : {}), ...(row.more?.length ? { more: row.more.map(toFile) } : {}) }];
      });
    const verdicts = await this.checkPictures(id, toCheck(t, numbers));
    const verdict = (x: Ticket, n: number) => {
      const row = rowOf(x, n);
      if (row) return together(row, verdicts.get(n), this.sameAsBefore(row));
      const reason = reasonOf(x, n);
      return reason ? fromReason(reason, verdicts.get(n)) : null;
    };
    // Only the check says it cannot be shown: the Tester gets a retake first, and may say so too.
    const isOpen = (x: Ticket, n: number) => {
      const v = verdict(x, n);
      return !v || v.shows === 'not-shown' || (v.shows === 'off-screen' && !reasonOf(x, n));
    };
    for (let retake = 1; retake <= MAX_RETAKES; retake += 1) {
      const x = readTicket(this.bp, id)!;
      const open = numbers.filter((n) => isOpen(x, n));
      const noes = this.listNoes.get(id) ?? [];
      if (!open.length && !noes.length) break;
      const asks = [...noes.map((no) => `Your team's checklist "${no.list}" asks: ${no.question} You answered no${no.why ? ` (${no.why})` : ''}. Look again, show it if you can, and answer this question again in "checklist".`), ...open.map((n) => {
        const v = verdict(x, n);
        const text = criterionText(x, n)!;
        const reason = reasonOf(x, n);
        if (!v) return `"Done when" ${n} ("${text}") has no screenshot, and you did not say it shows on no screen. Take one, or put it in offScreen with why.`;
        if (v.shows === 'off-screen') return cannotShowLine(n, text, v.why);
        return reason ? reasonRefusedLine(n, text, reason, v.why, v.advice) : retakeLine(n, text, v.why, v.advice);
      })];
      const which = open.length === 1 ? `"done when" ${open[0]}` : open.length ? `${open.length} "done when"` : "your team's checklist";
      this.update(id, (y) => addActivity(y, 'tester', open.length ? `The screenshots do not show ${which} clearly yet, so the Tester takes ${open.length === 1 ? 'it' : 'them'} again (try ${retake} of ${MAX_RETAKES})` : `The Tester answered no on ${which}, so it looks again (try ${retake} of ${MAX_RETAKES})`));
      // What the check has seen of it: its pictures and the Tester's reason.
      const had = (z: Ticket, n: number) => `${rowOf(z, n) ? rowPictures(rowOf(z, n)!).map((p) => p.after).sort().join(' ') : ''}|${reasonOf(z, n) ?? ''}`;
      const before = new Map(numbers.map((n) => [n, had(x, n)]));
      const again = await this.screens(id, 'after', undefined, asks);
      Object.assign(sizes, again.sizes);
      const y = readTicket(this.bp, id)!;
      // A row with a new picture or a new reason is looked at again, all its pictures together; one with neither still does not show it.
      const fresh = [...before].filter(([n, seen]) => had(y, n) !== seen).map(([n]) => n);
      for (const [n, v] of await this.checkPictures(id, toCheck(y, fresh))) verdicts.set(n, v);
    }
    const out: ProofJudged = { broken: [], notShown: [], offScreen: [] };
    this.update(id, (x) => {
      const stays: OffScreen[] = [];
      for (const n of numbers) {
        const row = rowOf(x, n);
        const text = criterionText(x, n)!;
        // No retake is left: pictures of a part and the Tester's reason for the rest never stop the story.
        const v = plannedProof(x, n, row ? afterLastRetake(verdict(x, n)!, reasonOf(x, n)) : verdict(x, n));
        const said = v ? plainParts(v.why, technicalWords).kept : '';
        if (!row) {
          if (v?.shows === 'off-screen') {
            const why = (said || reasonOf(x, n)!).slice(0, 600);
            stays.push({ criterion: text, why });
            out.offScreen.push({ criterion: n, text, why });
          } else out.notShown.push({ criterion: n, text, why: (said || 'No screenshot shows it.').slice(0, 600) });
          continue;
        }
        row.shows = v!.shows;
        if (v!.shows === 'met') {
          delete row.why;
          continue;
        }
        row.why = (said || (v!.shows === 'broken' ? 'The screenshot shows it does not work as written.' : v!.shows === 'off-screen' ? 'The screenshots show a part of it. The rest cannot be shown on a screen.' : 'The screenshot does not show it clearly.')).slice(0, 600);
        (v!.shows === 'broken' ? out.broken : v!.shows === 'off-screen' ? out.offScreen : out.notShown).push({ criterion: n, text, why: row.why });
      }
      // Agreed on, and with no picture, it stays on the list; a row with pictures says it itself; the rest are not on a list.
      if (stays.length) x.offScreen = stays;
      else delete x.offScreen;
      const open = [out.broken.length ? `${out.broken.length} not working yet` : '', out.notShown.length ? `${out.notShown.length} not shown yet` : '', out.offScreen.length ? `${out.offScreen.length} not on a screen` : ''].filter(Boolean);
      addActivity(x, 'reviewer', checkedLine(x, open));
      for (const r of out.offScreen) addActivity(x, 'reviewer', `"Done when" ${r.criterion} is not on a screen: ${r.why}`);
    });
    return out;
  },
};
/** When the Tester's run did not get through, for a reason only engineers need. */
const NO_PICTURES = 'squad-kit could not take the screenshots this time. Press Try again to try once more.';
/** When the Tester got stuck on something technical that squad-kit could not fix. */
const STUCK_PICTURES = 'The Tester got stuck on something technical that squad-kit could not fix, so there are no screenshots yet. Press Try again to try once more.';

/** What squad-kit's check of the proof ended with: the "done when" not working, not shown, and not on a screen. */
interface ProofJudged {
  broken: OpenRow[];
  notShown: OpenRow[];
  offScreen: OpenRow[];
}

/** One round of screenshots: the pictures that failed squad-kit's check, what was taken, the Tester's plain words and its technical trouble. */
export interface ShotRound {
  problems: ShotProblem[];
  /** The "done when" numbers it handed a picture in for. */
  planned: number[];
  said: string;
  stuck: { what: string; why: string }[];
  /** Each picture's size ("phone", "desktop"), by file name, for squad-kit's check of what it shows. */
  sizes: Record<string, string>;
}

/** The "done when" with no picture after a round (and not said to show on no screen), each with why in plain words. */
function missingShots(t: Ticket, round: ShotRound): { criterion: number; why: string }[] {
  const count = doneWhenCount(t);
  const off = offScreenNumbers(t);
  const out: { criterion: number; why: string }[] = [];
  for (let n = 1; n <= count; n += 1) {
    const row = (t.proof ?? []).find((p) => p.criterion === criterionText(t, n));
    if (row?.after || off.has(n)) continue;
    out.push({ criterion: n, why: round.planned.includes(n) ? 'squad-kit could not use the picture the Tester took.' : 'The Tester took no picture of it.' });
  }
  return out;
}

/** A proof picture that failed squad-kit's check, for the row of one "done when". */
export interface ShotProblem {
  criterion: string;
  text: string;
}

/** A row's verdict as the Tester said it, for squad-kit's check. */
const SAID: Record<NonNullable<ProofShot['shows']>, string> = { met: 'it is met', broken: 'it is broken', 'not-shown': 'it is not shown', 'off-screen': 'it is not on a screen' };
