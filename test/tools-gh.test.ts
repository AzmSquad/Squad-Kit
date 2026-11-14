import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { detectAll, ghVersionOf, type DetectHost, type Ran } from '../src/engine/tools/detect.js';
import { kindsOf } from '../src/engine/tools/kinds.js';
import { linesFor } from '../src/engine/tools/index.js';

/**
 * GitHub's own tool on the Tools page (ADR-008): Recommended for a project whose code is kept on GitHub, with the steps
 * to install it and sign in. Signed out counts as not ready, with one line that says so. It never stops a story: without
 * it, the work merges on this computer as before.
 */

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-tools-gh-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function mac(answers: Record<string, Ran>, gh = true): DetectHost {
  return {
    system: 'mac',
    home: '/Users/pm',
    env: { PATH: '/opt/homebrew/bin' },
    run: async (cmd, args) => answers[`${path.basename(cmd)} ${args.join(' ')}`] ?? { ok: false, out: '', err: 'not found' },
    exists: (p) => gh && p === '/opt/homebrew/bin/gh',
    read: () => null,
    real: (p) => p,
    list: () => [],
    writable: () => true,
  };
}

describe("GitHub's tool on the Tools page", () => {
  it('reads its version, and whether it is signed in from the exit code only', async () => {
    expect(ghVersionOf('gh version 2.63.0 (2024-11-27)\nhttps://github.com/cli/cli/releases/tag/v2.63.0\n')).toBe('2.63.0');
    const version = { ok: true, out: 'gh version 2.63.0 (2024-11-27)\n', err: '' };
    const ready = await detectAll(mac({ 'gh --version': version, 'gh auth token --hostname github.com': { ok: true, out: 'gho_made_up', err: '' } }), tmp);
    expect(ready.tools.gh).toEqual({ state: 'found', where: '/opt/homebrew/bin/gh', version: '2.63.0' });
    expect(JSON.stringify(ready)).not.toContain('gho_made_up');
    const out = await detectAll(mac({ 'gh --version': version, 'gh auth token --hostname github.com': { ok: false, out: '', err: 'no oauth token' } }), tmp);
    expect(out.tools.gh).toMatchObject({ state: 'missing', version: '2.63.0', note: "GitHub's tool is here, but not signed in. Sign in once: open a terminal and run gh auth login." });
    expect((await detectAll(mac({}, false), tmp)).tools.gh).toEqual({ state: 'missing' });
  });

  it('a project kept on GitHub gets the line, Recommended, with the steps; one kept elsewhere does not', async () => {
    const app = path.join(tmp, 'app');
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, 'package.json'), '{}');
    execSync('git init -q -b main && git remote add origin git@github.com:me/app.git', { cwd: app });
    expect(kindsOf(app).kinds).toEqual(['web', 'github']);
    // A story's copy (a git worktree) reads the same remotes.
    execSync('git -c user.name=t -c user.email=t@t commit -q --allow-empty -m start && git worktree add -q ../copy -b story', { cwd: app });
    expect(kindsOf(path.join(tmp, 'copy')).kinds).toContain('github');
    const book = { at: '', system: 'mac' as const, tools: { gh: { state: 'missing' as const } } };
    const line = linesFor([{ place: '.', kinds: ['web', 'github'], platforms: ['web'] }], book, 'mac').find((l) => l.id === 'gh')!;
    expect(line).toMatchObject({ name: "GitHub's tool (gh)", priority: 'recommended', state: 'missing', usedFor: 'Pull requests', blocks: [], installer: 'you', link: 'https://cli.github.com', command: 'squad tools check' });
    expect(line.steps).toEqual(['Open a terminal.', "Run: brew install gh. Without Homebrew, get it from GitHub's tool page.", 'Run: gh auth login, and sign in with your browser.', 'Come back here and press Check again.']);
    const azure = path.join(tmp, 'azure');
    fs.mkdirSync(azure);
    fs.writeFileSync(path.join(azure, 'package.json'), '{}');
    execSync('git init -q -b main && git remote add origin https://dev.azure.com/o/p/_git/r', { cwd: azure });
    expect(kindsOf(azure).kinds).toEqual(['web', 'azure']);
    expect(linesFor([{ place: '.', kinds: ['web', 'azure'], platforms: ['web'] }], book, 'mac').some((l) => l.id === 'gh')).toBe(false);
  });
});
