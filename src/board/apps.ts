import { copyViews } from '../engine/copies.js';
import { repoFor, reposOf } from '../engine/repos.js';
import { repoLabel, repoRuns } from './parts.js';
import type { BoardMeta, ProjectCommands, Ticket } from './types.js';

/** One app the project runs: a code repo with a start command and a web address. Either may not be known yet. */
export interface ProjectApp {
  name: string;
  repo: string;
  /** The branch it runs: main, with every ticket the person accepted. */
  base: string;
  url?: string;
  start?: string;
  /** Runs first in a new copy, and whenever the dependency files change. */
  setup?: string;
}

/**
 * Every app in the project: each code repo with a web address or a start command. A live project that knows neither
 * yet still lists its repos, so the person can ask the Architect or type the command. A sample board, or a project
 * with no code yet, lists only what it knows.
 */
/** Saved commands of a phone app: Flutter, Xcode, React Native or Expo. */
const PHONE_COMMANDS = /(?:^|[\s;&|(])(?:flutter|xcodebuild)\s|\b(?:expo|react-native)\s/m;

export function projectApps(meta: BoardMeta): ProjectApp[] {
  const all = reposOf(meta).filter((r) => repoRuns(meta, r.path)).map((r) => ({
    name: r.path === '.' ? meta.project : (repoLabel(meta, r.path) ?? r.path),
    repo: r.path,
    base: r.base,
    ...(r.commands.url?.trim() ? { url: r.commands.url.trim() } : {}),
    ...(r.commands.start?.trim() ? { start: r.commands.start.trim() } : {}),
    ...(r.commands.setup?.trim() ? { setup: r.commands.setup.trim() } : {}),
  }));
  // A phone app runs on squad-kit's iPhone with no start command of its own: its saved checks say what it is.
  const phone = new Set(reposOf(meta).filter((r) => PHONE_COMMANDS.test(Object.values(r.commands).join('\n'))).map((r) => r.path));
  const known = all.filter((a) => a.url || a.start || phone.has(a.repo));
  // A folder that started empty has no app to find while the Architect reads what the person wants to build.
  const noCode = meta.scan?.empty || (meta.setup?.kind === 'empty' && meta.scan?.status !== 'done');
  if (known.length || meta.engine !== 'live' || noCode) return known;
  return all;
}

/** The app a person names, by its name or its folder, in any case. With one app, no name is needed. */
export function findApp(meta: BoardMeta, ref?: string): ProjectApp {
  const apps = projectApps(meta);
  if (!apps.length) throw new Error('This project has no app to run yet. Set its start command in Settings, under How the squad checks and runs this project.');
  const asked = ref?.trim().toLowerCase();
  if (!asked) {
    if (apps.length === 1) return apps[0]!;
    throw new Error(`This project has ${apps.length} apps: ${apps.map((a) => a.name).join(', ')}. Name one, for example: squad app start ${apps[0]!.name}`);
  }
  const app = apps.find((a) => a.name.toLowerCase() === asked || a.repo.toLowerCase() === asked);
  if (!app) throw new Error(`There is no app called "${ref}". This project's apps: ${apps.map((a) => a.name).join(', ')}.`);
  return app;
}

/** "Type it": the app's start command and address, saved in the project's settings. Empty fields keep what is there. */
export function withAppCommands(meta: BoardMeta, repo: string, set: { start?: string; url?: string }): BoardMeta {
  const start = set.start?.trim();
  const url = set.url?.trim();
  if (!start && !url) throw new Error('Type the command that starts the app, for example npm run dev.');
  if (url && !/^https?:\/\/[^\s/]+/i.test(url)) throw new Error(`"${url}" is not a web address. Type it like http://localhost:3000`);
  const merge = (c: ProjectCommands = {}): ProjectCommands => ({ ...c, ...(start ? { start } : {}), ...(url ? { url } : {}) });
  if (meta.repos?.length) {
    if (!meta.repos.some((r) => r.path === repo)) throw new Error(`There is no code repo at ${repo}.`);
    return { ...meta, repos: meta.repos.map((r) => (r.path === repo ? { ...r, commands: merge(r.commands) } : r)) };
  }
  return { ...meta, commands: merge(meta.commands) };
}

/** A ticket in the code the app runs. */
export interface AppTicket {
  id: string;
  title: string;
}

/** A ticket merged into the app's repo after the app started: "RO-5 is in main · Run the new version". */
export interface NewVersion extends AppTicket {
  /** The branch it went into. */
  base: string;
  release?: string;
}

/** How long after a merge an app that is not running still offers the new version. */
const NEW_FOR_MS = 24 * 60 * 60_000;

/**
 * What the app's code holds: the newest tickets merged before it started, and the newest one merged since it last
 * started, unless the person said Not now to it. An app that is not running offers only a merge of the last day.
 */
export function appNews(
  meta: BoardMeta,
  tickets: Ticket[],
  app: { repo: string; state: string; startedAt?: string },
  notNow: string[] = [],
  now = Date.now(),
): { includes: AppTicket[]; fresh?: NewVersion } {
  const merged = tickets
    .filter((t) => t.mergedAt && copyViews(meta, t).some((v) => repoFor(meta, v).path === app.repo))
    .sort((a, b) => b.mergedAt!.localeCompare(a.mergedAt!));
  const runs = app.state === 'running' || app.state === 'starting';
  const since = app.startedAt;
  const includes = runs && since ? merged.filter((t) => t.mergedAt! <= since).slice(0, 3).map((t) => ({ id: t.id, title: t.title })) : [];
  if (app.state === 'starting') return { includes };
  const fresh = merged.find((t) => (!since || t.mergedAt! > since) && (runs || now - Date.parse(t.mergedAt!) < NEW_FOR_MS) && !notNow.includes(t.id));
  if (!fresh) return { includes };
  const base = repoFor(meta, fresh).base;
  return { includes, fresh: { id: fresh.id, title: fresh.title, base, ...(fresh.release ? { release: fresh.release } : {}) } };
}

/** Any answer counts, even an error page: the server is running. */
export async function isUp(url: string): Promise<boolean> {
  for (const u of new Set([url, url.replace('://localhost', '://127.0.0.1')])) {
    try {
      await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(1500) });
      return true;
    } catch {
      // Nothing answers there.
    }
  }
  return false;
}
