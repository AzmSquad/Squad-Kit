import type {
  AttachmentRef,
  DownloadOptions,
  DownloadedAttachment,
  FetchIssueResult,
  SearchIssueRow,
  TrackerClient,
} from './types.js';
import { TrackerError } from './types.js';
import { adfToPlainText } from './adf.js';
import { downloadAttachmentsWith, sanitizeFilename } from './attachments.js';

export interface JiraClientConfig {
  host: string; // e.g. "mycompany.atlassian.net" — no scheme, no trailing slash
  email: string;
  token: string;
}

export class JiraClient implements TrackerClient {
  readonly name = 'jira' as const;
  private readonly authHeader: string;
  private readonly baseUrl: string;

  constructor(private readonly cfg: JiraClientConfig) {
    const normHost = cfg.host.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    this.baseUrl = `https://${normHost}`;
    const basic = Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64');
    this.authHeader = `Basic ${basic}`;
  }

  async fetchIssue(id: string): Promise<FetchIssueResult> {
    const url =
      `${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(id)}` +
      `?fields=summary,description,labels,issuetype,assignee,status,attachment&expand=renderedFields`;
    let res: Response;
    try {
      res = await fetch(url, { headers: this.headers() });
    } catch (err) {
      throw new TrackerError(`Jira fetch failed: ${(err as Error).message}`, 'network');
    }
    if (!res.ok) throw this.mapHttpError(res.status, id);

    const body = (await res.json()) as JiraIssuePayload;
    const fields = body.fields ?? {};
    const rendered = body.renderedFields ?? {};

    const description =
      typeof rendered.description === 'string' && rendered.description.length > 0
        ? stripHtml(rendered.description)
        : adfToPlainText(fields.description);

    const attachments: AttachmentRef[] = (fields.attachment ?? []).map((a) => ({
      filename: sanitizeFilename(a.filename),
      url: a.content,
      size: typeof a.size === 'number' ? a.size : 0,
      mimeType: a.mimeType,
    }));

    return {
      id: body.key ?? id,
      title: fields.summary ?? '(no title)',
      description,
      acceptanceCriteria: '',
      url: `${this.baseUrl}/browse/${body.key ?? id}`,
      labels: Array.isArray(fields.labels) ? fields.labels : [],
      type: fields.issuetype?.name,
      assignee: fields.assignee?.displayName,
      status: fields.status?.name,
      attachments,
      fetchedAt: new Date().toISOString(),
    };
  }

  async searchIssues(query: string, opts?: { limit?: number }): Promise<SearchIssueRow[]> {
    const limit = Math.min(50, Math.max(1, opts?.limit ?? 25));
    const q = query.trim();
    let jql: string;
    if (/^[A-Z][A-Z0-9_]+-\d+$/i.test(q)) {
      jql = `issuekey = "${q.toUpperCase()}"`;
    } else if (q.length === 0) {
      jql = 'order by updated DESC';
    } else {
      const esc = q.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      jql = `text ~ "${esc}" order by updated DESC`;
    }
    const url =
      `${this.baseUrl}/rest/api/3/search?jql=${encodeURIComponent(jql)}` +
      `&fields=summary,status,issuetype&maxResults=${limit}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: this.headers() });
    } catch (err) {
      throw new TrackerError(`Jira search failed: ${(err as Error).message}`, 'network');
    }
    if (!res.ok) throw this.mapHttpError(res.status, 'search');
    const body = (await res.json()) as { issues?: JiraSearchIssue[] };
    const issues = body.issues ?? [];
    return issues.map((it) => {
      const key = it.key ?? '';
      const f = it.fields ?? {};
      return {
        id: key,
        title: f.summary ?? '(no title)',
        type: f.issuetype?.name,
        status: f.status?.name,
        url: `${this.baseUrl}/browse/${key}`,
      };
    });
  }

  async downloadAttachments(
    refs: AttachmentRef[],
    targetDir: string,
    opts?: DownloadOptions,
  ): Promise<DownloadedAttachment[]> {
    return downloadAttachmentsWith(refs, targetDir, this.headers(), opts);
  }

  private headers(): Record<string, string> {
    return {
      authorization: this.authHeader,
      accept: 'application/json',
    };
  }

  private mapHttpError(status: number, id: string): TrackerError {
    if (status === 401 || status === 403) {
      return new TrackerError(
        `Jira authentication failed (HTTP ${status}). Check your email and API token in .squad/secrets.yaml.`,
        'auth',
        status,
      );
    }
    if (status === 404) {
      return new TrackerError(
        id === 'search'
          ? `Jira search not found (HTTP 404) on ${this.cfg.host}.`
          : `Jira issue "${id}" not found on ${this.cfg.host} (HTTP 404). Check the id and your workspace host.`,
        'not-found',
        status,
      );
    }
    if (status === 429) {
      return new TrackerError(`Jira rate limit hit (HTTP 429). Wait a minute and retry.`, 'rate-limited', status);
    }
    return new TrackerError(
      id === 'search' ? `Jira search failed (HTTP ${status}).` : `Jira request failed (HTTP ${status}).`,
      'other',
      status,
    );
  }
}

interface JiraSearchIssue {
  key?: string;
  fields?: {
    summary?: string;
    issuetype?: { name?: string };
    status?: { name?: string };
  };
}

// ---- Local types for the Jira payload ----

interface JiraIssuePayload {
  key?: string;
  fields?: {
    summary?: string;
    description?: unknown; // ADF JSON
    labels?: string[];
    issuetype?: { name?: string };
    assignee?: { displayName?: string };
    status?: { name?: string };
    attachment?: Array<{
      filename: string;
      content: string;
      size?: number;
      mimeType?: string;
    }>;
  };
  renderedFields?: {
    description?: string; // HTML
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
