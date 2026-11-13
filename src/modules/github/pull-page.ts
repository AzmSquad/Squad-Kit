import type { PullRequestPageModule } from '../code-host/types.js';

/**
 * GitHub, as far as squad-kit knows it: the page that opens a pull request. A fork's branch goes to the repo it was
 * copied from as "owner:branch", and GitHub fills in the title.
 */

/** "owner/name" from https://github.com/owner/name(.git), git@github.com:owner/name(.git) or ssh://git@github.com/owner/name. */
export function repoName(remoteUrl: string): string | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(remoteUrl.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

export const githubPullPage: PullRequestPageModule = {
  name: 'github',
  label: 'GitHub',
  repoName,
  pageFor({ from, into, base, branch, title }) {
    const own = repoName(from);
    const target = repoName(into);
    if (!own || !target) return null;
    const head = own.toLowerCase() === target.toLowerCase() ? branch : `${own.split('/')[0]}:${branch}`;
    const q = new URLSearchParams({ expand: '1', title });
    return `https://github.com/${target}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head).replace(/%3A/g, ':')}?${q.toString()}`;
  },
};
