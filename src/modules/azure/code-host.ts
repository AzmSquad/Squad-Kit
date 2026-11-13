import type { CodeHostModule, MergeState, PullRequest, PullRequestReview, RepoHost } from '../code-host/types.js';
import { Azure, azureForProject, gitAuthEnv, parseAzureRemote } from './client.js';
import { postReviewThreads } from './review-threads.js';

/** Azure Repos as a squad-kit code host. The project's Azure token signs in, for any org it can reach. */

export class AzureRepo implements RepoHost {
  readonly host = 'azure';
  readonly label = 'Azure Repos';
  readonly abilities = { attachImages: true };

  constructor(
    private readonly az: Azure,
    readonly repo: string,
    private readonly remoteUrl: string,
  ) {}

  gitEnv(): Record<string, string> {
    return gitAuthEnv(this.az.target.pat, this.remoteUrl);
  }

  findPullRequest(source: string): Promise<PullRequest | null> {
    return this.az.findPullRequest(this.repo, source);
  }

  lastPullRequest(source: string): Promise<PullRequest | null> {
    return this.az.lastPullRequest(this.repo, source);
  }

  // Azure Repos shows pull request descriptions as Markdown, so they go as written.
  openPullRequest(input: { source: string; target: string; title: string; description: string; items: string[] }): Promise<PullRequest> {
    return this.az.createPullRequest({ repo: this.repo, source: input.source, target: input.target, title: input.title, description: input.description, workItemIds: input.items.map(Number).filter((n) => n > 0) });
  }

  attachImage(prId: number, file: string): Promise<string> {
    return this.az.attachToPullRequest(this.repo, prId, file);
  }

  updateDescription(prId: number, description: string): Promise<void> {
    return this.az.updatePullRequestDescription(this.repo, prId, description);
  }

  postReview(prId: number, review: PullRequestReview): Promise<{ threads: number }> {
    return postReviewThreads(this.az, this.repo, prId, review);
  }

  async mergeState(prId: number): Promise<MergeState> {
    const pr = await this.az.getPullRequest(this.repo, prId);
    if (pr.status === 'completed') return 'merged';
    if (pr.status === 'abandoned') return 'closed';
    if (pr.mergeStatus === 'conflicts') return 'clash';
    return pr.mergeStatus === 'succeeded' ? 'mergeable' : 'waiting';
  }

  async merge(prId: number, message: string): Promise<{ commit: string }> {
    return { commit: (await this.az.completePullRequest(this.repo, prId, message)).mergeCommit };
  }

  close(prId: number): Promise<void> {
    return this.az.abandonPullRequest(this.repo, prId);
  }

  refusedPush(message: string): boolean {
    return /TF402455|not permitted|protected|policy/i.test(message);
  }
}

export const azureCodeHost: CodeHostModule = {
  name: 'azure',
  label: 'Azure Repos',
  repoFor(root, remoteUrl) {
    const where = parseAzureRemote(remoteUrl);
    const pat = where && azureForProject(root)?.target.pat;
    if (!where || !pat) return null;
    return new AzureRepo(new Azure({ organization: where.organization, project: where.project, pat }), where.repo, remoteUrl);
  },
};
