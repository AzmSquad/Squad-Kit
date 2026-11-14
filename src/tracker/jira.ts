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
import { withoutTags } from '../utils/text.js';

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
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw this.mapHttpError(res.status, id, errBody);
    }

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
      // /rest/api/3/search/jql rejects unbounded JQL with HTTP 400. The "show recent issues
      // on Tracker page mount" intent is preserved by adding a date constraint that captures
      // ~3 months of activity — broad enough to surface anything the user is likely to want,
      // narrow enough to satisfy the bounded-query requirement.
      jql = 'updated >= -90d ORDER BY updated DESC';
    } else {
      const esc = q.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      jql = `text ~ "${esc}" order by updated DESC`;
    }
    // Atlassian sunset GET /rest/api/3/search in late 2025 (now returns 410 Gone).
    // /rest/api/3/search/jql is the supported replacement; same JQL grammar, same
    // `fields` and `maxResults` query params. Pagination switched from `startAt`
    // to `nextPageToken`, but we only ever request one page (≤ 50 issues), so we
    // don't read or send a token.
    const url =
      `${this.baseUrl}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}` +
      `&fields=summary,status,issuetype&maxResults=${limit}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: this.headers() });
    } catch (err) {
      throw new TrackerError(`Jira search failed: ${(err as Error).message}`, 'network');
    }
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw this.mapHttpError(res.status, 'search', errBody);
    }
    // TODO(jira-paging): if we ever need > 50 results we should follow `nextPageToken`
    // until `isLast === true`. For the Tracker page we cap at 25, so a single call is fine.
    const body = (await res.json()) as {
      issues?: JiraSearchIssue[];
      nextPageToken?: string;
      isLast?: boolean;
    };
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
    // The token goes only to the Jira site itself.
    return downloadAttachmentsWith(refs, targetDir, this.headers(), opts, (url) => onHost(url, new URL(this.baseUrl).host));
  }

  private headers(): Record<string, string> {
    return {
      authorization: this.authHeader,
      accept: 'application/json',
    };
  }

  private mapHttpError(status: number, id: string, body = ''): TrackerError {
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
    if (status === 410) {
      return new TrackerError(
        id === 'search'
          ? `Jira search endpoint has been removed by Atlassian (HTTP 410). ` +
              `squad-kit must call /rest/api/3/search/jql instead — upgrade squad-kit ` +
              `to a version that includes this fix.`
          : `Jira endpoint has been removed by Atlassian (HTTP 410). ` +
              `Upgrade squad-kit to a version that calls the current Jira Cloud REST API.`,
        'other',
        status,
      );
    }

    const reason = extractJiraErrorMessages(body);
    const base =
      id === 'search'
        ? `Jira search failed (HTTP ${status}).`
        : `Jira request failed (HTTP ${status}).`;
    return new TrackerError(reason ? `${base} ${reason}` : base, 'other', status);
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
  const breaks = html.replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6])>/gi, '\n\n');
  // &amp; goes last, so a written "&amp;lt;" reads "&lt;" and is not read twice into "<".
  return withoutTags(breaks)
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Atlassian REST APIs return errors in `{ errorMessages: string[], errors: Record<string,string> }`.
 * Concatenate the human-readable bits and cap at ~200 chars so we don't echo a multi-KB response
 * into terminal output or the console danger callout.
 */
function extractJiraErrorMessages(body: string): string {
  if (!body) return '';
  let parsed: { errorMessages?: unknown; errors?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    return body.slice(0, 200);
  }
  const messages: string[] = [];
  if (Array.isArray(parsed.errorMessages)) {
    for (const m of parsed.errorMessages) {
      if (typeof m === 'string' && m.trim().length > 0) messages.push(m.trim());
    }
  }
  if (parsed.errors && typeof parsed.errors === 'object') {
    for (const [k, v] of Object.entries(parsed.errors as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim().length > 0) messages.push(`${k}: ${v.trim()}`);
    }
  }
  if (messages.length === 0) return '';
  const joined = messages.join(' ');
  return joined.length > 200 ? `${joined.slice(0, 197)}...` : joined;
}

/** True for an https address on exactly this host. */
function onHost(url: string, host: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.host === host && !u.username && !u.password;
  } catch {
    return false;
  }
}
