import { reposOf } from '../engine/repos.js';
import type { BoardMeta } from './types.js';

/** One app the project runs: a code repo with a start command and a web address. */
export interface ProjectApp {
  name: string;
  repo: string;
  url: string;
  start?: string;
  /** It answered just now. */
  up: boolean;
}

/** Every app in the project, one per code repo that has a web address, and whether each one is running. */
export async function projectApps(meta: BoardMeta, probe = isUp): Promise<ProjectApp[]> {
  const apps = reposOf(meta)
    .filter((r) => r.commands.url?.trim())
    .map((r) => ({ name: r.path === '.' ? meta.project : r.path, repo: r.path, url: r.commands.url!.trim(), ...(r.commands.start ? { start: r.commands.start } : {}) }));
  return Promise.all(apps.map(async (a) => ({ ...a, up: await probe(a.url) })));
}

/** Any answer counts, even an error page: the server is running. */
async function isUp(url: string): Promise<boolean> {
  try {
    await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}
