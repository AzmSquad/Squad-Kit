import fs from 'node:fs';
import path from 'node:path';
import { readMeta, type BoardPaths } from '../board/store.js';
import type { Release, Ticket, UnpushedRelease } from '../board/types.js';
import { runCommand, tail } from './checks.js';
import { MergeClash, commitArgsFor, currentBranch, git, isAncestor, keepingFiles, mergeIntoBase, netGit, remotes, removeWorktree, worktreeRoot } from './git.js';
import { projectRoot } from './live.js';
import { repoFor } from './repos.js';
import type { RepoInfo } from '../board/types.js';
import { repoHostFor } from '../modules/registry.js';
import type { RepoHost } from '../modules/code-host/types.js';
import { docsInGit, docsRepo, stageReleaseDocs } from './project-git.js';

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

export function commitTicket(ticket: Ticket): string | null {
  if (!ticket.worktree || !fs.existsSync(ticket.worktree)) return null;
  git(ticket.worktree, ['add', '-A']);
  if (!git(ticket.worktree, ['status', '--porcelain'], { allowFail: true })) return null;
  git(ticket.worktree, [...commitArgsFor(ticket.worktree), 'commit', '-m', `${ticket.title} (${ticket.id})`]);
  return git(ticket.worktree, ['rev-parse', '--short', 'HEAD']);
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
  const plans = [...groups.values()].map(({ repo, tickets: list }) => {
    const repoRoot = path.join(root, repo.path);
    const remote = repo.remote || remotes(repoRoot)[0];
    const url = remote ? git(repoRoot, ['config', '--get', `remote.${remote}.url`], { allowFail: true }) : '';
    const host = url ? repoHostFor(bp, url) : null;
    return { repo, repoRoot, list, host, env: host?.gitEnv() ?? {} };
  });
  // One pull request the host cannot merge would stop the release halfway: look for those first, before anything changes.
  for (const { repo, repoRoot, list, host } of plans) {
    const clashing: string[] = [];
    for (const t of list.filter((x) => host && x.pr?.host === host.host && !x.mergedAt)) {
      if ((await host!.mergeState(t.pr!.id)) === 'clash') clashing.push(t.id);
    }
    if (clashing.length) throw new PullRequestClash(clashing, repo.base || currentBranch(repoRoot));
  }
  for (const { repo, repoRoot, list, host, env } of plans) {
    // The project's shared files go out with the release when `.squad/` sits in this repo (ADR-001).
    const docs = docsInGit(bp) && path.resolve(docsRepo(bp)!) === path.resolve(repoRoot) ? (dir: string) => stageReleaseDocs(bp, dir, release, list) : undefined;
    const keep = path.relative(repoRoot, bp.squadDir);
    const done = await releaseRepo(repoRoot, repo, release, list, meta.commands?.deploy, host, env, docs, keep && !keep.startsWith('..') ? keep : undefined);
    log.push(...done.log.map((l) => (multi ? { ...l, text: `${repo.path}: ${l.text}` } : l)));
    if (done.unpushed) unpushed.push(done.unpushed);
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
  for (const t of viaPr) {
    await host!.merge(t.pr!.id, `Merge ${t.title} (${t.id})`);
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

  try {
    for (const t of tickets) {
      if (!t.branch || t.mergedAt || viaPr.includes(t)) continue;
      try {
        git(dir, [...commitArgsFor(dir), 'merge', '--no-ff', '-m', `Merge ${t.title} (${t.id})`, t.branch]);
        log.push({ ok: true, text: `Merged ${t.id} ${t.title}` });
      } catch (err) {
        git(dir, ['merge', '--abort'], { allowFail: true });
        throw new Error(`${t.id} clashes with other changes in ${base}, so the release stopped. ${(err as Error).message}`);
      }
    }

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
    git(dir, ['add', '-A']);
    if (git(dir, ['status', '--porcelain'], { allowFail: true })) git(dir, [...commitArgsFor(dir), 'commit', '-m', `release ${version}`]);

    if (release.addons.tag) {
      // A tag needs a name like a commit does: the same fallback when this computer has none set.
      git(dir, [...commitArgsFor(dir), 'tag', '-f', '-a', version, '-m', `Release ${version}`]);
      log.push({ ok: true, text: `Tagged ${version}` });
    }

    const head = git(dir, ['rev-parse', 'HEAD']);
    if (remote) {
      try {
        await pushRelease(dir, remote, base, version, release.notes, host, env, log);
        if (release.addons.tag) netGit(dir, ['push', '-f', remote, `refs/tags/${version}`], { env });
        log.push({ ok: true, text: `Pushed ${base}${release.addons.tag ? ` and ${version}` : ''} to ${remote}` });
      } catch (err) {
        const error = (err as Error).message;
        // The release commit and tag are kept here: Push again sends them once the remote takes them.
        unpushed = { repo: repo.path, remote, base, commit: head, ...(release.addons.tag ? { tag: version } : {}), error };
        log.push({ ok: false, text: `Push to ${remote} failed, so the release is only on this computer: ${error}. Press Push again, or run: squad release ${version} --push-again` });
      }
    } else {
      log.push({ ok: false, text: 'No git remote is set, so nothing was pushed. Add one with: git remote add origin <url>' });
    }

    moveLocalBase(root, base, head, version, keep, log);

    if (release.addons.pipeline) {
      const deploy = repo.commands.deploy?.trim() || deployFallback?.trim();
      if (deploy) {
        const r = await runCommand(dir, deploy, 20 * 60_000);
        log.push({ ok: r.ok, text: r.ok ? `Ran the pipeline: ${deploy}` : `Pipeline failed: ${tail(r.output, 3)}` });
      } else {
        log.push({ ok: false, text: 'No pipeline command is set up in Settings, so no pipeline ran' });
      }
    }
  } finally {
    removeWorktree(root, dir);
  }

  for (const t of tickets) if (t.worktree) removeWorktree(root, t.worktree);
  return { log, ...(unpushed ? { unpushed } : {}) };
}

/**
 * Moves the local base branch to the release, without disturbing work in progress. It moves only from where it was:
 * work accepted into the base while the release went out is not in the release, so then the release is merged into
 * the base instead of taking its place.
 */
function moveLocalBase(root: string, base: string, head: string, version: string, keep: string | undefined, log: ReleaseLog, again = false): void {
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
      if (!there || !isAncestor(repoRoot, u.commit, there)) await pushRelease(repoRoot, u.remote, u.base, release.version, release.notes, host, env, lines, u.commit);
      if (u.tag) netGit(repoRoot, ['push', '-f', u.remote, `refs/tags/${u.tag}`], { env });
      lines.push({ ok: true, text: `Pushed ${u.base}${u.tag ? ` and ${u.tag}` : ''} to ${u.remote}` });
    } catch (err) {
      const error = (err as Error).message;
      unpushed.push({ ...u, error });
      lines.push({ ok: false, text: `Push to ${u.remote} failed again: ${error}` });
    }
    log.push(...lines.map((l) => (multi ? { ...l, text: `${u.repo}: ${l.text}` } : l)));
  }
  return { log, unpushed };
}

/**
 * Push the release commit (`ref`, the release worktree's HEAD by default) to the base branch. When the branch only
 * accepts pull requests, the release commit goes through its own small PR, which is merged at once.
 */
async function pushRelease(dir: string, remote: string, base: string, version: string, notes: string, host: RepoHost | null, env: Record<string, string>, log: ReleaseLog, ref = 'HEAD'): Promise<void> {
  try {
    netGit(dir, ['push', remote, `${ref}:refs/heads/${base}`], { env });
    return;
  } catch (err) {
    if (!host || !host.refusedPush((err as Error).message)) throw err;
  }
  const branch = `release/${version}`;
  netGit(dir, ['push', '-f', remote, `${ref}:refs/heads/${branch}`], { env });
  const pr = (await host.findPullRequest(branch)) ?? (await host.openPullRequest({ source: branch, target: base, title: `Release ${version}`, description: notes, items: [] }));
  await host.merge(pr.id, `Release ${version}`);
  log.push({ ok: true, text: `${base} only takes pull requests, so the release went through pull request ${pr.id}` });
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
