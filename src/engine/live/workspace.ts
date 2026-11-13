import fs from 'node:fs';
import path from 'node:path';
import { addActivity, readTicket } from '../../board/store.js';
import { scheduleSquad } from '../../board/schedule.js';
import type { RepoInfo, Ticket } from '../../board/types.js';
import { DOING } from '../plain-doing.js';
import { runCommand, tail, type CheckResult } from '../checks.js';
import { addWorktree, changedTracked, putBackTracked, writeChangesOf } from '../git.js';
import * as P from '../prompts.js';
import { repoFor, reposOf } from '../repos.js';
import { partsOf, repoLabel } from '../../board/parts.js';
import { placeStoryFiles } from '../local-files.js';
import { OWN_DB_WORDS, remakeStoryDb, rewireStoryDb, setAsideCopyDb, setUpStoryDb } from '../story-db.js';
import { copiesOf, reposOfParts, storyCopyDir } from '../copies.js';
import { dockerBlockedWords } from '../project-guard.js';
import { commitTicketDocs } from '../project-git.js';
import { carryOn, fetchBase } from '../handover.js';
import { watchLane, type Lane } from '../lane.js';
import { ranFor, runsFor } from '../../board/clock.js';
import { StepError } from '../../board/problem.js';
import { addWorktreeOn, dependencyToStartFrom } from '../depends.js';
import { SETUP_MS, setupPrintNow } from '../run-app.js';
import { projectRoot } from './shared.js';
import type { LiveSquad } from './squad.js';

/** A setup that failed over its database: only then is the copy's own database made again (setUpAgain). */
const DB_TROUBLE = /database|migrat|schema|drift|sqlite|prisma|alembic|sequelize|knex|typeorm|flyway|liquibase|entity ?framework/i;

/** The ticket's own copies of the code: made, set up, and given their local files and database. */
export const workspacePart = {
  /** Make (or reuse) the ticket's worktree and set it up once. */
  async workspace(this: LiveSquad, id: string): Promise<Ticket> {
    const root = projectRoot(this.bp);
    const meta = this.meta();
    let t = readTicket(this.bp, id)!;
    const repo = repoFor(meta, t);
    if (t.worktree && fs.existsSync(t.worktree)) {
      this.mendCopy(t);
      rewireStoryDb(this.bp, id, t.worktree, repo.path);
      for (const c of t.copies ?? []) rewireStoryDb(this.bp, id, c.dir, c.repo);
      this.placeLocalFiles(id, t.worktree, repo.path);
      for (const c of t.copies ?? []) this.placeLocalFiles(id, c.dir, c.repo);
      // A setup that stopped the story (only Docker does): Try again runs it, now an engineer may have allowed Docker.
      for (const owed of t.setupOwed ?? []) {
        const dir = owed === repo.path ? t.worktree : t.copies?.find((c) => c.repo === owed)?.dir;
        const of = owed === repo.path ? repo : reposOf(meta).find((r) => r.path === owed);
        this.update(id, (x) => (x.setupOwed = x.setupOwed?.filter((p) => p !== owed)));
        if (dir && of) await this.setUpCopy(id, dir, of);
      }
      return this.addWantedCopies(id);
    }
    // A new copy starts from the newest base, the remote's when the team moved it on; or from the work of the ticket
    // it depends on, when the person chose to build on that ticket's branch.
    const dep = dependencyToStartFrom(this.bp, t);
    const at = meta.repos?.length ? storyCopyDir(root, id, repo.path) : undefined;
    const fetched = dep ? undefined : await fetchBase(this.bp, t);
    const wt: { dir: string; branch: string; baseCommit: string; pushed?: string; from?: string } = await this.makingCopy(id, (how) => (dep ? addWorktreeOn(this.bp, t, dep, at, how) : addWorktree(path.join(root, repo.path), id, repo.base, fetched, at, how)));
    const named = repo.path === '.' ? 'the project' : (repoLabel(meta, repo.path) ?? repo.path);
    t = this.update(id, (x) => {
      x.worktree = wt.dir;
      if (at) x.storyDir = path.dirname(at);
      x.branch = wt.branch;
      x.baseCommit = x.baseCommit ?? wt.baseCommit;
      addActivity(
        x,
        'builder',
        wt.from
          ? `Made a copy of ${named} from ${wt.from}`
          : wt.pushed
          ? `Made a copy of ${named} from the pushed branch ${wt.pushed}, with the work so far`
          : `Made a clean copy of ${named}`,
      );
    });
    // The ticket's documents so far go on its branch first (ADR-001), when the project keeps them in git.
    const saved = await commitTicketDocs(this.bp, t, wt.pushed ? 'picked up from the pushed branch' : t.specApproved ? 'spec and design approved' : 'plan approved');
    if (saved) t = this.update(id, (x) => addActivity(x, 'squad', 'Saved the spec and design'));
    await this.setUpCopy(id, wt.dir, repo);
    return this.addWantedCopies(id);
  },

  /**
   * The story's copy for a conversation outside squad-kit, made as it is for the Builder: same base, same values, same
   * setup. A repo named on a workspace of several gets its own copy beside the first.
   */
  async copyForOutside(this: LiveSquad, id: string, repoPath?: string): Promise<Ticket> {
    await this.workspace(id);
    if (repoPath) await this.addCopy(id, repoPath);
    return readTicket(this.bp, id)!;
  },

  /** Makes the copies of the parts the Architect named that the story does not have yet. */
  async addWantedCopies(this: LiveSquad, id: string): Promise<Ticket> {
    const t = readTicket(this.bp, id)!;
    if (t.storyDir) for (const repo of reposOfParts(this.meta(), t.parts)) await this.addCopy(id, repo);
    return readTicket(this.bp, id)!;
  },

  /** One more repo's copy in the story's folder, on the same branch name, set up like the first. */
  async addCopy(this: LiveSquad, id: string, repoPath: string): Promise<void> {
    const t = readTicket(this.bp, id)!;
    if (!t.storyDir || repoFor(this.meta(), t).path === repoPath || t.copies?.some((c) => c.repo === repoPath)) return;
    const repo = reposOf(this.meta()).find((r) => r.path === repoPath);
    if (!repo) return;
    const fetched = await fetchBase(this.bp, { ...t, repo: repo.path });
    const wt = await this.makingCopy(id, (how) => addWorktree(path.join(projectRoot(this.bp), repo.path), id, repo.base, fetched, path.join(t.storyDir!, repo.path), how));
    this.update(id, (x) => {
      x.copies = [...(x.copies ?? []), { repo: repo.path, dir: wt.dir, baseCommit: wt.baseCommit }];
      addActivity(x, 'builder', `Made a clean copy of ${repoLabel(this.meta(), repo.path) ?? repo.path}`);
    });
    await this.setUpCopy(id, wt.dir, repo);
  },

  /**
   * A copy's own database, its local files and its setup command. The database comes first, so the setup never runs
   * against the person's own. A setup that fails on this computer goes to the Builder, not the person.
   */
  async setUpCopy(this: LiveSquad, id: string, dir: string, repo: RepoInfo): Promise<void> {
    const meta = this.meta();
    await this.storyDatabase(id, dir, repo.path);
    this.placeLocalFiles(id, dir, repo.path);
    const setup = repo.commands.setup?.trim();
    if (!setup) return;
    this.update(id, (x) => (x.status = DOING.setup));
    this.log('info', `Setting up the copy: ${setup}`, id);
    const r = await runCommand(dir, setup, SETUP_MS, this.guardedWatch(id, dir));
    this.goOn(id);
    // A setup can write the same files, like cp .env.example .env.dev: the values kept for stories go back over them.
    this.placeLocalFiles(id, dir, repo.path);
    // A new project has nothing to set up yet; the Builder creates it in this ticket.
    if (!r.ok && !meta.scan?.empty) {
      // Only an engineer can allow Docker. Anything else is technical, so it never stops the story for the person.
      const docker = dockerBlockedWords(r.output, this.guardFor(dir, id));
      if (docker) {
        this.update(id, (x) => (x.setupOwed = [...new Set([...(x.setupOwed ?? []), repo.path])]));
        throw new StepError(docker, `${setup}:\n${tail(r.output, 30)}`);
      }
      this.update(id, (x) => {
        const before = x.setupTrouble;
        const said = repo.path === '.' ? setup : `in ${repo.path}: ${setup}`;
        x.setupTrouble = before ? { command: `${before.command}, and ${said}`, output: `${before.output}\n\n${tail(r.output, 30)}` } : { command: meta.repos?.length ? said : setup, output: tail(r.output, 30) };
        addActivity(x, 'squad', 'Setting up the copy did not work on this computer. The Builder sorts that out first.');
      });
    }
    // What the setup rewrote (a lock file, often) is not the story's work: it goes back before anyone reads the copy.
    const back = await putBackTracked(dir);
    if (back.length) this.log('info', `The setup command changed ${back.join(', ')}; squad-kit put ${back.length === 1 ? 'it' : 'them'} back`, id);
    if (r.ok) {
      const print = await setupPrintNow(dir);
      this.update(id, (x) => (x.setupFor = { ...x.setupFor, [repo.path]: print }));
    }
  },

  /**
   * The copy's setup again, when new packages or database changes came into it since it last ran well: the newest code
   * came in, or the Builder added them. Before the checks, and before the app starts for the Reviewer or the Tester, so
   * the app never runs on an old database. When it fails, the copy's own database is made again (never the person's)
   * and the setup runs once more. Whether it ran, and what still fails, as a failed check for the Builder.
   */
  async setUpAgain(this: LiveSquad, id: string, c: { repo: RepoInfo; dir: string }): Promise<{ ran: boolean; failed?: CheckResult }> {
    const setup = c.repo.commands.setup?.trim();
    if (!setup || !fs.existsSync(c.dir) || readTicket(this.bp, id)?.setupFor?.[c.repo.path] === (await setupPrintNow(c.dir))) return { ran: false };
    this.update(id, (x) => {
      addActivity(x, 'squad', 'New packages or database changes came into this copy, so squad-kit sets it up again');
      // A step on the clock says it is set up meanwhile, and is working while it runs.
      runsFor(x, 'setup', DOING.setup);
    });
    this.log('info', `Setting up the copy again: ${setup}`, id);
    // The story's work is not committed yet: only what the setup itself rewrites goes back.
    const theirs = await changedTracked(c.dir);
    const run = async () => {
      const r = await runCommand(c.dir, setup, SETUP_MS, this.guardedWatch(id, c.dir));
      this.placeLocalFiles(id, c.dir, c.repo.path);
      return r;
    };
    let r = await run();
    if (!r.ok && DB_TROUBLE.test(r.output) && !this.stops.get(id)?.signal.aborted && ((await remakeStoryDb(this.bp, id, c.dir, c.repo.path)) || setAsideCopyDb(c.dir).length > 0)) {
      this.log('info', `The setup failed, so squad-kit made the copy's own database again and ran it once more. It said:\n${tail(r.output, 15)}`, id);
      this.update(id, (x) => addActivity(x, 'squad', "The copy's own database was out of step with the code, so squad-kit made it again"));
      r = await run();
    }
    this.update(id, (x) => ranFor(x, 'setup'));
    const back = await putBackTracked(c.dir, { keep: theirs });
    if (back.length) this.log('info', `The setup command changed ${back.join(', ')}; squad-kit put ${back.length === 1 ? 'it' : 'them'} back`, id);
    if (!r.ok) return { ran: true, failed: { name: 'setup', command: setup, ok: false, output: r.output, seconds: r.seconds, ...(r.ended ? { ended: true } : {}) } };
    const print = await setupPrintNow(c.dir);
    this.update(id, (x) => (x.setupFor = { ...x.setupFor, [c.repo.path]: print }));
    return { ran: true };
  },

  /**
   * The Builder found it needs a part the plan did not name. squad-kit adds that part's copy and says so: the person is
   * not asked. What it answers goes to the Builder.
   */
  async addPart(this: LiveSquad, id: string, which: string, lanes?: Lane[]): Promise<string> {
    const meta = this.meta();
    const part = partsOf(meta).find((p) => p.id === which.trim() || p.name.toLowerCase() === which.trim().toLowerCase());
    if (!part) return `There is no part "${which}". The parts: ${partsOf(meta).filter((p) => !p.shared && !p.off).map((p) => p.id).join(', ')}.`;
    if (part.shared || !part.repo) return `${part.name} is a service the parts share, with no code of its own here.`;
    if (part.off) return `An engineer marked ${part.name} as not used. If the story needs it, say so in notes.`;
    const t = readTicket(this.bp, id)!;
    const have = copiesOf(meta, t).some((c) => c.repo.path === part.repo);
    if (!have) {
      await this.addCopy(id, part.repo);
      const now = readTicket(this.bp, id)!;
      const made = now.copies?.find((c) => c.repo === part.repo);
      if (!made) return `squad-kit could not add a copy of ${part.name}. Call i_am_stuck if the story cannot go on without it.`;
      lanes?.push(await watchLane(made.dir, this.protectedFiles(made.dir)));
      this.update(id, (x) => addActivity(x, 'squad', `The Builder needed ${part.name} too, so squad-kit added its copy`));
    }
    this.update(id, (x) => {
      if (!x.parts?.includes(part.id)) x.parts = [...(x.parts ?? []), part.id];
    });
    return `${part.name} is in the folder ${part.repo}/ of this story's folder. Its checks: run_checks with part "${part.id}".`;
  },

  /**
   * What each part changed, written to a file in the story's folder. A step that only reads cannot run git there: its AI
   * tool refuses git in a folder that is not the one it works in, so squad-kit does that part.
   */
  async writeChanges(this: LiveSquad, t: Ticket): Promise<void> {
    if (!t.storyDir) return;
    for (const c of copiesOf(this.meta(), t)) await writeChangesOf(c.dir, c.baseCommit, path.join(t.storyDir, P.changesFile(c.repo.path)), c.repo.path);
  },

  /**
   * The story's own database, made from the template on the same server, with the copy pointed at it. A PM reads one
   * plain line; anything wrong goes to engineers only, and the story goes on as before.
   */
  async storyDatabase(this: LiveSquad, id: string, dir: string, repo: string): Promise<void> {
    const r = await setUpStoryDb(this.bp, id, dir, repo).catch((err: unknown) => {
      this.log('warn', `The story's own database was not set up: ${(err as Error).message}`, id);
      return null;
    });
    // No copy because of where the database is (another computer, a fallback there): the story says so, once.
    if (r?.state === 'as-before' && r.say && !readTicket(this.bp, id)?.activity.some((a) => a.text === r.say)) this.update(id, (x) => addActivity(x, 'squad', r.say!));
    if (r?.state !== 'own') return;
    if (r.made) this.log('info', `Made ${r.name}, the story's own database`, id);
    if (!readTicket(this.bp, id)?.activity.some((a) => a.text === OWN_DB_WORDS)) this.update(id, (x) => addActivity(x, 'squad', OWN_DB_WORDS));
  },

  /** A repo's local files go in the story's copy. One with no values yet is said once: the app may not start without it. */
  placeLocalFiles(this: LiveSquad, id: string, dir: string, repo: string): void {
    const { missing } = placeStoryFiles(this.bp, repo, dir);
    if (!missing.length) return;
    const line = `An engineer has not given stories their values for ${missing.join(', ')} yet, so the app may not start here.`;
    if (!readTicket(this.bp, id)?.activity.some((a) => a.text === line)) this.update(id, (x) => addActivity(x, 'squad', line));
  },

  /** A ticket that came from a pushed branch: its copy of the code comes from that branch, then it carries on. */
  async pickedUp(this: LiveSquad, id: string): Promise<void> {
    const t = await this.workspace(id);
    const next = carryOn(t, true);
    this.update(id, (x) => {
      x.status = next.status;
      x.waiting = next.waiting ?? null;
      x.live = Boolean(next.phase);
      if (next.phase) scheduleSquad(x, next.phase, 0.2, 1);
      else x.squad = null;
    });
  },
};
