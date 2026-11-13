import fs from 'node:fs';
import path from 'node:path';
import { readMeta, type BoardPaths } from '../../board/store.js';
import { BoardActionError } from '../../board/actions/errors.js';
import { forkHostFor } from '../../modules/registry.js';
import type { ForkHost, HostSignIn } from '../../modules/code-host/types.js';
import { git } from '../git.js';
import { reposOf } from '../repos.js';
import { selfRepo, selfUpstream } from '../self-project.js';
import { catchUp, type RepoPlace } from './catch-up.js';

/**
 * The contribution checklist of squad-kit's own code, for people with no git background: signed in to the code host,
 * a copy of their own (a fork), up to date with the main repo, the rules the checks hold, and a way to tell the
 * maintainers about a big idea first. squad-kit can do each item itself (one REST call and one terminal command each):
 * make the copy, bring it up to date. The idea is a link the person sends; squad-kit posts nothing in their name.
 */

export interface ChecklistAction {
  id: 'fork' | 'sync' | 'idea';
  name: string;
  route: string;
  command: string;
}

export interface ChecklistItem {
  id: 'sign-in' | 'copy' | 'up-to-date' | 'rules' | 'idea';
  title: string;
  /** done: a green check. todo: squad-kit can do it (the action). blocked: something must come first, or a person. info: to read. */
  state: 'done' | 'todo' | 'blocked' | 'info';
  line: string;
  steps?: string[];
  points?: string[];
  link?: string;
  /** A file in the person's own checkout to read. */
  file?: string;
  action?: ChecklistAction;
}

export interface Checklist {
  self: boolean;
  line: string;
  host?: string;
  /** "owner/name" of the main repo, and of the person's own copy. */
  main?: string;
  copy?: string;
  items: ChecklistItem[];
}

const FORK: ChecklistAction = { id: 'fork', name: 'Make my copy', route: 'POST /api/v1/contribute/fork', command: 'squad contribute --fork' };
const SYNC: ChecklistAction = { id: 'sync', name: 'Bring it up to date', route: 'POST /api/v1/contribute/sync', command: 'squad contribute --sync' };
const IDEA: ChecklistAction = { id: 'idea', name: 'Tell the maintainers first', route: 'POST /api/v1/contribute/idea', command: 'squad contribute --idea <title> --text <words>' };

interface SelfPlace extends RepoPlace {
  /** The upstream remote's address, '' with none. */
  upstreamRemote: string;
}

const remoteUrl = (dir: string, name: string) => git(dir, ['config', '--get', `remote.${name}.url`], { allowFail: true }).trim();

/** squad-kit's own code in this project: its folder, remote, base, the main repo it goes to, and its upstream remote. */
function selfPlace(bp: BoardPaths): SelfPlace | null {
  const meta = readMeta(bp);
  const rel = selfRepo(bp.root, meta);
  if (rel === null) return null;
  const repo = reposOf(meta).find((r) => r.path === rel)!;
  const dir = path.join(bp.root, rel);
  const remote = repo.remote || 'origin';
  return { dir, remote, base: repo.base, url: remoteUrl(dir, remote), upstream: selfUpstream(dir, remote), upstreamRemote: remote === 'upstream' ? '' : remoteUrl(dir, 'upstream') };
}

function count(file: string, of: (j: Record<string, unknown>) => number): number | null {
  try {
    return of(JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>);
  } catch {
    return null;
  }
}

/** What the checks hold, read from the person's own checkout. */
function rulesItem(dir: string): ChecklistItem {
  const caps = count(path.join(dir, 'test/architecture/file-size-caps.json'), (j) => Object.keys(j).length);
  const routes = count(path.join(dir, 'test/architecture/rest-commands.json'), (j) => Object.keys((j.commands as object) ?? {}).length);
  return {
    id: 'rules',
    title: 'The rules the checks hold',
    state: 'info',
    line: "squad-kit's own tests check these on every story, so a story that breaks one fails its checks.",
    points: [
      `Small files: a source file stays under 600 lines${caps ? `; the ${caps} older big files may only shrink` : ''} (test/architecture/file-size-caps.json).`,
      'The layers: the board talks to the engine over REST only, and outside tools are modules (test/architecture/layers.test.ts, test/module-boundaries.test.ts).',
      `Every button has its terminal command${routes ? `: ${routes} board actions, each one REST call and one squad command` : ''} (test/architecture/rest-commands.json).`,
      'The npm package stays under 5 MB (pnpm size:guard).',
    ],
    file: path.join(dir, 'CONTRIBUTING.md'),
    link: "CONTRIBUTING.md, \"Rules for squad-kit's own code\"",
  };
}

function ideaItem(main: string | undefined): ChecklistItem {
  return {
    id: 'idea',
    title: 'A big idea?',
    state: 'info',
    line: `Tell the maintainers first${main ? ` of ${main}` : ''}: a new page, a new integration or a big change is better planned together. squad-kit opens the new issue page with your idea filled in, and you send it.`,
    ...(main ? { action: IDEA } : {}),
  };
}

function signInItem(s: HostSignIn, label: string): ChecklistItem {
  if (s.state === 'ready') return { id: 'sign-in', title: `Signed in to ${label}`, state: 'done', line: `Signed in as ${s.account ?? 'you'}.` };
  const why = s.state === 'missing' ? `${label}'s own tool is not on this computer.` : `${label}'s own tool is here, but not signed in.`;
  return { id: 'sign-in', title: `Signed in to ${label}`, state: 'todo', line: `${why} squad-kit signs in through it, and keeps no password.`, steps: s.steps, link: s.link };
}

/** The main repo: the upstream remote's, else the package's (it wins over the host's own parent), else the parent, else the remote's own. */
function mainOf(forks: ForkHost, p: SelfPlace, origin: string, parent?: string): string {
  return forks.repoName(p.upstream ?? '') ?? parent ?? origin;
}

export async function contributeChecklist(bp: BoardPaths): Promise<Checklist> {
  const p = selfPlace(bp);
  if (!p) return { self: false, line: "This project is not squad-kit's own code, so it has no contribution checklist.", items: [] };
  const fh = forkHostFor(p.url);
  const origin = fh?.forks.repoName(p.url);
  if (!fh || !origin) return { self: true, line: `This copy of squad-kit's code has no remote on a code host squad-kit can work with, so only the rules apply.`, items: [rulesItem(p.dir)] };
  const sign = await fh.forks.signIn();
  const items: ChecklistItem[] = [signInItem(sign, fh.label)];
  if (sign.state !== 'ready') {
    const main = mainOf(fh.forks, p, origin);
    const first = `Sign in to ${fh.label} first.`;
    items.push({ id: 'copy', title: 'Your own copy', state: 'blocked', line: first }, { id: 'up-to-date', title: `Up to date with ${main}`, state: 'blocked', line: first }, rulesItem(p.dir), ideaItem(main));
    return { self: true, line: `Sign in to ${fh.label}, and squad-kit can do the rest of this list for you.`, host: fh.label, main, items };
  }
  const info = await fh.forks.repoInfo(origin);
  const main = mainOf(fh.forks, p, origin, info.parent);
  const same = origin.toLowerCase() === main.toLowerCase();
  if (info.parent) {
    items.push({ id: 'copy', title: 'Your own copy', state: 'done', line: `${origin}, a copy of ${main}. Your stories go to ${main} as pull requests from it.` });
    const { behind, ahead } = await fh.forks.compareFork(origin, main, p.base);
    if (ahead > 0) items.push({ id: 'up-to-date', title: `Up to date with ${main}`, state: 'blocked', line: `${p.base} of your copy has ${ahead === 1 ? 'a change' : `${ahead} changes`} that ${main} does not have, so squad-kit does not bring it up to date by itself. Nothing is forced.` });
    else if (behind > 0) items.push({ id: 'up-to-date', title: `Up to date with ${main}`, state: 'todo', line: `Your copy is ${behind === 1 ? 'one change' : `${behind} changes`} behind ${main}. Bring it up to date before your next story, so it starts from the newest code.`, action: SYNC });
    else items.push({ id: 'up-to-date', title: `Up to date with ${main}`, state: 'done', line: `Your copy has everything in ${p.base} of ${main}.`, action: SYNC });
  } else if (same && !info.canPush) {
    items.push({ id: 'copy', title: 'Your own copy', state: 'todo', line: `You can't send changes to ${main} itself. squad-kit makes your own copy of it (a fork) on ${fh.label}, then sends your stories from there as pull requests.`, action: FORK });
    items.push({ id: 'up-to-date', title: `Up to date with ${main}`, state: 'blocked', line: 'Make your own copy first.' });
  } else {
    items.push({ id: 'copy', title: 'Your own copy', state: 'done', line: same ? `You can send changes to ${main} itself: you are one of its maintainers.` : `${origin}, with ${main} as the repo your stories go to.` });
    items.push({ id: 'up-to-date', title: `Up to date with ${main}`, state: 'info', line: `Your stories start from ${p.base} as squad-kit last fetched it.` });
  }
  items.push(rulesItem(p.dir), ideaItem(main));
  const left = items.filter((i) => i.state === 'todo' || i.state === 'blocked').length;
  return { self: true, line: left ? `${left === 1 ? 'One thing' : `${left} things`} before your first pull request.` : 'Ready: your stories go as pull requests.', host: fh.label, main, copy: info.parent ? origin : undefined, items };
}

function ready(bp: BoardPaths): { p: SelfPlace; forks: ForkHost; origin: string } {
  const p = selfPlace(bp);
  if (!p) throw new BoardActionError("This project is not squad-kit's own code.");
  const fh = forkHostFor(p.url);
  const origin = fh?.forks.repoName(p.url);
  if (!fh || !origin) throw new BoardActionError('Its remote is not on a code host squad-kit can work with.');
  return { p, forks: fh.forks, origin };
}

/**
 * Make my copy: the person's own copy of the main repo on the code host, then `origin` points at it (in the same kind
 * of address as before) and `upstream` at the main repo. No history is deleted or rewritten.
 */
export async function makeMyCopy(bp: BoardPaths): Promise<{ line: string; checklist: Checklist }> {
  const { p, forks, origin } = ready(bp);
  if ((await forks.signIn()).state !== 'ready') throw new BoardActionError('Sign in first: squad contribute shows the steps.');
  const info = await forks.repoInfo(origin);
  if (info.parent) throw new BoardActionError(`${origin} is your own copy already, of ${info.parent}.`);
  if (info.canPush) throw new BoardActionError(`You can send changes to ${origin} itself, so you need no copy of it.`);
  const copy = await forks.makeFork(origin);
  const ssh = /^(?:git@|ssh:\/\/)/.test(p.url);
  if (!p.upstreamRemote) git(p.dir, ['remote', 'add', 'upstream', p.url]);
  git(p.dir, ['remote', 'set-url', p.remote, ssh ? copy.gitUrl.ssh : copy.gitUrl.https]);
  return { line: `Made your own copy, ${copy.repo}. ${p.remote} is your copy now${p.upstreamRemote ? '' : `, and upstream is ${origin}`}.`, checklist: await contributeChecklist(bp) };
}

/** Bring it up to date: the copy takes the main repo's newest by the host's own sync, then this computer's base moves forward. */
export async function bringCopyUpToDate(bp: BoardPaths): Promise<{ line: string; checklist: Checklist }> {
  const { p } = ready(bp);
  const r = await catchUp(bp, p);
  return { line: r.line, checklist: await contributeChecklist(bp) };
}

/**
 * Tell the maintainers first: the host's new issue page on the main repo, filled in. The person sends it. A long idea
 * does not fit in one link: the page has its start, and `rest` is the part to paste in.
 */
export function ideaPage(bp: BoardPaths, title: string, text: string): { link: string; cut: boolean; rest?: string } {
  const { p, forks, origin } = ready(bp);
  const t = title.trim();
  if (!t) throw new BoardActionError('Give your idea a short title.');
  const words = text.trim();
  const page = forks.newIssuePage(forks.repoName(p.upstream ?? '') ?? origin, t, words);
  return page.cut ? { ...page, rest: words } : page;
}
