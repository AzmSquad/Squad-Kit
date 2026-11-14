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
