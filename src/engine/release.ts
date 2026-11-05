import fs from 'node:fs';
import path from 'node:path';
import { readMeta, readTicket, type BoardPaths } from '../board/store.js';
import type { Release, Ticket, UnpushedRelease } from '../board/types.js';
import { runCommand, tail } from './checks.js';
import { HOOK_MS, HookRefused, MergeClash, SHORT_HOOK_MS, bringHookRunner, commitArgsFor, commitChecked, commitHooks, commitWithoutHooks, conventionalWords, currentBranch, git, isAncestor, keepingFiles, mergeIntoBase, netGit, netGitLater, remotes, removeWorktree, somethingToSave, stageAll, worktreeRoot, type HookRun } from './git.js';
import { projectRoot } from './live.js';
import { repoFor } from './repos.js';
import type { RepoInfo } from '../board/types.js';
import { repoHostFor } from '../modules/registry.js';
import type { RepoHost } from '../modules/code-host/types.js';
import { docsInGit, docsRepo, stageReleaseDocs } from './project-git.js';
import { bringBack, leaveOut, leaveOutProblem } from './leave-out.js';
import { noteRepo, notePrMerged, startJournal, type RepoJournal } from './release-resume.js';
import { dropTicketCache } from './sandbox.js';
import { guardSupport, projectGuardFor } from './project-guard.js';

/**
 * A real release: merge every ready ticket (its pull request on the code host, or its branch locally), write the
 * changelog, set the version, tag it, and push. All of it happens in a separate worktree, so the person's own
 * checkout is never touched unless it can simply fast-forward.
 */

export type ReleaseLog = { ok: boolean; text: string }[];

/** What a release did: its log, and the repos whose push failed (the release commit is only on this computer). */
export interface ReleaseResult {
  log: ReleaseLog;
  unpushed: UnpushedRelease[];
}

/** Pull requests the code host cannot merge because newer changes in the base clash with them. Thrown before anything changes. */
export class PullRequestClash extends Error {
  constructor(
    readonly tickets: string[],
    readonly base: string,
  ) {
    super(`The pull request of ${tickets.join(', ')} clashes with newer changes in ${base}.`);
  }
}

const ticketMessage = (t: Ticket) => `${t.title} (${t.id})`;
const ticketWords = (t: Ticket) => conventionalWords(t.kind === 'bug' ? 'fix' : 'feat', t.title, t.id);

/**
 * Saves the ticket's finished change. The project's commit hooks run on it; a hook that says no throws a HookRefused and
 * the ticket stops with a way out (board/actions.ts). When work was saved earlier without them (hookOwed), they run on
 * the whole change.
 */
export async function commitTicket(ticket: Ticket, how: HookRun = {}): Promise<string | null> {
  if (!ticket.worktree || !fs.existsSync(ticket.worktree)) return null;
  stageAll(ticket.worktree);
  const owed = ticket.hookOwed && ticket.baseCommit;
  if (!owed && !somethingToSave(ticket.worktree)) return null;
  await commitChecked(ticket.worktree, ticketMessage(ticket), ticketWords(ticket), HOOK_MS, { ...how, ...(owed ? { from: ticket.baseCommit! } : {}) });
  return git(ticket.worktree, ['rev-parse', '--short', 'HEAD']);
}

/**
 * What is left to save with no hooks: they had their say on the change a moment ago (commitTicket), or the person chose
 * to go past them, with a reason on the record. The caller answers for which.
 */
export function commitWithoutCheck(ticket: Ticket): string | null {
  if (!ticket.worktree || !fs.existsSync(ticket.worktree)) return null;
  stageAll(ticket.worktree);
  if (!somethingToSave(ticket.worktree)) return null;
  commitWithoutHooks(ticket.worktree, ticketMessage(ticket));
  return git(ticket.worktree, ['rev-parse', '--short', 'HEAD']);
}

/** True when the project's hooks have something to look at on this ticket that they have not seen. */
export function hooksStillOwed(ticket: Ticket): boolean {
  if (ticket.hookOwed) return true;
  if (!ticket.worktree || !fs.existsSync(ticket.worktree)) return false;
  stageAll(ticket.worktree);
  bringHookRunner(ticket.worktree);
  return somethingToSave(ticket.worktree) && commitHooks(ticket.worktree).length > 0;
}

/**
 * The release's own commit: its version, changelog and project files, no story's code, which passed the hooks when it
 * was accepted. The hooks get their try. When they say no (a fresh copy has no packages installed, or the project does
 * not take this kind of commit) it is saved anyway, since the release cannot stop here, and the release's log says so.
 */
async function commitRelease(dir: string, version: string, log: ReleaseLog, how: HookRun = {}): Promise<void> {
  const message = `release ${version}`;
  try {
    await commitChecked(dir, message, conventionalWords('chore', message), SHORT_HOOK_MS, { ...how, noRunner: true });
  } catch (err) {
    if (!(err instanceof HookRefused)) throw err;
    commitWithoutHooks(dir, message);
    log.push({ ok: false, text: `The project's own check said no to the release's own save, which holds only the version and the changelog, so squad-kit saved it without that check: ${err.said.split('\n').slice(-1)[0] ?? ''}`.trim() });
  }
}

export async function liveRelease(bp: BoardPaths, release: Release, tickets: Ticket[]): Promise<ReleaseResult> {
  const root = projectRoot(bp);
  const meta = readMeta(bp);
  const groups = new Map<string, { repo: RepoInfo; tickets: Ticket[] }>();
  for (const t of tickets) {
    const repo = repoFor(meta, t);
    const g = groups.get(repo.path) ?? { repo, tickets: [] };
    g.tickets.push(t);
    groups.set(repo.path, g);
  }
  const log: ReleaseLog = [];
  const unpushed: UnpushedRelease[] = [];
  const multi = groups.size > 1 || Boolean(meta.repos?.length);
  // Tickets taken out before the release was made: merged already, so the release leaves their code out.
  const leaving = (release.out ?? [])
    .filter((id) => !release.tickets.includes(id))
    .map((id) => readTicket(bp, id))
    .filter((t): t is Ticket => Boolean(t?.mergedAt && t.stage !== 'done'));
  const plans = [...groups.values()].map(({ repo, tickets: list }) => {
    const repoRoot = path.join(root, repo.path);
    const remote = repo.remote || remotes(repoRoot)[0];
    const url = remote ? git(repoRoot, ['config', '--get', `remote.${remote}.url`], { allowFail: true }) : '';
    const host = url ? repoHostFor(bp, url) : null;
    return { repo, repoRoot, list, host, env: host?.gitEnv() ?? {}, leave: leaving.filter((t) => repoFor(meta, t).path === repo.path) };
  });
  // One pull request the host cannot merge would stop the release halfway: look for those first, before anything changes.
  for (const { repo, repoRoot, list, host, leave } of plans) {
    const clashing: string[] = [];
    for (const t of list.filter((x) => host && x.pr?.host === host.host && !x.mergedAt)) {
      if ((await host!.mergeState(t.pr!.id)) === 'clash') clashing.push(t.id);
    }
    if (clashing.length) throw new PullRequestClash(clashing, repo.base || currentBranch(repoRoot));
    // A ticket taken out that cannot be left out (later work changed the same lines) stops it here too.
    const problem = leave.length ? leaveOutProblem(repoRoot, repo.base || currentBranch(repoRoot), leave) : null;
    if (problem) throw new Error(`${problem} Put it back into ${release.version}, or take that work out too.`);
  }
  // From here on the release writes down each step, so a restart half-way can finish it or undo it (release-resume.ts).
  startJournal(bp, release.version, tickets.map((t) => t.id));
  for (const { repo, repoRoot, list, host, env, leave } of plans) {
    // The project's shared files go out with the release when `.squad/` sits in this repo (ADR-001).
    const docs = docsInGit(bp) && path.resolve(docsRepo(bp)!) === path.resolve(repoRoot) ? (dir: string) => stageReleaseDocs(bp, dir, release, list) : undefined;
    const keep = path.relative(repoRoot, bp.squadDir);
    const note = (patch: Partial<RepoJournal> & { base: string }) => noteRepo(bp, repo.path, patch);
    const done = await releaseRepo(repoRoot, repo, release, list, meta.commands?.deploy, host, env, docs, keep && !keep.startsWith('..') ? keep : undefined, {
      leave,
      note,
      merged: (id) => notePrMerged(bp, id),
      guardFor: (dir) => (guardSupport().on ? projectGuardFor(bp, { cwd: dir, ...(meta.guard ? { allow: meta.guard } : {}) }) : undefined),
    });
    log.push(...done.log.map((l) => (multi ? { ...l, text: `${repo.path}: ${l.text}` } : l)));
    if (done.unpushed) unpushed.push(done.unpushed);
    // Their copies of the code went with the release, so their own package caches go too.
    for (const t of list) dropTicketCache(bp, t.id);
  }
  return { log, unpushed };
}

async function releaseRepo(
  root: string,
  repo: RepoInfo,
  release: Release,
  tickets: Ticket[],
  deployFallback: string | undefined,
  host: RepoHost | null,
  env: Record<string, string>,
  docs?: (dir: string) => void,
  keep?: string,
  extra: { leave?: Ticket[]; note?: (patch: Partial<RepoJournal> & { base: string }) => void; merged?: (id: string) => void; guardFor?: (dir: string) => ReturnType<typeof projectGuardFor> | undefined } = {},
): Promise<{ log: ReleaseLog; unpushed?: UnpushedRelease }> {
  const base = repo.base || currentBranch(root);
  const remote = repo.remote || remotes(root)[0];
  const version = release.version;
  const branch = `release/${version}`;
  const dir = path.join(worktreeRoot(root), `release-${version}`);
  const log: ReleaseLog = [];
  let unpushed: UnpushedRelease | undefined;

  // Accepted work is normally merged already. A pull request still waiting on the host is merged now.
  for (const t of tickets.filter((x) => x.mergedAt)) log.push({ ok: true, text: `Already in ${base}: ${t.id} ${t.title}` });
  const viaPr = tickets.filter((t) => host && t.pr?.host === host.host && !t.mergedAt);
  const note = extra.note ?? (() => undefined);
  for (const t of viaPr) {
    await host!.merge(t.pr!.id, `Merge ${t.title} (${t.id})`);
    extra.merged?.(t.id);
    log.push({ ok: true, text: `Merged pull request ${t.pr!.id}: ${t.title}` });
  }
  let start = base;
  if ((viaPr.length || tickets.some((t) => t.pr && t.mergedAt)) && remote) {
    netGit(root, ['fetch', remote, base], { env });
    start = 'FETCH_HEAD';
  }

  removeWorktree(root, dir);
  git(root, ['worktree', 'prune'], { allowFail: true });
  git(root, ['branch', '-D', branch], { allowFail: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(root, ['worktree', 'add', '-b', branch, dir, start]);
  note({ base, ...(remote ? { remote } : {}), dir, branch });

  try {
    for (const t of tickets) {
      if (!t.branch || t.mergedAt || viaPr.includes(t)) continue;
      try {
        // A merge commit holds no new work, and on Looks right it goes in with no hooks at all: the same here.
        git(dir, [...commitArgsFor(dir), 'merge', '--no-ff', '-m', `Merge ${t.title} (${t.id})`, t.branch]);
        log.push({ ok: true, text: `Merged ${t.id} ${t.title}` });
      } catch (err) {
        const clashes = git(dir, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true });
        git(dir, ['merge', '--abort'], { allowFail: true });
        // A real clash: the ticket leaves the release with the clash card and its ways out, and the rest can go.
        if (clashes) throw new PullRequestClash([t.id], base);
        throw new Error(`${t.id} could not be merged into ${base}, so the release stopped. ${(err as Error).message}`);
      }
    }
    const reverts = extra.leave?.length ? leaveOut(dir, root, base, extra.leave, version, log) : [];

    if (release.addons.changelog) {
      writeChangelog(dir, version, release.notes);
      log.push({ ok: true, text: 'Changelog updated' });
    }
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      const json = JSON.parse(fs.readFileSync(pkg, 'utf8')) as { version?: string };
      if (json.version) {
        json.version = version.replace(/^v/, '');
        fs.writeFileSync(pkg, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
        log.push({ ok: true, text: `Version set to ${json.version} in package.json` });
      }
    }
    docs?.(dir);
    stageAll(dir);
    if (somethingToSave(dir)) await commitRelease(dir, version, log, extra.guardFor?.(dir) ? { guard: extra.guardFor(dir)! } : {});
    // Written before the tag is made, so a restart right after it finds the tag and knows it is this release's.
    note({ base, commit: git(dir, ['rev-parse', 'HEAD']), ...(release.addons.tag ? { tag: version } : {}) });

    if (release.addons.tag) {
      // A tag needs a name like a commit does: the same fallback when this computer has none set.
      git(dir, [...commitArgsFor(dir), 'tag', '-f', '-a', version, '-m', `Release ${version}`]);
      log.push({ ok: true, text: `Tagged ${version}` });
    }
    // The tag has the release without the work taken out of it; the base gets that work back right after.
    if (reverts.length) bringBack(dir, reverts, version, base);

    const head = git(dir, ['rev-parse', 'HEAD']);
    note({ base, head });
    // What reached the remote: the release itself, or the release merged with a teammate's newer work.
    let sent = head;
    if (remote) {
      try {
        sent = await pushRelease(dir, remote, base, version, release.notes, host, env, log);
        note({ base, head: sent, pushed: true });
        if (release.addons.tag) netGit(dir, ['push', '-f', remote, `refs/tags/${version}`], { env });
        log.push({ ok: true, text: `Pushed ${base}${release.addons.tag ? ` and ${version}` : ''} to ${remote}` });
      } catch (err) {
        const error = (err as Error).message;
        const plain = pushWords(error);
        // The release commit and tag are kept here: Push again sends them once the remote takes them.
        unpushed = { repo: repo.path, remote, base, commit: head, ...(release.addons.tag ? { tag: version } : {}), error: pushDetail(error, { remote, base, version }), plain };
        log.push({ ok: false, text: `${plain} Press Push again, or run: squad release ${version} --push-again` });
      }
    } else {
      log.push({ ok: false, text: 'No git remote is set, so nothing was pushed. Add one with: git remote add origin <url>' });
    }

    moveLocalBase(root, base, sent, version, keep, log);
    note({ base, moved: true });

    if (release.addons.pipeline) {
      const deploy = repo.commands.deploy?.trim() || deployFallback?.trim();
      if (deploy) {
        try {
          // What reached the remote, with a teammate's newer work when it went out together with that.
          if (sent !== head) git(dir, ['checkout', '--quiet', '--detach', sent]);
          const r = await runCommand(dir, deploy, 20 * 60_000, extra.guardFor?.(dir) ? { guard: extra.guardFor!(dir)! } : {});
          log.push({ ok: r.ok, text: r.ok ? `Ran the pipeline: ${deploy}` : `Pipeline failed: ${tail(r.output, 3)}` });
        } catch (err) {
          // The release is out by now: this stops only the pipeline.
          log.push({ ok: false, text: `Pipeline did not run: ${(err as Error).message}` });
        }
      } else {
        log.push({ ok: false, text: 'No pipeline command is set up in Settings, so no pipeline ran' });
      }
    }
  } finally {
    removeWorktree(root, dir);
  }
  // The release's own branch is done with once the release is out and the local base has it. It stays when the push
  // failed (Push again) or the base did not move (the log says to merge it).
  const tip = git(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { allowFail: true });
  if (!unpushed && tip && isAncestor(root, tip, base)) git(root, ['branch', '-D', branch], { allowFail: true });

  for (const t of tickets) if (t.worktree) removeWorktree(root, t.worktree);
  return { log, ...(unpushed ? { unpushed } : {}) };
}

/**
 * Moves the local base branch to the release, without disturbing work in progress. It moves only from where it was:
 * work accepted into the base while the release went out is not in the release, so then the release is merged into
 * the base instead of taking its place.
 */
export function moveLocalBase(root: string, base: string, head: string, version: string, keep: string | undefined, log: ReleaseLog, again = false): void {
  const branch = `release/${version}`;
  const before = git(root, ['rev-parse', base]);
  if (!isAncestor(root, before, head)) {
    try {
      const r = mergeIntoBase(root, base, head, `Merge release ${version} into ${base}`, keep);
      log.push(
        r.moved
          ? { ok: true, text: `${base} has work accepted while the release went out, so the release was merged into it` }
          : { ok: false, text: r.note ?? `Your ${base} checkout was not updated. Run: git merge ${branch}` },
      );
    } catch (err) {
      const why = err instanceof MergeClash ? `it has work accepted while the release went out, and the two clash` : (err as Error).message;
      log.push({ ok: false, text: `${base} on this computer was not moved: ${why}. Run: git merge ${branch}` });
    }
    return;
  }
  if (currentBranch(root) === base) {
    // squad-kit's own .squad/ files do not count: they are kept as they are while the checkout moves.
    const dirty = git(root, ['status', '--porcelain', '--untracked-files=no', '--', '.', ...(keep ? [`:(exclude)${keep}`] : [])], { allowFail: true });
    if (dirty) log.push({ ok: false, text: `Your ${base} checkout has changes, so it was not updated. Run: git merge ${branch}` });
    else {
      try {
        keepingFiles(root, keep, before, head, () => git(root, ['merge', '--ff-only', head]));
        log.push({ ok: true, text: `Your ${base} checkout now has the release` });
      } catch (err) {
        // Usually untracked files in the checkout that the release also adds.
        log.push({
          ok: false,
          text: `Your ${base} checkout was not updated (${(err as Error).message.replace(/^git merge failed: /, '')}). Run: git merge --ff-only ${head.slice(0, 8)}`,
        });
      }
    }
    return;
  }
  try {
    // Only if it is still where it was: a merge on accept in between moves it, and then the release is merged in.
    git(root, ['update-ref', `refs/heads/${base}`, head, before]);
  } catch (err) {
    if (!again) return moveLocalBase(root, base, head, version, keep, log, true);
    log.push({ ok: false, text: `${base} on this computer was not moved (${(err as Error).message}). Run: git merge ${branch}` });
  }
}

/**
 * Push again: sends the release commits and tags that did not reach their remote. What still fails stays in the
 * result, with git's reason.
 */
export async function pushAgain(bp: BoardPaths, release: Release): Promise<ReleaseResult> {
  const root = projectRoot(bp);
  const list = release.unpushed ?? [];
  const multi = list.length > 1 || Boolean(readMeta(bp).repos?.length);
  const log: ReleaseLog = [];
  const unpushed: UnpushedRelease[] = [];
  for (const u of list) {
    const repoRoot = path.join(root, u.repo);
    const url = git(repoRoot, ['config', '--get', `remote.${u.remote}.url`], { allowFail: true });
    const host = url ? repoHostFor(bp, url) : null;
    const env = host?.gitEnv() ?? {};
    const lines: ReleaseLog = [];
    try {
      // A later release may have taken this commit to the remote already: then only the tag is left to send.
      netGit(repoRoot, ['fetch', u.remote, u.base], { env, allowFail: true });
      const there = git(repoRoot, ['rev-parse', '--verify', '-q', `refs/remotes/${u.remote}/${u.base}`], { allowFail: true });
      if (!there || !isAncestor(repoRoot, u.commit, there)) {
        const sent = await pushRelease(repoRoot, u.remote, u.base, release.version, release.notes, host, env, lines, u.commit);
        // Merged with a teammate's newer work: the local base gets that merge too.
        if (sent !== u.commit) moveLocalBase(repoRoot, u.base, sent, release.version, keepOf(bp, repoRoot), lines);
      }
      if (u.tag) netGit(repoRoot, ['push', '-f', u.remote, `refs/tags/${u.tag}`], { env });
      lines.push({ ok: true, text: `Pushed ${u.base}${u.tag ? ` and ${u.tag}` : ''} to ${u.remote}` });
    } catch (err) {
      const error = (err as Error).message;
      const plain = pushWords(error);
      unpushed.push({ ...u, error: pushDetail(error, { remote: u.remote, base: u.base, version: release.version }), plain });
      lines.push({ ok: false, text: plain });
    }
    log.push(...lines.map((l) => (multi ? { ...l, text: `${u.repo}: ${l.text}` } : l)));
  }
  return { log, unpushed };
}

/** Where a project's `.squad/` sits inside a repo, so a checkout that moves keeps its newer files. */
function keepOf(bp: BoardPaths, repoRoot: string): string | undefined {
  const keep = path.relative(repoRoot, bp.squadDir);
  return keep && !keep.startsWith('..') ? keep : undefined;
}

/** A teammate's newer work changes the same lines as the release: a person settles it. The words are plain already. */
export class PushClash extends Error {}

/** The remote has work this computer does not have: the only refusal a merge can settle. */
function isBehind(message: string): boolean {
  return /fetch first|fast-forward|Updates were rejected|before pushing again|tip of your current branch is behind/i.test(message);
}

/** The remote does not take direct pushes to this branch. */
function isProtected(message: string): boolean {
  return /protected branch|GH00\d|GH013|remote rejected|pre-receive hook declined|through a pull request|merge request/i.test(message);
}

/** What a person calls the place a release goes to: its branch and remote names are for the engineer's line. */
const SHARED_COPY = "your team's shared copy of the code";

/**
 * One plain sentence for a push that failed, for the person and the release's log. git's own words stay beside it, for
 * engineers.
 */
export function pushWords(message: string): string {
  if (/same lines as this release/.test(message)) return message.split('\n')[0]!;
  if (isProtected(message)) return `The shared copy of the code only takes changes after a review, and squad-kit cannot ask for one there. The release is safe on this computer. An engineer can see what to do below. Press Push again once it is in.`;
  if (/could not resolve|could not read from remote|does not appear to be|repository exists|unable to access|connection|timed out|gave up after|network|host key/i.test(message)) return `squad-kit could not reach ${SHARED_COPY}, so the release is only on this computer. Check the connection, then press Push again.`;
  if (/authentication failed|permission denied|could not read username|\b40[13]\b/i.test(message)) return `The shared copy of the code did not accept this computer's sign-in, so the release is only on this computer. Check the sign-in, then press Push again.`;
  return `The shared copy of the code did not take the release, so it is only on this computer. An engineer can see why below. Press Push again once that is settled.`;
}

/** The engineer's line beside those words: where it was going, git's own words, and what to do where the plain sentence leaves it out. */
export function pushDetail(message: string, at: { remote: string; base: string; version: string }): string {
  if (/same lines as this release/.test(message)) return message.split('\n').slice(1).join('\n');
  if (isProtected(message)) return `${at.base} on ${at.remote}: ${message}\nThe release is on the branch release/${at.version}: open a pull request from it into ${at.base}.`;
  return `${at.base} on ${at.remote}: ${message}`;
}

/**
 * Whether a release's commit is on its remote, as the remote says now. Not there also covers a merge that squashed it:
 * the caller warns, and a person decides. No answer means squad-kit could not ask.
 */
export async function onTheRemote(bp: BoardPaths, u: UnpushedRelease): Promise<{ there: 'yes' | 'no' | 'no-answer'; why?: string }> {
  const repoRoot = path.join(projectRoot(bp), u.repo);
  const url = git(repoRoot, ['config', '--get', `remote.${u.remote}.url`], { allowFail: true });
  const env = url ? (repoHostFor(bp, url)?.gitEnv() ?? {}) : {};
  try {
    await netGitLater(repoRoot, ['fetch', '--quiet', u.remote, u.base], { env, timeoutMs: 30_000 });
  } catch (err) {
    return { there: 'no-answer', why: (err as Error).message };
  }
  return { there: isAncestor(repoRoot, u.commit, 'FETCH_HEAD') ? 'yes' : 'no' };
}

/**
 * A teammate pushed the base while the release was on this computer. Their work and the release go together in one
 * merge commit that no branch points at. Nothing is forced, and a clash stops here for a person to settle.
 */
function mergeWithNewer(dir: string, remote: string, base: string, commit: string, version: string, env: Record<string, string>): string {
  netGit(dir, ['fetch', remote, base], { env });
  const newer = git(dir, ['rev-parse', 'FETCH_HEAD']);
  if (isAncestor(dir, commit, newer)) return newer;
  let tree: string;
  try {
    tree = git(dir, ['merge-tree', '--write-tree', newer, commit]).split('\n')[0]!.trim();
  } catch {
    // The first line is for the person; the rest is the engineer's line (pushDetail).
    throw new PushClash(`A teammate's newer work in ${base} changes the same lines as this release, so it cannot go out by itself. An engineer can see what to do below. Then press Push again.\nMerge them: git fetch ${remote} ${base} && git merge release/${version} && git push ${remote} ${base}`);
  }
  return git(dir, [...commitArgsFor(dir), 'commit-tree', tree, '-p', newer, '-p', commit, '-m', `Merge ${remote}/${base} into release ${version}`]);
}

/**
 * Push the release commit (`ref`, the release worktree's HEAD by default) to the base branch, and say which commit got
 * there. When a teammate pushed the base in the meantime, the release is merged with their work first. When the branch
 * only accepts pull requests, the release commit goes through its own small PR, which is merged at once.
 */
async function pushRelease(dir: string, remote: string, base: string, version: string, notes: string, host: RepoHost | null, env: Record<string, string>, log: ReleaseLog, ref = 'HEAD'): Promise<string> {
  let sending = git(dir, ['rev-parse', ref]);
  const branch = `release/${version}`;
  for (let tries = 0; ; tries += 1) {
    try {
      netGit(dir, ['push', remote, `${sending}:refs/heads/${base}`], { env });
      return sending;
    } catch (err) {
      const why = (err as Error).message;
      if (tries < 2 && isBehind(why)) {
        sending = mergeWithNewer(dir, remote, base, sending, version, env);
        if (!tries) log.push({ ok: true, text: `${base} on ${remote} had newer work from a teammate, so the release was merged with it` });
        continue;
      }
      if (!host || !host.refusedPush(why)) {
        // No way to open a pull request here: the release waits on its own branch, for an engineer to open one.
        if (isProtected(why)) netGit(dir, ['push', '-f', remote, `${sending}:refs/heads/${branch}`], { env, allowFail: true });
        throw err;
      }
      break;
    }
  }
  netGit(dir, ['push', '-f', remote, `${sending}:refs/heads/${branch}`], { env });
  const pr = (await host.findPullRequest(branch)) ?? (await host.openPullRequest({ source: branch, target: base, title: `Release ${version}`, description: notes, items: [] }));
  await host.merge(pr.id, `Release ${version}`);
  log.push({ ok: true, text: `${base} only takes pull requests, so the release went through pull request ${pr.id}` });
  return sending;
}

function writeChangelog(dir: string, version: string, notes: string): void {
  const file = path.join(dir, 'CHANGELOG.md');
  const date = new Date().toISOString().slice(0, 10);
  const body = notes
    .split('\n')
    .filter((l) => !l.startsWith('### '))
    .join('\n')
    .trim();
  const section = `## ${version.replace(/^v/, '')} (${date})\n\n${body}\n`;
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# Changelog\n';
  const [head, ...rest] = current.split(/\n(?=## )/);
  fs.writeFileSync(file, [head!.trimEnd(), '', section, ...rest].join('\n').replace(/\n{3,}/g, '\n\n'), 'utf8');
}
