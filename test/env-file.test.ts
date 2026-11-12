import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { boardPaths, readMeta, writeMeta, type BoardPaths } from '../src/board/store.js';
import { seedDemoBoard } from '../src/board/demo.js';
import { buildPaths } from '../src/core/paths.js';
import { mountBoardApi } from '../src/console/api/board.js';
import { runEnvFile } from '../src/commands/env-file.js';
import { envFileProblem, envFileSetting, envFilesFor, envFilesIn, envFilesOf, parseEnvFile, readEnvFiles, setEnvFile } from '../src/engine/env-file.js';
import { harnessView } from '../src/engine/harness.js';
import { hiddenFiles } from '../src/engine/local-files.js';
import { isPlain } from '../src/engine/shots.js';
import { addWorktree } from './support/copy.js';

/**
 * A part's env file: the setting, how squad-kit reads the file the way Docker Compose does, which part a folder holds,
 * and the same setting through the API Settings uses, the terminal and the Harness page. Made-up projects only: a shop
 * API whose daily stack runs in Docker Compose. Only the path is ever shown; a value never is.
 */

let root: string;
let bp: BoardPaths;
const sh = (cmd: string, cwd = root) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (file: string, text: string, dir = root) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};
const SECRET = 'SHOP-SECRET-5512';

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-envfile-')));
  sh('git init -q -b main');
  write('.gitignore', '.env.dev\n.squad/\n');
  write('src/Shop.Api/Program.cs', '// shop\n');
  sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm start');
  write('.env.dev', `ConnectionStrings__Shop=mongodb://shop:${SECRET}@app.db:27017/shop\n`);
  bp = boardPaths(path.join(root, '.squad'));
  seedDemoBoard(bp, { project: 'Shop', speed: 0.001 });
  writeMeta(bp, { ...readMeta(bp), commands: { test: 'dotnet test' } });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('reading an env file the way Docker Compose does', () => {
  it('reads every form: export, quotes, comments, empty values, several lines, and no $NAME filled in', () => {
    const text = [
      '\uFEFF# the shop API on this computer',
      'export EXPORTED=yes',
      'PLAIN=value',
      '  SPACED = two words  ',
      'INLINE=value # a comment',
      'HASH=#not-a-comment',
      'EMPTY=',
      'EMPTY_COMMENT= # nothing here',
      "SINGLE='as $written \\n kept'",
      'DOUBLE="say \\"hi\\"\\nnext # kept" # a comment',
      'MULTI="first',
      'second"',
      'DOLLAR=$HOME/shop',
      'ConnectionStrings__Shop=mongodb://shop:pw@app.db:27017/shop?authSource=admin',
      'Logging.Level-Name=Debug',
      'BARE',
      '=nothing',
      'PLAIN=later wins',
    ].join('\r\n');
    expect(Object.fromEntries(parseEnvFile(text))).toEqual({
      EXPORTED: 'yes',
      PLAIN: 'later wins',
      SPACED: 'two words',
      INLINE: 'value',
      HASH: '#not-a-comment',
      EMPTY: '',
      EMPTY_COMMENT: '',
      SINGLE: 'as $written \\n kept',
      DOUBLE: 'say "hi"\nnext # kept',
      MULTI: 'first\nsecond',
      DOLLAR: '$HOME/shop',
      ConnectionStrings__Shop: 'mongodb://shop:pw@app.db:27017/shop?authSource=admin',
      'Logging.Level-Name': 'Debug',
    });
  });

  it('a quote that never closes is read as written', () => {
    expect(parseEnvFile('OPEN="half\nNEXT=1\n')).toEqual([
      ['OPEN', '"half'],
      ['NEXT', '1'],
    ]);
  });

  it('reads several files, a later one over an earlier one, and nothing outside the folder', () => {
    write('.env', 'A=1\nB=1\n');
    write('config/api.env', 'B=2\n');
    fs.mkdirSync(path.join(root, 'a-folder.env'));
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-envfile-out-')), 'keys.env');
    fs.writeFileSync(outside, `KEY=${SECRET}\n`);
    fs.symlinkSync(outside, path.join(root, 'linked.env'));
    const got = readEnvFiles(root, ['.env', 'config/api.env', 'nope.env', 'linked.env', 'a-folder.env']);
    expect(got.env).toEqual({ A: '1', B: '2' });
    expect(got.read).toEqual(['.env', 'config/api.env']);
    expect(got.missing).toEqual(['nope.env']);
    expect(got.refused).toEqual(['linked.env', 'a-folder.env']);
    expect(JSON.stringify(got)).not.toContain(SECRET);
    fs.rmSync(path.dirname(outside), { recursive: true, force: true });
  });
});

describe('the setting', () => {
  it('takes one path in the repo or several, cleaned', () => {
    expect(envFileSetting('./.env.dev')).toBe('.env.dev');
    expect(envFileSetting(' .env.dev ,config\\api.env, .env.dev ')).toBe('.env.dev, config/api.env');
    expect(envFileSetting(['.env', 'docker/.env.dev'])).toBe('.env, docker/.env.dev');
    expect(envFileSetting('')).toBe('');
    expect(envFilesOf({ envFile: '.env, docker/.env.dev' })).toEqual(['.env', 'docker/.env.dev']);
    expect(envFilesOf({})).toEqual([]);
  });

  it('says plainly what is wrong with a path', () => {
    expect(envFileProblem('../other/.env')).toContain('must be inside the repo');
    expect(envFileProblem('/etc/hosts')).toContain('must be inside the repo');
    expect(envFileProblem('C:\\keys\\.env')).toContain('must be inside the repo');
    expect(envFileProblem('.git/config')).toContain('is not an env file');
    expect(envFileProblem('.squad/config.yaml')).toContain('is not an env file');
    expect(envFileProblem('config/')).toContain('is a folder');
    expect(envFileProblem('.env.dev')).toBeNull();
    expect(() => envFileSetting('.env, ../x')).toThrow('must be inside the repo');
  });

  it('is saved for a repo, and taken away', () => {
    expect(setEnvFile(bp, undefined, ['./.env.dev'])).toEqual({ repo: '.', files: ['.env.dev'] });
    expect(readMeta(bp).commands).toEqual({ test: 'dotnet test', envFile: '.env.dev' });
    expect(fs.readFileSync(bp.configFile, 'utf8')).toContain('envFile: .env.dev');
    expect(fs.readFileSync(bp.configFile, 'utf8')).not.toContain(SECRET);
    setEnvFile(bp, '.', []);
    expect(readMeta(bp).commands).toEqual({ test: 'dotnet test' });
    expect(() => setEnvFile(bp, 'web', ['.env'])).toThrow('There is no code repo at web');
  });

  it('asks which repo on a workspace', () => {
    writeMeta(bp, { ...readMeta(bp), repos: [{ path: 'api', base: 'main', remote: '', commands: { test: 'dotnet test' } }, { path: 'web', base: 'main', remote: '', commands: {} }] });
    expect(() => setEnvFile(bp, undefined, ['.env.dev'])).toThrow('Say which repo it is for: api, web');
    setEnvFile(bp, 'api', ['.env.dev']);
    expect(readMeta(bp).repos![0]!.commands).toEqual({ test: 'dotnet test', envFile: '.env.dev' });
    expect(readMeta(bp).repos![1]!.commands).toEqual({});
  });
});

describe('which part a folder holds', () => {
  it("a copy of the repo is a copy, the person's own folder is not, and a folder of no project has none", () => {
    expect(envFilesFor(root)).toBeNull();
    setEnvFile(bp, '.', ['.env.dev']);
    const copy = addWorktree(root, 'SH-1', 'main').dir;
    expect(envFilesFor(copy)).toEqual({ top: fs.realpathSync(copy), repo: '.', files: ['.env.dev'], copy: true });
    expect(envFilesFor(path.join(copy, 'src', 'Shop.Api'))).toMatchObject({ top: fs.realpathSync(copy), copy: true });
    expect(envFilesFor(root)).toEqual({ top: root, repo: '.', files: ['.env.dev'], copy: false });
    expect(envFilesIn(copy)).toEqual(['.env.dev']);
    expect(envFilesIn(path.join(copy, 'src'))).toEqual([]);
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-envfile-other-')));
    try {
      sh('git init -q -b main', other);
      expect(envFilesFor(other)).toBeNull();
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("on a workspace, each repo's copy has its own", () => {
    for (const r of ['api', 'web']) {
      sh(`git init -q -b main ${r}`);
      write(`${r}/README.md`, `# ${r}\n`);
      sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm start', path.join(root, r));
    }
    writeMeta(bp, { ...readMeta(bp), repos: [{ path: 'api', base: 'main', remote: '', commands: { envFile: 'deploy/api.env' } }, { path: 'web', base: 'main', remote: '', commands: {} }] });
    const api = addWorktree(path.join(root, 'api'), 'SH-2', 'main').dir;
    const web = addWorktree(path.join(root, 'web'), 'SH-2', 'main').dir;
    expect(envFilesFor(api)).toMatchObject({ repo: 'api', files: ['deploy/api.env'], copy: true });
    expect(envFilesFor(web)).toBeNull();
  });
});

describe('the agents', () => {
  it('cannot read an env file git does not carry, in your folder or in a copy; one in git stays as any file', async () => {
    write('config/api.env', `KEY=${SECRET}\n`);
    write('.gitignore', '.env.dev\n.squad/\nconfig/api.env\n');
    write('deploy/dev.env', 'MODE=dev\n');
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm files');
    setEnvFile(bp, '.', ['config/api.env', 'deploy/dev.env']);
    const copy = addWorktree(root, 'SH-5', 'main').dir;
    const hidden = await hiddenFiles(bp, copy);
    expect(hidden).toEqual(expect.arrayContaining([path.join(root, 'config/api.env'), path.join(copy, 'config/api.env')]));
    expect(hidden).not.toContain(path.join(root, 'deploy/dev.env'));
    expect(hidden).not.toContain(path.join(copy, 'deploy/dev.env'));
  });
});

describe('through the API Settings uses', () => {
  const put = async (body: unknown) => {
    const app = new Hono();
    mountBoardApi(app, { paths: buildPaths(root) });
    return app.request('/api/v1/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  };

  it('saves the env file beside the commands, cleaned, and refuses one outside the repo', async () => {
    const ok = await put({ commands: { test: 'dotnet test', envFile: './.env.dev' } });
    expect(ok.status).toBe(200);
    expect(readMeta(bp).commands).toEqual({ test: 'dotnet test', envFile: '.env.dev' });
    expect(await ok.text()).not.toContain(SECRET);
    const bad = await put({ commands: { test: 'dotnet test', envFile: '../../keys.env' } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('must be inside the repo');
    expect(readMeta(bp).commands).toEqual({ test: 'dotnet test', envFile: '.env.dev' });
    expect((await put({ commands: { test: 'dotnet test', envFile: '' } })).status).toBe(200);
    expect(readMeta(bp).commands).toEqual({ test: 'dotnet test' });
  });

  it("saves each repo's own on a workspace", async () => {
    writeMeta(bp, { ...readMeta(bp), repos: [{ path: 'api', base: 'main', remote: '', commands: {} }] });
    expect((await put({ repos: [{ path: 'api', commands: { envFile: 'docker\\.env.dev' } }] })).status).toBe(200);
    expect(readMeta(bp).repos![0]!.commands).toEqual({ envFile: 'docker/.env.dev' });
  });
});

describe('squad config set env-file', () => {
  it('does what the field does, and shows only the path', async () => {
    const cwd = process.cwd();
    const printed: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      printed.push(String(s));
      return true;
    });
    process.chdir(root);
    try {
      await runEnvFile([]);
      expect(printed.join('')).toContain('none');
      await runEnvFile(['./.env.dev']);
      expect(readMeta(bp).commands?.envFile).toBe('.env.dev');
      printed.length = 0;
      await runEnvFile([]);
      expect(printed.join('')).toContain('.env.dev');
      expect(printed.join('')).not.toContain(SECRET);
      await expect(runEnvFile(['../keys.env'])).rejects.toThrow('must be inside the repo');
      await runEnvFile([], { clear: true });
      expect(readMeta(bp).commands?.envFile).toBeUndefined();
    } finally {
      process.chdir(cwd);
      spy.mockRestore();
    }
  });
});

describe('the Harness page', () => {
  it("shows the part's env file read only, right after Local files, in plain words", () => {
    const build = harnessView({ commands: { envFile: '.env.dev' } } as never).stages.find((s) => s.id === 'build')!.gates;
    const at = build.findIndex((g) => g.id === 'env-file');
    expect(build[at - 1]!.id).toBe('local-files');
    expect(build[at]).toMatchObject({ name: "A part's env file", what: "squad-kit gives the app the story's values from it, then its own database, Redis and the app's address on top." });
    expect(build[at]!.you).toBeUndefined();
    expect(isPlain(build[at]!.what)).toBe(true);
    const d = Object.fromEntries(build[at]!.d!);
    expect(d).toMatchObject({ Here: '.env.dev', 'In the code': 'src/engine/env-file.ts', 'In the log': 'The names only, never a value' });
    const workspace = harnessView({ repos: [{ path: 'api', base: 'main', remote: '', commands: { envFile: '.env.dev' } }, { path: 'web', base: 'main', remote: '', commands: {} }] } as never);
    expect(Object.fromEntries(workspace.stages.find((s) => s.id === 'build')!.gates.find((g) => g.id === 'env-file')!.d!).Here).toBe('api: .env.dev');
    expect(Object.fromEntries(harnessView().stages.find((s) => s.id === 'build')!.gates.find((g) => g.id === 'env-file')!.d!).Here).toBe('None yet');
  });
});
