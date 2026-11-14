import { fakeJira, SITE, type FakeJira, type FakeJiraOptions } from '../fakes/jira.js';

/**
 * Atlassian as squad-kit's sign-in meets it, made up: squad-kit's sign-in helper (auth.squad-kit.com, which passes
 * Atlassian's token endpoint on), Atlassian's accessible-resources, and each Jira site through the gateway
 * (api.atlassian.com/ex/jira/<cloud id>), answered by the fake Jira. In the shapes of Atlassian's OAuth 2.0 (3LO) docs:
 * a code for a pair, refresh tokens that rotate, `invalid_grant` for a refresh token Atlassian no longer takes.
 */

export const CLOUD = '1324a887-45db-1bf4-1e99-ef0ff456d421';
export const OTHER = { id: '9a8b7c6d-0000-4e5f-8a9b-0c1d2e3f4a5b', url: 'https://globex.atlassian.net', name: 'Globex', host: 'globex.atlassian.net' };
const JIRA_SCOPES = ['read:jira-work', 'write:jira-work', 'read:jira-user', 'read:sprint:jira-software'];

export interface FakeAtlassian {
  fetch: typeof fetch;
  jira: FakeJira;
  /** The pair Atlassian would take now. */
  now: { access: string; refresh: string };
  /** What reached the helper and Atlassian: the address, and the sign-in it carried (never shown in a failure). */
  calls: { url: string; auth: string | null; body?: Record<string, string> }[];
  /** The sites a new token reaches, with Confluence's beside them. */
  sites: { id: string; url: string; name: string; scopes: string[]; avatarUrl: string }[];
  /** Atlassian takes no refresh token any more (revoked, or unused for 90 days). */
  revoked: boolean;
  /** Nothing answers: offline. */
  offline: boolean;
  /** Runs when a refresh token Atlassian does not take arrives, before it says no. */
  onRefused?: () => void;
  /** While set, a refresh waits for it before Atlassian answers: two refreshes at once, a Disconnect on the way. */
  gate?: Promise<void>;
  /**
   * The gateway answers every Jira call with a 401: true, "scope does not match" (the app lacks a permission, or an
   * admin removed it); a text, these words instead.
   */
  scopeMissing: boolean | string;
}

export const GOOD_CODE = 'good-code';

export function fakeAtlassian(opts: { jira?: FakeJiraOptions; sites?: 'one' | 'two' | 'other' | 'none'; scopeMissing?: boolean | string } = {}): FakeAtlassian {
  let n = 1;
  const site = (id: string, url: string, name: string, scopes = JIRA_SCOPES) => ({ id, url, name, scopes, avatarUrl: 'https://site-admin-avatar-cdn.prod.public.atl-paas.net/avatars/240/rocket.png' });
  const acme = site(CLOUD, `https://${SITE}`, 'Acme');
  const globex = site(OTHER.id, OTHER.url, OTHER.name);
  const wiki = site('c0ffee00-1111-2222-3333-444455556666', 'https://acme-wiki.atlassian.net', 'Acme wiki', ['read:confluence-content.all']);
  const which = opts.sites ?? 'one';
  const f: FakeAtlassian = {
    fetch: null as never,
    jira: null as never,
    now: { access: 'at-1', refresh: 'rt-1' },
    calls: [],
    sites: which === 'none' ? [wiki] : which === 'other' ? [globex, wiki] : which === 'two' ? [acme, globex, wiki] : [acme, wiki],
    revoked: false,
    offline: false,
    scopeMissing: opts.scopeMissing ?? false,
  };
  f.jira = fakeJira('secret', {
    ...opts.jira,
    cloud: {
      id: CLOUD,
      bearer: () => f.now.access,
      get scopeMissing() {
        return f.scopeMissing;
      },
    },
  });
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const pair = () => ({ access_token: f.now.access, refresh_token: f.now.refresh, expires_in: 3600, scope: 'read:jira-work write:jira-work read:jira-user offline_access' });
  f.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const auth = new Headers(init?.headers).get('authorization');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, string>) : undefined;
    f.calls.push({ url: url.href, auth, ...(body ? { body } : {}) });
    // As Node's fetch says it: no connection could be made.
    if (f.offline) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    if (url.href === 'https://auth.squad-kit.com/atlassian/token') {
      if (body?.code !== GOOD_CODE) return json({ error: 'invalid_grant', error_description: 'Invalid authorization code.' }, 403);
      return json(pair());
    }
    if (url.href === 'https://auth.squad-kit.com/atlassian/refresh') {
      await f.gate;
      if (f.offline) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
      if (f.revoked || body?.refresh_token !== f.now.refresh) {
        f.onRefused?.();
        return json({ error: 'invalid_grant', error_description: 'Unknown or invalid refresh token.' }, 403);
      }
      n += 1;
      f.now = { access: `at-${n}`, refresh: `rt-${n}` };
      return json(pair());
    }
    if (url.href === 'https://api.atlassian.com/oauth/token/accessible-resources') {
      if (auth !== `Bearer ${f.now.access}`) return json({ code: 401, message: 'Unauthorized' }, 401);
      return json(f.sites);
    }
    if (url.host === 'api.atlassian.com' && url.pathname.startsWith(`/ex/jira/${OTHER.id}/`)) {
      if (auth !== `Bearer ${f.now.access}`) return json({ code: 401, message: 'Unauthorized' }, 401);
      return json({ accountId: '5b10a2844c20165700ede21g', displayName: 'Sara Ali', emailAddress: 'sara@globex.test', active: true });
    }
    return f.jira.fetch(input, init);
  }) as typeof fetch;
  return f;
}
