import fs from 'node:fs';
import path from 'node:path';
import { readMeta, type BoardPaths } from '../board/store.js';
import type { Ticket } from '../board/types.js';
import { forkHostFor, pullRequestPageFor } from '../modules/registry.js';
import { git } from './git.js';
import { repoFor } from './repos.js';
import { isSquadKitCode } from './self-project.js';
import { shellArg } from '../utils/text.js';

/**
 * A merged story on squad-kit's own code, whose work goes on by pull request: its maintainers release it, never this
 * computer. It merged into the base here and its branch is kept, and no code host module opened a pull request for it.
 * The story says how to send it: push the branch, then open the request on the host's own page, into the repo it was
 * copied from (the `upstream` remote, or else the repo its package names). Any other project's work goes out with its
 * own release, so it gets none of this. squad-kit pushes nothing itself here: the person runs the push, with their own
 * sign-in. With the host's tool signed in, squad-kit sends the pull request itself instead (engine/contribution), so
 * this box is the way when it is not: it also says how to let squad-kit do it next time.
 */

export interface SendAs {
  branch: string;
  /** The git remote the branch goes to: the person's own copy of the repo. */
  remote: string;
  /** The one command that pushes the branch, run in the person's own folder. */
  push: string;
  /** Where that command runs. */
  dir: string;
  /** The host's page that opens the pull request, when squad-kit knows the host. */
  page?: string;
  /** The host, for people: "GitHub". */
  host?: string;
  /** The repo the pull request goes to, "owner/name", when it is not the person's own copy. */
  into?: string;
  /** How to let squad-kit send the next ones itself: the host's tool and its sign-in, step by step. */
  letSquadKit?: string[];
}

/** A remote's address, or '' when there is none. */
function remoteUrl(dir: string, name: string): string {
  return git(dir, ['config', '--get', `remote.${name}.url`], { allowFail: true }).trim();
}

/** The repo squad-kit's own package says it comes from, as a git address. */
function packageRepo(dir: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { repository?: string | { url?: string } };
    const url = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? '');
    return url.replace(/^git\+/, '');
  } catch {
    return '';
  }
}

/**
 * How to send a merged story as a pull request, or null: another project, a story with a pull request already, one not
 * merged on this computer, or one released.
 */
export function sendAsOf(bp: BoardPaths, t: Ticket): SendAs | null {
  if (!t.mergedAt || t.pr || !t.branch || t.stage === 'done') return null;
  const meta = readMeta(bp);
  if (meta.engine !== 'live') return null;
  const repo = repoFor(meta, t);
  const dir = path.join(bp.root, repo.path);
  try {
    if (!git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${t.branch}`], { allowFail: true }).trim()) return null;
  } catch {
    return null;
  }
  if (!isSquadKitCode(dir)) return null;
  const remote = repo.remote || 'origin';
  const from = remoteUrl(dir, remote);
  if (!from) return null;
  const into = remoteUrl(dir, 'upstream') || packageRepo(dir) || from;
  const host = pullRequestPageFor(from);
  const page = host?.pageFor({ from, into, base: repo.base, branch: t.branch, title: `${t.title}` }) ?? undefined;
  const target = host?.repoName(into);
  const steps = forkHostFor(from)?.forks.signInSteps;
  return {
    branch: t.branch,
    remote,
    push: `git push ${shellArg(remote)} ${shellArg(t.branch)}`,
    dir,
    ...(page ? { page } : {}),
    ...(host ? { host: host.label } : {}),
    ...(target && target.toLowerCase() !== host?.repoName(from)?.toLowerCase() ? { into: target } : {}),
    ...(steps ? { letSquadKit: steps } : {}),
  };
}
