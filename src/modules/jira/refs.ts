/**
 * How Jira names things: a site (yourcompany.atlassian.net), a project key (PAY) and an issue key (PAY-40). An issue's
 * id in squad-kit is its key, and the ticket on the board has the same name. A pasted Jira link works wherever a site,
 * a project or an issue is asked for.
 */

const ISSUE = /^([A-Za-z][A-Za-z0-9_]+)-(\d+)$/;
const PROJECT = /^[A-Za-z][A-Za-z0-9_]+$/;

function urlOf(text: string): URL | null {
  try {
    return new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
}

export { siteOf } from '../../tracker/jira-site.js';

/** The issue key in a Jira link: /browse/PAY-40, or ?selectedIssue=PAY-40 on a board. */
function keyInLink(text: string): string | null {
  const url = /^https?:\/\//i.test(text) ? urlOf(text) : null;
  if (!url) return null;
  const key = /\/browse\/([A-Za-z][A-Za-z0-9_]+-\d+)/.exec(url.pathname)?.[1] ?? url.searchParams.get('selectedIssue');
  return key && ISSUE.test(key) ? key.toUpperCase() : null;
}

/** The project key in what a person typed, picked or pasted: "PAY", "pay", or a link to the project or one of its issues. */
export function projectOf(text: string | undefined): string | null {
  const t = (text ?? '').trim();
  if (PROJECT.test(t)) return t.toUpperCase();
  const key = keyInLink(t);
  if (key) return key.split('-')[0]!;
  const inPath = /\/projects\/([A-Za-z][A-Za-z0-9_]+)(?:\/|$)/.exec(urlOf(t)?.pathname ?? '')?.[1];
  return inPath ? inPath.toUpperCase() : null;
}

/** The issue in what a person typed: PAY-40, pay-40, 40 in the project, or the issue's link. */
export function parseRef(text: string, project?: string): string | null {
  const t = text.trim();
  const linked = keyInLink(t);
  if (linked) return linked;
  const m = ISSUE.exec(t);
  if (m) return Number(m[2]) > 0 ? t.toUpperCase() : null;
  const n = /^#?(\d+)$/.exec(t)?.[1];
  return n && project && Number(n) > 0 ? `${project}-${Number(n)}` : null;
}

/** How people write an issue: its key. A bare number is in the project. */
export function refOf(id: string, project?: string): string {
  return /^\d+$/.test(id) && project ? `${project}-${id}` : id.toUpperCase();
}

/** The project an issue key belongs to. */
export function projectOfKey(key: string): string {
  return key.split('-')[0]!.toUpperCase();
}

/** A value as a JQL string: in quotes, with its backslashes and quotes escaped. */
export function jqlText(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
