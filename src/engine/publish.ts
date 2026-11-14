import fs from 'node:fs';
import path from 'node:path';
import { addActivity, now, requireTicket, updateTicket, type BoardPaths } from '../board/store.js';
import type { Ticket } from '../board/types.js';
import { StepError } from '../board/problem.js';
import { CHECKOUT_WAITS } from '../board/actions/accept.js';
import { PR_HOST_WAITS } from '../board/auto.js';
import { clearStaleStop } from '../board/stale-stop.js';
import { forkHostFor, trackerFor } from '../modules/registry.js';
import type { RepoHost } from '../modules/code-host/types.js';
import { ModuleError, mayPassSoon } from '../modules/errors.js';
import { MergeClash, baseTurn, fetchedTip, moveBase, netGitLater } from './git.js';
import { itemId, localSetupFor, mapAfterMerge, mergeLocally, noteOn, prItem, repoTarget, resolveItem, saidToEngineers, squadInside, targetHost } from './sync.js';
import { sentToOwner } from './contribution/send.js';
import { prDescription } from './review-record/pr-description.js';
import { writeReview } from './review-record/write.js';

/**
 * Looks right on a repo with a code host: push the story's branch, open its pull request (or find it again), and try
 * the merge once. Checks still running, or an approval a branch rule asks for, is a wait the squad looks at again by
 * itself (board/auto.ts mergeWait), so this step never holds a building place for it. squad-kit's own code sends its
 * pull request to the main repo, whose owner merges it (engine/contribution). A repo the person cannot push to merges on
 * this computer, as with no code host, and says why.
 */

type Target = NonNullable<ReturnType<typeof repoTarget>>;

/** A code host that said no to the sign-in, or a push it refused for one: the stop says how to sign in again. */
function signInStop(err: unknown, host: RepoHost): StepError | null {
  const msg = (err as Error)?.message ?? '';
  // A 403 is a code host's no to this one thing (a rule, a right), not a sign-in.
  const sign = err instanceof ModuleError ? err.kind === 'sign-in' && err.status !== 403 : /Authentication failed|could not read Username|Invalid username or password/i.test(msg);
  if (!sign) return null;
  return new StepError(`squad-kit could not sign in to ${host.label}, so the pull request did not open. ${host.signInHelp ?? 'Check the sign-in in Settings.'} Then press Try again.`, msg);
}

/** No sign-in on this computer for the host the repo is kept on: the stop gives its steps. */
async function notSignedIn(target: Target): Promise<StepError | null> {
  const host = forkHostFor(target.url);
  if (!host) return null;
  const s = await host.forks.signIn();
  if (s.state === 'ready') return null;
  return new StepError(`squad-kit is not signed in to ${host.label} on this computer, so it cannot send the pull request. ${s.steps.map((step, i) => `${i + 1}. ${step}`).join(' ')}`);
}

/**
 * Push the ticket's branch and open a PR to the base branch, linked to the tracker item, with the proof screenshots.
 * Safe to run again: it reuses the open PR for the branch.
 */
export async function publishTicket(bp: BoardPaths, ticketId: string): Promise<{ clash: boolean }> {
  const t = requireTicket(bp, ticketId);
  const target = repoTarget(bp, t);
  const host = target && targetHost(bp, target);
  const none = 'This ticket has no code host with a saved sign-in to open a pull request with.';
  if (!target || !t.branch) throw new Error(none);
  if (!host) throw (await notSignedIn(target)) ?? new Error(none);
  try {
    return await publishTo(bp, t, target, host);
  } catch (err) {
    throw signInStop(err, host) ?? err;
  }
}

/** A repo the person cannot push to: the story merges on this computer, as with no code host, and says why. */
function mergeHere(bp: BoardPaths, id: string, why: string): { clash: boolean } {
  let r: ReturnType<typeof mergeLocally>;
  try {
    r = mergeLocally(bp, requireTicket(bp, id));
  } catch (err) {
    if (err instanceof MergeClash) return { clash: true };
    throw err;
  }
  updateTicket(bp, id, (x) => {
    x.live = false;
    x.squad = null;
    x.progress = undefined;
    if (r?.moved) {
      x.mergedAt = now();
      clearStaleStop(x);
      const ls = localSetupFor(bp, x);
      if (ls) x.localSetup = ls;
      x.status = `Merged into ${r.base} · goes out in ${x.release ?? 'the next release'}`;
    } else x.status = CHECKOUT_WAITS;
    addActivity(x, 'release', why);
  });
  if (r?.moved) mapAfterMerge(bp);
  return { clash: false };
}

async function publishTo(bp: BoardPaths, t: Ticket, target: Target, host: RepoHost): Promise<{ clash: boolean }> {
  const ticketId = t.id;
  const branch = t.branch!;
  const env = await host.gitEnv();
  // squad-kit's own code: the main repo, whose owner merges it, never squad-kit (engine/contribution).
  const into = (await host.contribution?.()) ?? null;
  if (host.pushable && !(await host.pushable())) {
    if (into || target.upstream) throw new StepError(`You can't send changes to ${host.repo} itself. Make your own copy of it first (squad contribute --fork), then press Try again.`);
    return mergeHere(bp, ticketId, `${host.label} says you can't push to ${host.repo}, so squad-kit merged it on this computer instead, as it does with no code host. It goes out with the release`);
  }

  // A brand-new repo has no base branch yet, and a PR needs one to point at.
  const remoteBase = into ? 'there' : await netGitLater(target.dir, ['ls-remote', '--heads', target.remote, target.base], { allowFail: true, env });
  if (!remoteBase) {
    await netGitLater(target.dir, ['push', target.remote, `${target.base}:refs/heads/${target.base}`], { env });
    noteOn(bp, ticketId, `Sent the first code to ${host.label}, which was empty`);
  }
  // Never forced: when someone else's work is on that branch (the ticket was taken back from them), it stays there.
  try {
    await netGitLater(t.worktree ?? target.dir, ['push', target.remote, `${branch}:refs/heads/${branch}`], { env });
  } catch (err) {
    if (/rejected|fast-forward|fetch first|before pushing again/i.test((err as Error).message)) throw new StepError(`${target.remote} has newer work on this ticket from someone else, and squad-kit does not write over it. Bring in their work, then press Try again.`, (err as Error).message);
    throw err;
  }

  const tracker = trackerFor(bp);
  const item = tracker ? itemId(t, tracker) : null;
  // The item as its tracker names it, with the line that has the code host close it when the pull request merges.
  const words = prItem(tracker, item, into?.into ?? host.repo);
  // The owner of the main repo reads the review while reviewing: it goes in the description, note by note.
  const describe = (shots: { label: string; url: string }[]) => prDescription(t, words, shots, { notes: Boolean(into) });
  let pr = await host.findPullRequest(branch);
  // Found again (a fix sent to the same pull request, or a retry): its description gets the newest record.
  const found = Boolean(pr);
  if (!pr) pr = await host.openPullRequest({ source: branch, target: target.base, title: t.title, description: describe([]), items: item ? [item] : [] });
  // Screenshots go into the PR so reviewers see the proof where they review the code.
  const shots: { label: string; url: string }[] = [];
  // Each "done when"'s main picture first, then its others while there is room.
  const rows = t.proof ?? [];
  const pictures = [...rows.map((p) => ({ label: p.criterion, after: p.after })), ...rows.flatMap((p) => (p.more ?? []).map((m) => ({ label: p.criterion, after: m.after })))].slice(0, 6);
  // One picture often proves two "done when"s: it goes up once, and its link shows in each of them. The host refuses
  // the same name twice (Azure does), which would leave the second row with no picture.
  const sent = new Map<string, string | null>();
  for (const shot of host.abilities.attachImages ? pictures : []) {
    const file = path.join(bp.proofDir, shot.after);
    if (!shot.after || !fs.existsSync(file)) continue;
    if (!sent.has(file)) sent.set(file, await host.attachImage(pr.id, file).catch(() => null));
    const url = sent.get(file);
    // A missing screenshot should not block the PR.
    if (url) shots.push({ label: shot.label, url });
  }
  if (shots.length || found) await host.updateDescription(pr.id, describe(shots));

  const opened = pr;
  updateTicket(bp, ticketId, (x) => {
    x.pr = { id: opened.id, url: opened.url, repo: into?.into ?? host.repo, host: host.host };
    // The clash it had is settled, or a new pull request took the place of a closed one.
    delete x.clashedPr;
    delete x.prClosed;
    x.status = `Merging pull request ${opened.id}`;
    if (!into) addActivity(x, 'release', `Opened pull request ${opened.id} on ${host.label}`);
  });
  if (into) {
    const sentTo = await sentToOwner(bp, ticketId, host, opened, into, { dir: t.worktree ?? target.dir, branch, base: target.base, remote: target.remote });
    // The owner merges it, so the item is resolved but stays open until they do (engine/contribution/look.ts).
    if (!found) await resolveItem(bp, ticketId, tracker, item, false, `Pull request [${opened.id}](${opened.url}) is open in ${into.into} with the proof, waiting for its owner to merge it.`);
    return sentTo;
  }

  // Merge on accept, when the host allows it now: the change goes into the base branch, so the next tickets build on it.
  let merged = false;
  let movedLocal = false;
  let why = '';
  let clash = false;
  let waits = false;
  let held = false;
  try {
    await host.merge(opened.id, `Merge ${t.title} (${t.id})`);
    merged = true;
    const head = await fetchedTip(target.dir, target.remote, target.base, { env });
    const local = await baseTurn(target.dir, () => moveBase(target.dir, target.base, head, squadInside(bp, target.dir)));
    if (local.note) saidToEngineers(bp, ticketId, local.note);
    movedLocal = local.moved;
  } catch (err) {
    why = (err as Error).message;
    // Checks still running, a connection that dropped, a busy service: the squad looks again by itself and merges then.
    waits = mayPassSoon(err);
    held = err instanceof ModuleError && err.kind === 'waiting';
    // Newer changes in the base clash with it: that needs the clash card (the caller gives it), not a wait on the host.
    clash = !waits && (err instanceof ModuleError && err.kind === 'clash' ? true : (await host.mergeState(opened.id).catch(() => null)) === 'clash');
  }
  updateTicket(bp, ticketId, (x) => {
    x.live = false;
    x.squad = null;
    x.progress = undefined;
    if (merged) {
      x.mergedAt = new Date().toISOString();
      // Merged: a stop it went past (a clash it settled, a pull request that did not open) is over.
      clearStaleStop(x);
      const ls = movedLocal ? localSetupFor(bp, x) : undefined;
      if (ls) x.localSetup = ls;
      x.status = `Merged into ${target.base} · goes out in ${x.release ?? 'the next release'}`;
      addActivity(x, 'release', `Merged pull request ${opened.id} into ${target.base}`);
    } else if (waits) {
      // The squad looks again every few minutes and merges it then (sync.ts recheckMerge): nothing holds a place meanwhile.
      x.status = PR_HOST_WAITS;
      const said = held ? why : `Pull request ${opened.id} is open, not merged yet: ${why.replace(/\.?$/, '.')}`;
      addActivity(x, 'release', `${said} squad-kit looks again every few minutes and merges it then`);
    } else if (!clash) {
      x.status = `PR ${opened.id} is waiting in ${host.label} · ${x.release ?? 'next release'}`;
      addActivity(x, 'release', `Pull request ${opened.id} is open but not merged yet: ${why}`);
    }
  });
  if (merged) mapAfterMerge(bp);
  // The review goes in once the pull request is merged, so a thread can never hold it up. A pull request that waits
  // gets it when its merge is seen (recheckMerge, merged-outside.ts).
  if (merged) await writeReview(bp, ticketId, host, opened);

  // A clash is not done yet: the item stays where it is until the ticket is accepted again. One that waits on the code
  // host is resolved but stays open until the merge (sync.ts recheckMerge, merged-outside.ts tell the tracker then).
  if (!clash) {
    await resolveItem(
      bp,
      ticketId,
      tracker,
      item,
      merged,
      merged
        ? `Merged into **${target.base}** by pull request [${opened.id}](${opened.url}), with the proof. It goes out in the next release.`
        : `Pull request [${opened.id}](${opened.url}) is open with the proof, waiting to be merged in ${host.label}.`,
    );
  }
  return { clash };
}
