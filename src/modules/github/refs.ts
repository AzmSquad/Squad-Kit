import { githubPullPage } from './pull-page.js';

/**
 * How GitHub issues are named. An issue's id is always "owner/repo#40", so it stays the same issue whichever repo the
 * project points to later. People see "#40" for the project's own repo, and "owner/repo#40" for another repo's issue,
 * as a Project board can hold. The ticket is GH-40.
 */

export interface IssueKey {
  owner: string;
  name: string;
  number: number;
}

/** "owner/name" of a GitHub git remote, or null when it lives elsewhere. */
export function repoOf(remoteUrl: string): string | null {
  return githubPullPage.repoName(remoteUrl);
}

/** "owner/name" split in two. */
export function splitRepo(repo: string): { owner: string; name: string } {
  const [owner = '', name = ''] = repo.split('/');
  return { owner, name };
}

const FULL = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The issue an id names. A bare number is in the project's own repo. */
export function keyOf(id: string, own: string): IssueKey {
  const full = FULL.exec(id);
  if (full) return { owner: full[1]!, name: full[2]!, number: Number(full[3]) };
  const number = Number(id.replace(/^#/, ''));
  if (!Number.isInteger(number) || number <= 0) throw new Error(`"${id}" is not a GitHub issue.`);
  return { ...splitRepo(own), number };
}

/** The id of an issue: "owner/repo#40", in small letters, as GitHub does not mind the case and ids must match. */
export function idOf(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`;
}

/** The issue in what a person typed: #40, 40, owner/repo#40 or the issue's address. */
export function parseRef(text: string, own: string): string | null {
  const t = text.trim();
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\/?$/i.exec(t) ?? /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(t);
  if (m) return Number(m[2]) > 0 ? idOf(m[1]!, Number(m[2])) : null;
  const n = t.replace(/^#/, '');
  return /^\d+$/.test(n) && Number(n) > 0 ? idOf(own, Number(n)) : null;
}

/** "#40" in the project's own repo, "owner/repo#40" elsewhere. */
export function refOf(id: string, own: string): string {
  const k = keyOf(id, own);
  return same(`${k.owner}/${k.name}`, own) ? `#${k.number}` : `${k.owner}/${k.name}#${k.number}`;
}

/** GH-40, or GH-OWNER-REPO-40 for another repo's issue: a board name like every other ticket's (ADR-001). */
export function ticketName(id: string, own: string): string {
  return `GH-${refOf(id, own).replace(/^#/, '')}`.replace(/[^A-Za-z0-9]+/g, '-').toUpperCase();
}
