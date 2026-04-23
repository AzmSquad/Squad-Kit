import type {
  AttachmentRef,
  DownloadOptions,
  DownloadedAttachment,
  FetchIssueResult,
  TrackerClient,
} from './types.js';
import { TrackerError } from './types.js';
import { downloadAttachmentsWith, sanitizeFilename } from './attachments.js';

export interface AzureDevOpsClientConfig {
  organization: string; // e.g. "myorg"
  project: string; // e.g. "myproject"
  pat: string; // personal access token
  apiVersion?: string; // default "7.1"
}

const HTML_STRIPPER_RE = [
  [/<\s*br\s*\/?>/gi, '\n'] as const,
  [/<\/(p|div|li|h[1-6])>/gi, '\n\n'] as const,
  [/<[^>]+>/g, ''] as const,
  [/&nbsp;/g, ' '] as const,
  [/&amp;/g, '&'] as const,
  [/&lt;/g, '<'] as const,
  [/&gt;/g, '>'] as const,
  [/&quot;/g, '"'] as const,
  [/&#39;/g, "'"] as const,
  [/\n{3,}/g, '\n\n'] as const,
];

export class AzureDevOpsClient implements TrackerClient {
  readonly name = 'azure' as const;
  private readonly authHeader: string;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly webBase: string;

  constructor(private readonly cfg: AzureDevOpsClientConfig) {
    if (!cfg.organization) throw new Error('AzureDevOpsClient: missing "organization".');
    if (!cfg.project) throw new Error('AzureDevOpsClient: missing "project".');
    if (!cfg.pat) throw new Error('AzureDevOpsClient: missing "pat".');
    this.apiVersion = cfg.apiVersion ?? '7.1';
    this.baseUrl = `https://dev.azure.com/${encodeURIComponent(cfg.organization)}/${encodeURIComponent(cfg.project)}/_apis/wit`;
    this.webBase = `https://dev.azure.com/${encodeURIComponent(cfg.organization)}/${encodeURIComponent(cfg.project)}/_workitems/edit`;
    const basic = Buffer.from(`:${cfg.pat}`).toString('base64');
    this.authHeader = `Basic ${basic}`;
  }

  async fetchIssue(id: string): Promise<FetchIssueResult> {
    const url = `${this.baseUrl}/workitems/${encodeURIComponent(id)}?$expand=all&api-version=${this.apiVersion}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: this.headers() });
    } catch (err) {
      throw new TrackerError(`Azure DevOps fetch failed: ${(err as Error).message}`, 'network');
    }
    if (!res.ok) throw this.mapHttpError(res.status, id);

    const body = (await res.json()) as AzureWorkItemPayload;
    const fields = body.fields ?? {};
    const relations = Array.isArray(body.relations) ? body.relations : [];

    const attachments: AttachmentRef[] = relations
      .filter((r) => r.rel === 'AttachedFile')
      .map((r) => ({
        filename: sanitizeFilename(r.attributes?.name ?? 'attachment'),
        url: r.url,
        size: typeof r.attributes?.resourceSize === 'number' ? r.attributes.resourceSize : 0,
      }));

    return {
      id: String(body.id ?? id),
      title: fields['System.Title'] ?? '(no title)',
      description: stripHtml(fields['System.Description'] ?? ''),
      url: `${this.webBase}/${body.id ?? id}`,
      labels: parseTags(fields['System.Tags']),
      type: fields['System.WorkItemType'],
      assignee: fields['System.AssignedTo']?.displayName,
      status: fields['System.State'],
      attachments,
      fetchedAt: new Date().toISOString(),
    };
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
        `Azure DevOps authentication failed (HTTP ${status}). Check your PAT in .squad/secrets.yaml and that it has "Work Items (Read)" scope.`,
        'auth',
        status,
      );
    }
    if (status === 404) {
      return new TrackerError(
        `Azure DevOps work item "${id}" not found in ${this.cfg.organization}/${this.cfg.project} (HTTP 404). ` +
          `Check the id and the organization/project in .squad/config.yaml.`,
        'not-found',
        status,
      );
    }
    if (status === 429) {
      return new TrackerError(`Azure DevOps rate limit hit (HTTP 429). Wait a minute and retry.`, 'rate-limited', status);
    }
    return new TrackerError(`Azure DevOps request failed (HTTP ${status}).`, 'other', status);
  }
}

function parseTags(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  return raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

function stripHtml(html: string): string {
  let out = html;
  for (const [re, replacement] of HTML_STRIPPER_RE) {
    out = out.replace(re, replacement as string);
  }
  return out.trim();
}

// ---- Local payload types ----

interface AzureWorkItemPayload {
  id?: number;
  fields?: {
    'System.Title'?: string;
    'System.Description'?: string;
    'System.WorkItemType'?: string;
    'System.State'?: string;
    'System.Tags'?: string;
    'System.AssignedTo'?: { displayName?: string };
  };
  relations?: Array<{
    rel: string;
    url: string;
    attributes?: { name?: string; resourceSize?: number };
  }>;
}
