/**
 * squad-kit's own Atlassian app, for "Sign in with Atlassian" (ADR-012): OAuth 2.0 (3LO). Atlassian asks for the app's
 * client secret on every code exchange and refresh, so those two go through squad-kit's sign-in helper at
 * auth.squad-kit.com (`auth-helper/` in squad-kit's repo), which keeps the secret and stores nothing. The client id is
 * public. Without it (the placeholder), Jira keeps the pasted token only.
 */

const NOT_SET = 'ATLASSIAN_CLIENT_ID_NOT_SET';
/** squad-kit's Atlassian app (developer.atlassian.com). The same id is in auth-helper/wrangler.jsonc. */
const CLIENT_ID: string = 'ebxInlq1dxpw4jrSLlghUTsuJHaasD1C';

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

/**
 * lifeMs: squad-kit's door stays open 15 minutes at most. settleMs: after Atlassian refuses a refresh token, the wait
 * before the file is read again (another squad-kit may have just written a newer one). lockWaitMs: how long a refresh
 * waits for another one on this computer to finish.
 */
const PACE = { lifeMs: 15 * 60_000, settleMs: 1000, lockWaitMs: 75_000 };
type Pace = typeof PACE;

let app: { clientId: string; fetch?: typeof fetch; pace: Pace } = { clientId: CLIENT_ID, pace: PACE };

/** Tests use their own app id, a made-up Atlassian and shorter waits. Null goes back to the real ones. */
export function useAtlassianApp(p: ({ clientId?: string; fetch?: typeof fetch } & Partial<Pace>) | null): void {
  app = {
    clientId: p?.clientId ?? CLIENT_ID,
    ...(p?.fetch ? { fetch: p.fetch } : {}),
    pace: { lifeMs: p?.lifeMs ?? PACE.lifeMs, settleMs: p?.settleMs ?? PACE.settleMs, lockWaitMs: p?.lockWaitMs ?? PACE.lockWaitMs },
  };
}

/** The app is registered: Sign in with Atlassian works. Else Jira keeps the pasted token only, so nothing half-works. */
export function atlassianReady(): boolean {
  return app.clientId !== NOT_SET && /^[A-Za-z0-9_-]{8,128}$/.test(app.clientId);
}

/** The fetch the sign-in calls the helper and Atlassian with. */
export function atlassianFetch(): typeof fetch {
  return app.fetch ?? ((url, init) => fetch(url, init));
}

export function atlassianPace(): Pace {
  return app.pace;
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

/**
 * The scope a Jira call needs, from the list above, to name it when Atlassian says "scope does not match": Jira
 * Software's boards and sprints, /myself, else reading or writing work.
 */
export function scopeFor(method: string, path: string): string {
  const p = path.replace(/\?.*$/, '');
  if (/^\/rest\/agile\/1\.0\/board\/\d+\/sprint/.test(p)) return 'read:sprint:jira-software';
  if (/^\/rest\/agile\/1\.0\/board\/\d+$/.test(p)) return 'read:board-scope:jira-software, read:issue-details:jira';
  if (/^\/rest\/agile\//.test(p)) return 'read:board-scope:jira-software, read:project:jira';
  if (p === '/rest/api/3/myself') return 'read:jira-user';
  return method === 'GET' || p === '/rest/api/3/search/jql' ? 'read:jira-work' : 'write:jira-work';
}

/** The helper's two routes: a code for the first pair, a refresh token for a new one. */
export const helperUrl = (route: 'token' | 'refresh') => `${HELPER}/atlassian/${route}`;
