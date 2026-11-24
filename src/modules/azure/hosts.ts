/**
 * Azure DevOps' own hosts: dev.azure.com and <organization>.visualstudio.com. A sign-in header (the token, or the
 * Microsoft sign-in) is only ever made for one of these: for git, and for a work item's files.
 */

const AZURE_HOST = /^(?:dev\.azure\.com|[a-z0-9-]+\.visualstudio\.com)$/i;

/** The Azure DevOps host of an https address (no port), or null for any other. */
export function azureHost(url: string): string | null {
  if (!/^https:\/\//i.test(url)) return null;
  try {
    const host = new URL(url).host;
    return AZURE_HOST.test(host) ? host : null;
  } catch {
    return null;
  }
}

/** Where a git remote lives on Azure Repos, or null for any other host. */
export function parseAzureRemote(url: string): { organization: string; project: string; repo: string } | null {
  const clean = url.trim().replace(/\.git$/, '');
  const patterns = [
    /^https:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/i,
    /^https:\/\/(?:[^@/]+@)?([a-z0-9-]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)/i,
    /^(?:ssh:\/\/)?git@ssh\.dev\.azure\.com:(?:22\/)?v3\/([^/]+)\/([^/]+)\/([^/]+)$/i,
  ];
  for (const p of patterns) {
    const m = clean.match(p);
    if (m?.[1] && m[2] && m[3]) return { organization: decodeURIComponent(m[1]), project: decodeURIComponent(m[2]), repo: decodeURIComponent(m[3]) };
  }
  return null;
}

/** Azure DevOps' own pages under an organization, never a project's name: `_usersSettings`, `_apis`, `_git`. */
const NOT_A_PROJECT = /^_/;

/**
 * The organization and project of an Azure Boards address a person pasted from their browser: any page of the project
 * on dev.azure.com or <organization>.visualstudio.com, with or without https://, or plainly `organization/project`.
 * Null when it names no project.
 */
export function parseBoardAddress(text: string): { organization: string; project: string } | null {
  const t = text.trim().replace(/^https?:\/\//i, '').replace(/[?#].*$/, '');
  if (!t) return null;
  const parts = t.split('/').filter(Boolean);
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s).trim();
    } catch {
      return s.trim();
    }
  };
  let org: string | undefined;
  let rest: string[];
  const vs = /^([a-z0-9-]+)\.visualstudio\.com$/i.exec(parts[0] ?? '');
  if (/^dev\.azure\.com$/i.test(parts[0] ?? '')) [org, ...rest] = parts.slice(1);
  else if (vs) [org, rest] = [vs[1], parts.slice(1).filter((p, i) => !(i === 0 && /^DefaultCollection$/i.test(p)))];
  else if (parts.length === 2 && !parts[0]!.includes('.')) [org, ...rest] = parts;
  else return null;
  const project = rest[0] ? decode(rest[0]) : '';
  if (!org || !/^[a-z0-9][a-z0-9-]*$/i.test(org) || !project || NOT_A_PROJECT.test(project)) return null;
  return { organization: org, project };
}
