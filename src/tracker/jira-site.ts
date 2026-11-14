/**
 * Which Jira host a saved token may go to: the one rule every Jira path follows, the tracker module (src/modules/jira)
 * and squad-kit 0.x's own Jira calls (`squad new-story --id`, the old tracker routes). A token goes only to the host
 * saved with it; the team's site in `.squad/config.yaml` never pulls it somewhere else.
 */

function urlOf(text: string): URL | null {
  try {
    return new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
}

/**
 * The site's host from what a person typed or pasted: "acme", "acme.atlassian.net" or any Jira link on it. A name only:
 * no port, no IP address and no user name or password in it, as Jira Cloud has none of these.
 */
export function siteOf(text: string | undefined): string | null {
  const t = (text ?? '').trim();
  if (!t || /\s/.test(t)) return null;
  const url = urlOf(t);
  if (!url || url.port || url.username || url.password || /^\d+(\.\d+){3}$/.test(url.hostname)) return null;
  const host = url.hostname.toLowerCase();
  if (/^[a-z0-9-]+$/.test(host)) return `${host}.atlassian.net`;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z][a-z0-9-]*$/.test(host) ? host : null;
}

export interface JiraAccess {
  /** The team's site, else the host the token was saved for. */
  site?: string;
  email?: string;
  /** Only when it was saved for `site`. */
  token?: string;
  /** The team's site, when a token is here but was saved for another host (or for none): it is not used. */
  moved?: string;
}

/** The sign-in for the team's site (`workspace`), from a sign-in whose host and token came from the same place. */
export function jiraAccess(workspace: string | undefined, saved: { host?: string; email?: string; token?: string } | undefined): JiraAccess {
  const own = siteOf(saved?.host) ?? undefined;
  const site = siteOf(workspace) ?? own;
  const token = saved?.token && own && own === site ? saved.token : undefined;
  return {
    ...(site ? { site } : {}),
    ...(saved?.email ? { email: saved.email } : {}),
    ...(token ? { token } : {}),
    ...(saved?.token && !token && site ? { moved: site } : {}),
  };
}
