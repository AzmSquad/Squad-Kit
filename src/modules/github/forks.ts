import type { ForkHost, HostRepoInfo } from '../code-host/types.js';
import { ModuleError } from '../errors.js';
import { githubApi } from './auth.js';
import { repoName } from './pull-page.js';
import { ghSignIn } from './sign-in.js';
import { infoOf, rawRepo, type RawRepo } from './where.js';

/**
 * A person's own copy (a fork) of someone else's GitHub repo, for the contribution checklist: make it, see how far it
 * is from the repo it came from, bring it up to date by GitHub's own sync, and the page that opens a new issue. squad-kit
 * never deletes a repo or a branch here, and never forces anything.
 */

export interface ForkPace {
  stepMs: number;
  /** Looks at most, one every stepMs: about 3 minutes in all. Counted, never timed, so a busy computer changes nothing. */
  looks: number;
  sleep(ms: number): Promise<void>;
}

const REAL: ForkPace = { stepMs: 3_000, looks: 60, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
let pace = REAL;

/** Tests wait no time. Null goes back to the real pace. */
export function useForkPace(p: Partial<ForkPace> | null): void {
  pace = p ? { ...REAL, ...p } : REAL;
}

const said = (err: unknown) => (err as Error).message.replace(/^GitHub said \d+: /, '');

async function makeFork(repo: string): Promise<HostRepoInfo> {
  let made: RawRepo;
  try {
    made = await githubApi<RawRepo>(`/repos/${repo}/forks`, { method: 'POST', body: { default_branch_only: true } });
  } catch (err) {
    // GitHub says 403 for a repo whose owners allow no copies: that is no sign-in trouble.
    if (err instanceof ModuleError && err.status && err.status !== 401) throw new ModuleError(`GitHub did not make your copy of ${repo}: ${said(err)}. Its owners may not allow copies of it.`, err.status === 403 ? 'other' : err.kind, err.status);
    throw err;
  }
  // GitHub makes the copy in the background: it is ready once its default branch is there.
  for (let look = 1; ; look++) {
    try {
      const r = await rawRepo(made.full_name);
      await githubApi(`/repos/${r.full_name}/branches/${encodeURIComponent(r.default_branch)}`);
      return infoOf(r);
    } catch (err) {
      if (!(err instanceof ModuleError && err.kind === 'not-found') || look >= pace.looks) throw err;
    }
    await pace.sleep(pace.stepMs);
  }
}

async function compareFork(copy: string, parent: string, branch: string): Promise<{ behind: number; ahead: number }> {
  const owner = copy.split('/')[0]!;
  const b = encodeURIComponent(branch);
  const c = await githubApi<{ ahead_by: number; behind_by: number }>(`/repos/${parent}/compare/${b}...${owner}:${b}`);
  return { behind: c.behind_by, ahead: c.ahead_by };
}

async function syncFork(copy: string, branch: string): Promise<void> {
  const parent = (await rawRepo(copy)).parent?.full_name;
  if (!parent) throw new ModuleError(`${copy} is not a copy of another repo on GitHub.`, 'other', 422);
  // GitHub's sync would make a merge commit when the copy has its own changes: squad-kit only moves it forward.
  const { ahead } = await compareFork(copy, parent, branch);
  if (ahead > 0) throw new ModuleError(`${branch} of your copy has ${ahead === 1 ? 'a change' : `${ahead} changes`} that ${parent} does not have, so squad-kit does not bring it up to date by itself.`, 'clash', 409);
  try {
    await githubApi(`/repos/${copy}/merge-upstream`, { method: 'POST', body: { branch } });
  } catch (err) {
    if (err instanceof ModuleError && (err.status === 409 || err.status === 422)) throw new ModuleError(`GitHub could not bring ${branch} of your copy up to date: ${said(err)}`, 'clash', err.status);
    throw err;
  }
}

/** GitHub's own pages and browsers take a link of about 8,000 characters: the words, encoded, stay well under. */
const MOST_LINK = 6000;

function newIssuePage(repo: string, title: string, body: string): { link: string; cut: boolean } {
  const page = (b: string) => `https://github.com/${repo}/issues/new?${new URLSearchParams({ title: title.slice(0, 200), body: b }).toString()}`;
  if (page(body).length <= MOST_LINK) return { link: page(body), cut: false };
  // Cut at a word, shorter until it fits: a long idea's start, with a line that says the rest stays with the person.
  const tail = '\n\n(The rest did not fit in this link. It is in squad-kit: paste it here before you send.)';
  let keep = body.length;
  while (keep > 0 && page(`${body.slice(0, keep)}${tail}`).length > MOST_LINK) {
    const space = body.lastIndexOf(' ', Math.floor(keep * 0.9));
    keep = space > 0 ? space : Math.floor(keep * 0.9);
  }
  return { link: page(`${body.slice(0, keep).trimEnd()}${tail}`), cut: true };
}

export const githubForks: ForkHost = {
  repoName,
  signIn: ghSignIn,
  signInSteps: ["Install GitHub's tool, gh, from cli.github.com.", 'Sign in: open a terminal and run gh auth login.', 'squad-kit then sends your next stories as pull requests by itself.'],
  repoInfo: async (repo) => infoOf(await rawRepo(repo)),
  makeFork,
  compareFork,
  syncFork,
  newIssuePage,
};
