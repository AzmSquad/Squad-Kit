import type {
  AttachmentRef,
  DownloadOptions,
  DownloadedAttachment,
  FetchIssueResult,
  SearchIssueRow,
  TrackerClient,
} from './types.js';
import { TrackerError } from './types.js';
import { downloadAttachmentsWith } from './attachments.js';

export interface GitHubClientConfig {
  owner: string;
  repo: string;
  pat: string;
  host?: string; // optional GHES hostname; defaults to api.github.com
}

const PUBLIC_HOST = 'api.github.com';
const ID_PREFIX_RE = /^[\w.-]+\/[\w.-]+#/;

export class GitHubClient implements TrackerClient {
  readonly name = 'github' as const;
  private readonly authHeader: string;
  private readonly baseUrl: string;
  private readonly webBase: string;

  constructor(private readonly cfg: GitHubClientConfig) {
    if (!cfg.owner) throw new Error('GitHubClient: missing "owner".');
    if (!cfg.repo) throw new Error('GitHubClient: missing "repo".');
    if (!cfg.pat) throw new Error('GitHubClient: missing "pat".');
    const host = (cfg.host ?? PUBLIC_HOST).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    // GHES uses /api/v3 prefix; api.github.com uses bare paths.
    const apiPath = host === PUBLIC_HOST ? '' : '/api/v3';
    this.baseUrl = `https://${host}${apiPath}`;
    this.webBase = host === PUBLIC_HOST ? 'https://github.com' : `https://${host}`;
    this.authHeader = `Bearer ${cfg.pat}`;
  }

  async fetchIssue(id: string): Promise<FetchIssueResult> {
    const number = stripIdPrefix(id);
    const url = `${this.baseUrl}/repos/${encodeURIComponent(this.cfg.owner)}/${encodeURIComponent(
      this.cfg.repo,
    )}/issues/${encodeURIComponent(number)}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: this.headers() });
    } catch (err) {
      throw new TrackerError(`GitHub fetch failed: ${(err as Error).message}`, 'network');
    }
    if (!res.ok) throw this.mapHttpError(res, number);
    const body = (await res.json()) as GitHubIssuePayload;
    return this.toFetchResult(body);
  }

  async searchIssues(query: string, opts?: { limit?: number }): Promise<SearchIssueRow[]> {
    const limit = Math.min(50, Math.max(1, opts?.limit ?? 25));
    const q = query.trim();
    const repoPath = `${encodeURIComponent(this.cfg.owner)}/${encodeURIComponent(this.cfg.repo)}`;

    if (q.length === 0) {
      const url =
        `${this.baseUrl}/repos/${repoPath}/issues` +
        `?state=all&sort=updated&direction=desc&per_page=${limit}`;
      let res: Response;
      try {
        res = await fetch(url, { headers: this.headers() });
      } catch (err) {
        throw new TrackerError(`GitHub search failed: ${(err as Error).message}`, 'network');
      }
      if (!res.ok) throw this.mapHttpError(res, 'search');
      const body = (await res.json()) as GitHubIssuePayload[];
      return (body ?? []).map((it) => this.toSearchRow(it));
    }

    if (/^\d+$/.test(q) || ID_PREFIX_RE.test(q)) {
      try {
        const issue = await this.fetchIssue(q);
        return [
          {
            id: issue.id,
            title: issue.title,
            type: issue.type,
            status: issue.status,
            url: issue.url,
          },
        ];
      } catch (err) {
        if (err instanceof TrackerError && err.kind === 'not-found') return [];
        throw err;
      }
    }

    const searchQuery = `${q} repo:${this.cfg.owner}/${this.cfg.repo}`;
    const url =
      `${this.baseUrl}/search/issues` +
      `?q=${encodeURIComponent(searchQuery)}&sort=updated&order=desc&per_page=${limit}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: this.headers() });
    } catch (err) {
      throw new TrackerError(`GitHub search failed: ${(err as Error).message}`, 'network');
    }
    if (!res.ok) throw this.mapHttpError(res, 'search');
    const body = (await res.json()) as { items?: GitHubIssuePayload[] };
    return (body.items ?? []).map((it) => this.toSearchRow(it));
  }

  async downloadAttachments(
    refs: AttachmentRef[],
    targetDir: string,
    opts?: DownloadOptions,
  ): Promise<DownloadedAttachment[]> {
    // GitHub's REST API does not expose issue attachments; user-content URLs
    // require browser session cookies. Pass through for contract compatibility.
    if (refs.length === 0) return [];
    return downloadAttachmentsWith(refs, targetDir, this.headers(), opts);
  }

  private toFetchResult(body: GitHubIssuePayload): FetchIssueResult {
    return {
      id: String(body.number ?? ''),
      title: body.title ?? '(no title)',
      description: body.body ?? '',
      acceptanceCriteria: '',
      url: body.html_url ?? `${this.webBase}/${this.cfg.owner}/${this.cfg.repo}/issues/${body.number ?? ''}`,
      labels: Array.isArray(body.labels)
        ? body.labels.map((l) => (typeof l === 'string' ? l : l.name ?? '')).filter(Boolean)
        : [],
      type: body.pull_request ? 'Pull Request' : 'Issue',
      assignee: body.assignee?.login,
      status: body.state,
      attachments: [],
      fetchedAt: new Date().toISOString(),
    };
  }

  private toSearchRow(body: GitHubIssuePayload): SearchIssueRow {
    return {
      id: String(body.number ?? ''),
      title: body.title ?? '(no title)',
      type: body.pull_request ? 'Pull Request' : 'Issue',
      status: body.state,
      url: body.html_url ?? `${this.webBase}/${this.cfg.owner}/${this.cfg.repo}/issues/${body.number ?? ''}`,
    };
  }

  private headers(): Record<string, string> {
    return {
      authorization: this.authHeader,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'squad-kit',
    };
  }

  private mapHttpError(res: Response, id: string): TrackerError {
    const status = res.status;
    if (status === 401 || status === 403) {
      // Primary rate-limit hits return 403 with x-ratelimit-remaining: 0.
      if (res.headers.get('x-ratelimit-remaining') === '0') {
        return new TrackerError(
          `GitHub rate limit hit (HTTP ${status}). Wait until the limit resets and retry.`,
          'rate-limited',
          status,
        );
      }
      return new TrackerError(
        `GitHub authentication failed (HTTP ${status}). Check your PAT in .squad/secrets.yaml; it needs "repo" scope (or "Issues: read" for fine-grained tokens).`,
        'auth',
        status,
      );
    }
    if (status === 404) {
      return new TrackerError(
        id === 'search'
          ? `GitHub search failed (HTTP 404) for ${this.cfg.owner}/${this.cfg.repo}.`
          : `GitHub issue "${id}" not found in ${this.cfg.owner}/${this.cfg.repo} (HTTP 404). Check the id and tracker.workspace / tracker.project in .squad/config.yaml.`,
        'not-found',
        status,
      );
    }
    if (status === 422) {
      return new TrackerError(
        `GitHub rejected the search query (HTTP 422). Try a simpler query or a bare issue number.`,
        'other',
        status,
      );
    }
    if (status === 429) {
      return new TrackerError(`GitHub rate limit hit (HTTP 429). Wait a minute and retry.`, 'rate-limited', status);
    }
    return new TrackerError(
      id === 'search' ? `GitHub search failed (HTTP ${status}).` : `GitHub request failed (HTTP ${status}).`,
      'other',
      status,
    );
  }
}

function stripIdPrefix(id: string): string {
  return id.replace(ID_PREFIX_RE, '');
}

interface GitHubIssuePayload {
  number?: number;
  title?: string;
  body?: string | null;
  html_url?: string;
  state?: string;
  labels?: Array<string | { name?: string }>;
  assignee?: { login?: string } | null;
  pull_request?: unknown;
}
