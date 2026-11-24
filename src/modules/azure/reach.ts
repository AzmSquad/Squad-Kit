import { ModuleError } from '../errors.js';
import { Azure, type AzureTarget } from './client.js';

/**
 * What a sign-in reaches on Azure DevOps, so connecting never asks a person to type names: the organizations of the
 * Microsoft account in the directory az signed in to (Azure DevOps' own profile and accounts pages), and each one's
 * projects. The Connections page lists them, and the person picks the one their stories come from. Also: whether one
 * project is really there, so the page says Connected only when squad-kit can reach the project itself.
 */

export interface AzureProjectRef {
  organization: string;
  project: string;
}

const VSSPS = 'https://app.vssps.visualstudio.com/_apis';
/** A person in more organizations than this picks by pasting the address. */
const MAX_ORGS = 20;
const KEEP_MS = 60_000;

/** Kept for one token: a new sign-in, or another directory's token, asks again. */
let kept: { at: number; token: string; list: AzureProjectRef[] } | null = null;

const devops = (auth: Pick<AzureTarget, 'pat' | 'bearer'>, organization = '') => new Azure({ organization, project: '', ...auth });
const orgUrl = (org: string) => `https://dev.azure.com/${encodeURIComponent(org)}`;

/** One organization's projects, by name, or none when this sign-in cannot read them (not a member there any more). */
async function projectsOf(auth: Pick<AzureTarget, 'pat' | 'bearer'>, org: string): Promise<AzureProjectRef[]> {
  try {
    const r = await devops(auth, org).call<{ value?: { name: string; state?: string }[] }>('GET', `${orgUrl(org)}/_apis/projects?$top=500&api-version=7.1`);
    return (r?.value ?? [])
      .filter((p) => !p.state || p.state === 'wellFormed')
      .map((p) => ({ organization: org, project: p.name }))
      .sort((a, b) => a.project.localeCompare(b.project));
  } catch (err) {
    // Not reaching Azure DevOps is said for the whole list; one organization saying no is left out.
    if (err instanceof ModuleError && err.kind === 'offline') throw err;
    return [];
  }
}

/**
 * Every project the Microsoft sign-in reaches with this token, organization by organization, kept a minute. Throws what
 * Azure DevOps said when it could not be asked (offline, the sign-in refused).
 */
export async function reachable(token: string): Promise<AzureProjectRef[]> {
  if (kept && kept.token === token && Date.now() - kept.at < KEEP_MS) return kept.list;
  const bearer = () => Promise.resolve(token);
  const az = devops({ bearer });
  const me = await az.call<{ id?: string }>('GET', `${VSSPS}/profile/profiles/me?api-version=7.1`);
  if (!me?.id) return [];
  const orgs = await az.call<{ value?: { accountName: string }[] }>('GET', `${VSSPS}/accounts?memberId=${encodeURIComponent(me.id)}&api-version=7.1`);
  const names = (orgs?.value ?? []).map((o) => o.accountName).filter(Boolean).slice(0, MAX_ORGS);
  const list = (await Promise.all(names.map((org) => projectsOf({ bearer }, org)))).flat();
  kept = { at: Date.now(), token, list };
  return list;
}

/** Check again, a new sign-in, a pick: ask Azure DevOps afresh. */
export function forgetReach(): void {
  kept = null;
}

const notFound = (err: unknown) => err instanceof ModuleError && err.kind === 'not-found';
const refusedHere = (err: unknown) => err instanceof ModuleError && err.kind === 'sign-in';

/**
 * The project as Azure DevOps names it, or null when the organization has no such project (a typo, a project renamed
 * or gone). A token made without the right to read projects is refused there though it works for work items and code:
 * the project's work item types then say whether it is there (its own name as typed). Not reaching Azure DevOps is
 * thrown as it said it.
 */
export async function projectThere(auth: Pick<AzureTarget, 'pat' | 'bearer' | 'refused'>, place: AzureProjectRef): Promise<string | null> {
  const az = new Azure({ organization: place.organization, project: place.project, ...auth });
  const project = encodeURIComponent(place.project);
  try {
    const p = await az.call<{ name?: string }>('GET', `${orgUrl(place.organization)}/_apis/projects/${project}?api-version=7.1`);
    return p?.name ?? place.project;
  } catch (err) {
    if (notFound(err)) return null;
    if (!refusedHere(err)) throw err;
  }
  try {
    await az.call('GET', `${orgUrl(place.organization)}/${project}/_apis/wit/workitemtypes?api-version=7.1`);
    return place.project;
  } catch (err) {
    if (notFound(err)) return null;
    // Refused here too: nothing tells; the place stays as named and the calls themselves say what is wrong.
    if (refusedHere(err)) return place.project;
    throw err;
  }
}
