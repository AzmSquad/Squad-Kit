import type { PullRequest, RepoHost } from '../modules/code-host/types.js';
import { mayPassSoon } from '../modules/errors.js';

/**
 * A release on a branch that only takes pull requests goes through its own pull request (release.ts pushRelease). It is
 * new, so its checks run first: the release waits for them, once and for a while, and merges it then. Past that, it is
 * not sent yet, and Send again merges it once the code host allows it.
 */

/** The longest a release waits for its own pull request, and how often it looks. */
export const RELEASE_PR_WAIT_MS = 10 * 60_000;
const RELEASE_PR_LOOK_MS = 15_000;

/** Tests wait no time. */
export const releasePace = { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };

export async function mergeReleasePr(host: RepoHost, branch: string, base: string, version: string, notes: string): Promise<PullRequest> {
  const pr = (await host.findPullRequest(branch)) ?? (await host.openPullRequest({ source: branch, target: base, title: `Release ${version}`, description: notes, items: [] }));
  const until = Date.now() + RELEASE_PR_WAIT_MS;
  for (;;) {
    const err = await host.merge(pr.id, `Release ${version}`).then(() => null, (e: unknown) => e as Error);
    if (!err) return pr;
    if (!mayPassSoon(err) || Date.now() >= until) throw err;
    await releasePace.sleep(RELEASE_PR_LOOK_MS);
  }
}
