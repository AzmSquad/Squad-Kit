import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { addActivity, boardExists, listDecisions, listTickets, readMeta, readTicket, ticketDir, updateTicket, type BoardPaths } from '../board/store.js';
import { readTicketDocs, ticketDocs } from '../board/docs.js';
import { isMine, ownerOf, sameName } from '../board/owner.js';
import { scheduleSquad } from '../board/schedule.js';
import type { Ticket, Waiting } from '../board/types.js';
import { repoHostFor } from '../modules/registry.js';
import { addWorktree, changedFiles, commitAll, commitArgsFor, git, isAncestor, isRepo, networkGitEnv, remotes, removeWorktree } from './git.js';
import { docsInGit, docsRepo, squadInRepo, stageProjectFiles, stageTicketDocs } from './project-git.js';
import { repoTarget } from './sync.js';
import { spotOwnerDeletes } from './teammate-delete.js';

/**
 * Hand over, and a new computer (ADR-001). A ticket's documents and code travel on its pushed branch; live progress,
 * agent chats and screenshots stay on the computer that made them. Whoever owns a ticket next carries on from the
 * branch: squad-kit makes their copy of the code from it, and the Builder starts a fresh chat from the spec, the
 * design and the code.
 */

const DOC_FILES = ['ticket.md', 'spec.md', 'questions.md', 'design.md', 'notes.md', 'proof.md'];

/** git never asks for a password in the background; a code host module signs pushes in through its environment. */
function gitEnv(bp: BoardPaths, t: Ticket): Record<string, string> {
  const target = repoTarget(bp, t);
  return { GIT_TERMINAL_PROMPT: '0', ...(target ? (repoHostFor(bp, target.url)?.gitEnv() ?? {}) : {}) };
}

/** git over the network, without holding up the board while it waits. */
function gitLater(cwd: string, args: string[], env: Record<string, string>, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, ...networkGitEnv(cwd, env) } }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout.trim());
      const detail = (stderr || err.message).trim().split('\n').slice(-3).join(' ');
      reject(new Error(`git ${args[0]} failed: ${detail}`));
    });
  });
}

/**
 * Fetches the ticket's base branch from its remote, so "the latest base" is the team's and not an old copy on this
 * computer. Returns the remote's name, or undefined when the repo has none. Never throws: offline, the last fetch counts.
 */
export async function fetchBase(bp: BoardPaths, t: Ticket): Promise<string | undefined> {
  const target = repoTarget(bp, t);
  if (!target) return undefined;
  await gitLater(target.dir, ['fetch', '--quiet', target.remote, target.base], gitEnv(bp, t), 60_000).catch(() => undefined);
  return target.remote;
}

/* ── Hand over ───────────────────────────────────────────── */

export interface HandOverPush {
  branch: string;
  remote: string;
  /** The commit that went out, short. */
  commit: string;
  /** The project files the branch carries because the base has none yet. */
  carried: string[];
  baseCommit?: string;
}

/**
 * Saves the work so far and the ticket's documents (already naming the new owner) on its branch, and pushes it. A
 * ticket not built yet gets its branch now, from the base, so its spec and design travel too.
 */
export async function pushHandOver(bp: BoardPaths, t: Ticket): Promise<HandOverPush> {
  const repo = docsRepo(bp);
  if (!repo) {
    throw new Error("This project's documents sit outside its code repos, so they cannot travel with a branch yet. Share the .squad folder another way.");
  }
  if (!docsInGit(bp)) throw new Error('"Put project documents in git" is off for this project, so the documents cannot travel with the branch. Turn it on in Settings first.');
  const target = repoTarget(bp, t);
  if (!target) throw new Error('This repo has no remote to push to. Add one first, for example: git remote add origin <url>');
  const env = gitEnv(bp, t);
  const had = Boolean(t.worktree && fs.existsSync(t.worktree));
  const copy = had ? { dir: t.worktree!, branch: t.branch!, baseCommit: t.baseCommit } : addWorktree(target.dir, t.id, target.base);
  const ticket: Ticket = { ...t, worktree: copy.dir, branch: copy.branch, baseCommit: t.baseCommit ?? copy.baseCommit };
  try {
    if (had) commitAll(copy.dir, `${t.title} (${t.id}): work so far`);
    const remoteBase = `refs/remotes/${target.remote}/${target.base}`;
    const baseRef = git(target.dir, ['rev-parse', '--verify', '-q', remoteBase], { allowFail: true }) ? remoteBase : target.base;
    const carried = stageProjectFiles(bp, ticket, baseRef);
    const paths = [...stageTicketDocs(bp, ticket), ...carried];
    if (paths.length && git(copy.dir, ['diff', '--cached', '--name-only', '--', ...paths], { allowFail: true })) {
      git(copy.dir, [...commitArgsFor(copy.dir), 'commit', '--no-verify', '-m', `${t.id}: handed over to ${t.owner}`, '--', ...paths]);
    }
    await gitLater(copy.dir, ['push', target.remote, `${copy.branch}:refs/heads/${copy.branch}`], env).catch((err: Error) => {
      if (/rejected|non-fast-forward|fetch first/i.test(err.message)) {
        throw new Error(`${copy.branch} on ${target.remote} has work this computer does not have. Nothing was handed over. ${err.message}`);
      }
      throw err;
    });
    return {
      branch: copy.branch,
      remote: target.remote,
      commit: git(copy.dir, ['rev-parse', '--short', 'HEAD']),
      carried,
      ...(ticket.baseCommit ? { baseCommit: ticket.baseCommit } : {}),
    };
  } finally {
    // A copy made only to push is removed again; the branch stays.
    if (!had) removeWorktree(target.dir, copy.dir);
  }
}

/* ── Picking up pushed tickets ───────────────────────────── */

export interface PickedUp {
  id: string;
  branch: string;
  /** new: this board had no such ticket; handed: a newer hand over came; follow: someone else's ticket moved on. */
  kind: 'new' | 'handed' | 'follow';
  mine: boolean;
  from?: string;
}

/** The ticket branches the remotes have, as this repo last fetched them: refs/remotes/<remote>/squad/<name>. */
function pushedTicketRefs(repo: string): string[] {
  return git(repo, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/remotes/*/squad/*'], { allowFail: true })
    .split('\n')
    .filter(Boolean);
}

/** The files under a folder on a branch, as paths inside that folder. */
function filesOn(repo: string, ref: string, dir: string): string[] {
  return git(repo, ['ls-tree', '-r', '--name-only', ref, '--', `${dir}/`], { allowFail: true })
    .split('\n')
    .filter(Boolean)
    .map((f) => f.slice(dir.length + 1));
}

function blob(repo: string, ref: string, file: string): Buffer {
  return execFileSync('git', ['cat-file', 'blob', `${ref}:${file}`], { cwd: repo, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

/** The ticket on a ticket branch: the folder named like the branch (squad/ab-80 carries AB-80). */
function ticketOn(repo: string, ref: string, squad: string): { id: string; files: string[]; docs: Record<string, string> } | null {
  const name = ref.replace(/^refs\/remotes\/[^/]+\/squad\//, '');
  const folders = git(repo, ['ls-tree', '--name-only', ref, '--', `${squad}/tickets/`], { allowFail: true })
    .split('\n')
    .map((f) => f.slice(`${squad}/tickets/`.length));
  const id = folders.find((f) => f.toLowerCase() === name);
  if (!id) return null;
  const files = filesOn(repo, ref, `${squad}/tickets/${id}`);
  const docs = Object.fromEntries(files.filter((f) => DOC_FILES.includes(f)).map((f) => [f, blob(repo, ref, `${squad}/tickets/${id}/${f}`).toString('utf8')]));
  return docs['ticket.md'] ? { id, files, docs } : null;
}

/** The documents say something else than this board's copy (read the same way, so layout alone never counts). */
function differs(bp: BoardPaths, id: string, docs: Record<string, string>): boolean {
  const dir = ticketDir(bp, id);
  const here = Object.fromEntries(DOC_FILES.filter((f) => fs.existsSync(path.join(dir, f))).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
  return JSON.stringify(ticketDocs(readTicketDocs(here))) !== JSON.stringify(ticketDocs(readTicketDocs(docs)));
}

/** Writes the ticket's folder as the branch has it, and the decisions it made that this board does not have yet. */
function bringIn(bp: BoardPaths, repo: string, ref: string, squad: string, id: string, files: string[]): void {
  const dir = ticketDir(bp, id);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const f of files) {
    const to = path.join(dir, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, blob(repo, ref, `${squad}/tickets/${id}/${f}`));
  }
  const known = new Set(listDecisions(bp).map((d) => d.id));
  for (const f of filesOn(repo, ref, `${squad}/decisions`)) {
    if (!f.endsWith('.md') || known.has(f.slice(0, -3))) continue;
    fs.mkdirSync(bp.decisionsDir, { recursive: true });
    fs.writeFileSync(path.join(bp.decisionsDir, f), blob(repo, ref, `${squad}/decisions/${f}`));
  }
}

/**
 * Brings in the tickets on pushed ticket branches: one this board does not have, one handed over again since this
 * board last saw it, and someone else's ticket that moved on. A ticket you own and work on here stays as it is.
 * Nothing is fetched here; fetchPushed fetches first.
 */
export function pickUpPushed(bp: BoardPaths): PickedUp[] {
  const repo = docsRepo(bp);
  if (!repo || !boardExists(bp) || !docsInGit(bp)) return [];
  const meta = readMeta(bp);
  const squad = squadInRepo(bp, repo);
  const out: PickedUp[] = [];
  const seen = new Set<string>();
  // The base, here and on the remotes: a branch already merged into it has nothing newer than the base has.
  const base = meta.git?.base || 'main';
  const bases = [`refs/heads/${base}`, ...git(repo, ['for-each-ref', '--format=%(refname)', `refs/remotes/*/${base}`], { allowFail: true }).split('\n').filter(Boolean)];
  for (const ref of pushedTicketRefs(repo)) {
    if (bases.some((b) => isAncestor(repo, ref, b))) continue;
    const on = ticketOn(repo, ref, squad);
    // The newest branch for a ticket wins when two remotes have it.
    if (!on || seen.has(on.id)) continue;
    seen.add(on.id);
    const theirs = readTicketDocs(on.docs);
    if (!theirs.title || !theirs.stage) continue;
    const local = readTicket(bp, on.id);
    // Deleted on this computer: its branch left on the remote does not bring it back, unless it is handed over again.
    const deleted = local ? undefined : meta.deleted?.filter((d) => d.id === on.id).at(-1);
    // Removed from this board after its owner deleted it: pushed again, it is back.
    if (deleted && !deleted.fromBoard && !(theirs.handedOver?.at && theirs.handedOver.at > deleted.at)) continue;
    const newer = theirs.handedOver?.at && theirs.handedOver.at > (local?.handedOver?.at ?? '');
    const kind: PickedUp['kind'] | null = !local ? 'new' : newer ? 'handed' : !isMine(local, meta) && differs(bp, on.id, on.docs) ? 'follow' : null;
    if (!kind) continue;
    bringIn(bp, repo, ref, squad, on.id, on.files);
    const branch = ref.replace(/^refs\/remotes\/[^/]+\//, '');
    const t = received(bp, repo, on.id, ref, kind);
    out.push({ id: on.id, branch, kind, mine: isMine(t, meta), ...(t.handedOver ? { from: t.handedOver.from } : {}) });
  }
  // Someone else's ticket whose branch is merged (or gone): once they push the base, it has the newest documents.
  for (const t of listTickets(bp)) {
    if (seen.has(t.id) || isMine(t, meta)) continue;
    for (const ref of bases.filter((b) => b.startsWith('refs/remotes/'))) {
      const files = filesOn(repo, ref, `${squad}/tickets/${t.id}`);
      if (!files.includes('ticket.md')) continue;
      const docs = Object.fromEntries(files.filter((f) => DOC_FILES.includes(f)).map((f) => [f, blob(repo, ref, `${squad}/tickets/${t.id}/${f}`).toString('utf8')]));
      if (differs(bp, t.id, docs)) {
        bringIn(bp, repo, ref, squad, t.id, files);
        received(bp, repo, t.id, ref, 'follow');
        out.push({ id: t.id, branch: ref.replace(/^refs\/remotes\/[^/]+\//, ''), kind: 'follow', mine: false });
      }
      break;
    }
  }
  return out;
}

/**
 * Fetches the remote, then picks up what was pushed, and spots tickets their owners deleted. The fetch prunes, so a
 * branch deleted on the remote is gone here too. Never throws: a remote that cannot be reached is tried later.
 */
export async function fetchPushed(bp: BoardPaths): Promise<PickedUp[]> {
  const repo = docsRepo(bp);
  if (!repo || !boardExists(bp) || !docsInGit(bp)) return [];
  const meta = readMeta(bp);
  const remote = meta.git?.remote || remotes(repo)[0];
  let fetched = false;
  if (remote) {
    const url = git(repo, ['config', '--get', `remote.${remote}.url`], { allowFail: true });
    const env = { GIT_TERMINAL_PROMPT: '0', ...(url ? (repoHostFor(bp, url)?.gitEnv() ?? {}) : {}) };
    fetched = await gitLater(repo, ['fetch', '--quiet', '--prune', remote], env, 60_000).then(
      () => true,
      () => false,
    );
  }
  let picked: PickedUp[] = [];
  try {
    picked = pickUpPushed(bp);
  } catch {
    // A half-written ticket file; the next look tries again.
  }
  try {
    spotOwnerDeletes(bp, { fetched });
  } catch {
    // The same.
  }
  return picked;
}

/** The local branch catches up with the pushed one, so a ticket handed back to you carries on from the newest work. */
function catchUp(repo: string, t: Ticket, ref: string): string | null {
  const branch = t.branch ?? `squad/${t.id.toLowerCase()}`;
  const here = git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { allowFail: true });
  const tip = git(repo, ['rev-parse', ref], { allowFail: true });
  if (!here || !tip || here === tip) return null;
  if (!isAncestor(repo, here, tip)) return `${branch} on this computer has commits that are not on the pushed branch, so it was kept as it is.`;
  try {
    if (t.worktree && fs.existsSync(t.worktree)) git(t.worktree, ['merge', '--ff-only', tip]);
    else git(repo, ['update-ref', `refs/heads/${branch}`, tip, here]);
    return null;
  } catch (err) {
    return `Could not bring the pushed work into this computer's copy: ${(err as Error).message}`;
  }
}

/** What this computer knew of a ticket's running work: it belongs to the computer that did it. */
const RUN_STATE = ['sessions', 'stuck', 'agentQuestion', 'chat', 'takenOver', 'retryPhase', 'reviewNotes', 'replanFor', 'quiet', 'quietSnoozedUntil', 'stopRequested', 'retryOnStop', 'clock', 'notesSeen', 'planReview', 'changeRequest', 'tries', 'fails', 'reviewRound'] as const;

/** The ticket just came from a branch: yours carries on from its documents; someone else's waits for its owner. */
function received(bp: BoardPaths, repo: string, id: string, ref: string, kind: PickedUp['kind']): Ticket {
  const meta = readMeta(bp);
  const branch = ref.replace(/^refs\/remotes\/[^/]+\//, '');
  return updateTicket(bp, id, (t) => {
    for (const k of RUN_STATE) delete t[k];
    t.seenOn = ref.replace(/^refs\/remotes\//, '');
    delete t.ownerDeleted;
    t.live = false;
    t.squad = null;
    t.waiting = null;
    t.progress = undefined;
    const owner = ownerOf(t);
    if (!isMine(t, meta)) {
      t.status = `With ${owner}`;
      addActivity(
        t,
        'squad',
        kind === 'follow'
          ? `Updated from ${branch}, as ${owner} pushed it`
          : kind === 'handed' && t.handedOver
            ? `${t.handedOver.from} handed it over to ${owner} on ${branch}. Their squad works on it`
            : `Came from ${branch}. ${owner} owns it: their squad works on it`,
      );
      return;
    }
    // Handed to you by a teammate, or your own work pushed from another computer.
    const from = t.handedOver && sameName(t.handedOver.to, meta.user.name) ? t.handedOver.from : undefined;
    addActivity(
      t,
      'squad',
      from
        ? `${from} handed it over to you. Picked it up from ${branch}: the documents and the code came with it. Chats, live progress and screenshots stayed on ${from}'s computer`
        : `Picked it up from ${branch}, pushed from another computer. Chats, live progress and screenshots stayed there`,
    );
    const note = catchUp(repo, t, ref);
    if (note) addActivity(t, 'squad', note);
    // Screenshots stay on the computer that took them: the Tester takes them again here.
    if (t.proof?.length && ['implement', 'test', 'review'].includes(t.stage)) {
      t.proof = undefined;
      if (t.gates) t.gates = { ...t.gates, proof: 'pending' };
    }
    const next = carryOn(t, false);
    t.status = next.status;
    t.waiting = next.waiting ?? null;
    if (next.phase) {
      t.live = true;
      scheduleSquad(t, next.phase, 0.5, 1);
    }
  });
}

/**
 * Where a ticket carries on when this computer has its documents but none of its live state. Steps that change code
 * need the ticket's copy first: `pick-up` makes it from the pushed branch, then asks again with `copy` true.
 */
export function carryOn(t: Ticket, copy: boolean): { phase?: string; waiting?: Waiting; status: string } {
  const open = (t.questions ?? []).filter((q) => !q.answer);
  const spec = t.track !== 'express' && !t.specApproved;
  switch (t.stage) {
    case 'done':
      return { status: t.release ? `Released in ${t.release}` : 'Released' };
    case 'release':
      return { status: `Ready for ${t.release ?? 'the next release'}` };
    case 'bugs':
      return { phase: 'triage', status: 'Triage is sorting the bug' };
    case 'implement':
    case 'test':
    case 'review':
      if (!copy) return { phase: 'pick-up', status: 'Making a copy of the code from the pushed branch' };
      if (t.stage === 'implement') return { phase: 'build', status: 'The Builder starts again from the spec, the design and the code' };
      if (t.stage === 'test') return { phase: 'test', status: 'Running the project checks' };
      return t.gates?.review === 'pass' ? { phase: 'proof', status: 'The Tester takes the screenshots again' } : { phase: 'review', status: 'Reviewer is reading the changes' };
    default:
      if (!t.questions && t.stage === 'tickets') return { phase: 'analyst-read', status: 'Analyst is reading the ticket' };
      if (open.length) return { waiting: { kind: 'questions', summary: `${t.questions!.length} questions from the Analyst and Architect` }, status: `${open.length} questions for you` };
      if (!t.story && !t.steps) return { phase: 'plan-write', status: spec ? 'Analyst is writing the spec' : 'Architect is choosing the design' };
      if (spec) return { waiting: { kind: 'spec', summary: 'The spec is ready: is this what you want?' }, status: 'Spec ready for you' };
      if (!t.steps) return { phase: 'plan-write', status: 'Architect is choosing the design' };
      if (t.track === 'express') return { phase: 'express-approve', status: 'Express track: approving the plan' };
      return t.specApproved
        ? { waiting: { kind: 'plan', summary: 'The design is ready: is this how to build it?' }, status: 'Design ready for you' }
        : { waiting: { kind: 'plan', summary: 'The plan is ready for your approval' }, status: 'Plan ready for you' };
  }
}

/** The code a ticket's copy has against where it left the base: work done before this Builder session, if any. */
export function workSoFar(dir: string, baseCommit: string): string[] {
  return changedFiles(dir, baseCommit).filter((f) => !f.startsWith('.squad/'));
}

/* ── A new computer ──────────────────────────────────────── */

/**
 * A fresh clone of a project that has not released yet has no `.squad/` settings in its base. The newest pushed
 * ticket branch that carries them (a hand over puts them there) gives them to this computer: the settings, rules,
 * knowledge and decisions. Returns the branch they came from, or null.
 */
export function projectFromPushed(squadDir: string): string | null {
  const root = path.dirname(path.resolve(squadDir));
  if (!isRepo(root)) return null;
  const squad = path.relative(root, path.resolve(squadDir)).split(path.sep).join('/');
  for (const ref of pushedTicketRefs(root)) {
    let config: { board?: { id?: string } } | undefined;
    try {
      config = yaml.load(blob(root, ref, `${squad}/config.yaml`).toString('utf8')) as typeof config;
    } catch {
      continue;
    }
    if (!config?.board?.id) continue;
    for (const sub of ['config.yaml', 'rules', 'knowledge', 'decisions']) {
      const files = sub === 'config.yaml' ? [''] : filesOn(root, ref, `${squad}/${sub}`);
      for (const f of files) {
        const rel = f ? `${sub}/${f}` : sub;
        const to = path.join(squadDir, rel);
        // What this folder has already stays, except the starting settings a new folder gets.
        if (fs.existsSync(to) && sub !== 'config.yaml') continue;
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.writeFileSync(to, blob(root, ref, `${squad}/${rel}`));
      }
    }
    return ref.replace(/^refs\/remotes\//, '');
  }
  return null;
}
