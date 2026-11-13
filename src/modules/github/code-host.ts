import type { CodeHostModule, Contribution, HostNote, MergeState, PullRequest, PullRequestReview, RepoHost } from '../code-host/types.js';
import { ModuleError } from '../errors.js';
import { githubForks } from './forks.js';
import { mergePull, pullState } from './merge.js';
import { answerOwnerNote, ownerNotesOf } from './owner-notes.js';
import { repoName } from './pull-page.js';
import { closePull, describePull, findPull, openPull } from './pulls.js';
import { postReviewComments } from './review-comments.js';
import { SIGN_IN_HELP, ghState } from './sign-in.js';
import { whereOf } from './where.js';

/**
 * GitHub as a squad-kit code host, signed in through GitHub's own tool, gh. Pull requests of the team's own repo (a fork
 * too) are opened and merged like any code host's. Only when the engine names an upstream (squad-kit's own code) does the
 * pull request go to that repo, where its owner merges: squad-kit never merges there.
 */

/**
 * git push signs in through gh's own credential helper, for https addresses of github.com only: the other helpers are
 * set aside for it, and nothing is written to any file. An ssh address uses the person's own keys, as always.
 */
const GIT_ENV: Record<string, string> = {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
  GIT_CONFIG_VALUE_0: '',
  GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
  GIT_CONFIG_VALUE_1: '!gh auth git-credential',
};

class GitHubRepo implements RepoHost {
  readonly host = 'github';
  readonly label = 'GitHub';
  // GitHub has no way to upload a picture for a pull request from outside its own pages: the pictures stay on the
  // board (ADR-008).
  readonly abilities = { attachImages: false };
  readonly signInHelp = SIGN_IN_HELP;

  constructor(
    /** "owner/name" of the remote. */
    readonly repo: string,
    private readonly upstream?: string,
  ) {}

  private where() {
    return whereOf(this.repo, this.upstream);
  }

  private async prRepo(): Promise<string> {
    return (await this.where()).repo;
  }

  gitEnv(): Record<string, string> {
    return { ...GIT_ENV };
  }

  async pushable(): Promise<boolean> {
    return (await this.where()).push;
  }

  async findPullRequest(source: string): Promise<PullRequest | null> {
    return findPull(await this.where(), source, 'open');
  }

  async lastPullRequest(source: string): Promise<PullRequest | null> {
    return findPull(await this.where(), source, 'all');
  }

  /** Into the upstream's default branch when there is one, whatever this repo's base is called. */
  async openPullRequest(input: { source: string; target: string; title: string; description: string; items: string[] }): Promise<PullRequest> {
    const w = await this.where();
    return openPull(w, { source: input.source, base: w.into?.base ?? input.target, title: input.title, description: input.description });
  }

  attachImage(): Promise<string> {
    return Promise.reject(new ModuleError('GitHub takes no pictures for a pull request from squad-kit.', 'other', 405));
  }

  async updateDescription(prId: number, description: string): Promise<void> {
    await describePull(await this.prRepo(), prId, description);
  }

  async mergeState(prId: number): Promise<MergeState> {
    return pullState(await this.prRepo(), prId);
  }

  async postReview(prId: number, review: PullRequestReview): Promise<{ threads: number }> {
    return postReviewComments(await this.prRepo(), prId, review);
  }

  async merge(prId: number, message: string): Promise<{ commit: string }> {
    const w = await this.where();
    if (w.into) throw new ModuleError(`Pull request ${prId} is in ${w.into.repo}: its owner merges it, never squad-kit.`, 'other', 405);
    return mergePull(w.repo, prId, message);
  }

  async close(prId: number): Promise<void> {
    await closePull(await this.prRepo(), prId);
  }

  refusedPush(message: string): boolean {
    // GitHub's own branch protection and rules, and a server hook of GitHub Enterprise that turns direct pushes away.
    return /GH006|protected branch|hook declined|refusing to allow|push declined|rule violations/i.test(message);
  }

  async contribution(): Promise<Contribution | null> {
    const w = await this.where();
    return w.into ? { into: w.into.repo, base: w.into.base } : null;
  }

  async ownerNotes(prId: number): Promise<HostNote[]> {
    return ownerNotesOf(await this.prRepo(), prId);
  }

  async answerNote(prId: number, note: Pick<HostNote, 'id' | 'kind' | 'who' | 'text' | 'thread'>, text: string): Promise<void> {
    await answerOwnerNote(await this.prRepo(), prId, note, text);
  }
}

export const githubCodeHost: CodeHostModule = {
  name: 'github',
  label: 'GitHub',
  repoFor(_root, remoteUrl, upstream) {
    const repo = repoName(remoteUrl);
    // No sign-in on this computer: squad-kit opens nothing, and the work goes on as without a code host. gh that did not
    // answer this time counts as signed in: a refusal then stops the story with the steps, never a merge here.
    const state = ghState();
    if (!repo || state === 'missing' || state === 'signed-out') return null;
    return new GitHubRepo(repo, (upstream && repoName(upstream)) || undefined);
  },
  forks: githubForks,
  // Code kept on GitHub: the Tools page lists GitHub's tool for it.
  kindOf: (remoteUrl) => (repoName(remoteUrl) ? 'github' : null),
};
