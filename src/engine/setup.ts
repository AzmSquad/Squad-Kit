import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { LAYOUT, boardExists, boardPaths, newProjectId, readMeta, writeMeta, type BoardPaths } from '../board/store.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../core/config.js';
import { SQUAD_DIR } from '../core/paths.js';
import type { BoardMeta } from '../board/types.js';
import { AI_TOOLS } from '../modules/registry.js';
import { currentBranch, ensureRepo, isRepo, remotes } from './git.js';
import { findNestedRepos } from './repos.js';
import { projectRoot } from './live.js';
import { ensureAgents } from './agents.js';
import { hideSquadFromGit } from './project-git.js';

/** A short ticket key from the project name: "moj-taqadi" becomes "MT", "Leave requests" becomes "LR". */
export function keyFor(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const key = (words.length > 1 ? words.map((w) => w[0]) : [words[0]?.slice(0, 2) ?? 'SK']).join('').toUpperCase().slice(0, 3);
  return key || 'SK';
}

function gitUser(): string {
  try {
    return execSync('git config user.name', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/)[0] || 'You';
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
 * Opening the board in a project with no board yet starts a live one: the project gets a git repo if it has none,
 * its own id, and the rules for each role; then the Architect reads it first.
 */
export function ensureLiveBoard(bp: BoardPaths, projectName: string): BoardSetup {
  const root = projectRoot(bp);
  if (boardExists(bp)) {
    // `.squad/` never shows in `git status`; squad-kit commits the documents itself (ADR-001).
    hideSquadFromGit(bp);
    const meta = readMeta(bp);
    if (meta.engine === 'live') {
      meta.tools = detectTools();
      writeMeta(bp, meta);
      ensureAgents(bp);
    }
    return { bp, did: [] };
  }
  const did: string[] = [];
  // A workspace of separate code repos needs no repo of its own; a plain folder becomes one.
  const nested = findNestedRepos(root);
  const hadRepo = isRepo(root);
  const hadFiles = fs.readdirSync(root).some((f) => f !== SQUAD_DIR);
  if (hadRepo || nested.length === 0) ensureRepo(root, projectName);
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
    user: { name: gitUser(), role: 'Project manager' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools,
    speed: 1,
    map: [],
    lessons: [],
    commands: {},
    git: { base: currentBranch(root), remote: remotes(root)[0] ?? '' },
    scan: { status: 'pending' },
    parallel: 2,
  };
  writeMeta(next, meta);
  ensureAgents(next);
  did.push(`Board: ready, with rules for the five roles; tickets are named ${meta.key}-1, ${meta.key}-2`);
  did.push(`AI tools: ${tools.map((t) => `${t.name} ${t.ready ? 'ready' : 'not installed'}`).join(', ')}`);
  return { bp: next, did };
}
