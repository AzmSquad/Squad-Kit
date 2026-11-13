import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { addActivity } from '../../board/store.js';
import type { BoardMeta, Ticket } from '../../board/types.js';
import { shotProblem } from '../proof-check.js';
import { plainParts, prepareShots, shotsErrorDetail } from '../shots.js';
import { AgentWindow, tooManyMistakesWords, tooManyWords, type WindowPhone } from '../window.js';
import { judgeQuestion, refusedAskLine } from '../question-filter.js';
import * as P from '../prompts.js';
import { answerLists, checklistAsk, checklistsFor } from '../../board/additions.js';
import { workFolder } from '../copies.js';
import { watchLane } from '../lane.js';
import { StepError } from '../../board/problem.js';
import {
  MAX_PICTURES_PER_DONE_WHEN,
  addPictures,
  isApiProof,
  criterionText,
  doneWhenCount,
  verdictOf,
  type Judged,
} from '../proof-verdict.js';
import { PROOF_STEP_MS } from './limits.js';
import { technicalWords } from './shared.js';
import type { LiveSquad } from './squad.js';
import type { ShotProblem, ShotRound } from './proof.js';

/** The Tester's run in the browser, and its words for the proof. */
export const shootPart = {
  async shoot(this: LiveSquad, id: string, t: Ticket, when: 'before' | 'after', meta: BoardMeta, win: AgentWindow, appUrl: string, beside?: { cwd: string; job: string }, again: string[] = [], phone?: WindowPhone): Promise<ShotRound> {
    // The Tester only reads the code: squad-kit takes the pictures. The lane still puts back anything changed.
    const lanes = beside ? [await watchLane(beside.cwd, this.protectedFiles(beside.cwd), true)] : await this.watchCopies(t, true);
    // A picture saved before this moment was not taken in this step.
    const since = Date.now();
    const lists = when === 'after' && !beside ? checklistsFor(this.bp, 'tester') : [];
    const onPhone = phone ? { labels: phone.labels(), links: phone.links() } : undefined;
    const prompt = `${P.proofPrompt(meta, t, when, this.ctx(t), appUrl, when === 'after' ? this.beforeSizes(t) : undefined, beside || phone ? [] : Object.keys(this.apiParts(t)), onPhone)}${checklistAsk(lists)}`;
    // A new round of after-shots names every "done when": a picture, or why it shows on no screen.
    const count = doneWhenCount(t);
    const complete = (answer: unknown): string | null => {
      const a = (answer ?? {}) as { shots?: { criterion?: unknown }[]; offScreen?: { criterion?: unknown }[] };
      const named = new Set([...(a.shots ?? []), ...(a.offScreen ?? [])].map((x) => Number(x?.criterion)));
      const left = Array.from({ length: count }, (_, i) => i + 1).filter((n) => !named.has(n));
      return left.length ? `every "done when" must be in shots or in offScreen, and ${left.map((n) => `"done when" ${n}`).join(', ')} ${left.length === 1 ? 'is' : 'are'} in neither` : null;
    };
    // Only pictures taken in this step count: a file it names from outside them is asked for once more, with the list.
    const realFiles = (answer: unknown): string | null => {
      const wrong = [...new Set(((answer ?? {}) as { shots?: { file?: unknown }[] }).shots?.map((x) => path.basename(String(x?.file ?? ''))) ?? [])].filter((f) => !win.pictures.has(f));
      return wrong.length ? `it names ${wrong.join(', ')}, which squad-kit did not take in this step` : null;
    };
    // A "done when" gets one picture per part or case, so an answer may name it several times, up to a limit.
    const notTooMany = (answer: unknown): string | null => {
      const named = ((answer ?? {}) as { shots?: { criterion?: unknown }[] }).shots?.map((x) => Number(x?.criterion)) ?? [];
      const over = [...new Set(named)].filter((n) => named.filter((m) => m === n).length > MAX_PICTURES_PER_DONE_WHEN);
      return over.length ? `one "done when" takes at most ${MAX_PICTURES_PER_DONE_WHEN} pictures, one per part or case, and ${over.map((n) => `"done when" ${n}`).join(', ')} ${over.length === 1 ? 'has' : 'have'} more` : null;
    };
    const check = (answer: unknown): string | null => realFiles(answer) ?? notTooMany(answer) ?? (when === 'after' && !again.length && count ? complete(answer) : null);
    const r = await this.runAgent({
      role: 'tester',
      step: 'proof',
      ticket: id,
      // The before-shots ran in a copy that is gone now, so the after-shots have a conversation of their own.
      ...(beside ? { job: beside.job, cwd: beside.cwd, sessionId: randomUUID() } : { cwd: workFolder(t)!, sessionId: t.sessions!.tester }),
      prompt: again.length ? `${prompt}\n\n${P.proofAgainPrompt(again)}` : prompt,
      permissions: ['read'],
      schema: P.PROOF_SCHEMA,
      check,
      checkHelp: () => win.pictureList(),
      // Up to 40 pictures, with a look at each.
      timeoutMs: PROOF_STEP_MS,
      addDirs: this.extraDirs(t),
      box: {},
      win,
      ...(beside ? {} : { onTool: this.watcher(id, 'tester', workFolder(t)!) }),
    }).finally(() => this.keepLanes(id, 'tester', lanes, [this.bp.proofDir]));
    const out = (r.structured ?? { shots: [] }) as {
      shots: { criterion: number; file: string; shows?: string; note?: string }[];
      offScreen?: { criterion: number; why?: string }[];
      checklist?: { n?: unknown; answer?: unknown; why?: unknown }[];
      /** Older answers: one line for what shows on no screen. */
      skipped?: string;
    };
    const say = (text: string) => this.update(id, (x) => addActivity(x, 'tester', text));
    if (lists.length) this.update(id, (x) => this.listNoes.set(id, answerLists(this.bp, x, lists, out.checklist)));
    // Only pictures squad-kit took in this step count, each with the page it was taken at and the Tester's verdict.
    const shots: { criterion: number; file: string; page: string; size: string; device?: string; shows: Judged; note?: string }[] = [];
    for (const s of out.shots ?? []) {
      const file = path.basename(String(s.file ?? ''));
      const taken = win.pictures.get(file);
      if (!taken) {
        say(`The Tester named ${file || 'a picture'} for "done when" ${s.criterion}, which squad-kit did not take in this step, so it is left out`);
        continue;
      }
      // Asked once more already (notTooMany): the first ones stay.
      if (shots.filter((x) => x.criterion === s.criterion).length >= MAX_PICTURES_PER_DONE_WHEN) {
        say(`The Tester named more than ${MAX_PICTURES_PER_DONE_WHEN} pictures for "done when" ${s.criterion}, so squad-kit kept the first ${MAX_PICTURES_PER_DONE_WHEN}`);
        continue;
      }
      const note = s.note ? this.plainNote(win, s.note) : '';
      shots.push({ criterion: s.criterion, file, page: taken.page, size: taken.size, ...(taken.device ? { device: taken.device } : {}), shows: verdictOf(s.shows) ?? 'not-shown', ...(note ? { note } : {}) });
    }
    // Each "done when" that shows on no screen, with why in plain words.
    const off: { criterion: number; why: string }[] = [];
    for (const o of when === 'after' ? (out.offScreen ?? []) : []) {
      const n = Number(o?.criterion);
      // Pictures of a part and a reason for the rest go together: squad-kit's check judges both.
      if (!criterionText(t, n) || off.some((x) => x.criterion === n)) continue;
      const refused = win.refusals.length;
      const why = this.plainNote(win, String(o.why ?? ''));
      // A reason that asked for what nobody may ask is no reason: that "done when" still needs a picture.
      if (win.refusals.length > refused) continue;
      off.push({ criterion: n, why });
    }
    const skipped = [...off.map((o) => o.why), this.plainNote(win, out.skipped ?? '')].filter(Boolean).join(' ');
    if (win.tooMany) throw new StepError(tooManyWords('Tester'), win.refusalDetail());
    if (win.tooManyMistakes) throw new StepError(tooManyMistakesWords('Tester'), win.mistakeDetail());
    const named = (n: number) => criterionText(t, n);
    // squad-kit looks at each picture itself: a real image, a sensible size, not blank, saved in this step.
    const problems: ShotProblem[] = [];
    const rejected = new Set<string>();
    for (const s of shots) {
      const full = path.join(this.bp.proofDir, s.file);
      const criterion = named(s.criterion);
      if (!criterion || !fs.existsSync(full)) continue;
      const bad = isApiProof(s.file) ? null : shotProblem(full, since);
      if (!bad) continue;
      rejected.add(s.file);
      problems.push({ criterion, text: `The ${when} screenshot for "${criterion}" (${s.file}): ${bad}.` });
    }
    this.update(id, (x) => {
      const proof = x.proof ?? [];
      const usable = shots.filter((s) => !rejected.has(s.file) && named(s.criterion) && fs.existsSync(path.join(this.bp.proofDir, s.file)));
      for (const n of new Set(usable.map((s) => s.criterion))) {
        const criterion = named(n)!;
        const own = usable.filter((s) => s.criterion === n);
        let row = proof.find((p) => p.criterion === criterion);
        if (!row) {
          row = { criterion, before: '', after: '', beforeLabel: 'Before', afterLabel: 'After' };
          proof.push(row);
        }
        // One before pairs with the main after. The Tester's own verdict stands until squad-kit's check of them (judge).
        if (when === 'before') {
          row.before = own[0]!.file;
          if (own[0]!.device) row.beforeDevice = own[0]!.device;
          else delete row.beforeDevice;
        }
        else {
          addPictures(row, own, (a, b) => this.sameFile(a, b));
          this.pairWithBefore(row);
        }
      }
      x.proof = proof.map((p) => (p.before ? p : { ...p, before: p.after, ...(p.device ? { beforeDevice: p.device } : {}), beforeLabel: 'New screen', afterLabel: 'After' }));
      if (when === 'after') {
        // A new round says again what shows on no screen; a retake adds to it. squad-kit's check judges them next (judge).
        const kept = again.length ? (x.offScreen ?? []) : [];
        const added = off.map((o) => ({ criterion: named(o.criterion)!, why: o.why || 'The Tester says it does not show on a screen.' }));
        const all = [...kept.filter((k) => !added.some((a) => a.criterion === k.criterion)), ...added];
        if (all.length) x.offScreen = all;
        else delete x.offScreen;
        const notOn = off.length ? `. Not on a screen: ${off.map((o) => `"done when" ${o.criterion}`).join(', ')}` : skipped ? `. Skipped: ${skipped}` : '';
        const answers = shots.filter((s) => isApiProof(s.file)).length;
        const pictures = shots.length - answers - rejected.size;
        addActivity(x, 'tester', `Saved ${pictures} ${answers && pictures === 1 ? 'screenshot' : 'screenshots'}${answers ? ` and ${answers} ${answers === 1 ? 'answer' : 'answers'} from the API` : ''}${notOn}`);
      }
    });
    return { problems, planned: shots.map((s) => s.criterion), said: skipped, stuck: win.stuck, sizes: Object.fromEntries(shots.map((s) => [s.file, s.size])) };
  },

  /** Sets up squad-kit's screenshot browser when this computer lacks it, on its own limit, saying so on the ticket. */
  async readyBrowser(this: LiveSquad, id: string, signal: AbortSignal | undefined, job: string): Promise<void> {
    // Setting it up the first time is the step working, not hanging.
    const beat = setInterval(() => this.dog.beat(job), 20_000);
    try {
      await prepareShots({ ...(signal ? { signal } : {}), onLine: (text) => this.update(id, (x) => addActivity(x, 'tester', text)) });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new StepError((err as Error).message, shotsErrorDetail(err));
    } finally {
      clearInterval(beat);
    }
  },

  /**
   * The Tester's words for the person (a picture's note, why a "done when" shows on no screen): its plain sentences
   * stay, and each technical one goes to the app log (shots.ts plainParts), so "390 px" or "1280 wide" never hides a
   * note. A note with nothing plain left says so in the activity; an ask that is not allowed is refused and counted.
   */
  plainNote(this: LiveSquad, win: AgentWindow, text: string): string {
    const said = text.trim();
    if (!said) return '';
    const verdict = judgeQuestion({ text: said });
    if (!verdict.pass && verdict.kind === 'not-allowed') {
      win.refuse('note', `${verdict.why}: "${said.slice(0, 200)}"`, refusedAskLine('Tester', verdict.what));
      return '';
    }
    const { kept, left } = plainParts(said, technicalWords);
    // Its technical words go to the app log, not to the activity.
    if (left) this.log('info', `Left out of the Tester's note: ${left.slice(0, 600)}`, win.ticket);
    if (kept) return kept.slice(0, 600);
    this.update(win.ticket, (x) => addActivity(x, 'tester', 'The Tester wrote something technical, so it stays out of the proof.'));
    return '';
  },
};
