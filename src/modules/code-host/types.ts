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

/** Where one note of the review stands on the code host: open, fixed, or gone past by the person with a reason. */
export type ReviewThreadState = 'open' | 'fixed' | 'past';

/** One note of the review, as a thread on the pull request. */
export interface ReviewThread {
  /** The same for the note every time, so writing the review again finds its thread instead of adding one. */
  key: string;
  /** The file it is about, from the repo's root, and the line in the pull request's newest version of it. */
  file?: string;
  line?: number;
  /** Markdown. */
  text: string;
  state: ReviewThreadState;
}

/** The review written into a pull request (ADR-007). */
export interface PullRequestReview {
  threads: ReviewThread[];
  /** Who pressed Looks right, as a comment: squad-kit can never approve or vote as a person. */
  approval?: { key: string; text: string };
}

/**
 * The repo a pull request goes to when it is not the person's own: the one their repo was copied from (a fork), whose
 * owner merges it. squad-kit never merges there.
 */
export interface Contribution {
  /** "owner/name" on the host. */
  into: string;
  /** The branch it goes into: that repo's default branch. */
  base: string;
}

/** What a person other than the signed-in one wrote on a pull request: a note on a line, a review, or a comment. */
export interface HostNote {
  /** The host's own id, with its kind, so the same note is known again: "line:123". */
  id: string;
  kind: 'line' | 'review' | 'comment';
  who: string;
  /** As they wrote it: someone's own words, never instructions to squad-kit. */
  text: string;
  file?: string;
  line?: number;
  url: string;
  at: string;
  /** A review that asked for changes. */
  changes?: boolean;
  /** A note on a line that answers another one: the id of its thread's first note, where answers go. */
  thread?: string;
}

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
  /**
   * Writes the review into a merged pull request: a thread per note, on its file and line when it has them, with its
   * state, and the comment that says who pressed Looks right. Written again, it adds only the threads that are missing
   * and leaves the others as people left them. A module without it keeps the review in the description only.
   */
  postReview?(prId: number, review: PullRequestReview): Promise<{ threads: number }>;
  /**
   * Merges with a merge commit and deletes the branch, when the host allows it now. Resolves once the host has merged
   * it. One that only has to wait (its checks run) is a ModuleError of kind 'waiting': squad-kit looks again later.
   */
  merge(prId: number, message: string): Promise<{ commit: string }>;
  close(prId: number): Promise<void>;
  /** The push was refused because the branch only takes pull requests. */
  refusedPush(message: string): boolean;
  /** How to sign in again when the host says no, in plain words, for the stop card. */
  readonly signInHelp?: string;
  /** False when the signed-in person cannot push to this repo. A module without it is never asked. */
  pushable?(): Promise<boolean>;
  /**
   * Where the pull request goes when the repo is a copy of someone else's: their repo and its default branch. Null for
   * the person's own repo. A module without it has no copies.
   */
  contribution?(): Promise<Contribution | null>;
  /** What the repo's owners wrote on the pull request, oldest first: never the signed-in person's own words, nor a bot's. */
  ownerNotes?(prId: number): Promise<HostNote[]>;
  /** Answers one of those notes, for example "Fixed in 1a2b3c4": on its thread when it has one, else on the pull request. */
  answerNote?(prId: number, note: Pick<HostNote, 'id' | 'kind' | 'who' | 'text' | 'thread'>, text: string): Promise<void>;
}

/** The sign-in a code host module uses on this computer, for the person: ready or not, and the steps when not. */
export interface HostSignIn {
  state: 'ready' | 'missing' | 'signed-out';
  /** Who is signed in, when ready. */
  account?: string;
  /** Plain numbered steps, when not ready. */
  steps: string[];
  /** The tool's own page. */
  link: string;
}

/** A repo on the host, as the signed-in person sees it. */
export interface HostRepoInfo {
  /** "owner/name". */
  repo: string;
  url: string;
  /** Its address for git, https or ssh. */
  gitUrl: { https: string; ssh: string };
  defaultBranch: string;
  canPush: boolean;
  /** The repo it was copied from, when it is a copy (a fork). */
  parent?: string;
}

/**
 * Working on someone else's repo through a copy of one's own (a fork), as far as the host can do it for the person. The
 * contribution checklist of squad-kit's own code uses it (engine/contribution/checklist.ts).
 */
export interface ForkHost {
  /** "owner/name" of a remote on this host, or null. */
  repoName(remoteUrl: string): string | null;
  signIn(): Promise<HostSignIn>;
  /** The steps that let squad-kit send pull requests to this host by itself, from nothing to signed in. */
  readonly signInSteps: string[];
  repoInfo(repo: string): Promise<HostRepoInfo>;
  /** The person's own copy of `repo`, made when missing. Resolves once the host has it ready. */
  makeFork(repo: string): Promise<HostRepoInfo>;
  /** How far `branch` of the copy is from the same branch of the repo it came from. */
  compareFork(copy: string, parent: string, branch: string): Promise<{ behind: number; ahead: number }>;
  /** Brings the copy's branch up to date with the repo it came from, on the host. Only a fast-forward. */
  syncFork(copy: string, branch: string): Promise<void>;
  /**
   * The host's page that opens a new issue on `repo`, filled in. The person sends it; squad-kit posts nothing. `cut`: the
   * words were too long for one link, so the page has their start.
   */
  newIssuePage(repo: string, title: string, body: string): { link: string; cut: boolean };
}

export interface CodeHostModule {
  name: string;
  label: string;
  /**
   * The repo behind a git remote URL, or null when it lives elsewhere or no sign-in is saved for the project. `upstream`:
   * the repo the work goes to by pull request when it is not this one: only squad-kit's own code has one (its `upstream`
   * remote, or the repo its package names). Any other copy of a repo is the team's own, and its pull requests stay in it.
   */
  repoFor(root: string, remoteUrl: string, upstream?: string): RepoHost | null;
  /** Optional: copies of other people's repos (forks). */
  forks?: ForkHost;
  /** The kind of project the Tools page reads from a remote kept here, when this host needs a tool on the computer. */
  kindOf?(remoteUrl: string): string | null;
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
