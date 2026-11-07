import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LAYOUT, boardExists, boardPaths, listDecisions, listTickets, newProjectId, readMeta, settingsProblem, writeMeta, type BoardPaths } from '../board/store.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../core/config.js';
import { SQUAD_DIR, buildPaths, type SquadPaths, isOwnFolder } from '../core/paths.js';
import { openBoard } from '../board/move.js';
import type { BoardMeta } from '../board/types.js';
import { AI_TOOLS } from '../modules/registry.js';
import { currentBranch, ensureRepo, gitEnv, isRepo, remotes } from './git.js';
import { workspaceRepos } from './repos.js';
import { projectRoot } from './live.js';
import { ensureAgents } from './agents.js';
import { hideSquadFromGit } from './project-git.js';
import { pickUpPushed, projectFromPushed, type PickedUp } from './handover.js';
import { newSetup, type FolderKind } from '../board/setup-state.js';

/** A short ticket key from the project name: "moj-taqadi" becomes "MT", "Leave requests" becomes "LR". */
export function keyFor(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const key = (words.length > 1 ? words.map((w) => w[0]) : [words[0]?.slice(0, 2) ?? 'SK']).join('').toUpperCase().slice(0, 3);
  return key || 'SK';
}

/** The person's first name from git, as the project's own repo sees it. */
function gitUser(dir?: string): string {
  try {
    return execSync('git config user.name', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv(), ...(dir && fs.existsSync(dir) ? { cwd: dir } : {}) }).trim().split(/\s+/)[0] || 'You';
  } catch {
    return 'You';
  }
}

/** Which AI tools are on this computer, one line per AI tool module. */
export function detectTools(): BoardMeta['tools'] {
  return AI_TOOLS.map((t) => ({ name: t.label, ready: t.ready() }));
}

/** What `.squad/` holds, for anyone who opens it. */
const SQUAD_README = `# squad-kit

This folder is the project's memory, kept by squad-kit. People can read it, and edit it by hand.

- \`config.yaml\`: the project's settings.
- \`tickets/<ID>/\`: each ticket's spec, questions, design, notes and proof.
- \`decisions/\`: what the squad decided, and why.
- \`releases/\`: what each release carried.
- \`rules/\`: how each role works on this project.
- \`knowledge/\`: what the squad learned about the project.

Live progress, agent chats, screenshots and sign-ins stay on each person's computer, in \`~/.squad-kit/\`.

Open the board: \`squad console\`
`;

/**
 * A folder without squad-kit gets its project files: the settings and a README that says what \`.squad/\` holds. The
 * board, the rules and git come next, with ensureLiveBoard.
 */
export function setupProject(root: string): string {
  const squadDir = path.join(root, SQUAD_DIR);
  const name = path.basename(path.resolve(root));
  fs.mkdirSync(squadDir, { recursive: true });
  saveConfig(path.join(squadDir, 'config.yaml'), { ...DEFAULT_CONFIG, project: { ...DEFAULT_CONFIG.project, name } });
  const readme = path.join(squadDir, 'README.md');
  if (!fs.existsSync(readme)) fs.writeFileSync(readme, SQUAD_README, 'utf8');
  return name;
}

export interface BoardSetup {
  /** The board's paths, fresh: a new board gets its own id, which names this computer's folder for it. */
  bp: BoardPaths;
  /** What setting up did, one plain line each; nothing when the board was there already. */
  did: string[];
}

/** Sign-ins live on this computer (ADR-001); squad-kit 0.x kept them in .squad/secrets.yaml. */
function moveOldSecrets(bp: BoardPaths): boolean {
  const old = path.join(bp.squadDir, 'secrets.yaml');
  const local = path.join(bp.localDir, 'secrets.yaml');
  if (!fs.existsSync(old) || fs.existsSync(local)) return false;
  fs.mkdirSync(bp.localDir, { recursive: true });
  fs.copyFileSync(old, local);
  fs.chmodSync(local, 0o600);
  fs.rmSync(old);
  return true;
}

/** The board writes knowledge/project.md, lessons.md and stack.md: a project's own files of those names are kept, renamed. */
function keepOwnKnowledge(bp: BoardPaths): string[] {
  const kept: string[] = [];
  for (const name of ['project.md', 'lessons.md', 'stack.md']) {
    const file = path.join(bp.knowledgeDir, name);
    if (!fs.existsSync(file)) continue;
    const to = name.replace(/\.md$/, '.before-squad-kit.md');
    fs.renameSync(file, path.join(bp.knowledgeDir, to));
    kept.push(to);
  }
  return kept;
}

/**
 * A project this computer has none of its own files for (a clone, a copy, a new computer): this computer's part of
 * the board starts fresh, and everything else comes from `.squad/`. The Architect reads the project again only when
 * `.squad/` has nothing it learned.
 */
function thisComputer(bp: BoardPaths): boolean {
  if (fs.existsSync(bp.localMetaFile)) return false;
  const meta = readMeta(bp);
  writeMeta(bp, {
    ...meta,
    user: meta.user ?? { name: gitUser(projectRoot(bp)), role: 'Project manager' },
    roles: meta.roles ?? { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: detectTools(),
    speed: meta.speed ?? 1,
    parallel: meta.parallel ?? 2,
    map: meta.map ?? [],
    lessons: meta.lessons ?? [],
    ...(meta.engine === 'live' && !meta.scan ? { scan: { status: 'pending' as const } } : {}),
  });
  return true;
}

/** One line for each ticket picked up from a pushed branch. */
function pickedUpLines(picked: PickedUp[]): string[] {
  return picked.map((p) =>
    p.mine
      ? `Picked up ${p.id} from ${p.branch}${p.from ? `: ${p.from} handed it over to you` : ''}. The squad carries on from its documents and code`
      : `${p.id} came from ${p.branch}: someone else owns it, so their squad works on it`,
  );
}

/**
 * Opening the board in a project with no board yet starts a live one: the project gets a git repo if it has none,
 * its own id, and the rules for each role; then the Architect reads it first.
 */
export function ensureLiveBoard(bp: BoardPaths, projectName: string): BoardSetup {
  const root = projectRoot(bp);
  if (boardExists(bp)) {
    // `.squad/` never shows in `git status`; squad-kit commits the documents itself (ADR-001).
    hideSquadFromGit(bp);
    const fresh = thisComputer(bp);
    const meta = readMeta(bp);
    const picked = meta.engine === 'live' ? pickUpPushed(bp) : [];
    if (meta.engine === 'live') {
      meta.tools = detectTools();
      writeMeta(bp, meta);
      ensureAgents(bp);
    }
    const n = listTickets(bp).length;
    const d = listDecisions(bp).length;
    const here = `This computer: new for this project. The board comes from .squad/: ${n} ${n === 1 ? 'ticket' : 'tickets'} and ${d} ${d === 1 ? 'decision' : 'decisions'}. Agent chats, live progress and screenshots stay on the computer they ran on`;
    return { bp, did: [...(fresh ? [here] : []), ...pickedUpLines(picked)] };
  }
  // A fresh clone of a project that has not released yet: its settings came with a pushed ticket branch.
  const from = isRepo(root) ? projectFromPushed(bp.squadDir) : null;
  if (from && boardExists(boardPaths(bp.squadDir))) {
    const next = ensureLiveBoard(boardPaths(bp.squadDir), projectName);
    return { bp: next.bp, did: [`Project files: the settings, rules and knowledge came from the pushed branch ${from}`, ...next.did] };
  }
  const did: string[] = [];
  const started = Date.now();
  // A workspace of separate code repos needs no repo of its own, and one it has stays as it is; a plain folder becomes one.
  const nested = workspaceRepos(root);
  const hadRepo = isRepo(root);
  const hadFiles = fs.readdirSync(root).some((f) => f !== SQUAD_DIR);
  // squad-kit 0.x kept stories and plans in .squad/; they stay where they are.
  const older = ['stories', 'plans'].some((d) => fs.existsSync(path.join(bp.squadDir, d)));
  const kind: FolderKind = older ? 'older' : nested.length ? 'repos' : hadRepo ? (hadFiles ? 'repo' : 'empty') : hadFiles ? 'files' : 'empty';
  if (nested.length === 0) ensureRepo(root, projectName);
  // A freshly cloned empty repo has nothing to branch from yet, so it gets its first commit too.
  for (const r of nested) ensureRepo(path.join(root, r.path), projectName);
  did.push(
    nested.length
      ? `Git: found ${nested.length} code ${nested.length === 1 ? 'repo' : 'repos'} inside`
      : hadRepo
        ? `Git: found the repo, on ${currentBranch(root)}`
        : hadFiles
          ? 'Git: made a repo, with the files already here in its first commit'
          : 'Git: made a new repo for the project',
  );

  // The project's id first: it names this computer's folder for the project.
  const id = newProjectId(projectName);
  saveConfig(bp.configFile, { ...loadConfig(bp.configFile), board: { id } });
  let next = boardPaths(bp.squadDir);
  if (moveOldSecrets(next)) {
    next = boardPaths(bp.squadDir);
    did.push('Sign-ins: moved out of .squad, to this computer only');
  }
  hideSquadFromGit(next);
  const kept = keepOwnKnowledge(next);
  if (kept.length) did.push(`Your notes in knowledge/ kept as ${kept.join(', ')}`);

  const tools = detectTools();
  const meta: BoardMeta = {
    id,
    layout: LAYOUT,
    documentsInGit: true,
    project: projectName,
    key: keyFor(projectName),
    nextNumber: 1,
    engine: 'live',
    user: { name: gitUser(root), role: 'Project manager' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools,
    speed: 1,
    map: [],
    lessons: [],
    commands: {},
    git: { base: currentBranch(root), remote: remotes(root)[0] ?? '' },
    ...(nested.length ? { repos: nested } : {}),
    scan: { status: 'pending' },
    parallel: 2,
    // The first run, step by step: the person follows it on the setup page, the board and in the terminal.
    setup: newSetup(kind, started),
  };
  writeMeta(next, meta);
  ensureAgents(next);
  did.push(`Board: ready, with rules for the five roles; tickets are named ${meta.key}-1, ${meta.key}-2`);
  did.push(`AI tools: ${tools.map((t) => `${t.name} ${t.ready ? 'ready' : 'not installed'}`).join(', ')}`);
  return { bp: next, did };
}

/** Every project squad-kit works on is a git repo; on a Mac, git comes with the developer tools. */
export function requireGit(): void {
  try {
    execSync('git --version', { stdio: 'ignore', env: gitEnv() });
  } catch {
    throw new Error('squad-kit needs git. On a Mac, run this once, then run squad console again: xcode-select --install');
  }
}

export { isOwnFolder };

export interface ReadyProject {
  paths: SquadPaths;
  bp: BoardPaths;
  /** What getting it ready did, one plain line each; nothing when it was ready already. */
  did: string[];
  /** The board was set up just now, so the Architect reads the project first. */
  fresh: boolean;
}

/**
 * Gets a folder ready the way `squad console` and Add project in the app do: the project files when it has none, a
 * board from before ADR-001 moved once, and a live board where there is none, so the Architect reads the project first.
 */
export function prepareProject(root: string): ReadyProject {
  const did: string[] = [];
  // Even with a `.squad` there already: setting up here would put the whole folder into git.
  if (!isOwnFolder(root)) throw new Error("squad-kit works inside a project folder. Pick the project's own folder, or a new, empty one.");
  if (!fs.existsSync(path.join(root, SQUAD_DIR, 'config.yaml'))) {
    setupProject(root);
    did.push('Project files: .squad/ with the settings and a README');
  }
  const paths = buildPaths(root);
  const broken = settingsProblem(boardPaths(paths.squadDir));
  if (broken) throw new Error(broken);
  // loadConfig also validates the settings: problems show before anything starts.
  const config = loadConfig(paths.configFile);
  const opened = openBoard(paths.squadDir);
  if (opened.moved) {
    const m = opened.moved;
    did.push(`Moved this board to the new layout: ${m.tickets} tickets, ${m.decisions} decisions and ${m.releases} releases, all checked.`);
    did.push(`The project's files are in .squad/; this computer's are in ${m.localDir}. A copy of the old files: ${m.backup}`);
  }
  if (!boardExists(opened.bp)) requireGit();
  const setup = ensureLiveBoard(opened.bp, config.project.name);
  did.push(...setup.did);
  return { paths: buildPaths(root), bp: setup.bp, did, fresh: setup.did.length > 0 };
}
