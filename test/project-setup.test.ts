import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import yaml from 'js-yaml';
import { boardPaths, listDecisions, listReleases, listTickets, readMeta, writeRelease } from '../src/board/store.js';
import { DEFAULT_CONFIG, saveConfig } from '../src/core/config.js';
import { ensureLiveBoard, setupProject } from '../src/engine/setup.js';

/** Every way a project starts with squad-kit: an empty folder, existing code with or without git, and squad-kit 0.x. */

let tmp: string;
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-setup-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** What `squad console` does in a folder: set it up when it has no squad-kit, then start its board. */
function open(dir: string) {
  if (!fs.existsSync(path.join(dir, '.squad', 'config.yaml'))) setupProject(dir);
  return ensureLiveBoard(boardPaths(path.join(dir, '.squad')), path.basename(dir));
}

describe('starting squad-kit in a project', () => {
  it('sets up an empty folder: a new repo, its own id, and the Architect reads it first', () => {
    const dir = path.join(tmp, 'coffee-shop');
    fs.mkdirSync(dir);
    const { bp, did } = open(dir);
    expect(did[0]).toBe('Git: made a new repo for the project');
    const config = yaml.load(fs.readFileSync(bp.configFile, 'utf8')) as { project: { name: string }; board: { id: string } };
    expect(config.project.name).toBe('coffee-shop');
    expect(config.board.id).toBe(bp.projectId);
    expect(bp.localDir.startsWith(process.env.SQUAD_KIT_HOME!)).toBe(true);
    expect(readMeta(bp)).toMatchObject({ key: 'CS', engine: 'live', scan: { status: 'pending' } });
    expect(fs.readFileSync(path.join(dir, '.squad', 'README.md'), 'utf8')).toContain("the project's memory");
    expect(sh('git log --format=%s', dir)).toBe('start the project');
    expect(sh('git status --porcelain --untracked-files=all', dir)).toBe('');
  });

  it('puts existing code without git into the first commit, but not what tools generate, or secrets', () => {
    const dir = path.join(tmp, 'old-site');
    put(path.join(dir, 'src', 'app.ts'), 'export {};\n');
    put(path.join(dir, 'dist', 'app.js'), 'built\n');
    put(path.join(dir, 'node_modules', 'x', 'index.js'), 'lib\n');
    put(path.join(dir, '.env'), 'KEY=secret\n');
    const { did } = open(dir);
    expect(did[0]).toBe('Git: made a repo, with the files already here in its first commit');
    expect(sh('git ls-files', dir).split('\n')).toEqual(['src/app.ts']);
  });

  it('keeps an existing repo as it is, and keeps .squad out of git status', () => {
    const dir = path.join(tmp, 'app');
    put(path.join(dir, 'index.ts'), 'export {};\n');
    sh('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -q -m first', dir);
    const { did } = open(dir);
    expect(did[0]).toBe('Git: found the repo, on main');
    expect(sh('git log --format=%s', dir)).toBe('first');
    expect(sh('git status --porcelain --untracked-files=all', dir)).toBe('');
  });

  it('adds a board to a squad-kit 0.x project and leaves its own files alone', () => {
    const dir = path.join(tmp, 'legacy');
    const squad = path.join(dir, '.squad');
    fs.mkdirSync(squad, { recursive: true });
    saveConfig(path.join(squad, 'config.yaml'), { ...DEFAULT_CONFIG, project: { ...DEFAULT_CONFIG.project, name: 'legacy' } });
    put(path.join(squad, 'stories', 'login', '1', 'intake.md'), '# Login\n');
    put(path.join(squad, 'releases', '2026-10-19-925572.md'), '# 2026-10-19 — Story 925572\n\nWhat changed.\n');
    put(path.join(squad, 'decisions', 'notes.md'), '# Our notes\n');
    put(path.join(squad, 'tickets', 'old', 'ticket.md'), '# Not a board ticket\n');
    put(path.join(squad, 'knowledge', 'project.md'), '# Our own project notes\n');
    put(path.join(squad, 'secrets.yaml'), 'tracker:\n  azure:\n    pat: test\n');
    put(path.join(dir, 'index.ts'), 'export {};\n');
    sh('git init -q -b main && git add index.ts && git -c user.name=t -c user.email=t@t commit -q -m first', dir);

    const { bp, did } = open(dir);
    expect(did).toContain('Sign-ins: moved out of .squad, to this computer only');
    expect(did).toContain('Your notes in knowledge/ kept as project.before-squad-kit.md');
    expect(fs.readFileSync(path.join(squad, 'stories', 'login', '1', 'intake.md'), 'utf8')).toBe('# Login\n');
    expect(fs.readFileSync(path.join(squad, 'knowledge', 'project.before-squad-kit.md'), 'utf8')).toBe('# Our own project notes\n');
    expect(fs.existsSync(path.join(squad, 'secrets.yaml'))).toBe(false);
    expect(bp.secretsFile).toBe(path.join(bp.localDir, 'secrets.yaml'));
    expect(fs.statSync(bp.secretsFile).mode & 0o777).toBe(0o600);

    // The project's own notes in the board's folders are not the board's records.
    expect(listReleases(bp)).toEqual([]);
    expect(listDecisions(bp)).toEqual([]);
    expect(listTickets(bp)).toEqual([]);
    writeRelease(bp, { version: 'v0.1.0', status: 'draft', from: 'v0.0.0', tickets: [], notes: '', addons: { changelog: true, tag: true, pipeline: true, whatsapp: true } });
    expect(listReleases(bp).map((r) => r.version)).toEqual(['v0.1.0']);
    expect(fs.readFileSync(path.join(squad, 'releases', '2026-10-19-925572.md'), 'utf8')).toContain('Story 925572');
  });

  it('opens an existing board without setting anything up again', () => {
    const dir = path.join(tmp, 'again');
    fs.mkdirSync(dir);
    const first = open(dir);
    const second = open(dir);
    expect(second.did).toEqual([]);
    expect(second.bp.projectId).toBe(first.bp.projectId);
  });
});
