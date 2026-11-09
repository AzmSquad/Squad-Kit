import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bubblewrapArgs, buildGuard, commitGuard, guardSupport, profileText, projectEnv, spawnProject, type GuardSpec } from '../src/engine/project-guard.js';

/**
 * What a command in the guard must not get round, with a real command in the real guard on a Mac: the copy moved away, the
 * rules swapped, a cache the person's own tools run from, a signal to another program, a .env, a socket in a hidden place, a
 * key into a runtime's machine. The fixtures sit under the worktree, not the system temp, which the guard lets commands
 * write in; only the cases about temp use a temp folder of their own. On Linux, the bubblewrap arguments.
 */

const onMac = process.platform === 'darwin' && guardSupport().on;
const ROOT = fs.realpathSync(process.cwd());

let base: string;
let home: string;
let project: string;
let copy: string;
let tempWas: string | undefined;
const started: number[] = [];
/** A socket that says hello. */
const SOCKET_SERVER = "require('net').createServer((c)=>{c.on('error',()=>{});c.end('hi')}).listen(process.argv[1])";

const sh = (cmd: string, cwd = base) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const guardFor = (o: { cwd?: string; root?: string; cache?: string; allow?: { allowRead?: string[]; allowWrite?: string[] } } = {}) => buildGuard({ cwd: o.cwd ?? copy, root: o.root ?? project, home, platform: process.platform, ...(o.cache ? { cache: o.cache, extraWrite: [o.cache], extraRead: [o.cache] } : {}), ...(o.allow ? { allow: o.allow } : {}) });

function run(line: string, guard: GuardSpec = guardFor(), cwd = copy, env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; said: string }> {
  return new Promise((done) => {
    const child = spawnProject(line, { cwd, guard, env });
    let said = '';
    child.stdout?.on('data', (d: Buffer) => (said += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (said += d.toString()));
    child.on('close', (code) => done({ code, said: said.trim() }));
  });
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(ROOT, '.dk-')));
  home = path.join(base, 'h');
  project = path.join(base, 'p');
  copy = path.join(base, 'c');
  for (const d of [home, project, copy]) fs.mkdirSync(d);
  tempWas = process.env.TMPDIR;
  process.env.GIT_CEILING_DIRECTORIES = ROOT;
});

afterEach(() => {
  // Only what this file started: a command in its folder, or its socket server, which is given just the socket's name.
  for (const pid of started.splice(0)) {
    const command = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout;
    if (command.includes(base) || command.includes(SOCKET_SERVER)) process.kill(pid, 'SIGKILL');
  }
  if (tempWas === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = tempWas;
  delete process.env.GIT_CEILING_DIRECTORIES;
  fs.rmSync(base, { recursive: true, force: true });
});

describe.runIf(onMac)('the copy and what holds git stay where they are', () => {
  it('a command cannot move its copy away, or put another in its place', async () => {
    fs.writeFileSync(path.join(copy, 'keep.txt'), 'kept\n');
    // To the temp folder, where a command may write, or into a folder of its own: as the attack did.
    const away = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-away-')));
    const r = await run(`cd / && mv "${copy}" "${away}/old"; rmdir "${copy}"; echo done`);
    const gone = !fs.existsSync(path.join(copy, 'keep.txt'));
    fs.rmSync(away, { recursive: true, force: true });
    expect(gone).toBe(false);
    expect(r.said).toContain('done');
    expect(r.said).toMatch(/not permitted/i);
    // What is inside it is still its own to change.
    const inside = await run('mkdir sub && mv keep.txt sub/keep.txt && mv sub sub2 && rm -rf sub2 && echo ok');
    expect(inside.said).toBe('ok');
  });

  it('a command in the person\'s own checkout cannot move it either', async () => {
    sh('git init -q -b main', project);
    const before = fs.readFileSync(path.join(project, '.git', 'HEAD'), 'utf8');
    const away = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-away-')));
    const r = await run(`cd / && mv "${project}" "${away}/old"; echo done`, guardFor({ cwd: project }), project);
    const gone = !fs.existsSync(path.join(project, '.git', 'HEAD'));
    fs.rmSync(away, { recursive: true, force: true });
    expect(gone).toBe(false);
    expect(r.said).toMatch(/not permitted/i);
    expect(fs.readFileSync(path.join(project, '.git', 'HEAD'), 'utf8')).toBe(before);
  });

  it('a project in a temp folder, where commands may write: nothing above its git folder moves', async () => {
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-')));
    try {
      const inTemp = path.join(temp, 'outer', 'app');
      fs.mkdirSync(inTemp, { recursive: true });
      sh('git init -q -b main && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m s', inTemp);
      const c = path.join(base, 'c2');
      sh(`git worktree add -q -b t "${c}"`, inTemp);
      const g = buildGuard({ cwd: c, root: inTemp, home, platform: process.platform });
      for (const from of [inTemp, path.dirname(inTemp), path.join(inTemp, '.git')]) {
        const r = await run(`cd / && mv "${from}" "${from}.moved"; echo done`, g, c);
        expect(r.said, from).toMatch(/not permitted/i);
        expect(fs.existsSync(`${from}.moved`), from).toBe(false);
      }
      // Other things in temp are as free as before.
      const other = await run(`mkdir "${temp}/x" && mv "${temp}/x" "${temp}/y" && rmdir "${temp}/y" && echo ok`, g, c);
      expect(other.said).toBe('ok');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});

describe.runIf(onMac)('a process left behind cannot change the rules of the next command', () => {
  it('there is no file of rules to swap, so none of the next commands gets out', async () => {
    const temp = path.join(base, 't');
    fs.mkdirSync(temp);
    process.env.TMPDIR = temp;
    const watcher = path.join(base, 'w.mjs');
    fs.writeFileSync(watcher, `import fs from 'node:fs'; import path from 'node:path';
const end = Date.now() + 20000; const dir = process.argv[2];
while (Date.now() < end) for (const d of fs.readdirSync(dir)) {
  if (!d.startsWith('squad-guard-')) continue;
  fs.appendFileSync(process.argv[3], d + '\\n');
  try { fs.writeFileSync(path.join(dir, d, 'profile.sb'), '(version 1)(allow default)\\n'); } catch {}
}
`);
    const seen = path.join(base, 'seen');
    fs.writeFileSync(seen, '');
    const child = spawn(process.execPath, [watcher, temp, seen], { detached: true, stdio: 'ignore' });
    child.unref();
    started.push(child.pid!);
    const guard = guardFor();
    let wins = 0;
    for (let i = 0; i < 25; i += 1) {
      const mark = path.join(base, `m${i}`);
      await run(`touch "${mark}"`, guard);
      if (fs.existsSync(mark)) wins += 1;
    }
    expect(wins).toBe(0);
    expect(fs.readFileSync(seen, 'utf8')).toBe('');
    expect(fs.readdirSync(temp).filter((f) => f.startsWith('squad-guard-'))).toEqual([]);
  });
});

describe.runIf(onMac)('caches the person\'s own tools run from', () => {
  it('~/.cache and ~/Library/Caches stay read only, as a hook of theirs runs from there', async () => {
    const tool = path.join(home, '.cache', 'pre-commit', 'repo1', 'py_env', 'bin', 'end-of-file-fixer');
    const browser = path.join(home, 'Library', 'Caches', 'ms-playwright', 'chromium-1', 'Chromium');
    for (const f of [tool, browser]) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, '#!/bin/sh\nexit 0\n');
    }
    const r = await run(`echo evil > "${tool}"; echo evil > "${browser}"; touch "${home}/.cache/new" "${home}/Library/Caches/new"; cat "${tool}" > /dev/null && echo read-ok`);
    expect(r.said).toMatch(/not permitted/i);
    expect(r.said).toContain('read-ok');
    for (const f of [tool, browser]) expect(fs.readFileSync(f, 'utf8')).toBe('#!/bin/sh\nexit 0\n');
    expect(fs.existsSync(path.join(home, '.cache', 'new'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'Library', 'Caches', 'new'))).toBe(false);
  });

  it('package caches stay open, and a command\'s other caches go to the copy\'s own', async () => {
    const cache = path.join(base, 'cache');
    fs.mkdirSync(cache);
    const guard = guardFor({ cache });
    for (const d of ['.npm', '.cache', 'Library/Caches']) fs.mkdirSync(path.join(home, d), { recursive: true });
    const r = await run(`mkdir -p "${home}/.npm/_cacache/x" "${home}/.cache/pnpm/x" "${home}/Library/Caches/pnpm/x" "$XDG_CACHE_HOME/tool" "$GOCACHE" "$PIP_CACHE_DIR" && printf '%s\\n' "$XDG_CACHE_HOME" "$GOCACHE" "$PIP_CACHE_DIR" "$POETRY_CACHE_DIR" "$DENO_DIR" "$npm_config_devdir"`, guard);
    expect(r.code).toBe(0);
    for (const line of r.said.split('\n')) expect(line.startsWith(`${cache}/`)).toBe(true);
    expect(r.said.split('\n')).toHaveLength(6);
    expect(fs.existsSync(path.join(cache, 'xdg', 'tool'))).toBe(true);
  });

  it("pnpm's store goes to the cache: in the copy, it would be thousands of files a commit could take", async () => {
    const cache = path.join(base, 'cache');
    fs.mkdirSync(cache);
    const r = await run(`printf '%s\\n' "$pnpm_config_store_dir" "$npm_config_store_dir"`, guardFor({ cache }));
    expect(r.code).toBe(0);
    expect(r.said.trim().split('\n')).toEqual([path.join(cache, 'pnpm-store'), path.join(cache, 'pnpm-store')]);
  });
});

describe.runIf(onMac)('a project\'s own browsers', () => {
  const homeWas = process.env.HOME;
  beforeEach(() => {
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = homeWas;
  });

  it('Playwright gets a folder of the copy\'s own, with this computer\'s browsers in it and theirs out of reach', async () => {
    const theirs = path.join(home, 'Library', 'Caches', 'ms-playwright');
    const browser = path.join(theirs, 'chromium-1', 'Chromium');
    fs.mkdirSync(path.dirname(browser), { recursive: true });
    fs.mkdirSync(path.join(theirs, '.links'));
    fs.writeFileSync(browser, 'real\n');
    const cache = path.join(base, 'cache');
    fs.mkdirSync(cache);
    const at = path.join(cache, 'ms-playwright');
    const P = '"$PLAYWRIGHT_BROWSERS_PATH"';
    const r = await run(`echo "$PLAYWRIGHT_BROWSERS_PATH"; cat ${P}/chromium-1/Chromium; mkdir ${P}/__dirlock ${P}/chromium-2 && echo own-ok; echo evil > ${P}/chromium-1/Chromium; rm -rf ${P}/chromium-1 && echo link-gone`, guardFor({ cache }));
    expect(r.said.split('\n')[0]).toBe(at);
    expect(r.said).toContain('real');
    expect(r.said).toContain('own-ok');
    expect(r.said).toMatch(/not permitted/i);
    expect(r.said).toContain('link-gone');
    expect(fs.readFileSync(browser, 'utf8')).toBe('real\n');
    expect(fs.existsSync(path.join(theirs, '__dirlock'))).toBe(false);
    expect(fs.existsSync(path.join(theirs, 'chromium-2'))).toBe(false);
    expect(fs.existsSync(path.join(at, '.links'))).toBe(false);
    // The next command has it back, as Playwright's clean up is no reason to lose a browser this computer has.
    expect((await run(`cat ${P}/chromium-1/Chromium`, guardFor({ cache }))).said).toBe('real');
  });

  it('with no browsers here yet the folder is still its own, and Puppeteer and Electron download to the copy\'s cache', async () => {
    const cache = path.join(base, 'cache');
    fs.mkdirSync(cache);
    const r = await run('mkdir -p "$PLAYWRIGHT_BROWSERS_PATH/chromium-9" "$PUPPETEER_CACHE_DIR/chrome" "$electron_config_cache/x" && printf "%s\\n" "$PLAYWRIGHT_BROWSERS_PATH" "$PUPPETEER_CACHE_DIR" "$electron_config_cache"', guardFor({ cache }));
    expect(r.code).toBe(0);
    expect(r.said.split('\n')).toEqual(['ms-playwright', 'puppeteer', 'electron'].map((d) => path.join(cache, d)));
  });

  it('a person who keeps them in the project (0) is left alone', async () => {
    const was = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
    try {
      const cache = path.join(base, 'cache');
      fs.mkdirSync(cache);
      expect((await run('echo "$PLAYWRIGHT_BROWSERS_PATH"', guardFor({ cache }))).said).toBe('0');
    } finally {
      if (was === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      else process.env.PLAYWRIGHT_BROWSERS_PATH = was;
    }
  });
});

describe.runIf(onMac)('signals', () => {
  it('reach what the command started, and nothing else: not squad-kit, not another program', async () => {
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      const r = await run(`kill -0 ${process.pid}; echo "squad-kit $?"; kill -9 ${other.pid}; echo "other $?"; sleep 30 & c=$!; kill $c; echo "child $?"; wait $c; kill -0 $$; echo "self $?"`);
      expect(r.said).toMatch(/squad-kit 1/);
      expect(r.said).toMatch(/other 1/);
      expect(r.said).toMatch(/child 0/);
      expect(r.said).toMatch(/self 0/);
      expect(() => process.kill(other.pid!, 0)).not.toThrow();
    } finally {
      other.kill();
    }
  });

  it('one command\'s leftover cannot signal the next, and a tool can end what it started', async () => {
    const r = await run(`node -e "const c=require('child_process').spawn('sleep',['30']);setTimeout(()=>{console.log('kill',c.kill());},100);c.on('exit',(code,sig)=>console.log('ended',sig));"`);
    expect(r.said).toContain('ended SIGTERM');
  });
});

describe.runIf(onMac)('.env files', () => {
  it('a command in the person\'s own checkout does not read them, there or deeper', async () => {
    fs.writeFileSync(path.join(project, '.env'), 'ENV-SECRET\n');
    fs.mkdirSync(path.join(project, 'apps'));
    fs.writeFileSync(path.join(project, 'apps', '.env.local'), 'ENV-SECRET\n');
    fs.writeFileSync(path.join(project, 'plain.txt'), 'plain\n');
    const r = await run('cat .env apps/.env.local plain.txt', guardFor({ cwd: project }), project);
    expect(r.said).not.toContain('ENV-SECRET');
    expect(r.said).toContain('plain');
  });

  it('nor one in a project under a link, as /tmp is on a Mac', async () => {
    fs.writeFileSync(path.join(project, '.env'), 'ENV-SECRET\n');
    fs.symlinkSync(project, path.join(base, 'linked'));
    const r = await run(`cat "${project}/.env"`, buildGuard({ cwd: copy, root: path.join(base, 'linked'), home, platform: process.platform }));
    expect(r.said).not.toContain('ENV-SECRET');
  });

  it('the copy\'s own is its to read, and an engineer can allow the person\'s', async () => {
    fs.writeFileSync(path.join(copy, '.env'), 'COPY-OWN\n');
    fs.writeFileSync(path.join(project, '.env'), 'PERSON-OWN\n');
    expect((await run('cat .env')).said).toBe('COPY-OWN');
    expect((await run('cat .env', guardFor({ cwd: project, allow: { allowRead: [path.join(project, '.env')] } }), project)).said).toBe('PERSON-OWN');
  });
});

describe.runIf(onMac)('sockets in places the guard hides, and sockets it may not move', () => {
  const connect = (file: string, guard: GuardSpec, cwd = copy) => run(`${JSON.stringify(process.execPath)} -e "const c=require('net').connect(process.argv[1]);c.on('connect',()=>{console.log('CONNECTED');c.destroy()});c.on('error',e=>console.log(e.code))" ${JSON.stringify(file)}`, guard, cwd);
  function serve(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const child = spawn(process.execPath, ['-e', SOCKET_SERVER, path.basename(file)], { cwd: path.dirname(file), stdio: 'ignore', detached: true });
    child.unref();
    started.push(child.pid!);
  }
  const up = async (file: string) => {
    for (let i = 0; i < 200 && !fs.existsSync(file); i += 1) await new Promise((r) => setTimeout(r, 25));
    expect(fs.existsSync(file)).toBe(true);
  };

  it('an agent\'s socket under ~/.gnupg or ~/.ssh is refused; a socket in the copy, under squad-kit\'s own folder, is not', async () => {
    const gnupg = path.join(home, '.gnupg', 'S.gpg-agent');
    const ssh = path.join(home, '.ssh', 'agent.sock');
    const squad = process.env.SQUAD_KIT_HOME!;
    process.env.SQUAD_KIT_HOME = path.join(base, 'sk');
    const inSquad = path.join(base, 'sk', 'wt', 'c');
    fs.mkdirSync(inSquad, { recursive: true });
    const own = path.join(inSquad, 'db.sock');
    for (const f of [gnupg, ssh, own]) serve(f);
    for (const f of [gnupg, ssh, own]) await up(f);
    try {
      const g = buildGuard({ cwd: inSquad, root: project, home, platform: process.platform });
      expect((await connect(gnupg, g, inSquad)).said).toBe('EPERM');
      expect((await connect(ssh, g, inSquad)).said).toBe('EPERM');
      expect((await connect(own, g, inSquad)).said).toBe('CONNECTED');
    } finally {
      process.env.SQUAD_KIT_HOME = squad;
    }
  });

  it('Podman\'s socket in the temp folder cannot be moved to be reached', async () => {
    const temp = path.join(base, 't');
    process.env.TMPDIR = temp;
    const socket = path.join(temp, 'podman', 'api.sock');
    serve(socket);
    await up(socket);
    const g = guardFor();
    expect((await connect(socket, g)).said).toBe('EPERM');
    const moved = await run(`mv "${temp}/podman" "${temp}/p2"; mv "${socket}" "${temp}/moved.sock"; ln -s "${socket}" "${temp}/l.sock"; echo done`, g);
    expect(moved.said).toMatch(/not permitted/i);
    expect(fs.existsSync(path.join(temp, 'p2'))).toBe(false);
    expect(fs.existsSync(path.join(temp, 'moved.sock'))).toBe(false);
    expect((await connect(socket, g)).said).toBe('EPERM');
    if (fs.existsSync(path.join(temp, 'l.sock'))) expect((await connect(path.join(temp, 'l.sock'), g)).said).toBe('EPERM');
    // A folder an engineer allowed is theirs to use.
    const allowed = guardFor({ allow: { allowWrite: [path.join(temp, 'podman')] } });
    expect((await connect(socket, allowed)).said).toBe('CONNECTED');
    expect((await run(`touch "${temp}/podman/mine" && echo ok`, allowed)).said).toBe('ok');
  });

  it('the keys into a runtime\'s machine are hidden', async () => {
    const keys = ['.lima/_config/user', '.colima/_lima/_config/user', '.orbstack/ssh/id_ed25519', '.local/share/containers/podman/machine/machine', '.finch/lima/data/_config/user', '.local/share/rancher-desktop/lima/_config/user', 'Library/Application Support/rancher-desktop/lima/_config/user'];
    for (const k of keys) {
      fs.mkdirSync(path.dirname(path.join(home, k)), { recursive: true });
      fs.writeFileSync(path.join(home, k), 'VM-KEY\n');
    }
    const g = guardFor();
    for (const k of keys) expect((await run(`cat "${path.join(home, k)}"`, g)).said, k).not.toContain('VM-KEY');
  });
});

describe('an ssh agent stays reachable, as the text says: its socket is not in a hidden place', () => {
  it('the variable reaches the project\'s commands', () => {
    process.env.SSH_AUTH_SOCK = '/fixture/agent';
    try {
      expect(projectEnv().SSH_AUTH_SOCK).toBe('/fixture/agent');
    } finally {
      delete process.env.SSH_AUTH_SOCK;
    }
  });
});

describe('the shape on Linux', () => {
  const linux = (o: { allow?: { allowRead?: string[]; allowWrite?: string[] }; cache?: string } = {}) => buildGuard({ cwd: copy, root: project, home, platform: 'linux', ...(o.cache ? { cache: o.cache, extraWrite: [o.cache], extraRead: [o.cache] } : {}), ...(o.allow ? { allow: o.allow } : {}) });
  const at = (args: string[], flag: string, place: string) => args.findIndex((a, i) => a === place && args[i - 1] === flag);
  const hiddenAt = (args: string[], place: string) => args.findIndex((a, i) => a === place && args[i - 1] === '/dev/null' && args[i - 2] === '--ro-bind-try');

  it('each .env of the person\'s project goes behind an empty file, a few folders down, and none in a folder of packages', () => {
    for (const f of ['.env', '.env.local', 'apps/web/.env', 'a/b/c/.env.test', 'node_modules/x/.env', 'plain.txt']) {
      fs.mkdirSync(path.dirname(path.join(project, f)), { recursive: true });
      fs.writeFileSync(path.join(project, f), 'x');
    }
    const args = bubblewrapArgs(linux(), 'x');
    for (const f of ['.env', '.env.local', 'apps/web/.env', 'a/b/c/.env.test']) expect(hiddenAt(args, path.join(project, f)), f).toBeGreaterThan(-1);
    for (const f of ['node_modules/x/.env', 'plain.txt']) expect(hiddenAt(args, path.join(project, f)), f).toBe(-1);
  });

  it('a mount goes where a place really is: through a link bubblewrap would stop, and with it every command', () => {
    const real = path.join(base, 'real-run');
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, 'docker.sock'), '');
    fs.symlinkSync(real, path.join(base, 'link-run'));
    process.env.DOCKER_HOST = `unix://${path.join(base, 'link-run', 'docker.sock')}`;
    try {
      const args = bubblewrapArgs(linux(), 'x');
      expect(hiddenAt(args, path.join(real, 'docker.sock'))).toBeGreaterThan(-1);
      expect(args.join(' ')).not.toContain(path.join(base, 'link-run'));
    } finally {
      delete process.env.DOCKER_HOST;
    }
  });

  it('a socket that is not there gets no mount at all', () => {
    process.env.DOCKER_HOST = `unix://${path.join(base, 'gone', 'docker.sock')}`;
    try {
      expect(bubblewrapArgs(linux(), 'x').join(' ')).not.toContain(path.join(base, 'gone'));
    } finally {
      delete process.env.DOCKER_HOST;
    }
  });

  it('what is hidden in temp stays hidden: the hiding comes after temp is opened', () => {
    const temp = path.join(base, 't');
    fs.mkdirSync(path.join(temp, 'podman'), { recursive: true });
    process.env.TMPDIR = temp;
    const args = bubblewrapArgs(linux(), 'x');
    expect(at(args, '--tmpfs', path.join(temp, 'podman'))).toBeGreaterThan(at(args, '--bind-try', temp));
    expect(at(args, '--bind-try', temp)).toBeGreaterThan(-1);
  });

  it('a package cache that is read and written is writable: the writable mount comes last', () => {
    const cache = path.join(base, 'cache');
    fs.mkdirSync(cache);
    const args = bubblewrapArgs(linux({ cache }), 'x');
    expect(at(args, '--bind-try', cache)).toBeGreaterThan(at(args, '--ro-bind-try', cache));
  });

  it('a commit\'s hooks see the copy\'s .git lead to their own folder, whichever git they run: it comes last', () => {
    fs.writeFileSync(path.join(copy, '.git'), 'gitdir: /real/own\n');
    const gitDir = path.join(base, 'throwaway');
    const args = bubblewrapArgs(commitGuard(linux(), { common: '/real', own: '/real/own', gitDir }), 'x');
    const link = args.findIndex((a, i) => a === path.join(copy, '.git') && args[i - 1] === path.join(gitDir, 'dotgit') && args[i - 2] === '--ro-bind-try');
    expect(link).toBeGreaterThan(at(args, '--ro-bind-try', path.join(copy, '.git')));
    expect(link).toBeGreaterThan(at(args, '--bind', gitDir));
    // A checkout whose .git is a folder gets no such mount: a file cannot go over a folder.
    fs.rmSync(path.join(copy, '.git'));
    fs.mkdirSync(path.join(copy, '.git'));
    expect(bubblewrapArgs(commitGuard(linux(), { common: '/real', own: '/real/own', gitDir }), 'x').join(' ')).not.toContain('dotgit');
  });

  it('~/.cache is not opened whole, nor ~/Library/Caches', () => {
    const args = bubblewrapArgs(linux(), 'x');
    expect(at(args, '--bind-try', path.join(home, '.cache'))).toBe(-1);
    expect(at(args, '--bind-try', path.join(home, 'Library', 'Caches'))).toBe(-1);
    expect(args).toContain('--unshare-pid');
  });
});

describe('the Mac profile', () => {
  it('passes as text, so spawnProject makes no file of rules', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'engine', 'project-guard.ts'), 'utf8');
    expect(source).toContain("['-p', profileText(o.guard)");
    expect(source).not.toContain('squad-guard-');
  });
});
