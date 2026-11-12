import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { Hono } from 'hono';
import { firstLook } from '../src/engine/first-look.js';
import { prepareProject } from '../src/engine/setup.js';
import { overviewView, setupView } from '../src/board/first-run.js';
import { saveScan, type ScanAnswer } from '../src/engine/onboard.js';
import { readMeta, writeMeta, writeRelease } from '../src/board/store.js';
import { createTicket, releaseVersion } from '../src/board/actions.js';
import { saveSettings } from '../src/board/settings.js';
import { pushHandOver } from '../src/engine/handover.js';
import { mountBoardApi } from '../src/console/api/board.js';
import { docsInGit } from '../src/engine/project-git.js';
import { fileAlone } from '../src/engine/failed-tests.js';
import { SAMPLE_TOKEN, SELF_DOCS_OFF, SELF_NOTE, SELF_NO_RELEASE, designCommands, isSelfProject, isSquadKitCode, selfCommands, selfRule } from '../src/engine/self-project.js';

/**
 * Someone builds squad-kit with squad-kit: squad-kit knows its own code by its package, never by the folder's name. It
 * says so once on Add, the setup and the Overview, tells every agent, checks and runs it its own way, and leaves its
 * releases to the maintainers.
 */

let tmp: string;
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, stdio: 'ignore' });
const put = (file: string, text = 'x\n') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const squadKitPackage = { name: 'squad-kit', version: '1.3.15', bin: { squad: './dist/cli.js' }, scripts: { test: 'vitest run', lint: 'tsc --noEmit', build: 'tsup', dev: 'tsup --watch' } };

/** A folder with squad-kit's own package.json, in git, under any name. */
function squadKitRepo(name: string, pkg: object = squadKitPackage): string {
  const dir = path.join(tmp, name);
  put(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  put(path.join(dir, 'src', 'cli.ts'), 'export {};\n');
  put(path.join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  sh('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -q -m first', dir);
  return dir;
}

const read: ScanAnswer = {
  empty: false,
  summary: 'A local board',
  map: [],
  decisions: [],
  // What the Architect guessed on 1.3.15: the person's own board, on its own port.
  commands: { setup: 'pnpm install', test: 'pnpm test', lint: 'pnpm lint', build: 'pnpm build', start: 'pnpm exec tsx src/cli.ts console --no-open', url: 'http://127.0.0.1:4571' },
};

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-self-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("squad-kit knows its own code", () => {
  it('by its package: named squad-kit, with the squad command, whatever the folder is called', () => {
    expect(isSquadKitCode(squadKitRepo('my-fork'))).toBe(true);
    // The name alone, or the command alone, is some other project.
    expect(isSquadKitCode(squadKitRepo('squad-kit', { name: 'squad-kit', version: '1.0.0' }))).toBe(false);
    expect(isSquadKitCode(squadKitRepo('tool', { name: 'my-tool', bin: { squad: './cli.js' } }))).toBe(false);
    // A folder named squad-kit with another app in it is that app.
    const other = path.join(tmp, 'squad-kit-site');
    put(path.join(other, 'package.json'), JSON.stringify({ name: 'site' }));
    expect(isSquadKitCode(other)).toBe(false);
    expect(isSquadKitCode(path.join(tmp, 'nothing-here'))).toBe(false);
  });

  it('Add project says so before anything happens, with the one plain note', async () => {
    const look = await firstLook(squadKitRepo('fork'));
    expect(look.title).toBe("squad-kit's own code");
    expect(look.found).toMatch(/^squad-kit's own code: a TypeScript/);
    expect(look.next).toContain(SELF_NOTE);
  });

  it('the setup and the Overview show the note; another project shows none', () => {
    const { bp } = prepareProject(squadKitRepo('fork'));
    expect(isSelfProject(bp)).toBe(true);
    expect(setupView(bp)?.self).toBe(SELF_NOTE);
    expect(overviewView(bp).self).toBe(SELF_NOTE);
    const app = path.join(tmp, 'shop');
    put(path.join(app, 'package.json'), JSON.stringify({ name: 'shop' }));
    sh('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -q -m first', app);
    const other = prepareProject(app).bp;
    expect(isSelfProject(other)).toBe(false);
    expect(setupView(other)?.self).toBeUndefined();
    expect(overviewView(other).self).toBeUndefined();
  });

  it('every agent is told: change only the folder, never this board, ~/.squad-kit or a release', () => {
    const { bp } = prepareProject(squadKitRepo('fork'));
    const rule = selfRule(bp);
    expect(rule).toMatch(/This project is squad-kit itself/);
    expect(rule).toMatch(/Never run `squad` or `node dist\/cli\.js` against this board/);
    expect(rule).toContain('~/.squad-kit');
    expect(rule).toContain(`?t=${SAMPLE_TOKEN}`);
    expect(rule).toMatch(/No release, no version bump and no tag/);
    expect(rule).toContain('Send it as a pull request');
    const app = path.join(tmp, 'shop');
    put(path.join(app, 'index.js'));
    sh('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -q -m first', app);
    expect(selfRule(prepareProject(app).bp)).toBe('');
  });

  it("its documents stay on this computer, so a pull request carries code only", () => {
    const { bp } = prepareProject(squadKitRepo('fork'));
    expect(readMeta(bp).documentsInGit).toBe(false);
    // Even a project set up before, with documents in git on.
    writeMeta(bp, { ...readMeta(bp), documentsInGit: true });
    expect(docsInGit(bp)).toBe(false);
    // Turning it on says why it stays off, never a silent no.
    expect(() => saveSettings(bp, { documentsInGit: true })).toThrow(SELF_DOCS_OFF);
    expect(() => saveSettings(bp, { documentsInGit: false })).not.toThrow();
  });

  it('a hand over says why the documents cannot travel, and the Settings switch gets the reason', async () => {
    const { bp } = prepareProject(squadKitRepo('fork'));
    const t = createTicket(bp, { title: 'Show the version' });
    await expect(pushHandOver(bp, t)).rejects.toThrow(`${SELF_DOCS_OFF} A hand over needs them in git`);
    const app = new Hono();
    mountBoardApi(app, { paths: { squadDir: bp.squadDir } as never });
    const board = (await (await app.request('/api/v1/board')).json()) as { self?: { docs: string } };
    expect(board.self?.docs).toBe(SELF_DOCS_OFF);
  });
});

describe('how squad-kit checks and runs its own code', () => {
  it("the read's guess gives way to squad-kit's own way; what the person saved still wins", () => {
    const { bp } = prepareProject(squadKitRepo('fork'));
    saveScan(bp, read, []);
    const c = readMeta(bp).commands!;
    expect(c).toEqual(selfCommands('main'));
    // Both packages, from their lock files.
    expect(c.setup).toBe('pnpm install --frozen-lockfile && pnpm -C console-ui install --frozen-lockfile');
    // The tests the story's changes reach, from where it started, and the board's server: never the whole suite.
    expect(c.test).toBe('pnpm exec vitest run --changed main && pnpm exec vitest run test/console-server.test.ts');
    // A branch with odd characters stays one word.
    expect(selfCommands('my main').test).toContain('--changed "my main"');
    expect(c.test).toContain('test/console-server.test.ts');
    expect(c.test).not.toMatch(/^pnpm test$/);
    // Both type checks, and the build ends with the package's size limit.
    expect(c.lint).toBe('pnpm -s lint && pnpm -C console-ui lint');
    expect(c.build).toBe('pnpm -s build && pnpm -s size:guard');
    // A sample board built from the story's code, on the story's port, never the person's board on 4571.
    expect(c.start).toMatch(/^pnpm -s build && node dist\/cli\.js demo --port \$\{PORT:-4580\} --no-open --token [0-9a-f]{64}$/);
    expect(c.url).toBe(`http://127.0.0.1:4580/?t=${SAMPLE_TOKEN}`);
    expect(`${c.start} ${c.url}`).not.toContain('4571');
    // The read's parts keep no address: it was the person's own board.
    saveScan(bp, { ...read, runs: [{ id: 'console', name: 'The board', repo: '.', url: 'http://127.0.0.1:4571' }, { id: 'site', name: 'Website', repo: '.', folder: 'site' }] }, []);
    const parts = readMeta(bp).parts ?? [];
    expect(parts.map((x) => x.id)).toContain('console');
    expect(JSON.stringify(parts)).not.toContain('4571');
    // The person's own choice, saved before a read again, is kept.
    writeMeta(bp, { ...readMeta(bp), commands: { ...c, test: 'pnpm exec vitest run test/a.test.ts' } });
    saveScan(bp, read, []);
    expect(readMeta(bp).commands!.test).toBe('pnpm exec vitest run test/a.test.ts');
  });

  it('a run of one test file is made from it, never the whole related set', () => {
    const dir = squadKitRepo('fork');
    put(path.join(dir, 'node_modules', '.bin', 'vitest'), '#!/bin/sh\n');
    put(path.join(dir, 'test', 'side-version.test.ts'), 'export {};\n');
    expect(fileAlone(dir, selfCommands('main').test!, 'test/side-version.test.ts')).toEqual({ command: "npx vitest run 'test/side-version.test.ts'", tool: 'vitest' });
  });

  it('a design changes none of them: no question about commands in the middle of a story', () => {
    const { bp } = prepareProject(squadKitRepo('fork'));
    expect(designCommands(bp, readMeta(bp), { test: 'pnpm test', start: 'pnpm dev' })).toEqual({});
    const app = path.join(tmp, 'shop');
    put(path.join(app, 'index.js'));
    sh('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -q -m first', app);
    const other = prepareProject(app).bp;
    expect(designCommands(other, readMeta(other), { test: 'npm test' })).toEqual({ test: 'npm test' });
  });

  it('another project keeps what the read found', () => {
    const app = path.join(tmp, 'shop');
    put(path.join(app, 'package.json'), JSON.stringify({ name: 'shop', scripts: { test: 'node t.js' } }));
    sh('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -q -m first', app);
    const { bp } = prepareProject(app);
    saveScan(bp, { ...read, commands: { test: 'npm test', start: 'npm start', url: 'http://localhost:3000' } }, []);
    expect(readMeta(bp).commands).toMatchObject({ test: 'npm test', start: 'npm start', url: 'http://localhost:3000' });
  });
});

describe("releases are for squad-kit's maintainers", () => {
  it('Release is refused with plain words, and the board gives the Releases page its note', async () => {
    const { bp } = prepareProject(squadKitRepo('fork'));
    writeRelease(bp, { version: 'v1.3.16', status: 'draft', from: 'v1.3.15', date: '', tickets: ['SK-1'], notes: '', addons: { changelog: true, tag: true, pipeline: false, whatsapp: false } });
    await expect(releaseVersion(bp, 'v1.3.16')).rejects.toThrow(SELF_NO_RELEASE);
    const app = new Hono();
    mountBoardApi(app, { paths: { squadDir: bp.squadDir } as never });
    const board = (await (await app.request('/api/v1/board')).json()) as { self?: { note: string; releases: string } };
    expect(board.self?.note).toBe(SELF_NOTE);
    expect(board.self?.releases).toMatch(/maintainers make its releases: a release on GitHub publishes squad-kit to npm/);
    const r = await app.request('/api/v1/releases/v1.3.16/release', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe(SELF_NO_RELEASE);
    // No tag was made.
    expect(execSync('git tag', { cwd: bp.root, encoding: 'utf8' }).trim()).toBe('');
  });
});
