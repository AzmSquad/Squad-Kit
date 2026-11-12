/**
 * A code host: where the project's git repos live. Git itself (ticket copies, commits, merges, tags, push) is the
 * engine's job; a code host module only does what git cannot: pull requests, the sign-in for push, links (ADR-002).
 */

export interface PullRequest {
  id: number;
  url: string;
}

/**
 * Where a pull request stands: ready to merge, merged, clashing with newer changes in the base, waiting, or closed
 * without merging.
 */
export type MergeState = 'mergeable' | 'merged' | 'clash' | 'waiting' | 'closed';

/** One repo on a code host. */
export interface RepoHost {
  /** The module's name, saved on the ticket's pull request. */
  readonly host: string;
  /** For people, for example "Azure Repos". */
  readonly label: string;
  /** The repo's name on the host. */
  readonly repo: string;
  readonly abilities: { attachImages: boolean };
  /** Environment variables that let git push sign in, without writing the token to any git file. */
  gitEnv(): Record<string, string>;
  /** The open pull request from a branch, so a retry does not open a second one. */
  findPullRequest(source: string): Promise<PullRequest | null>;
  /**
   * The newest pull request from a branch, open, merged or closed, so one a person merged on the host is found again.
   * A module without it leaves it out.
   */
  lastPullRequest?(source: string): Promise<PullRequest | null>;
  /** Opens a pull request; items are tracker item ids to link when the host can. Descriptions are Markdown. */
  openPullRequest(input: { source: string; target: string; title: string; description: string; items: string[] }): Promise<PullRequest>;
  /** Uploads an image and returns a link to use in the description. Only when abilities.attachImages. */
  attachImage(prId: number, file: string): Promise<string>;
  updateDescription(prId: number, description: string): Promise<void>;
  mergeState(prId: number): Promise<MergeState>;
  /** Merges with a merge commit and deletes the branch. Resolves once the host has merged it. */
  merge(prId: number, message: string): Promise<{ commit: string }>;
  close(prId: number): Promise<void>;
  /** The push was refused because the branch only takes pull requests. */
  refusedPush(message: string): boolean;
}

export interface CodeHostModule {
  name: string;
  label: string;
  /** The repo behind a git remote URL, or null when it lives elsewhere or no sign-in is saved for the project. */
  repoFor(root: string, remoteUrl: string): RepoHost | null;
}

/**
 * A code host squad-kit opens no pull request on by itself (it has no sign-in for it): it knows only the page where the
 * person opens one, so a merged story can say where to send it (engine/send-as-pr.ts).
 */
export interface PullRequestPageModule {
  readonly name: string;
  /** For people, for example "GitHub". */
  readonly label: string;
  /** "owner/name" of a remote on this host, or null when the remote is elsewhere. */
  repoName(remoteUrl: string): string | null;
  /**
   * The page that opens a pull request of `branch`, pushed to `from`, into `base` of `into` (the same repo, or the one
   * it was copied from). Null when either is not on this host.
   */
  pageFor(o: { from: string; into: string; base: string; branch: string; title: string }): string | null;
}
