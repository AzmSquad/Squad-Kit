import { randomUUID } from 'node:crypto';
import { addActivity, listDecisions, readTicket } from '../../board/store.js';
import { scheduleSquad } from '../../board/schedule.js';
import type { Ticket } from '../../board/types.js';
import { commitAll, conventionalWords, git, gitLater, isAncestor, latestBase } from '../git.js';
import * as P from '../prompts.js';
import { repoFor } from '../repos.js';
import { copiesOf } from '../copies.js';
import { leaveProjectFiles } from '../project-git.js';
import { fetchBase } from '../handover.js';
import { StepError } from '../../board/problem.js';
import { carriesOn, carryOnLine, carryOnPrompt } from '../interrupt.js';
import { openStep, planKey } from './shared.js';
import type { LiveSquad } from './squad.js';

/** Bringing main's new code into a ticket's copy, and the person's own fix. */
export const basePart = {
  /**
   * The accepted change clashes with newer work in the base. squad-kit starts the merge in the ticket's copy (agents
   * never write to git), the Builder settles each clash, and the checks, review and proof run again.
   */
  /**
   * The plan was redone to follow a newer decision, after the Builder had started. The latest base comes in first, so
   * the work builds on what that decision already changed, then the Builder redoes the work to the new plan.
   */
  /**
   * Brings the latest base into the ticket's copy. Work not saved yet is committed first, or git refuses to merge over
   * it; if the base still is not in the copy, the step fails with git's reason instead of saying it worked.
   */
  async bringInBase(this: LiveSquad, t: Ticket, base: string, remote?: string, dir = t.worktree!): Promise<{ baseSha: string; clashes: string[]; from: string }> {
    const unmerged = async () => (await gitLater(dir, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true })).split('\n').filter(Boolean);
    const merging = () => git(dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFail: true }) !== '';
    // The newest base: the remote's when the team moved it on (fetched just before), with work accepted here kept.
    const latest = latestBase(dir, base, remote);
    // Clashes from last time that are not fixed yet: the Builder fixes those first.
    const left = merging() ? await unmerged() : [];
    if (left.length) return { baseSha: git(dir, ['rev-parse', 'MERGE_HEAD']), clashes: left, from: latest.ref };
    const baseSha = latest.sha;
    leaveProjectFiles(this.bp, t, base);
    const guard = this.guardFor(dir, t.id);
    const signal = this.stops.get(t.id)?.signal;
    const saved = await commitAll(dir, `Work so far on ${t.title} (${t.id})`, conventionalWords('chore', `work so far on ${t.title}`, t.id), { ...(guard ? { guard } : {}), ...(signal ? { signal } : {}) });
    if (saved.hookSaid !== undefined) {
      this.log('warn', `The project's own check said no to the work so far: ${saved.hookSaid}`, t.id);
      this.update(t.id, (x) => {
        x.hookOwed = true;
        addActivity(x, 'squad', "Saved the work so far without the project's own check, as it is not finished. The check runs on the whole change before it goes in");
      });
    }
    let why = 'git did not merge it';
    try {
      await gitLater(dir, ['merge', '--no-commit', '--no-ff', '-m', `Merge ${latest.ref} into ${t.branch ?? 'this ticket'}`, baseSha]);
    } catch (err) {
      why = (err as Error).message;
    }
    const clashes = await unmerged();
    if (!merging() && !isAncestor(dir, baseSha, 'HEAD')) throw new StepError('squad-kit could not bring the newest code into this ticket. Press Try again.', why);
    return { baseSha, clashes, from: latest.ref };
  },

  /** The latest base into every copy the story has: each from its own repo. The first copy's answer, with every clash. */
  async bringInEveryBase(this: LiveSquad, t: Ticket): Promise<{ baseSha: string; clashes: string[]; from: string }> {
    const copies = copiesOf(this.meta(), t);
    const clashes: string[] = [];
    const bases = new Map<string, string>();
    let first: { baseSha: string; from: string } | undefined;
    for (const c of copies) {
      const r = await this.bringInBase(t, c.repo.base, await fetchBase(this.bp, { ...t, repo: c.repo.path }), c.dir);
      first ??= r;
      clashes.push(...r.clashes.map((f) => (t.storyDir ? `${c.repo.path}/${f}` : f)));
      bases.set(c.repo.path, r.baseSha);
    }
    if (t.copies?.length) this.update(t.id, (x) => (x.copies = x.copies?.map((c) => ({ ...c, baseCommit: bases.get(c.repo) ?? c.baseCommit }))));
    return { ...first!, clashes };
  },

  /** Whether any copy's base has something new since its copy took it. */
  async anyBaseMoved(this: LiveSquad, t: Ticket): Promise<boolean> {
    for (const c of copiesOf(this.meta(), t)) {
      if (this.baseMoved({ ...t, worktree: c.dir, baseCommit: c.baseCommit }, c.repo.base, await fetchBase(this.bp, { ...t, repo: c.repo.path }))) return true;
    }
    return false;
  },

  async rebuild(this: LiveSquad, id: string, adr: string): Promise<void> {
    const t = readTicket(this.bp, id)!;
    const base = repoFor(this.meta(), t).base;
    // The redo was handed to the Builder already (its conversation has this plan) and a restart, a Stop or sleep cut
    // it off: it carries on where it was. The base comes in again only when something new arrived on it since.
    const cut = t.builtPlan === planKey(t) && t.sessions?.build ? carriesOn(t, 'build') : undefined;
    const moved = !cut || (await this.anyBaseMoved(t));
    const { baseSha, clashes, from } = moved ? await this.bringInEveryBase(t) : { baseSha: t.baseCommit!, clashes: [] as string[], from: base };
    const t1 = this.update(id, (x) => {
      x.baseCommit = baseSha;
      x.stage = 'implement';
      x.live = true;
      x.tries = 0;
      x.reviewRound = 0;
      x.proof = undefined;
      x.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
      x.sessions = { ...x.sessions, build: x.sessions?.build ?? randomUUID() };
      x.status = cut ? `Step ${openStep(x)} of ${x.steps?.length ?? 1}` : `Redoing the work to follow ${adr}`;
      if (moved) addActivity(x, 'squad', `Brought the newest code into this ticket${clashes.length ? `. Clashes in ${clashes.join(', ')}` : ''}`);
      addActivity(x, 'builder', cut ? carryOnLine(x, cut.by) : `Started redoing the work to follow ${adr}`);
    });
    const meta = this.meta();
    this.update(id, (x) => (x.builtPlan = planKey(t1)));
    const intro = `The plan changed to follow ${adr}, a decision approved after you started. The latest ${base} is now in this copy${clashes.length ? `, with clashes in ${clashes.join(', ')} to fix first` : ''}. Stay on this branch: it already has the newest code, so a plan that says to start from ${base} is met, and squad-kit does all the git. Redo the work to the new plan below: keep what still fits, change what does not.`;
    const newer = moved && cut ? ` squad-kit brought the newest code into this copy meanwhile${clashes.length ? `, with clashes in ${clashes.join(', ')} to fix first` : ''}.` : '';
    await this.runBuilder(id, cut ? `${carryOnPrompt(t1, cut.by)}${newer}` : `${intro}\n\n${P.buildPrompt(meta, listDecisions(this.bp), t1, this.ctx(t1))}`, Boolean(t.sessions?.build), 'build');
    this.update(id, (x) => {
      for (const s of x.steps ?? []) {
        s.status = 'done';
        s.live = undefined;
      }
      x.replanFor = undefined;
      x.progress = 100;
      addActivity(x, 'builder', 'Finished all steps');
      x.stage = 'test';
      x.status = 'Running the project checks';
      scheduleSquad(x, 'test', 0.2, 1);
    });
  },

  /** Something new arrived on the base since the ticket's copy last took it in. */
  baseMoved(this: LiveSquad, t: Ticket, base: string, remote?: string): boolean {
    try {
      const latest = latestBase(t.worktree!, base, remote).sha;
      return latest !== t.baseCommit && !isAncestor(t.worktree!, latest, 'HEAD');
    } catch {
      return true;
    }
  },

  async updateBase(this: LiveSquad, id: string): Promise<void> {
    const t = await this.workspace(id);
    const base = repoFor(this.meta(), t).base;
    const { baseSha, clashes, from } = await this.bringInEveryBase(t);
    this.update(id, (x) => {
      x.baseCommit = baseSha;
      x.stage = 'implement';
      x.live = true;
      x.tries = 0;
      x.reviewRound = 0;
      x.proof = undefined;
      x.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
      x.status = clashes.length ? `Builder is fixing ${clashes.length} clashing ${clashes.length === 1 ? 'file' : 'files'}` : 'Running the project checks';
      addActivity(x, 'squad', `Brought the newest code into this ticket${clashes.length ? `. Clashes in ${clashes.join(', ')}` : ''}`);
    });
    if (clashes.length) {
      await this.runBuilder(id, P.clashPrompt(base, clashes), Boolean(t.sessions?.build));
      this.update(id, (x) => addActivity(x, 'builder', `Fixed the clash with ${base}`));
    }
    this.update(id, (x) => {
      x.stage = 'test';
      x.status = 'Running the project checks';
      scheduleSquad(x, 'test', 0.2, 1);
    });
  },

  async fixFromPerson(this: LiveSquad, id: string): Promise<void> {
    const t = await this.workspace(id);
    this.update(id, (x) => {
      x.stage = 'implement';
      x.live = true;
      x.status = 'Builder is fixing what you found';
      x.tries = 0;
      x.fails = 0;
      x.reviewRound = 0;
      x.steps = [...(x.steps ?? []), { title: `Fix: ${x.changeRequest?.split('\n')[0] ?? 'what you found'}`, status: 'doing' }];
    });
    await this.runBuilder(id, P.changeFixPrompt(t.changeRequest ?? ''), Boolean(t.sessions?.build));
    this.update(id, (x) => {
      const last = x.steps?.[x.steps.length - 1];
      if (last) {
        last.status = 'done';
        last.live = undefined;
      }
      addActivity(x, 'builder', 'Fixed what you found');
      x.changeRequest = undefined;
      x.stage = 'test';
      x.status = 'Running the project checks';
      x.proof = undefined;
      scheduleSquad(x, 'test', 0.2, 1);
    });
  },
};
