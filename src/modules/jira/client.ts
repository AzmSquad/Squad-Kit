import fs from 'node:fs';
import path from 'node:path';
import { ModuleError, kindOfStatus } from '../errors.js';
import { writeLog } from '../../core/app-log.js';

/**
 * Jira Cloud's REST API as squad-kit calls it: one site, one person's email and API token. squad-kit makes these calls
 * itself; agents never reach Jira. The token goes only to the site, never into a log, an error or a URL.
 */

export interface JiraAccess {
  /** The site's host, like yourcompany.atlassian.net. */
  site: string;
  email: string;
  token: string;
}

/**
 * The sign-in header, and the only place that builds it: an email and an API token today. A later "Sign in with
 * Atlassian" swaps in its own header here and nothing else changes.
 */
function authHeader(a: JiraAccess): string {
  return `Basic ${Buffer.from(`${a.email}:${a.token}`).toString('base64')}`;
}

/** The longest one call may take, so a stalled network never holds up the board. */
const CALL_MS = 60_000;
/** Jira asks to wait this long or less: squad-kit waits and asks once more. Longer, and it says so. */
const SHORT_WAIT_S = 5;
/** Search pages: Jira gives at most 100 issues a page with their fields. */
const PAGE = 100;

interface SearchPage<T> {
  issues: T[];
  /** Jira had more than the cap. */
  more: boolean;
}

/** Jira's own words for what went wrong, short: never the request, never a header. */
function jiraWords(text: string): string {
  try {
    const parsed = JSON.parse(text) as { errorMessages?: unknown; errors?: unknown; message?: unknown };
    const list = [
      ...(Array.isArray(parsed.errorMessages) ? parsed.errorMessages : []),
      ...Object.entries(parsed.errors && typeof parsed.errors === 'object' ? (parsed.errors as Record<string, unknown>) : {}).map(([k, v]) => `${k}: ${String(v)}`),
      ...(typeof parsed.message === 'string' ? [parsed.message] : []),
    ].filter((m): m is string => typeof m === 'string' && Boolean(m.trim()));
    const joined = list.join(' ').trim();
    return joined.length > 200 ? `${joined.slice(0, 197)}...` : joined;
  } catch {
    return '';
  }
}

export class JiraClient {
  readonly base: string;

  constructor(
    readonly access: JiraAccess,
    private readonly http: typeof fetch = fetch,
    private readonly opts: { timeoutMs?: number; pause?: (ms: number) => Promise<void> } = {},
  ) {
    this.base = `https://${access.site}`;
  }

  /** The page people open for an issue. */
  browseUrl(key: string): string {
    return `${this.base}/browse/${key}`;
  }

  /** Waits a while, as Jira asks; tests give their own pace. */
  wait(ms: number): Promise<void> {
    return (this.opts.pause ?? ((t) => new Promise((r) => setTimeout(r, t))))(ms);
  }

  /** A call to the site's own API. Only a path on the site: the sign-in never goes to another host. */
  async call<T>(method: string, path: string, body?: unknown, again = true): Promise<T> {
    if (!path.startsWith('/')) throw new Error(`A Jira call takes a path on the site, not "${path}".`);
    let res: Response;
    try {
      res = await this.http(`${this.base}${path}`, {
        method,
        headers: { authorization: authHeader(this.access), accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? CALL_MS),
      });
    } catch (err) {
      writeLog({ level: 'warn', text: `Could not reach Jira at ${this.access.site}: ${(err as Error).name}` });
      throw new ModuleError(`Could not reach Jira at ${this.access.site}. Check the connection, then try again.`, 'offline');
    }
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') ?? '');
      if (again && Number.isFinite(wait) && wait <= SHORT_WAIT_S) {
        await this.wait(Math.max(0, wait) * 1000);
        return this.call<T>(method, path, body, false);
      }
      const after = Number.isFinite(wait) && wait > 0 ? ` Try again in ${Math.ceil(wait)} seconds.` : ' Try again in a minute.';
      throw new ModuleError(`Jira asked squad-kit to slow down: too many calls just now.${after}`, 'too-many', 429);
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new ModuleError(`Jira at ${this.access.site} stopped answering half-way. Check the connection, then try again.`, 'offline');
    }
    if (res.status >= 300 && res.status < 400) {
      // A site that moved, or something in between that sends squad-kit elsewhere: never followed with the sign-in.
      const to = res.headers.get('location');
      let host = '';
      try {
        host = to ? new URL(to, this.base).host : '';
      } catch {
        // An address that is not one: said without it.
      }
      writeLog({ level: 'warn', text: `Jira at ${this.access.site} sent HTTP ${res.status} to ${host || 'nowhere'} for ${method} ${path.replace(/\?.*$/, '')}` });
      throw new ModuleError(
        `Jira at ${this.access.site} sends squad-kit ${host && host !== this.access.site ? `to ${host}` : 'somewhere else'}. If your site moved, enter the new one in Settings.`,
        'not-found',
        res.status,
      );
    }
    if (res.status >= 400) throw this.failure(method, path, res.status, text);
    if (!text) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // A sign-in page or a proxy's page answered instead of Jira.
      writeLog({ level: 'warn', text: `Jira at ${this.access.site} answered ${method} ${path.replace(/\?.*$/, '')} with a page, not data: ${text.slice(0, 80).replace(/\s+/g, ' ')}` });
      throw new ModuleError(`${this.access.site} answered with a web page instead of Jira's data. A sign-in page or a network proxy may be in the way. Check the site in Settings.`, 'other');
    }
  }

  private failure(method: string, url: string, status: number, text: string): ModuleError {
    const words = jiraWords(text);
    // The exact answer is for engineers: the path and Jira's words, never the header.
    writeLog({ level: 'warn', text: `Jira said HTTP ${status} to ${method} ${url.replace(/\?.*$/, '')}. ${words}`.trim() });
    if (status === 401) {
      return new ModuleError(
        `Jira did not accept the API token for ${this.access.email}. It may have expired or been removed: Atlassian tokens last a year at most. Make a new one and paste it in Settings.`,
        'sign-in',
        401,
      );
    }
    if (status === 403) return new ModuleError(`Jira did not let ${this.access.email} do this. ${words || 'Ask a Jira admin for the right in this project.'}`.trim(), 'sign-in', 403);
    if (status === 404) return new ModuleError(words || 'Jira has no such item, or this account cannot see it.', 'not-found', 404);
    if (status === 410) return new ModuleError('Jira no longer has this part of its API. Update squad-kit.', 'other', 410);
    return new ModuleError(words ? `Jira said no: ${words}` : `Jira said no (HTTP ${status}). An engineer can see why in the log.`, kindOfStatus(status), status);
  }

  /**
   * Every issue a JQL query finds, page by page with Jira's nextPageToken, up to `cap`. Some Jira sites give a page
   * again or never say it is the last: a token seen before, or an empty page, ends it too.
   */
  async search<T extends { key: string }>(jql: string, fields: string[], cap = 500): Promise<SearchPage<T>> {
    const issues: T[] = [];
    const keys = new Set<string>();
    const seen = new Set<string>();
    let token: string | undefined;
    for (;;) {
      const page = await this.call<{ issues?: T[]; nextPageToken?: string; isLast?: boolean }>('POST', '/rest/api/3/search/jql', {
        jql,
        fields,
        maxResults: Math.min(PAGE, cap - issues.length),
        ...(token ? { nextPageToken: token } : {}),
      });
      // A page given again adds nothing twice.
      for (const issue of page?.issues ?? []) {
        if (keys.has(issue.key)) continue;
        keys.add(issue.key);
        issues.push(issue);
      }
      const next = page?.nextPageToken;
      if (!next || page?.isLast === true || !page?.issues?.length || seen.has(next)) return { issues, more: false };
      if (issues.length >= cap) return { issues, more: true };
      seen.add(next);
      token = next;
    }
  }

  /**
   * Saves an attachment. Jira answers with a redirect to its media service: that host gets no sign-in, only the
   * one-time address Jira gave. Only files on the site itself are asked for.
   */
  async download(url: string, file: string): Promise<string> {
    let at = new URL(url);
    if (at.protocol !== 'https:' || at.host !== this.access.site) throw new ModuleError(`squad-kit only downloads files kept on ${this.access.site}.`, 'not-found');
    for (let hop = 0; hop < 4; hop += 1) {
      const own = at.host === this.access.site;
      let res: Response;
      try {
        res = await this.http(at.toString(), {
          headers: own ? { authorization: authHeader(this.access) } : {},
          redirect: 'manual',
          signal: AbortSignal.timeout((this.opts.timeoutMs ?? CALL_MS) * 5),
        });
      } catch {
        throw new ModuleError(`Could not reach Jira to download ${path.basename(file)}. Check the connection, then try again.`, 'offline');
      }
      const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (next) {
        at = new URL(next, at);
        if (at.protocol !== 'https:') break;
        continue;
      }
      if (!res.ok) throw this.failure('GET', at.pathname, res.status, await res.text().catch(() => ''));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      return file;
    }
    throw new ModuleError(`Jira sent ${path.basename(file)} somewhere squad-kit does not follow.`, 'other');
  }
}
