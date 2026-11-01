import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { boardPaths } from '../src/board/store.js';
import { seedDemoBoard } from '../src/board/demo.js';
import { readAppInfo, readConsoleInfo } from '../src/board/console-info.js';

/**
 * The one app from the terminal (ADR-001): plain `squad` starts it from any folder, `squad console` in a project folder
 * adds that project to the running app and prints its link, and terminal commands take --project.
 */

const repo = path.resolve(__dirname, '..');
const tsx = pathToFileURL(path.join(repo, 'node_modules/tsx/dist/loader.mjs')).href;
const cli = path.join(repo, 'src/cli.ts');

let tmp: string;
let app: ChildProcess | undefined;
let output = '';

function squad(cwd: string, ...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    execFile(process.execPath, ['--import', tsx, cli, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' }, timeout: 60_000 }, (err, stdout, stderr) =>
      done({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` }),
    );
  });
}

async function until<T>(what: string, check: () => Promise<T | undefined>, ms = 40_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await check().catch(() => undefined);
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${what}. App output:\n${output}`);
}

function demoProject(name: string) {
  const root = path.join(tmp, name.toLowerCase().replace(/\s+/g, '-'));
  fs.mkdirSync(path.join(root, '.squad'), { recursive: true });
  fs.writeFileSync(path.join(root, '.squad', 'config.yaml'), yaml.dump({ version: 1, project: { name, primaryLanguage: 'typescript' }, tracker: { type: 'none' }, agents: [] }));
  const bp = boardPaths(path.join(root, '.squad'));
  seedDemoBoard(bp, { speed: 0.001, project: name });
  return bp;
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-one-app-cli-')));
});

afterAll(() => {
  if (app?.pid && app.exitCode === null) app.kill('SIGKILL');
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('squad, the one app, from the terminal', () => {
  it('starts from any folder, takes projects from squad console, and answers --project', async () => {
    app = spawn(process.execPath, ['--import', tsx, cli, '--no-open', '--port', '0'], { cwd: tmp, env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    app.stdout!.on('data', (d) => (output += d));
    app.stderr!.on('data', (d) => (output += d));
    const exited = new Promise<number | null>((done) => app!.on('exit', (code) => done(code)));
    const info = await until('the app', async () => {
      const i = readAppInfo();
      if (!i?.pid || i.pid !== app!.pid) return undefined;
      return (await fetch(`http://127.0.0.1:${i.port}/healthz`)).ok ? i : undefined;
    });
    expect(output).toContain(`http://127.0.0.1:${info.port}/?t=${info.token}`);

    // squad console in a project folder: the running app adds it; no second app starts.
    const shop = demoProject('Tea Shop');
    const added = await squad(shop.root, 'console', '--no-open');
    expect(added.code).toBe(0);
    expect(added.out).toContain('Added Tea Shop to squad-kit, which is open already.');
    expect(added.out).toContain(`Open it: http://127.0.0.1:${info.port}/p/${shop.projectId}/board?t=${info.token}`);
    expect(readAppInfo()?.pid).toBe(app.pid);
    expect(readConsoleInfo(shop)?.pid).toBe(app.pid);
    const listed = (await (await fetch(`http://127.0.0.1:${info.port}/api/v1/app/projects`, { headers: { authorization: `Bearer ${info.token}` } })).json()) as { projects: { id: string }[] };
    expect(listed.projects.map((p) => p.id)).toEqual([shop.projectId]);

    // Plain squad again points to the app that runs.
    const again = await squad(tmp, '--no-open');
    expect(again.out).toContain('squad-kit is open already');

    // Outside a project folder: one Waiting for you list across the projects, with commands that name the project.
    const inbox = await squad(tmp, 'inbox');
    expect(inbox.out).toMatch(/Waiting for you \(\d+\) in 1 project/);
    expect(inbox.out).toContain('--project "Tea Shop"');

    // --project picks the project from any folder, by name or folder.
    const board = await squad(tmp, 'board', '--project', 'tea shop');
    expect(board.out).toContain('Tea Shop');
    expect(board.out).toContain('open tickets');
    expect((await squad(os.tmpdir(), 'show', 'SK-148', '--project', shop.root)).out).toContain('SK-148');
    const wrong = await squad(tmp, 'inbox', '--project', 'nothing');
    expect(wrong.code).not.toBe(0);
    expect(wrong.out).toContain('No project called "nothing". Your projects: Tea Shop.');

    const projects = await squad(tmp, 'projects');
    expect(projects.out).toContain('Tea Shop');
    expect(projects.out).toMatch(/\d+ open/);

    expect((await squad(tmp, 'inbx')).out).toContain("unknown command 'inbx'");

    app.kill('SIGINT');
    expect(await exited).toBe(0);
    expect(readAppInfo()?.pid).toBeNull();
    expect(readConsoleInfo(shop)?.pid).toBeNull();
    expect(output).toContain('console stopped');
  }, 120_000);
});
