import fs from 'node:fs';
import path from 'node:path';
import { ModuleError, kindOfStatus } from '../errors.js';
import { writeLog } from '../../core/app-log.js';
import { GATEWAY, scopeFor } from './atlassian-app.js';

/**
 * Jira Cloud's REST API as squad-kit calls it: one site, with the person's email and API token, or with squad-kit's own
 * Atlassian sign-in (ADR-012). squad-kit makes these calls itself; agents never reach Jira. A token goes only to its own
 * site and the sign-in's bearer only to Atlassian's gateway, never into a log, an error or a URL.
 */

/** Signed in with Atlassian: every call goes to Atlassian's gateway, for this site's cloud id, with a bearer token. */
export interface AtlassianCloud {
  id: string;
  bearer(): Promise<string>;
  /** Jira refused this token: true when one more try with a new one is worth it. */
  refused(token: string): boolean;
}

export interface JiraAccess {
  /** The site's host, like yourcompany.atlassian.net. */
  site: string;
  /** Who signs in: the email with an API token, the Atlassian account's name with the sign-in. */
  email: string;
  /** The person's API token, sent only to `site`. */
  token?: string;
  cloud?: AtlassianCloud;
}

/**
 * The sign-in header, and the only place that builds it: Basic with an email and an API token, or the Atlassian
 * sign-in's bearer token. `bearer`: the token sent, for a refusal.
 */
async function authHeader(a: JiraAccess): Promise<{ header: string; bearer?: string }> {
  if (a.cloud && !a.token) {
    const bearer = await a.cloud.bearer();
    return { header: `Bearer ${bearer}`, bearer };
  }
  return { header: `Basic ${Buffer.from(`${a.email}:${a.token ?? ''}`).toString('base64')}` };
}

/** Calls Atlassian said squad-kit's app has no scope for, and when: not sent again for a while. A new sign-in clears it. */
const missing = new Map<string, number>();
const MISSING_MS = 10 * 60_000;
const ISSUES = 'https://github.com/AzmSquad/Squad-Kit/issues';
/** One kind of call: the site, the method and the path with its ids and issue keys left out. */
const missingKey = (gate: string, method: string, path: string) =>
  `${gate} ${method} ${path.replace(/\?.*$/, '').replace(/\/[A-Z][A-Z0-9_]*-\d+(?=\/|$)/g, '/{key}').replace(/\/\d+(?=\/|$)/g, '/{id}')}`;

/** The words for a call squad-kit's Atlassian app has no permission for. */
export function missingScopeWords(scope: string): string {
  return `Jira refused this call: squad-kit's Atlassian app is missing a permission it needs (${scope}), or the site's admin removed squad-kit's access. Ask the admin, or tell the squad-kit maintainers: ${ISSUES}`;
}

/** A call squad-kit's Atlassian app has no permission for: an access problem, so the Connections row is not connected. */
export class MissingScopeError extends ModuleError {
  constructor(readonly scope: string) {
    super(missingScopeWords(scope), 'sign-in', 401);
  }
}

/** A new sign-in may bring the permission: every call is tried again. */
export function forgetMissingScopes(): void {
  missing.clear();
}

/** An attachment's file on the site, by Jira's two ways of linking it. */
const ATTACHMENT = /^\/(?:rest\/api\/[23]\/attachment\/content\/(\d+)|secure\/attachment\/(\d+)\/)/;

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
  /** Where the calls go: the site itself with a token, Atlassian's gateway for the site with the sign-in. */
  readonly base: string;
  /** The site, for the pages people open. */
  private readonly own: string;
  /** With the Atlassian sign-in: the site's path on the gateway, /ex/jira/<cloud id>. */
  private readonly gate: string | null;

  constructor(
    readonly access: JiraAccess,
    private readonly http: typeof fetch = fetch,
    private readonly opts: { timeoutMs?: number; pause?: (ms: number) => Promise<void> } = {},
  ) {
    this.own = `https://${access.site}`;
    this.gate = access.cloud && !access.token ? `/ex/jira/${access.cloud.id}` : null;
    this.base = this.gate ? `${GATEWAY}${this.gate}` : this.own;
  }

  /** The page people open for an issue: always on the site. */
  browseUrl(key: string): string {
    return `${this.own}/browse/${key}`;
  }

  /** Waits a while, as Jira asks; tests give their own pace. */
  wait(ms: number): Promise<void> {
    return (this.opts.pause ?? ((t) => new Promise((r) => setTimeout(r, t))))(ms);
  }

  /** A call to the site's own API. Only a path on it: the sign-in never goes to another host. */
  call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.send<T>(method, path, body, { wait: true, fresh: true });
  }

  /** `wait`: Jira's short "slow down" is waited once. `fresh`: a refused sign-in token is swapped for a new one once. */
  private async send<T>(method: string, path: string, body: unknown, again: { wait: boolean; fresh: boolean }): Promise<T> {
    if (!path.startsWith('/')) throw new Error(`A Jira call takes a path on the site, not "${path}".`);
    const lacking = this.gate ? missing.get(missingKey(this.gate, method, path)) : undefined;
    if (lacking && Date.now() - lacking < MISSING_MS) throw this.missingScope(method, path, false);
    const auth = await authHeader(this.access);
    let res: Response;
    try {
      res = await this.http(`${this.base}${path}`, {
        method,
        headers: { authorization: auth.header, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? CALL_MS),
      });
    } catch (err) {
      writeLog({ level: 'warn', text: `Could not reach Jira at ${this.access.site}: ${(err as Error).name}` });
      throw new ModuleError(`Could not reach Jira at ${this.access.site}. Check the connection, then try again.`, 'offline');
    }
    if (res.status === 401 && auth.bearer) {
      const text = await res.text().catch(() => '');
      // squad-kit's app lacks a permission for this call: a new token would not help, so none is asked for.
      if (/scope does not match/i.test(jiraWords(text))) throw this.missingScope(method, path);
      // A sign-in token kept a while may have ended early on Atlassian's side: that one is dropped and the call made once more.
      if (again.fresh && this.access.cloud?.refused(auth.bearer)) return this.send<T>(method, path, body, { ...again, fresh: false });
      throw this.failure(method, path, 401, text);
    }
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') ?? '');
      if (again.wait && Number.isFinite(wait) && wait <= SHORT_WAIT_S) {
        await this.wait(Math.max(0, wait) * 1000);
        return this.send<T>(method, path, body, { ...again, wait: false });
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

  /**
   * Atlassian's gateway said "scope does not match": squad-kit's app is missing the permission this call needs, or the
   * site's admin took squad-kit's access away. Said with the permission's name, remembered a while so the same call is
   * not sent again, and never answered with a new token.
   */
  private missingScope(method: string, path: string, first = true): MissingScopeError {
    const scope = scopeFor(method, path);
    if (first) {
      missing.set(missingKey(this.gate!, method, path), Date.now());
      writeLog({ level: 'warn', text: `Atlassian said squad-kit's app has no scope for ${method} ${path.replace(/\?.*$/, '')} (needs ${scope}).` });
    }
    return new MissingScopeError(scope);
  }

  private failure(method: string, url: string, status: number, text: string): ModuleError {
    const words = jiraWords(text);
    // The exact answer is for engineers: the path and Jira's words, never the header.
    writeLog({ level: 'warn', text: `Jira said HTTP ${status} to ${method} ${url.replace(/\?.*$/, '')}. ${words}`.trim() });
    if (status === 401 && this.gate) {
      return new ModuleError(
        `Jira did not accept squad-kit's Atlassian sign-in for ${this.access.email}. Sign in with Atlassian again on the Connections page (squad connect jira), or paste an API token in Settings.`,
        'sign-in',
        401,
      );
    }
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
   * Where an attachment is asked for, or null when it is not on this site. With the Atlassian sign-in, an attachment on
   * the site (or already on the gateway for this site) is asked of the gateway, by its id.
   */
  private fileUrl(url: string): URL | null {
    let at: URL;
    try {
      at = new URL(url);
    } catch {
      return null;
    }
    if (at.protocol !== 'https:') return null;
    if (!this.gate) return at.host === this.access.site ? at : null;
    const own = at.host === this.access.site ? at.pathname : this.ownAddress(at) ? at.pathname.slice(this.gate.length) : null;
    const id = own ? ATTACHMENT.exec(own) : null;
    return id ? new URL(`${this.base}/rest/api/3/attachment/content/${id[1] ?? id[2]}`) : null;
  }

  /** Only squad-kit's own address for the sign-in gets it: the site with a token, the site's gateway path with the sign-in. */
  private ownAddress(at: URL): boolean {
    return this.gate ? at.origin === GATEWAY && at.pathname.startsWith(`${this.gate}/`) : at.host === this.access.site;
  }

  /**
   * Saves an attachment. Jira answers with a redirect to its media service: that host gets no sign-in, only the
   * one-time address Jira gave. Only files on the site itself are asked for.
   */
  async download(url: string, file: string): Promise<string> {
    let at = this.fileUrl(url);
    if (!at) throw new ModuleError(`squad-kit only downloads files kept on ${this.access.site}.`, 'not-found');
    for (let hop = 0; hop < 4; hop += 1) {
      const own = this.ownAddress(at);
      let res: Response;
      try {
        res = await this.http(at.toString(), {
          headers: own ? { authorization: (await authHeader(this.access)).header } : {},
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
