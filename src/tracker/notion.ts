import type {
  AttachmentRef,
  DownloadOptions,
  DownloadedAttachment,
  FetchIssueResult,
  SearchIssueRow,
  TrackerClient,
} from './types.js';
import { TrackerError } from './types.js';
import { downloadAttachmentsWith, sanitizeFilename } from './attachments.js';

export interface NotionClientConfig {
  token: string;
  version?: string; // Notion-Version header; default '2022-06-28'
}

const API_BASE = 'https://api.notion.com/v1';
const DEFAULT_VERSION = '2022-06-28';

export class NotionClient implements TrackerClient {
  readonly name = 'notion' as const;
  private readonly authHeader: string;
  private readonly version: string;

  constructor(private readonly cfg: NotionClientConfig) {
    if (!cfg.token) throw new Error('NotionClient: missing "token".');
    this.authHeader = `Bearer ${cfg.token}`;
    this.version = cfg.version ?? DEFAULT_VERSION;
  }

  async fetchIssue(id: string): Promise<FetchIssueResult> {
    const pageId = normalizeId(id);
    const pageUrl = `${API_BASE}/pages/${encodeURIComponent(pageId)}`;
    let res: Response;
    try {
      res = await fetch(pageUrl, { headers: this.headers() });
    } catch (err) {
      throw new TrackerError(`Notion fetch failed: ${(err as Error).message}`, 'network');
    }
    if (!res.ok) throw await this.mapHttpError(res, pageId);
    const page = (await res.json()) as NotionPage;

    const description = await this.fetchPlainTextBody(pageId);

    return {
      id: pageId,
      title: extractTitle(page) || '(no title)',
      description,
      acceptanceCriteria: '',
      url: page.url ?? `https://www.notion.so/${pageId.replace(/-/g, '')}`,
      labels: extractMultiSelect(page),
      type: 'Page',
      assignee: extractAssignee(page),
      status: extractStatus(page),
      attachments: extractAttachments(page),
      fetchedAt: new Date().toISOString(),
    };
  }

  async searchIssues(query: string, opts?: { limit?: number }): Promise<SearchIssueRow[]> {
    const limit = Math.min(50, Math.max(1, opts?.limit ?? 25));
    const url = `${API_BASE}/search`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify({
          query: query.trim(),
          filter: { property: 'object', value: 'page' },
          page_size: limit,
        }),
      });
    } catch (err) {
      throw new TrackerError(`Notion search failed: ${(err as Error).message}`, 'network');
    }
    if (!res.ok) throw await this.mapHttpError(res, 'search');
    const body = (await res.json()) as { results?: NotionPage[] };
    return (body.results ?? []).map((page) => ({
      id: page.id,
      title: extractTitle(page) || '(untitled page)',
      type: 'Page',
      status: extractStatus(page),
      url: page.url ?? `https://www.notion.so/${page.id.replace(/-/g, '')}`,
    }));
  }

  async downloadAttachments(
    refs: AttachmentRef[],
    targetDir: string,
    opts?: DownloadOptions,
  ): Promise<DownloadedAttachment[]> {
    // Notion file URLs are pre-signed (S3); they must NOT carry the integration
    // token, so pass empty auth headers.
    if (refs.length === 0) return [];
    return downloadAttachmentsWith(refs, targetDir, {}, opts);
  }

  private async fetchPlainTextBody(pageId: string): Promise<string> {
    // Only the first 100 top-level blocks are read (no pagination) and nested
    // child blocks are not recursed — a deliberate bound, not a bug.
    const url = `${API_BASE}/blocks/${encodeURIComponent(pageId)}/children?page_size=100`;
    let res: Response;
    try {
      res = await fetch(url, { headers: this.headers() });
    } catch {
      return ''; // body is best-effort; title/metadata already succeeded
    }
    if (!res.ok) return '';
    const body = (await res.json()) as { results?: NotionBlock[] };
    return blocksToPlainText(body.results ?? []);
  }

  private headers(): Record<string, string> {
    return {
      authorization: this.authHeader,
      'notion-version': this.version,
      accept: 'application/json',
    };
  }

  private async mapHttpError(res: Response, id: string): Promise<TrackerError> {
    const status = res.status;
    const body = await res.text().catch(() => '');
    if (status === 401) {
      return new TrackerError(
        `Notion authentication failed (HTTP 401). Check the integration token in .squad/secrets.yaml.`,
        'auth',
        status,
      );
    }
    if (status === 403) {
      return new TrackerError(
        `Notion access denied (HTTP 403). Share the page/database with your integration in Notion, then retry.`,
        'auth',
        status,
      );
    }
    if (status === 404) {
      return new TrackerError(
        id === 'search'
          ? `Notion search failed (HTTP 404).`
          : `Notion page "${id}" not found (HTTP 404). Check the id and that the page is shared with your integration.`,
        'not-found',
        status,
      );
    }
    if (status === 429) {
      return new TrackerError(`Notion rate limit hit (HTTP 429). Wait a moment and retry.`, 'rate-limited', status);
    }
    const reason = extractNotionErrorMessage(body);
    const base = id === 'search' ? `Notion search failed (HTTP ${status}).` : `Notion request failed (HTTP ${status}).`;
    return new TrackerError(reason ? `${base} ${reason}` : base, 'other', status);
  }
}

// ---- Helpers ----

/** Accept a bare 32-hex id or a dashed UUID; return the dashed 8-4-4-4-12 form Notion expects. */
function normalizeId(id: string): string {
  const hex = id.trim().replace(/-/g, '').toLowerCase();
  if (/^[0-9a-f]{32}$/.test(hex)) {
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return id.trim();
}

function richTextToPlain(rich: NotionRichText[] | undefined): string {
  if (!Array.isArray(rich)) return '';
  return rich.map((r) => r.plain_text ?? '').join('');
}

function extractTitle(page: NotionPage): string {
  const props = page.properties ?? {};
  for (const value of Object.values(props)) {
    if (value?.type === 'title') return richTextToPlain(value.title).trim();
  }
  return '';
}

function extractStatus(page: NotionPage): string | undefined {
  const props = page.properties ?? {};
  for (const value of Object.values(props)) {
    if (value?.type === 'status' && value.status?.name) return value.status.name;
    if (value?.type === 'select' && value.select?.name) return value.select.name;
  }
  return undefined;
}

function extractMultiSelect(page: NotionPage): string[] {
  const props = page.properties ?? {};
  for (const value of Object.values(props)) {
    if (value?.type === 'multi_select' && Array.isArray(value.multi_select)) {
      return value.multi_select.map((o) => o.name).filter(Boolean);
    }
  }
  return [];
}

function extractAssignee(page: NotionPage): string | undefined {
  const props = page.properties ?? {};
  for (const value of Object.values(props)) {
    if (value?.type === 'people' && Array.isArray(value.people) && value.people.length > 0) {
      return value.people[0]?.name;
    }
  }
  return undefined;
}

function extractAttachments(page: NotionPage): AttachmentRef[] {
  const props = page.properties ?? {};
  const out: AttachmentRef[] = [];
  for (const value of Object.values(props)) {
    if (value?.type === 'files' && Array.isArray(value.files)) {
      for (const f of value.files) {
        const url = f.file?.url ?? f.external?.url;
        if (!url) continue;
        out.push({ filename: sanitizeFilename(f.name ?? 'attachment'), url, size: 0 });
      }
    }
  }
  return out;
}

function blocksToPlainText(blocks: NotionBlock[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    // Every text-bearing block type (paragraph, heading_*, list items, to_do,
    // quote, callout, toggle) exposes its runs under `block[block.type].rich_text`.
    const container = b[b.type] as { rich_text?: NotionRichText[] } | undefined;
    const text = richTextToPlain(container?.rich_text);
    if (text) lines.push(text);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractNotionErrorMessage(body: string): string {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      const m = parsed.message.trim();
      return m.length > 200 ? `${m.slice(0, 197)}...` : m;
    }
  } catch {
    return body.slice(0, 200);
  }
  return '';
}

// ---- Local payload types ----

interface NotionRichText {
  plain_text?: string;
}

interface NotionPropertyValue {
  type?: string;
  title?: NotionRichText[];
  status?: { name?: string };
  select?: { name?: string };
  multi_select?: Array<{ name: string }>;
  people?: Array<{ name?: string }>;
  files?: Array<{ name?: string; file?: { url?: string }; external?: { url?: string } }>;
}

interface NotionPage {
  id: string;
  url?: string;
  properties?: Record<string, NotionPropertyValue>;
}

interface NotionBlock {
  type: string;
  [key: string]: unknown;
}
