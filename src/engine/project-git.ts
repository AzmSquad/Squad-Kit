import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { harnessFile, mergeHarness } from '../board/additions.js';
import { isPlain } from '../board/shape.js';
import { writeLog } from '../core/app-log.js';
import { writeConfigFile } from '../core/config.js';
import { boardExists, listDecisions, listReleases, listTickets, readMeta, splitTicket, ticketDir, type BoardPaths } from '../board/store.js';
import { decisionDoc, releaseDoc } from '../board/docs.js';
import type { Release, Ticket } from '../board/types.js';
import { commitArgsFor, currentBranch, git, isRepo, latestBase, remotes, gitLater, keepsCommitRules, conventionalWords } from './git.js';
import { repoFor } from './repos.js';
import { BREAKDOWN_ID, breakdownDir } from '../board/requirements-paths.js';

/**
 * The project's documents in git, for a project whose `.squad/` sits inside its one repo (ADR-001). squad-kit keeps
 * `.squad/` out of `git status` with git's local ignore list, and commits a ticket's documents on its own branch at
 * big moments, so they reach the base with its code through the pull request. A workspace of several repos keeps
 * `.squad/` in no repo, and "Put project documents in git" off commits nothing.
 */

/**
 * The repo that takes the project's documents, or null when there is none. A workspace's stories work in its code
 * repos, and squad-kit's own files never enter their history. A root repo around them takes none either: no story
 * branches from it.
 */
export function docsRepo(bp: BoardPaths): string | null {
  if (!isRepo(bp.root)) return null;
  return boardExists(bp) && readMeta(bp).repos?.some((r) => r.path !== '.') ? null : bp.root;
}

export function docsInGit(bp: BoardPaths): boolean {
  return docsRepo(bp) !== null && readMeta(bp).documentsInGit !== false;
}

/** `.squad/` as a path inside the repo, with forward slashes. */
export function squadInRepo(bp: BoardPaths, repo: string): string {
  return path.relative(repo, bp.squadDir).split(path.sep).join('/');
}

/** Keeps `.squad/` out of `git status`, in git's local ignore list: it is never committed and .gitignore is not changed. */
export function hideSquadFromGit(bp: BoardPaths): void {
  if (!isRepo(bp.root)) return;
  const repo = bp.root;
  const common = git(repo, ['rev-parse', '--git-common-dir'], { allowFail: true });
  if (!common) return;
  const exclude = path.join(path.resolve(repo, common), 'info', 'exclude');
  // Git reads this list from the repo's top folder, which a project in a subfolder is not.
  const top = git(repo, ['rev-parse', '--show-toplevel'], { allowFail: true }) || repo;
  const line = `/${path.relative(fs.realpathSync(top), fs.realpathSync(bp.squadDir)).split(path.sep).join('/')}/`;
  const text = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (text.split('\n').some((l) => l.trim() === line)) return;
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.writeFileSync(exclude, `${text}${text && !text.endsWith('\n') ? '\n' : ''}# squad-kit: the project's documents, committed by squad-kit itself\n${line}\n`, 'utf8');
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

/** A ticket's documents as they are now, and its own files (attachments, mockup) from its folder. */
function writeTicketFolder(bp: BoardPaths, t: Ticket, to: string): void {
  for (const [name, text] of Object.entries(splitTicket(bp, t).docs)) write(path.join(to, name), text);
  const own = ticketDir(bp, t.id);
  if (!fs.existsSync(own)) return;
  for (const entry of fs.readdirSync(own, { withFileTypes: true })) {
    if (entry.isDirectory()) fs.cpSync(path.join(own, entry.name), path.join(to, entry.name), { recursive: true });
    else if (!entry.name.endsWith('.md')) fs.copyFileSync(path.join(own, entry.name), path.join(to, entry.name));
  }
}

/** The newest base the branch meets: the remote's copy as last fetched (the team's merges) with work accepted here. */
function newestBase(bp: BoardPaths, t: Ticket, base: string): string {
  try {
    return latestBase(t.worktree!, base, repoFor(readMeta(bp), t).remote || remotes(t.worktree!)[0]).sha;
  } catch {
    return base;
  }
}

interface BreakdownCopy {
  folder: string;
  way: 'now' | 'base';
  /** The newest base, which 'base' takes the folder from. */
  from: string;
}

/**
 * A story's branch carries its breakdown's folder (`.squad/requirements/BR-1/`, the document and its parts), so the
 * breakdown is in git once its first story merges. Stories build side by side, so a branch never brings a copy that
 * could clash with another story's: it brings the folder as it is now while the newest base has none yet, or still
 * has the copy the branch started from ('now'). Otherwise it keeps the newest base's copy ('base'), and a later story
 * or the release brings the newer one. The newest base is the remote's when the team moved it on, so a story merged
 * from another computer counts too.
 */
function breakdownCopy(bp: BoardPaths, t: Ticket, squad: string, base: string): BreakdownCopy | null {
  if (!t.breakdown || !t.worktree || !BREAKDOWN_ID.test(t.breakdown.id)) return null;
  const folder = path.posix.join(squad, 'requirements', t.breakdown.id);
  const tree = (ref: string) => git(t.worktree!, ['rev-parse', '-q', '--verify', `${ref}:${folder}`], { allowFail: true });
  const from = newestBase(bp, t, base);
  const atBase = tree(from);
  if (!atBase) return { folder, way: 'now', from };
  const fork = git(t.worktree, ['merge-base', from, 'HEAD'], { allowFail: true });
  return { folder, way: fork && tree(fork) === atBase ? 'now' : 'base', from };
}

/** The breakdown's folder in the ticket's copy, as it is now or as the newest base has it, staged. */
function writeBreakdownCopy(bp: BoardPaths, t: Ticket, copy: BreakdownCopy): void {
  const to = path.join(t.worktree!, copy.folder);
  fs.rmSync(to, { recursive: true, force: true });
  git(t.worktree!, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', copy.folder], { allowFail: true });
  if (copy.way === 'base') git(t.worktree!, ['checkout', copy.from, '--', copy.folder]);
  else if (fs.existsSync(breakdownDir(bp, t.breakdown!.id))) fs.cpSync(breakdownDir(bp, t.breakdown!.id), to, { recursive: true });
}

/**
 * Writes a ticket's documents as they are now (and the decisions it made, and a story's breakdown) into its own copy
 * and stages them, so the next commit there carries them. Returns the staged paths, or nothing when documents do not
 * go into git.
 */
export function stageTicketDocs(bp: BoardPaths, t: Ticket): string[] {
  const repo = docsRepo(bp);
  if (!repo || !docsInGit(bp) || !t.worktree || !fs.existsSync(t.worktree)) return [];
  // The same files sit untracked in the person's checkout; ignored, git replaces them when the branch comes in.
  hideSquadFromGit(bp);
  const squad = squadInRepo(bp, repo);
  const folder = path.posix.join(squad, 'tickets', t.id);
  fs.rmSync(path.join(t.worktree, folder), { recursive: true, force: true });
  writeTicketFolder(bp, t, path.join(t.worktree, folder));
  const paths = [folder];
  for (const d of listDecisions(bp).filter((x) => x.from === t.id)) {
    const file = path.posix.join(squad, 'decisions', `${d.id}.md`);
    write(path.join(t.worktree, file), decisionDoc(d));
    paths.push(file);
  }
  const base = repoFor(readMeta(bp), t).base;
  const copy = breakdownCopy(bp, t, squad, base);
  if (copy) {
    writeBreakdownCopy(bp, t, copy);
    if (fs.existsSync(path.join(t.worktree, copy.folder))) paths.push(copy.folder);
  }
  git(t.worktree, ['add', '-f', '--', ...paths]);
  return paths;
}

/**
 * A hand over in a project that has not released yet: its base has no settings, rules or knowledge in git, so a
 * fresh clone would know nothing of the board. The ticket's branch carries them, with the decisions the ticket
 * follows, and stages them. Once the base has them (after the first release), a clone gets them from there.
 */
export function stageProjectFiles(bp: BoardPaths, t: Ticket, baseRef: string): string[] {
  const repo = docsRepo(bp);
  if (!repo || !docsInGit(bp) || !t.worktree || !fs.existsSync(t.worktree)) return [];
  const squad = squadInRepo(bp, repo);
  if (git(t.worktree, ['ls-tree', '--name-only', baseRef, '--', `${squad}/config.yaml`], { allowFail: true })) return [];
  const into = (rel: string) => path.join(t.worktree!, squad, rel);
  const paths: string[] = [];
  if (fs.existsSync(bp.configFile)) {
    write(into('config.yaml'), fs.readFileSync(bp.configFile, 'utf8'));
    paths.push(`${squad}/config.yaml`);
  }
  if (fs.existsSync(harnessFile(bp))) {
    write(into('harness.yaml'), fs.readFileSync(harnessFile(bp), 'utf8'));
    paths.push(`${squad}/harness.yaml`);
  }
  for (const sub of ['rules', 'knowledge']) {
    const from = path.join(bp.squadDir, sub);
    if (!fs.existsSync(from)) continue;
    // The tracker's wiki is copied again from the tracker on each computer.
    fs.cpSync(from, into(sub), { recursive: true, filter: (f) => path.relative(bp.wikiDir, f).startsWith('..') });
    paths.push(`${squad}/${sub}`);
  }
  for (const d of listDecisions(bp).filter((x) => t.follows?.includes(x.id) && x.from !== t.id)) {
    write(into(path.posix.join('decisions', `${d.id}.md`)), decisionDoc(d));
    paths.push(`${squad}/decisions/${d.id}.md`);
  }
  if (paths.length) git(t.worktree, ['add', '-f', '--', ...paths]);
  return paths;
}

/**
 * Before the ticket's branch meets the base (accepted, or the base brought in), the project files a hand over
 * carried leave it again. They reach the base with the release, as always, so they never clash with it. The
 * ticket's own folder and its own decisions stay.
 */
export function leaveProjectFiles(bp: BoardPaths, t: Ticket, base: string): string[] {
  const repo = docsRepo(bp);
  if (!repo || !t.worktree || !fs.existsSync(t.worktree)) return [];
  const squad = squadInRepo(bp, repo);
  const fork = git(t.worktree, ['merge-base', base, 'HEAD'], { allowFail: true });
  if (!fork) return [];
  const own = new Set(listDecisions(bp).filter((d) => d.from === t.id).map((d) => `${squad}/decisions/${d.id}.md`));
  // A story's breakdown stays too, as the base has it when the base has a newer copy, so the two never clash on it.
  const copy = breakdownCopy(bp, t, squad, base);
  const carried = git(t.worktree, ['diff', '--name-only', '--diff-filter=A', fork, 'HEAD', '--', squad], { allowFail: true })
    .split('\n')
    .filter((f) => f && !f.startsWith(`${squad}/tickets/${t.id}/`) && !own.has(f) && !(copy && f.startsWith(`${copy.folder}/`)));
  if (carried.length) git(t.worktree, ['rm', '-q', '-f', '--', ...carried]);
  // What a team added changes on the board only: a story's change to the file never travels with it.
  const added = `${squad}/harness.yaml`;
  if (git(t.worktree, ['rev-parse', '-q', '--verify', `${base}:${added}`], { allowFail: true })) git(t.worktree, ['restore', `--source=${base}`, '--staged', '--worktree', '--', added], { allowFail: true });
  if (copy?.way === 'base' && git(t.worktree, ['rev-parse', '-q', '--verify', `HEAD:${copy.folder}`], { allowFail: true })) writeBreakdownCopy(bp, t, copy);
  return carried;
}

/** Commits a ticket's documents on its branch, at a big moment such as "spec and design approved". */
export async function commitTicketDocs(bp: BoardPaths, t: Ticket, moment: string): Promise<string | null> {
  const paths = stageTicketDocs(bp, t);
  if (!paths.length || !git(t.worktree!, ['diff', '--cached', '--name-only', '--', ...paths], { allowFail: true })) return null;
  // squad-kit's own bookkeeping: the project's commit hooks (tests, linters) are for code, and could wait forever.
  await gitLater(t.worktree!, [...commitArgsFor(t.worktree!), 'commit', '-m', keepsCommitRules(t.worktree!) ? conventionalWords('chore', moment, t.id) : `${t.id}: ${moment}`, '--', ...paths]);
  return git(t.worktree!, ['rev-parse', '--short', 'HEAD']);
}

/**
 * The release commit carries the project's shared files: every release (this one as it went out), the released
 * tickets' folders, the decisions they made and the ones found in the code, the rules, the knowledge and the
 * settings. What changed in them since the last release comes along too. Tickets still in progress come later,
 * with their own pull requests.
 */
export function stageReleaseDocs(bp: BoardPaths, dir: string, release: Release, tickets: Ticket[], base?: string): string[] {
  const repo = docsRepo(bp);
  if (!repo || !docsInGit(bp)) return [];
  hideSquadFromGit(bp);
  const squad = squadInRepo(bp, repo);
  const into = (rel: string) => path.join(dir, squad, rel);
  for (const r of listReleases(bp).filter((x) => x.status === 'released')) write(into(path.posix.join('releases', `${r.version}.md`)), releaseDoc(r));
  write(into(path.posix.join('releases', `${release.version}.md`)), releaseDoc({ ...release, status: 'released' }));
  const going = tickets.map((t) => ({ ...t, stage: 'done' as const, release: release.version }));
  const released = [...going, ...listTickets(bp).filter((t) => t.stage === 'done' && !going.some((g) => g.id === t.id))];
  const ids = new Set(released.map((t) => t.id));
  for (const t of released) writeTicketFolder(bp, t, into(path.posix.join('tickets', t.id)));
  // The breakdowns of the released stories, as they are now.
  for (const id of new Set(released.map((t) => t.breakdown?.id).filter((x): x is string => Boolean(x) && BREAKDOWN_ID.test(x!)))) {
    const from = breakdownDir(bp, id);
    if (!fs.existsSync(from)) continue;
    fs.rmSync(into(path.posix.join('requirements', id)), { recursive: true, force: true });
    fs.cpSync(from, into(path.posix.join('requirements', id)), { recursive: true });
  }
  for (const d of listDecisions(bp)) {
    if (ids.has(d.from) || d.id.startsWith('STACK.') || fs.existsSync(into(path.posix.join('decisions', `${d.id}.md`)))) write(into(path.posix.join('decisions', `${d.id}.md`)), decisionDoc(d));
  }
  const teamFiles = mergeTeamFiles(bp, repo, dir, squad, base ?? currentBranch(repo), release.version);
  // Put together with the base's newest copy: one person's release never takes away what a teammate set or added.
  const settingsAt = into('config.yaml');
  const onRemote = remotes(dir).map((r) => git(dir, ['show', `refs/remotes/${r}/${base ?? currentBranch(repo)}:${squad}/config.yaml`], { allowFail: true })).find(Boolean);
  const settings = fs.existsSync(bp.configFile) ? mergeSettings(bp, onRemote || (fs.existsSync(settingsAt) ? fs.readFileSync(settingsAt, 'utf8') : '')) : null;
  if (settings) write(settingsAt, settings.text);
  const atBase = into('harness.yaml');
  const team = mergeHarness(bp, fs.existsSync(atBase) ? fs.readFileSync(atBase, 'utf8') : '');
  if (team) write(atBase, team);
  git(dir, ['add', '-f', '--', squad]);
  return [...(settings?.theirsStayed ?? []).map((name) => `A teammate changed ${name} too, so theirs stays, here as well. You can look at it in Settings.`), ...teamFiles];
}

/**
 * This computer's rules and knowledge files put together with the base's newest copies, file by file, like the settings:
 * what only one side changed since this computer last took the base wins. When both did, the team's stays here too, and
 * this computer's words are kept aside for an engineer. Returns what the release says about it.
 */
function mergeTeamFiles(bp: BoardPaths, repo: string, dir: string, squad: string, base: string, version: string): string[] {
  const said: string[] = [];
  const newest = remotes(dir).map((r) => `refs/remotes/${r}/${base}`).find((ref) => git(dir, ['rev-parse', '--verify', '-q', ref], { allowFail: true }));
  for (const sub of ['rules', 'knowledge']) {
    const from = path.join(bp.squadDir, sub);
    if (!fs.existsSync(from)) continue;
    for (const rel of fs.readdirSync(from, { recursive: true, encoding: 'utf8' })) {
      const here = path.join(from, rel);
      if (!fs.statSync(here).isFile()) continue;
      const inRepo = `${squad}/${sub}/${rel.split(path.sep).join('/')}`;
      // The copy holds this computer's base. A teammate's newer work is only on the remote until the push brings it in.
      if (newest) git(dir, ['restore', '--source', newest, '--worktree', '--', inRepo], { allowFail: true });
      const there = path.join(dir, inRepo);
      const mine = fs.readFileSync(here);
      const theirs = fs.existsSync(there) ? fs.readFileSync(there) : null;
      if (theirs?.equals(mine)) continue;
      const was = git(repo, ['show', `HEAD:${inRepo}`], { allowFail: true }).trim();
      const unchanged = (b: Buffer) => Boolean(was) && b.toString('utf8').trim() === was;
      if (!theirs || unchanged(theirs)) {
        fs.mkdirSync(path.dirname(there), { recursive: true });
        fs.writeFileSync(there, mine);
        continue;
      }
      fs.writeFileSync(here, theirs);
      if (unchanged(mine)) continue;
      const aside = path.join(bp.localDir, 'left-out', version, sub, rel);
      fs.mkdirSync(path.dirname(aside), { recursive: true });
      fs.writeFileSync(aside, mine);
      writeLog({ level: 'warn', text: `${sub}/${rel} changed here and in the team's copy. The team's stays; this computer's is in ${aside}` });
      said.push(`A teammate changed ${path.basename(rel)} too, so theirs stays, here as well. Yours is saved: an engineer can see where in the log.`);
    }
  }
  return said;
}

/** The settings in people's words, for the release's log. */
const SETTING_WORDS: Record<string, string> = {
  commands: 'how the project is tested and run',
  git: 'where the code goes',
  repos: 'the code folders',
  parts: "the product's parts",
  guard: "what the project's commands may reach",
  allowedHosts: 'the allowed addresses',
  network: 'the network level',
  quality: 'the Quality setting',
  delivery: 'how changes reach the code',
  atOnce: 'how many stories run at once',
  documentsInGit: 'where the project documents go',
  tracker: 'the tracker',
};

/** What this computer last shared with the team, to tell who changed what since. */
const sharedSettingsFile = (bp: BoardPaths) => path.join(bp.localDir, 'config-shared.yaml');

function readSettings(text: string): Record<string, unknown> | null {
  try {
    const raw = yaml.load(text);
    return isPlain(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * A copy of the settings from the base, put together with this computer's, like harness.yaml (board/additions.ts). Each
 * setting: what only one side changed since this computer last shared them wins, and when both did, the team's stays
 * and the release says so. The next ticket number is the higher one. A copy that can't be read is never mixed in. This
 * computer's own copy takes the result too, and keeps its own project id, which links it to this computer's files.
 * `fetched`: the base's copy seen at a fetch, with no release to tell the person anything.
 */
export function mergeSettings(bp: BoardPaths, theirs: string, opts: { fetched?: boolean } = {}): { text: string; theirsStayed: string[] } {
  const mineText = fs.readFileSync(bp.configFile, 'utf8');
  const mine = readSettings(mineText);
  const team = readSettings(theirs);
  if (!mine || !team) {
    if (mine) write(sharedSettingsFile(bp), mineText);
    return { text: mine ? mineText : theirs, theirsStayed: [] };
  }
  // An older version kept no note of what it last shared: what the checkout holds says the same.
  const was = readSettings(fs.existsSync(sharedSettingsFile(bp)) ? fs.readFileSync(sharedSettingsFile(bp), 'utf8') : git(bp.root, ['show', `HEAD:${squadInRepo(bp, bp.root)}/config.yaml`], { allowFail: true }));
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const theirsStayed: string[] = [];
  const pick = (m: Record<string, unknown>, t: Record<string, unknown>, a: Record<string, unknown> | null) => {
    const out: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(m), ...Object.keys(t)])) {
      if (same(m[key], t[key]) || (a && same(a[key], t[key]))) out[key] = m[key];
      else if (a && same(a[key], m[key])) out[key] = t[key];
      else {
        // Both changed it. At a fetch nothing is said yet, so this computer keeps its own until the release says so.
        out[key] = opts.fetched ? m[key] : t[key];
        theirsStayed.push(SETTING_WORDS[key] ?? `the setting "${key}"`);
      }
      if (out[key] === undefined) delete out[key];
    }
    return out;
  };
  const { board: myBoard, ...myRest } = mine;
  const { board: teamBoard, ...teamRest } = team;
  const { board: wasBoard, ...wasRest } = was ?? {};
  const rest = pick(myRest, teamRest, was ? wasRest : null);
  const boardMine = isPlain(myBoard) ? myBoard : {};
  const boardTeam = isPlain(teamBoard) ? teamBoard : {};
  const next = Math.max(Number(boardMine.nextNumber) || 0, Number(boardTeam.nextNumber) || 0);
  // The next number is the higher one, and each computer keeps its own id: neither is a setting to disagree on.
  const counted = ({ id: _id, ...b }: Record<string, unknown>) => (next ? { ...b, nextNumber: next } : b);
  const board = pick(counted(boardMine), counted(boardTeam), isPlain(wasBoard) ? counted(wasBoard) : was ? {} : null);
  const dump = (id: unknown) => yaml.dump({ ...rest, board: { ...(id ? { id } : {}), ...board } }, { lineWidth: 100, noRefs: true, sortKeys: false });
  const text = dump(boardTeam.id);
  const local = dump(boardMine.id);
  if (local !== mineText) writeConfigFile(bp.configFile, local);
  if (!opts.fetched) write(sharedSettingsFile(bp), local);
  return { text, theirsStayed };
}
