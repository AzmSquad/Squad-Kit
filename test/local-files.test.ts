import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardPaths, readMeta, writeMeta, type BoardPaths } from '../src/board/store.js';
import { seedDemoBoard } from '../src/board/demo.js';
import { addLocalFile, addLockedFile, lockDockerFiles, offLimits, projectFilesView, removeProjectFile, storyFile, useMyFile } from '../src/board/project-files.js';
import { hiddenFiles, placeStoryFiles } from '../src/engine/local-files.js';
import { addWorktree, stageAll } from '../src/engine/git.js';
import { copyEnvFiles } from '../src/engine/run-app.js';
import { buildPrompt, offLimitsText } from '../src/engine/prompts.js';
import { SETUP_STEPS } from '../src/board/setup-state.js';
import { dropSetupCopies, runSetupProof, setupCopyDir } from '../src/engine/onboard.js';

/** The files an engineer keeps agents off: what can be named, what goes in a story's copy, and what never goes in a commit. */

let root: string;
let bp: BoardPaths;
const sh = (cmd: string, cwd = root) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (file: string, text: string, dir = root) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};
const REAL = 'REAL-VALUE-4471';
const TEST = 'TEST-VALUE-2208';
const local = { repo: '.', path: '.env.dev' };

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-files-')));
  sh('git init -q -b main');
  write('.gitignore', '.env.dev\npublic/config.js\n.squad/\n');
  write('docker-compose.yml', 'services: {}\n');
  write('docker/Dockerfile.api', 'FROM node\n');
  write('src/app.ts', 'export {};\n');
  write('.env.example', 'KEY=\n');
  sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm start');
  write('.env.dev', `KEY=${REAL}\n`);
  write('public/config.js', `var k='${REAL}';\n`);
  bp = boardPaths(path.join(root, '.squad'));
  seedDemoBoard(bp, { project: 'App', user: 'Momen' } as never);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('naming a file', () => {
  it('takes a local file git leaves out, and a locked file git has', () => {
    expect(addLocalFile(bp, undefined, './public//config.js')).toEqual({ repo: '.', path: 'public/config.js' });
    expect(addLockedFile(bp, '.', 'docker-compose.yml')).toEqual({ repo: '.', path: 'docker-compose.yml' });
    const meta = readMeta(bp);
    expect(meta.localFiles).toEqual([{ repo: '.', path: 'public/config.js' }]);
    expect(meta.lockedFiles).toEqual([{ repo: '.', path: 'docker-compose.yml' }]);
    expect(offLimits(meta)).toEqual(['public/config.js', 'docker-compose.yml']);
    // Names only are shared with the team.
    expect(fs.readFileSync(bp.configFile, 'utf8')).toContain('public/config.js');
    expect(fs.readFileSync(bp.configFile, 'utf8')).not.toContain(REAL);
  });

  it('says plainly what is wrong, and changes nothing', () => {
    expect(() => addLocalFile(bp, '.', '')).toThrow("Write the file's path");
    expect(() => addLocalFile(bp, '.', '/etc/passwd')).toThrow('must be inside the repo');
    expect(() => addLocalFile(bp, '.', '../other/.env')).toThrow('must be inside the repo');
    expect(() => addLocalFile(bp, '.', 'C:\\keys\\a.txt')).toThrow('must be inside the repo');
    expect(() => addLocalFile(bp, '.', '.git/config')).toThrow('Agents already cannot change');
    expect(() => addLocalFile(bp, '.', '.squad/config.yaml')).toThrow('Agents already cannot change');
    expect(() => addLocalFile(bp, '.', 'public')).toThrow('is a folder');
    expect(() => addLocalFile(bp, 'nope', '.env.dev')).toThrow('There is no code repo at nope');
    expect(() => addLocalFile(bp, '.', 'docker-compose.yml')).toThrow('is in git');
    expect(() => addLocalFile(bp, '.', 'notes.txt')).toThrow("Add it to the repo's .gitignore first");
    expect(() => addLockedFile(bp, '.', '.env.dev')).toThrow('is not in git');
    expect(readMeta(bp).localFiles).toBeUndefined();
    expect(readMeta(bp).lockedFiles).toBeUndefined();
  });

  it('asks which repo on a workspace', () => {
    writeMeta(bp, { ...readMeta(bp), repos: [{ path: 'a', base: 'main', remote: '', commands: {} }, { path: 'b', base: 'main', remote: '', commands: {} }] });
    expect(() => addLocalFile(bp, undefined, '.env.dev')).toThrow('Say which repo it is in: a, b.');
  });

  it('finds the Docker files in git, and locks them together', () => {
    expect(projectFilesView(bp).docker.map((f) => f.path).sort()).toEqual(['docker-compose.yml', 'docker/Dockerfile.api']);
    expect(lockDockerFiles(bp)).toHaveLength(2);
    expect(projectFilesView(bp).docker).toEqual([]);
    expect(projectFilesView(bp).locked).toHaveLength(2);
    expect(() => lockDockerFiles(bp)).toThrow('no Docker file to lock');
  });

  it('takes a file off the list, with the values kept for stories', () => {
    addLocalFile(bp, '.', '.env.dev');
    useMyFile(bp, '.', '.env.dev');
    const kept = storyFile(bp, local);
    expect(fs.existsSync(kept)).toBe(true);
    removeProjectFile(bp, '.', '.env.dev');
    expect(fs.existsSync(kept)).toBe(false);
    expect(readMeta(bp).localFiles).toBeUndefined();
    expect(() => removeProjectFile(bp, '.', '.env.dev')).toThrow('is not on the list');
  });
});

describe('the values stories use', () => {
  it('are never taken from the person without asking, and never shown', () => {
    addLocalFile(bp, '.', '.env.dev');
    const view = projectFilesView(bp).local[0]!;
    expect(view).toMatchObject({ ready: false, inFolder: true });
    expect(JSON.stringify(projectFilesView(bp))).not.toContain(REAL);
    expect(fs.existsSync(view.storyFile)).toBe(false);
  });

  it('start from the file in the folder when the person says so, private to them', () => {
    addLocalFile(bp, '.', '.env.dev');
    useMyFile(bp, '.', '.env.dev');
    const view = projectFilesView(bp).local[0]!;
    expect(view.ready).toBe(true);
    expect(fs.readFileSync(view.storyFile, 'utf8')).toContain(REAL);
    if (process.platform !== 'win32') expect(fs.statSync(view.storyFile).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(projectFilesView(bp))).not.toContain(REAL);
  });

  it('cannot start from a file that is not there or not on the list', () => {
    expect(() => useMyFile(bp, '.', '.env.dev')).toThrow('is not a local file yet');
    addLocalFile(bp, '.', '.env.dev');
    fs.rmSync(path.join(root, '.env.dev'));
    expect(() => useMyFile(bp, '.', '.env.dev')).toThrow('There is no .env.dev in your folder');
  });

  it('live outside the project, so no copy of the code or commit can carry them', () => {
    expect(storyFile(bp, local).startsWith(root)).toBe(false);
  });
});

describe("a story's copy", () => {
  let wt: string;
  const giveValues = (text = `KEY=${TEST}\n`) => {
    addLocalFile(bp, '.', '.env.dev');
    fs.mkdirSync(path.dirname(storyFile(bp, local)), { recursive: true });
    fs.writeFileSync(storyFile(bp, local), text);
  };

  beforeEach(() => {
    wt = addWorktree(root, 'AP-1', 'main').dir;
  });

  it("gets the story's values, never the person's", () => {
    giveValues();
    expect(placeStoryFiles(bp, '.', wt)).toEqual({ placed: ['.env.dev'], missing: [] });
    expect(fs.readFileSync(path.join(wt, '.env.dev'), 'utf8')).toContain(TEST);
    expect(fs.readFileSync(path.join(wt, '.env.dev'), 'utf8')).not.toContain(REAL);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(wt, '.env.dev')).mode & 0o777).toBe(0o600);
  });

  it('says which file has no values yet, and puts nothing there', () => {
    addLocalFile(bp, '.', '.env.dev');
    expect(placeStoryFiles(bp, '.', wt)).toEqual({ placed: [], missing: ['.env.dev'] });
    expect(fs.existsSync(path.join(wt, '.env.dev'))).toBe(false);
  });

  it('takes new values, and comes back when something removed it', () => {
    giveValues();
    placeStoryFiles(bp, '.', wt);
    fs.writeFileSync(storyFile(bp, local), 'KEY=NEWER\n');
    placeStoryFiles(bp, '.', wt);
    expect(fs.readFileSync(path.join(wt, '.env.dev'), 'utf8')).toBe('KEY=NEWER\n');
    fs.rmSync(path.join(wt, '.env.dev'));
    placeStoryFiles(bp, '.', wt);
    expect(fs.existsSync(path.join(wt, '.env.dev'))).toBe(true);
  });

  it('only the repo it belongs to gets it', () => {
    giveValues();
    expect(placeStoryFiles(bp, 'other', wt)).toEqual({ placed: [], missing: [] });
  });

  it('a link in the copy never sends the file somewhere else', () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-outside-')));
    try {
      // A link where the file goes: replaced, and the file it pointed at is left alone.
      fs.writeFileSync(path.join(outside, 'target.txt'), 'theirs\n');
      giveValues();
      fs.symlinkSync(path.join(outside, 'target.txt'), path.join(wt, '.env.dev'));
      expect(placeStoryFiles(bp, '.', wt).placed).toEqual(['.env.dev']);
      expect(fs.readFileSync(path.join(outside, 'target.txt'), 'utf8')).toBe('theirs\n');
      expect(fs.lstatSync(path.join(wt, '.env.dev')).isSymbolicLink()).toBe(false);
      // A link on the way to it: nothing is written through it.
      addLocalFile(bp, '.', 'public/config.js');
      const f = { repo: '.', path: 'public/config.js' };
      fs.mkdirSync(path.dirname(storyFile(bp, f)), { recursive: true });
      fs.writeFileSync(storyFile(bp, f), TEST);
      fs.symlinkSync(outside, path.join(wt, 'public'));
      expect(placeStoryFiles(bp, '.', wt).missing).toEqual(['public/config.js']);
      expect(fs.existsSync(path.join(outside, 'config.js'))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('saving works while git ignores it, which is the usual case', () => {
    giveValues();
    placeStoryFiles(bp, '.', wt);
    fs.writeFileSync(path.join(wt, 'src/app.ts'), 'export const a = 2;\n');
    expect(() => stageAll(wt)).not.toThrow();
    expect(sh('git diff --cached --name-only', wt)).toBe('src/app.ts');
  });

  it('never goes in a commit, even when the story takes it out of .gitignore', () => {
    giveValues();
    placeStoryFiles(bp, '.', wt);
    fs.writeFileSync(path.join(wt, '.gitignore'), '.squad/\n');
    fs.writeFileSync(path.join(wt, 'src/app.ts'), 'export const a = 1;\n');
    stageAll(wt);
    const staged = sh('git diff --cached --name-only', wt).split('\n');
    expect(staged).toContain('src/app.ts');
    expect(staged).not.toContain('.env.dev');
  });

  it('a copy with no local files stages as before', () => {
    fs.writeFileSync(path.join(wt, '.env.mine'), 'x\n');
    placeStoryFiles(bp, '.', wt);
    stageAll(wt);
    expect(sh('git diff --cached --name-only', wt)).toBe('.env.mine');
  });
});

describe('what no agent may read', () => {
  it('names the local files in the folder and the copy, and the project .env files, by exact path', () => {
    write('.env', 'A=1\n');
    write('sub/.env.local', 'B=1\n');
    sh('git rm -q --cached .gitignore && printf ".env*\\n!.env.example\\npublic/config.js\\n.squad/\\n" > .gitignore && git add .gitignore && git -c user.name=t -c user.email=t@t commit -qm ignore');
    addLocalFile(bp, '.', 'public/config.js');
    const hidden = hiddenFiles(bp, '/copy/AP-1');
    expect(hidden).toEqual(expect.arrayContaining([path.join(root, '.env'), path.join(root, 'sub/.env.local'), path.join(root, '.env.dev'), path.join(root, 'public/config.js'), '/copy/AP-1/public/config.js']));
    // A Builder still reads what is meant to be read.
    expect(hidden).not.toContain(path.join(root, '.env.example'));
    expect(hidden.some((f) => f.endsWith('/story-files/**'))).toBe(true);
  });

  it('adds nothing on a project with no such files', () => {
    fs.rmSync(path.join(root, '.env.dev'));
    expect(hiddenFiles(bp, '/copy/AP-1')).toEqual([]);
  });

  it('asks for nothing when the project has no board yet', () => {
    expect(hiddenFiles(boardPaths(path.join(root, 'none', '.squad')))).toEqual([]);
  });
});

describe("squad-kit's own copy for the first run", () => {
  const proofDeps = () => ({ shoot: async () => ({ why: 'no picture' }), signal: new AbortController().signal });

  const runSetupWith = async (values: string | null) => {
    write('package.json', JSON.stringify({ scripts: { test: 'node -e "process.stdout.write(require(\'fs\').readFileSync(\'.env.dev\',\'utf8\'))"' } }));
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm scripts');
    addLocalFile(bp, '.', '.env.dev');
    if (values) {
      fs.mkdirSync(path.dirname(storyFile(bp, local)), { recursive: true });
      fs.writeFileSync(storyFile(bp, local), values);
    }
    const dir = setupCopyDir(bp, { path: '.', base: 'main', remote: '', commands: {} });
    fs.rmSync(dir, { recursive: true, force: true });
    const meta = readMeta(bp);
    writeMeta(bp, { ...meta, engine: 'live', commands: { test: 'npm test' }, setup: { steps: SETUP_STEPS.map((id) => ({ id, state: id === 'commands' || id === 'tests' ? 'todo' : 'done' })), proof: {} } as never });
    await runSetupProof(bp, proofDeps());
    return { dir, kept: JSON.stringify(readMeta(bp).setup) };
  };

  afterEach(() => {
    dropSetupCopies(bp);
  });

  it("uses the story's values for a named local file, never the person's", async () => {
    const { dir, kept } = await runSetupWith(`KEY=${TEST}\n`);
    expect(fs.readFileSync(path.join(dir, '.env.dev'), 'utf8')).toContain(TEST);
    expect(kept).not.toContain(REAL);
  });

  it("leaves a named local file out when it has no values, and never takes the person's", async () => {
    const { dir, kept } = await runSetupWith(null);
    expect(fs.existsSync(path.join(dir, '.env.dev'))).toBe(false);
    expect(kept).not.toContain(REAL);
  });
});

describe("squad-kit's own copies", () => {
  it("that run the person's version take their files, with the .env files", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-own-copy-')));
    try {
      expect(copyEnvFiles(root, dir, ['public/config.js', 'not/there.js'])).toEqual(['.env.dev', 'public/config.js'].filter((f) => fs.existsSync(path.join(root, f))));
      expect(fs.readFileSync(path.join(dir, 'public/config.js'), 'utf8')).toContain(REAL);
      expect(fs.existsSync(path.join(dir, 'not/there.js'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the Builder is told', () => {
  it('which files it cannot use, only when there are some', () => {
    expect(offLimitsText(readMeta(bp))).toBe('');
    addLocalFile(bp, '.', '.env.dev');
    addLockedFile(bp, '.', 'docker-compose.yml');
    const text = offLimitsText(readMeta(bp));
    expect(text).toContain('.env.dev: you cannot read these');
    expect(text).toContain('run_checks and start_app');
    expect(text).toContain('docker-compose.yml: you can read these');
    expect(text).toContain('say so in notes');
    const ticket = { id: 'AP-1', title: 'x', ask: 'x', steps: [], criteria: [], activity: [] } as never;
    expect(buildPrompt(readMeta(bp), [], ticket)).toContain('Files only an engineer changes');
  });
});
