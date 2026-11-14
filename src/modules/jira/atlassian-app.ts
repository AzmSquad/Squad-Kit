/**
 * squad-kit's own Atlassian app, for "Sign in with Atlassian" (ADR-012): OAuth 2.0 (3LO). Atlassian asks for the app's
 * client secret on every code exchange and refresh, so those two go through squad-kit's sign-in helper at
 * auth.squad-kit.com (`auth-helper/` in squad-kit's repo), which keeps the secret and stores nothing. The client id is
 * public. Until the app is registered it is the placeholder, and Jira keeps the pasted token only.
 */

const NOT_SET = 'ATLASSIAN_CLIENT_ID_NOT_SET';
/** squad-kit's Atlassian app (developer.atlassian.com). The same id is in auth-helper/wrangler.jsonc. */
const CLIENT_ID: string = NOT_SET;

const HELPER = 'https://auth.squad-kit.com';
/** Where Atlassian sends the person back: the helper, which sends them on to squad-kit on 127.0.0.1. */
const REDIRECT_URI = `${HELPER}/atlassian/callback`;
/** Atlassian's API gateway: the only host the sign-in's bearer token ever goes to. */
export const GATEWAY = 'https://api.atlassian.com';

/**
 * What squad-kit asks for, each for a call the Jira module makes. Classic: read:jira-work (search, issues, fields,
 * statuses, link types, projects, transitions, issue properties, attachments, editmeta), write:jira-work (create and
 * edit issues, transitions, comments, labels, links, issue properties, createmeta), read:jira-user (/myself). Jira
 * Software's board and sprint calls take granular scopes only: boards (read:board-scope:jira-software,
 * read:project:jira), one board (read:board-scope:jira-software, read:issue-details:jira), sprints
 * (read:sprint:jira-software). offline_access gives the refresh token, so the sign-in lasts.
 */
export const SCOPES = [
  'read:jira-work',
  'write:jira-work',
  'read:jira-user',
  'read:board-scope:jira-software',
  'read:sprint:jira-software',
  'read:project:jira',
  'read:issue-details:jira',
  'offline_access',
];

/** Atlassian keeps a code for a while; squad-kit's door stays open 15 minutes at most. */
const PACE = { lifeMs: 15 * 60_000 };

let app: { clientId: string; fetch?: typeof fetch; lifeMs: number } = { clientId: CLIENT_ID, lifeMs: PACE.lifeMs };

/** Tests use their own app id, a made-up Atlassian and a shorter wait. Null goes back to the real ones. */
export function useAtlassianApp(p: { clientId?: string; fetch?: typeof fetch; lifeMs?: number } | null): void {
  app = { clientId: p?.clientId ?? CLIENT_ID, ...(p?.fetch ? { fetch: p.fetch } : {}), lifeMs: p?.lifeMs ?? PACE.lifeMs };
}

/** The app is registered: Sign in with Atlassian works. Else Jira keeps the pasted token only, so nothing half-works. */
export function atlassianReady(): boolean {
  return app.clientId !== NOT_SET && /^[A-Za-z0-9_-]{8,128}$/.test(app.clientId);
}

/** The fetch the sign-in calls the helper and Atlassian with. */
export function atlassianFetch(): typeof fetch {
  return app.fetch ?? ((url, init) => fetch(url, init));
}

export function signInLife(): number {
  return app.lifeMs;
}

/** Atlassian's consent page, where the person picks their Jira site and presses Accept. */
export function authorizeUrl(state: string): string {
  const q: [string, string][] = [
    ['audience', 'api.atlassian.com'],
    ['client_id', app.clientId],
    ['scope', SCOPES.join(' ')],
    ['redirect_uri', REDIRECT_URI],
    ['state', state],
    ['response_type', 'code'],
    ['prompt', 'consent'],
  ];
  // Spaces as %20, as Atlassian's own examples write them.
  return `https://auth.atlassian.com/authorize?${q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

/** The helper's two routes: a code for the first pair, a refresh token for a new one. */
export const helperUrl = (route: 'token' | 'refresh') => `${HELPER}/atlassian/${route}`;
