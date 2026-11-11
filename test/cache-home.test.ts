import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { boardPaths } from '../src/board/store.js';
import { HEALED_LINE, cacheHomeEnv, healHome, healedBefore, homeCachePlace, rememberHealed, storiesCacheDir } from '../src/engine/cache-home.js';
import { outsideTheGuard, runCommand, startApp } from '../src/engine/checks.js';
import { buildGuard, guardSupport, homeCachesRefused, projectGuardFor, ticketGuard, type GuardSpec } from '../src/engine/project-guard.js';
import { projectCacheDir, sandboxAsk } from '../src/engine/sandbox.js';
import { claudeLaunch, claudeRunOptions } from '../src/modules/claude/index.js';

/**
 * The project's cache home (1.3.3): one folder per project where every tool keeps its downloads, shared by the project's
 * stories, in both walls (the project's own commands and the agent's shell), with each tool pointed there by its own
 * setting. The person's own caches stay read only. A tool that still writes in the person's home gets a home of the
 * project's own, once, when squad-kit runs its command again by itself. The fixtures sit under the worktree, not the
 * system temp, which the guard lets commands write in.
 */

const onMac = process.platform === 'darwin' && guardSupport().on;
const ROOT = fs.realpathSync(process.cwd());

let base: string;
let home: string;
let project: string;
let copy: string;
let cache: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(ROOT, '.ch-')));
  home = path.join(base, 'h');
  project = path.join(base, 'p');
  copy = path.join(base, 'c');
  cache = path.join(base, 'cache');
  for (const d of [home, project, copy, cache]) fs.mkdirSync(d);
  vi.stubEnv('HOME', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(base, { recursive: true, force: true });
});

const guardOf = (): GuardSpec => buildGuard({ cwd: copy, root: project, cache, extraWrite: [cache], extraRead: [cache], home, platform: process.platform });
const counted = () => (fs.existsSync(path.join(copy, 'runs.txt')) ? fs.readFileSync(path.join(copy, 'runs.txt'), 'utf8').split('\n').filter(Boolean).length : 0);

describe("one cache home for the project's stories", () => {
  it('is the same folder for every story, and another for what runs accepted code', () => {
    const bp = boardPaths(path.join(project, '.squad'));
    const one = ticketGuard(bp, { cwd: copy, id: 'AP-1', home });
    const two = ticketGuard(bp, { cwd: copy, id: 'AP-2', home });
    expect(one.cache).toBe(fs.realpathSync(storiesCacheDir(bp)));
    expect(two.cache).toBe(one.cache);
    expect(one.write).toContain(one.cache);
    const accepted = projectGuardFor(bp, { cwd: copy, home });
    expect(accepted.cache).toBe(fs.realpathSync(projectCacheDir(bp)));
    expect(accepted.cache).not.toBe(one.cache);
    // A story may not write where accepted code takes its downloads from, nor the other way round.
    expect(one.write).not.toContain(accepted.cache);
    expect(accepted.write).not.toContain(one.cache);
  });

  it('is a real folder: a link a command left in its place goes before the guard is made', () => {
    const bp = boardPaths(path.join(project, '.squad'));
    const dir = storiesCacheDir(bp);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const elsewhere = path.join(base, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, dir);
    const g = ticketGuard(bp, { cwd: copy, id: 'AP-1', home });
    expect(fs.lstatSync(dir).isSymbolicLink()).toBe(false);
    expect(g.write).not.toContain(elsewhere);
  });

  it("points each tool at it by the tool's own setting, the same in both walls but pnpm's store", () => {
    const want = {
      XDG_CACHE_HOME: 'xdg',
      PIP_CACHE_DIR: 'pip',
      POETRY_CACHE_DIR: 'poetry',
      UV_CACHE_DIR: 'uv',
      PUB_CACHE: 'pub',
      COMPOSER_CACHE_DIR: 'composer',
      GRADLE_USER_HOME: 'gradle',
      MAVEN_USER_HOME: 'maven',
      NUGET_PACKAGES: 'nuget/packages',
      GEM_HOME: 'ruby/gems',
      BUNDLE_PATH: 'ruby/bundle',
      CYPRESS_CACHE_FOLDER: 'cypress',
      PUPPETEER_CACHE_DIR: 'puppeteer',
      PLAYWRIGHT_BROWSERS_PATH: 'ms-playwright',
      npm_config_cache: 'npm',
    };
    const env = { PATH: '/bin' };
    const project = cacheHomeEnv(cache, { wall: 'project', home, env });
    const agent = cacheHomeEnv(cache, { wall: 'agent', home, env });
    // Windows has no guard, and Playwright's browsers stay where they are there.
    if (process.platform === 'win32') delete (want as Record<string, string>).PLAYWRIGHT_BROWSERS_PATH;
    for (const [name, at] of Object.entries(want)) {
      expect(project[name]).toBe(path.join(cache, at));
      expect(agent[name]).toBe(path.join(cache, at));
    }
    expect(project.MAVEN_OPTS).toBe(`-Dmaven.repo.local=${path.join(cache, 'maven', 'repository')}`);
    // Flutter runs from its own folder, which stays read only.
    expect(project.FLUTTER_ALREADY_LOCKED).toBe('true');
    // Tools whose usage reports would go in the person's home leave them out.
    expect(agent).toMatchObject({ FLUTTER_SUPPRESS_ANALYTICS: 'true', DOTNET_CLI_TELEMETRY_OPTOUT: '1' });
    expect(project.pnpm_config_store_dir).toBe(path.join(cache, 'pnpm-store'));
    expect(agent).not.toHaveProperty('pnpm_config_store_dir');
  });

  it('reaches the agent\'s shell: writable in its sandbox, and its settings in the environment its commands get', () => {
    const bp = boardPaths(path.join(project, '.squad'));
    const dir = storiesCacheDir(bp);
    const env = cacheHomeEnv(dir, { wall: 'agent', home });
    const ask = sandboxAsk({ cwd: copy, root: project, read: [], proof: path.join(base, 'proof'), secrets: [], cache: dir, home });
    expect(ask.write).toContain(dir);
    expect(ask.read).toContain(dir);
    const launch = claudeLaunch(claudeRunOptions({ cwd: copy, prompt: 'x', permissions: ['edit'], sandbox: ask, env }), '/adapter.js', '/bin/claude');
    expect(launch.env).toMatchObject({ XDG_CACHE_HOME: path.join(dir, 'xdg'), PUB_CACHE: path.join(dir, 'pub'), GRADLE_USER_HOME: path.join(dir, 'gradle'), PIP_CACHE_DIR: path.join(dir, 'pip') });
  });

  it("starts Prisma's engines as a copy of the person's, and links their Gradle and Maven settings, once", () => {
    const engine = path.join(home, '.cache', 'prisma', 'master', 'abc', 'darwin-arm64', 'libquery-engine');
    fs.mkdirSync(path.dirname(engine), { recursive: true });
    fs.writeFileSync(engine, 'engine');
    fs.mkdirSync(path.join(home, '.gradle'));
    fs.writeFileSync(path.join(home, '.gradle', 'gradle.properties'), 'systemProp.http.proxyHost=proxy.example.com\n');
    cacheHomeEnv(cache, { wall: 'project', home, env: {} });
    const copied = path.join(cache, 'xdg', 'prisma', 'master', 'abc', 'darwin-arm64', 'libquery-engine');
    expect(fs.readFileSync(copied, 'utf8')).toBe('engine');
    expect(fs.lstatSync(copied).isSymbolicLink()).toBe(false);
    expect(fs.readlinkSync(path.join(cache, 'gradle', 'gradle.properties'))).toBe(path.join(home, '.gradle', 'gradle.properties'));
    // What a tool put there since is kept: the copy is made only once.
    fs.writeFileSync(copied, 'newer');
    cacheHomeEnv(cache, { wall: 'project', home, env: {} });
    expect(fs.readFileSync(copied, 'utf8')).toBe('newer');
    expect(fs.readFileSync(engine, 'utf8')).toBe('engine');
  });
});

describe('what this computer downloaded already', () => {
  it('Gradle, NuGet and Maven read it without writing in it, and download only what is missing', () => {
    for (const d of ['.gradle/caches/modules-2', '.nuget/packages', '.m2/repository']) fs.mkdirSync(path.join(home, d), { recursive: true });
    const env = cacheHomeEnv(cache, { wall: 'project', home, env: { MAVEN_OPTS: '-Xmx2g' } });
    expect(env.GRADLE_RO_DEP_CACHE).toBe(path.join(home, '.gradle', 'caches'));
    expect(env.NUGET_FALLBACK_PACKAGES).toBe(path.join(home, '.nuget', 'packages'));
    expect(env.MAVEN_OPTS).toBe(`-Xmx2g -Dmaven.repo.local=${path.join(cache, 'maven', 'repository')} -Dmaven.repo.local.tail=${path.join(home, '.m2', 'repository')}`);
    // Where they write is the cache home.
    expect(env.GRADLE_USER_HOME).toBe(path.join(cache, 'gradle'));
    expect(env.NUGET_PACKAGES).toBe(path.join(cache, 'nuget', 'packages'));
    // Nothing there yet: nothing to read.
    const bare = cacheHomeEnv(path.join(base, 'other'), { wall: 'project', home: path.join(base, 'empty'), env: {} });
    for (const name of ['GRADLE_RO_DEP_CACHE', 'NUGET_FALLBACK_PACKAGES']) expect(bare).not.toHaveProperty(name);
  });

  it("the Gradle a project's wrapper asks for is linked in once, in a folder of the project's own, without its zip", () => {
    fs.mkdirSync(path.join(copy, 'gradle', 'wrapper'), { recursive: true });
    fs.writeFileSync(path.join(copy, 'gradle', 'wrapper', 'gradle-wrapper.properties'), 'distributionBase=GRADLE_USER_HOME\ndistributionPath=wrapper/dists\ndistributionUrl=https\\://services.gradle.org/distributions/gradle-8.10.2-all.zip\n');
    // The wrapper's own folder name for that address.
    const theirs = path.join(home, '.gradle', 'wrapper', 'dists', 'gradle-8.10.2-all', '7iv73wktx1xtkvlq19urqw1wm');
    fs.mkdirSync(path.join(theirs, 'gradle-8.10.2', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(theirs, 'gradle-8.10.2', 'bin', 'gradle'), '#!/bin/sh\n');
    for (const f of ['gradle-8.10.2-all.zip', 'gradle-8.10.2-all.zip.ok', 'gradle-8.10.2-all.zip.lck']) fs.writeFileSync(path.join(theirs, f), '');
    cacheHomeEnv(cache, { wall: 'project', cwd: copy, home, env: {} });
    const mine = path.join(cache, 'gradle', 'wrapper', 'dists', 'gradle-8.10.2-all', '7iv73wktx1xtkvlq19urqw1wm');
    expect(fs.readdirSync(mine).sort()).toEqual(['gradle-8.10.2', 'gradle-8.10.2-all.zip.ok']);
    expect(fs.existsSync(path.join(mine, 'gradle-8.10.2', 'bin', 'gradle'))).toBe(true);
    // The wrapper locks a file in that folder: the folder is the project's own, the Gradle in it the person's, read only.
    expect(fs.lstatSync(mine).isSymbolicLink()).toBe(false);
    expect(fs.readlinkSync(path.join(mine, 'gradle-8.10.2'))).toBe(path.join(theirs, 'gradle-8.10.2'));
    // Made once: what the wrapper put there since stays.
    fs.writeFileSync(path.join(mine, 'gradle-8.10.2-all.zip.lck'), '');
    cacheHomeEnv(cache, { wall: 'project', cwd: copy, home, env: {} });
    expect(fs.existsSync(path.join(mine, 'gradle-8.10.2-all.zip.lck'))).toBe(true);
    // A Gradle this computer does not have is the wrapper's to download.
    fs.writeFileSync(path.join(copy, 'gradle', 'wrapper', 'gradle-wrapper.properties'), 'distributionUrl=https\\://services.gradle.org/distributions/gradle-9.0-bin.zip\n');
    cacheHomeEnv(cache, { wall: 'project', cwd: copy, home, env: {} });
    expect(fs.readdirSync(path.join(cache, 'gradle', 'wrapper', 'dists'))).toEqual(['gradle-8.10.2-all']);
  });
});

describe.runIf(onMac)("the person's own caches, in the guard on a Mac", () => {
  it('stay read only while the copies in the cache home are the command\'s', async () => {
    const engine = path.join(home, '.cache', 'prisma', 'master', 'abc', 'engine');
    fs.mkdirSync(path.dirname(engine), { recursive: true });
    fs.writeFileSync(engine, 'engine');
    for (const d of ['.pub-cache', '.gradle', 'Library/Caches/composer']) fs.mkdirSync(path.join(home, d), { recursive: true });
    const r = await runCommand(copy, [
      'touch "$XDG_CACHE_HOME/prisma/master/abc/engine" && echo copy-ok',
      `touch "${engine}"`,
      'mkdir -p "$PUB_CACHE/hosted" "$GRADLE_USER_HOME/caches" "$COMPOSER_CACHE_DIR/files" "$PIP_CACHE_DIR/http" && echo homes-ok',
      `mkdir "${home}/.pub-cache/hosted" "${home}/.gradle/caches" "${home}/Library/Caches/composer/files"`,
      'exit 0',
    ].join('; '), undefined, { guard: guardOf() });
    expect(r.output).toContain('copy-ok');
    expect(r.output).toContain('homes-ok');
    expect(r.output.match(/not permitted/gi)).toHaveLength(4);
    for (const d of ['.pub-cache/hosted', '.gradle/caches', 'Library/Caches/composer/files']) expect(fs.existsSync(path.join(home, d))).toBe(false);
    expect(fs.existsSync(path.join(cache, 'pub', 'hosted'))).toBe(true);
  });

  it("are read where a tool can read them, and the person's Gradle linked in stays theirs, read only", async () => {
    const dep = path.join(home, '.gradle', 'caches', 'modules-2', 'files-2.1', 'org.example', 'lib.jar');
    fs.mkdirSync(path.dirname(dep), { recursive: true });
    fs.writeFileSync(dep, 'jar');
    fs.mkdirSync(path.join(copy, 'gradle', 'wrapper'), { recursive: true });
    fs.writeFileSync(path.join(copy, 'gradle', 'wrapper', 'gradle-wrapper.properties'), 'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.10.2-all.zip\n');
    const theirs = path.join(home, '.gradle', 'wrapper', 'dists', 'gradle-8.10.2-all', '7iv73wktx1xtkvlq19urqw1wm');
    fs.mkdirSync(path.join(theirs, 'gradle-8.10.2', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(theirs, 'gradle-8.10.2', 'bin', 'gradle'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(theirs, 'gradle-8.10.2-all.zip.ok'), '');
    const mine = '"$GRADLE_USER_HOME/wrapper/dists/gradle-8.10.2-all/7iv73wktx1xtkvlq19urqw1wm';
    const r = await runCommand(copy, [
      'cat "$GRADLE_RO_DEP_CACHE/modules-2/files-2.1/org.example/lib.jar" && echo read-ok',
      'touch "$GRADLE_RO_DEP_CACHE/modules-2/files-2.1/org.example/lib.jar"',
      `touch ${mine}/gradle-8.10.2-all.zip.lck" && echo lock-ok`,
      `echo changed > ${mine}/gradle-8.10.2/bin/gradle"`,
      'exit 0',
    ].join('; '), undefined, { guard: guardOf() });
    expect(r.output).toContain('read-ok');
    expect(r.output).toContain('lock-ok');
    expect(r.output.match(/not permitted/gi)).toHaveLength(2);
    expect(fs.readFileSync(dep, 'utf8')).toBe('jar');
    expect(fs.readFileSync(path.join(theirs, 'gradle-8.10.2', 'bin', 'gradle'), 'utf8')).toBe('#!/bin/sh\n');
    expect(fs.existsSync(path.join(theirs, 'gradle-8.10.2-all.zip.lck'))).toBe(false);
  });
});

describe('a tool that still writes in the person\'s home', () => {
  it("is found in what the command printed, in the person's caches or a tool's own folder, and nowhere else", () => {
    const g = guardOf();
    const out = [
      `Error: EPERM: operation not permitted, utime '${home}/.cache/prisma/master/abc/engine'`,
      `mkdir: ${home}/Library/Caches/sometool/v1: Operation not permitted`,
      `touch: ${home}/.sometool/state.json: Operation not permitted`,
      // Dart's words.
      `PathAccessException: Cannot open file, path = '${home}/.dart-tool/session.json' (OS Error: Operation not permitted, errno = 1)`,
      // Keys, settings and the copy are no cache.
      `cat: ${home}/.ssh/id_rsa: Operation not permitted`,
      `touch: ${home}/.config/tool/x: Operation not permitted`,
      `touch: ${copy}/x: Operation not permitted`,
    ].join('\n');
    expect(homeCachesRefused(out, g, home)).toEqual([path.join(home, '.cache', 'prisma'), path.join(home, 'Library', 'Caches', 'sometool'), path.join(home, '.sometool'), path.join(home, '.dart-tool')]);
    expect(homeCachesRefused('AssertionError: expected 1 to equal 2', g, home)).toEqual([]);
    // A program the person installed is not a cache: its folder is never the project's own.
    expect(homeCachePlace(path.join(home, '.nvm', 'versions', 'node', 'x'), home, [])).toBeNull();
    expect(homeCachePlace(path.join(home, '.claude', 'cache', 'x'), home, [path.join(home, '.claude', '.credentials.json')])).toBeNull();
  });

  it('gets a home of the project\'s own: the person\'s seen through links, keys left out, that one place its own', () => {
    fs.mkdirSync(path.join(home, '.ssh'));
    fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n');
    fs.mkdirSync(path.join(home, '.cache', 'other'), { recursive: true });
    fs.mkdirSync(path.join(home, '.cache', 'tool'));
    fs.writeFileSync(path.join(home, '.cache', 'tool', 'had.txt'), 'had');
    // A link a command left where the project's own place goes.
    fs.mkdirSync(path.join(cache, 'home', '.cache'), { recursive: true });
    fs.symlinkSync(path.join(base, 'p'), path.join(cache, 'home', '.cache', 'tool'));
    const own = healHome(cache, [path.join(home, '.cache', 'tool')], { home, hidden: [path.join(home, '.ssh')] });
    expect(own).toBe(path.join(cache, 'home'));
    expect(fs.readlinkSync(path.join(own, '.gitconfig'))).toBe(path.join(home, '.gitconfig'));
    expect(fs.existsSync(path.join(own, '.ssh'))).toBe(false);
    expect(fs.lstatSync(path.join(own, '.cache')).isSymbolicLink()).toBe(false);
    expect(fs.readlinkSync(path.join(own, '.cache', 'other'))).toBe(path.join(home, '.cache', 'other'));
    expect(fs.lstatSync(path.join(own, '.cache', 'tool')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(own, '.cache', 'tool', 'had.txt'), 'utf8')).toBe('had');
  });

  it('learns from a place squad-kit checks again, kept where no command can write', () => {
    rememberHealed(cache, 'npm install', [path.join(home, '.cache', 'tool'), path.join(home, '.ssh')]);
    expect(fs.existsSync(`${cache}.healed.json`)).toBe(true);
    expect(healedBefore(cache, 'npm install', { home, hidden: [path.join(home, '.ssh')] })).toEqual([path.join(home, '.cache', 'tool')]);
    expect(healedBefore(cache, 'npm test', { home, hidden: [] })).toEqual([]);
  });
});

describe.runIf(onMac)('squad-kit runs it once more, by itself, on a Mac', () => {
  it("with a home of the project's own, once, says so, and starts there from then on", async () => {
    fs.mkdirSync(path.join(home, '.cache'));
    const line = 'echo run >> runs.txt; mkdir -p "$HOME/.cache/mytool" && echo state > "$HOME/.cache/mytool/state" && echo DONE';
    const said: string[] = [];
    const r = await runCommand(copy, line, undefined, { guard: guardOf(), onHealed: (d) => said.push(d) });
    expect(r.ok).toBe(true);
    expect(r.output).toContain('DONE');
    expect(counted()).toBe(2);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('~/.cache/mytool');
    expect(r.healed).toBe(said[0]);
    expect(fs.existsSync(path.join(home, '.cache', 'mytool'))).toBe(false);
    expect(fs.readFileSync(path.join(cache, 'home', '.cache', 'mytool', 'state'), 'utf8')).toBe('state\n');
    // The next run of the same command, by any story, starts with that home.
    const next = await runCommand(copy, line, undefined, { guard: guardOf(), onHealed: (d) => said.push(d) });
    expect(next.ok).toBe(true);
    expect(counted()).toBe(3);
    expect(said).toHaveLength(1);
    expect(HEALED_LINE).not.toMatch(/EPERM|XDG|cache|sandbox|\/Users|~\//i);
  });

  it('never more than once: a tool that still cannot write fails as it did', async () => {
    fs.mkdirSync(path.join(home, '.cache'));
    const said: string[] = [];
    const r = await runCommand(copy, `echo run >> runs.txt; mkdir -p "${home}/.cache/mytool"`, undefined, { guard: guardOf(), onHealed: (d) => said.push(d) });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/not permitted/i);
    expect(counted()).toBe(2);
    expect(said).toHaveLength(1);
    expect(healedBefore(cache, `echo run >> runs.txt; mkdir -p "${home}/.cache/mytool"`, { home, hidden: [] })).toEqual([]);
  });

  it('an app that stopped while starting for that reason starts once more the same way', async () => {
    fs.mkdirSync(path.join(home, '.cache'));
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const start = `echo run >> runs.txt; mkdir -p "$HOME/.cache/mytool" && exec node -e "require('http').createServer((q, r) => r.end('ok')).listen(${port}, '127.0.0.1')"`;
    const said: string[] = [];
    const app = await startApp(copy, start, `http://127.0.0.1:${port}`, 30_000, undefined, guardOf(), { onHealed: (d) => said.push(d) });
    try {
      expect(counted()).toBe(2);
      expect(said).toHaveLength(1);
      expect(said[0]).toContain('~/.cache/mytool');
      expect(fs.existsSync(path.join(cache, 'home', '.cache', 'mytool'))).toBe(true);
      expect(healedBefore(cache, start, { home, hidden: [] })).toEqual([path.join(home, '.cache', 'mytool')]);
    } finally {
      app.stop();
    }
    // An app that stops for another reason is not started again.
    await expect(startApp(copy, 'echo run >> runs.txt; exit 1', `http://127.0.0.1:${port}`, 30_000, undefined, guardOf(), { onHealed: (d) => said.push(d) })).rejects.toThrow(/stopped while starting/);
    expect(counted()).toBe(3);
    expect(said).toHaveLength(1);
  });

  it('a command that failed for another reason is not run again', async () => {
    const said: string[] = [];
    const r = await runCommand(copy, 'echo run >> runs.txt; echo "expected 1 to equal 2"; exit 3', undefined, { guard: guardOf(), onHealed: (d) => said.push(d) });
    expect(r.ok).toBe(false);
    expect(counted()).toBe(1);
    expect(said).toEqual([]);
    // Nor one the guard refused a key to.
    fs.mkdirSync(path.join(home, '.ssh'));
    const key = await runCommand(copy, `echo run >> runs.txt; touch "${home}/.ssh/known_hosts"`, undefined, { guard: guardOf(), onHealed: (d) => said.push(d) });
    expect(key.ok).toBe(false);
    expect(counted()).toBe(2);
    expect(said).toEqual([]);
  });
});

describe('phone apps: Flutter, Dart, CocoaPods and Xcode', () => {
  it("CocoaPods keeps its spec repos and pods in the cache home, with no usage report, in both walls", () => {
    for (const wall of ['project', 'agent'] as const) {
      const env = cacheHomeEnv(cache, { wall, home, env: {} });
      expect(env).toMatchObject({ CP_REPOS_DIR: path.join(cache, 'cocoapods', 'repos'), CP_CACHE_DIR: path.join(cache, 'cocoapods', 'cache'), COCOAPODS_DISABLE_STATS: 'true', PUB_CACHE: path.join(cache, 'pub') });
      // Its settings stay the person's own.
      expect(env).not.toHaveProperty('CP_HOME_DIR');
    }
  });

  it("a Flutter app's copy finds the Dart packages this computer has, linked in by version, and only that", () => {
    const pub = flutterApp();
    // Not a Dart project: nothing linked.
    fs.renameSync(path.join(copy, 'pubspec.yaml'), path.join(copy, 'pubspec.off'));
    cacheHomeEnv(cache, { wall: 'project', cwd: copy, home, env: {} });
    expect(fs.existsSync(path.join(cache, 'pub', 'hosted'))).toBe(false);
    fs.renameSync(path.join(copy, 'pubspec.off'), path.join(copy, 'pubspec.yaml'));
    cacheHomeEnv(cache, { wall: 'agent', cwd: copy, home, env: {} });
    expect(fs.readlinkSync(path.join(cache, 'pub', 'hosted', 'pub.dev', 'http-1.2.2'))).toBe(path.join(pub, 'hosted', 'pub.dev', 'http-1.2.2'));
    expect(fs.readlinkSync(path.join(cache, 'pub', 'hosted-hashes', 'pub.dev', 'http-1.2.2.sha256'))).toBe(path.join(pub, 'hosted-hashes', 'pub.dev', 'http-1.2.2.sha256'));
    // The folder it lists them in is the project's own, and pub's own lists and programs are not linked.
    expect(fs.lstatSync(path.join(cache, 'pub', 'hosted', 'pub.dev')).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(cache, 'pub', 'hosted', 'pub.dev', '.cache'))).toBe(false);
    expect(fs.existsSync(path.join(cache, 'pub', 'bin'))).toBe(false);
    // Where the person keeps them, when they set it.
    const elsewhere = path.join(base, 'their-pub');
    fs.mkdirSync(path.join(elsewhere, 'hosted', 'pub.dev', 'intl-0.19.0'), { recursive: true });
    cacheHomeEnv(cache, { wall: 'project', cwd: copy, home, env: { PUB_CACHE: elsewhere } });
    expect(fs.readlinkSync(path.join(cache, 'pub', 'hosted', 'pub.dev', 'intl-0.19.0'))).toBe(path.join(elsewhere, 'hosted', 'pub.dev', 'intl-0.19.0'));
  });

  it.runIf(process.platform === 'darwin')("a company's own CocoaPods spec repo is linked in; the public one and CocoaPods' lock are the project's own", () => {
    const repos = path.join(home, '.cocoapods', 'repos');
    for (const d of ['trunk', 'acme-specs/.git']) fs.mkdirSync(path.join(repos, d), { recursive: true });
    fs.writeFileSync(path.join(repos, 'Spec_Lock'), '');
    cacheHomeEnv(cache, { wall: 'project', home, env: {} });
    expect(fs.readdirSync(path.join(cache, 'cocoapods', 'repos'))).toEqual(['acme-specs']);
    expect(fs.readlinkSync(path.join(cache, 'cocoapods', 'repos', 'acme-specs'))).toBe(path.join(repos, 'acme-specs'));
  });

  it("opens none of the person's own: their pub cache, CocoaPods' folders, Xcode's DerivedData, Swift's cache or Flutter itself", () => {
    const flutter = path.join(base, 'flutter');
    fs.mkdirSync(path.join(flutter, 'bin', 'cache'), { recursive: true });
    const closed = [
      path.join(home, '.pub-cache'),
      path.join(home, '.cocoapods'),
      path.join(home, 'Library', 'Caches', 'CocoaPods'),
      path.join(home, 'Library', 'Developer', 'Xcode', 'DerivedData'),
      path.join(home, 'Library', 'Caches', 'org.swift.swiftpm'),
      flutter,
    ];
    const under = (list: string[], p: string) => list.some((w) => p === w || p.startsWith(`${w}${path.sep}`));
    const g = guardOf();
    const ask = sandboxAsk({ cwd: copy, root: project, read: [], proof: path.join(base, 'proof'), secrets: [], cache, home });
    for (const p of closed) {
      expect(under(g.write, p)).toBe(false);
      expect(under(ask.write, p)).toBe(false);
    }
    // Flutter itself is read like any program: never hidden.
    expect(under(g.noRead, flutter)).toBe(false);
    expect(under(ask.noRead, flutter)).toBe(false);
    // Xcode's DerivedData is no tool cache, so a command that could not write there never gets it as the project's own.
    expect(homeCachePlace(path.join(home, 'Library', 'Developer', 'Xcode', 'DerivedData', 'Wasl-abc', 'x'), home, [])).toBeNull();
  });
});

describe.runIf(onMac)('phone apps in the guard on a Mac', () => {
  it("Dart packages, CocoaPods and Xcode write in the cache home and the copy, never in the person's own", async () => {
    const pub = flutterApp();
    const flutter = path.join(base, 'flutter');
    fs.mkdirSync(path.join(flutter, 'bin', 'cache'), { recursive: true });
    fs.writeFileSync(path.join(flutter, 'bin', 'cache', 'engine.stamp'), 'e1');
    for (const d of ['.cocoapods/repos/trunk', 'Library/Caches', 'Library/Developer/Xcode/DerivedData']) fs.mkdirSync(path.join(home, d), { recursive: true });
    const r = await runCommand(copy, [
      'mkdir -p "$PUB_CACHE/hosted/pub.dev/intl-0.19.0" "$CP_REPOS_DIR/trunk/Specs" "$CP_CACHE_DIR/Pods" build/squad-kit-ios/ModuleCache.noindex && echo own-ok',
      'cat "$PUB_CACHE/hosted/pub.dev/http-1.2.2/lib/http.dart" && echo read-ok',
      `cat "${flutter}/bin/cache/engine.stamp" && echo flutter-read-ok`,
      'echo changed > "$PUB_CACHE/hosted/pub.dev/http-1.2.2/lib/http.dart"',
      `mkdir "${home}/.cocoapods/repos/trunk/Specs"`,
      `mkdir "${home}/Library/Caches/CocoaPods"`,
      `mkdir "${home}/Library/Developer/Xcode/DerivedData/Wasl-abc"`,
      `touch "${flutter}/bin/cache/engine.stamp"`,
      'exit 0',
    ].join('; '), undefined, { guard: guardOf() });
    expect(r.output).toContain('own-ok');
    expect(r.output).toContain('read-ok');
    expect(r.output).toContain('flutter-read-ok');
    expect(r.output.match(/not permitted/gi)).toHaveLength(5);
    expect(fs.readFileSync(path.join(pub, 'hosted', 'pub.dev', 'http-1.2.2', 'lib', 'http.dart'), 'utf8')).toBe('library http;\n');
    for (const d of ['.cocoapods/repos/trunk/Specs', 'Library/Caches/CocoaPods', 'Library/Developer/Xcode/DerivedData/Wasl-abc']) expect(fs.existsSync(path.join(home, d))).toBe(false);
    expect(fs.existsSync(path.join(copy, 'build', 'squad-kit-ios', 'ModuleCache.noindex'))).toBe(true);
  });
});

describe("Xcode's own builds, by the one rule", () => {
  const xcode = "xcodebuild build -project Wasl.xcodeproj -scheme Wasl -destination 'generic/platform=iOS Simulator' -derivedDataPath build/squad-kit-ios";

  it('are the only commands outside the guard, and only in the copy the guard was made for', () => {
    const g = { ...guardOf(), noPush: true };
    expect(outsideTheGuard(copy, xcode, g)).toBe(true);
    // Anything more, no guard at all, or another folder: as before.
    expect(outsideTheGuard(copy, `${xcode} -IDEPackageSupportDisableManifestSandbox=YES`, g)).toBe(false);
    expect(outsideTheGuard(copy, `${xcode}; touch x`, g)).toBe(false);
    expect(outsideTheGuard(copy, 'npm test', g)).toBe(false);
    expect(outsideTheGuard(copy, xcode, undefined)).toBe(false);
    expect(outsideTheGuard(project, xcode, g)).toBe(false);
  });

  it.runIf(onMac)("run outside it, in the copy, with the guard's caches and no push; anything else stays in", async () => {
    // A stand-in for Xcode: it writes where the guard keeps commands out, and says what it was given.
    const bin = path.join(base, 'bin');
    fs.mkdirSync(bin);
    const outside = path.join(base, 'outside.txt');
    fs.writeFileSync(path.join(bin, 'xcodebuild'), `#!/bin/sh\npwd\necho "pub=$PUB_CACHE pods=$CP_REPOS_DIR push=$GIT_CONFIG_VALUE_0"\necho made > "${outside}"\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    const g = { ...guardOf(), noPush: true };
    const r = await runCommand(copy, xcode, 30_000, { guard: g });
    expect(r.ok).toBe(true);
    expect(r.outsideGuard).toBe(true);
    expect(r.output).toContain(copy);
    expect(r.output).toContain(`pub=${path.join(cache, 'pub')} pods=${path.join(cache, 'cocoapods', 'repos')} push=/`);
    expect(fs.readFileSync(outside, 'utf8')).toBe('made\n');
    // The same stand-in with one more word is not squad-kit's own Xcode command: it stays in the guard.
    fs.rmSync(outside);
    const kept = await runCommand(copy, `${xcode} -IDEPackageSupportDisableManifestSandbox=YES`, 30_000, { guard: g });
    expect(kept.outsideGuard).toBeUndefined();
    expect(kept.output).toMatch(/not permitted/i);
    expect(fs.existsSync(outside)).toBe(false);
  });
});

describe("Flutter's own version stamps", () => {
  /** A made-up Flutter folder, as 3.35 and later keep it. */
  const sdk = () => {
    const root = path.join(base, 'flutter');
    for (const d of ['bin/cache/dart-sdk/bin', 'bin/cache/artifacts/engine', 'bin/internal']) fs.mkdirSync(path.join(root, d), { recursive: true });
    for (const f of ['bin/flutter', 'bin/cache/flutter_tools.snapshot', 'bin/cache/engine.stamp', 'bin/cache/engine.realm', 'bin/cache/dart-sdk/bin/dart', 'bin/internal/engine.version']) fs.writeFileSync(path.join(root, f), 'theirs\n');
    return root;
  };
  const refused = (root: string) => ['bin/cache/dart-sdk/bin/dart', 'bin/cache/artifacts/engine/x', 'bin/cache/flutter_tools.snapshot', 'bin/flutter', 'bin/cache/engine.stamp.bak', 'bin/cache/engine.stamp.tmp.12x', 'bin/cache/engine.realm2', 'bin/cache/lockfile', 'bin/internal/engine.version'].map((f) => path.join(root, f));
  const allowed = (root: string) => ['bin/cache/engine.stamp', 'bin/cache/engine.stamp.tmp.72843', 'bin/cache/engine.realm'].map((f) => path.join(root, f));

  it('are the only files of Flutter open in the guard, each exactly, and the agents\' sandbox gets the same', () => {
    const root = sdk();
    const g = buildGuard({ cwd: copy, root: project, cache, home, platform: process.platform, flutter: root });
    expect(g.writeExactly).toHaveLength(3);
    for (const p of allowed(root)) expect(g.writeExactly!.some((r) => new RegExp(r).test(p)), p).toBe(true);
    for (const p of refused(root)) expect(g.writeExactly!.some((r) => new RegExp(r).test(p)), p).toBe(false);
    expect(g.write.some((w) => w.startsWith(root))).toBe(false);
    // A refusal there is the guard's; a write to a stamp is not.
    expect(homeCachesRefused(`touch: ${path.join(root, 'bin/cache/flutter_tools.snapshot')}: Operation not permitted`, g, home)).toEqual([]);
    const ask = sandboxAsk({ cwd: copy, root: project, read: [], proof: path.join(base, 'proof'), secrets: [], cache, home, flutter: root });
    expect(ask.write.filter((w) => w.startsWith(root)).sort()).toEqual(['bin/cache/engine.realm', 'bin/cache/engine.stamp', 'bin/cache/engine.stamp.tmp.*'].map((f) => path.join(root, f)));
    // No Flutter here: nothing of it is named.
    expect(buildGuard({ cwd: copy, root: project, home, platform: process.platform, flutter: null }).writeExactly).toBeUndefined();
  });

  it.runIf(onMac)('a command writes them as Flutter does, and nothing else of Flutter', async () => {
    const root = sdk();
    const g = buildGuard({ cwd: copy, root: project, cache, extraWrite: [cache], extraRead: [cache], home, platform: process.platform, flutter: root });
    const tmp = path.join(root, 'bin/cache/engine.stamp.tmp.$$');
    const r = await runCommand(copy, [`echo v2 > "${tmp}" && mv "${tmp}" "${path.join(root, 'bin/cache/engine.stamp')}" && echo "" > "${path.join(root, 'bin/cache/engine.realm')}" && echo stamps-ok`, ...refused(root).map((p) => `echo planted > "${p}"`), 'exit 0'].join('; '), 30_000, { guard: g });
    expect(r.output).toContain('stamps-ok');
    expect(r.output.match(/not permitted/gi)).toHaveLength(refused(root).length);
    expect(fs.readFileSync(path.join(root, 'bin/cache/engine.stamp'), 'utf8')).toBe('v2\n');
    for (const p of refused(root)) expect(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : 'none', p).not.toBe('planted\n');
  });
});

/** A Flutter app's copy, and Dart packages this computer downloaded already, with pub's own lists and programs beside. */
function flutterApp(): string {
  fs.writeFileSync(path.join(copy, 'pubspec.yaml'), 'name: wasl\ndependencies:\n  flutter:\n    sdk: flutter\n');
  const pub = path.join(home, '.pub-cache');
  fs.mkdirSync(path.join(pub, 'hosted', 'pub.dev', 'http-1.2.2', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pub, 'hosted', 'pub.dev', 'http-1.2.2', 'lib', 'http.dart'), 'library http;\n');
  fs.mkdirSync(path.join(pub, 'hosted', 'pub.dev', '.cache'), { recursive: true });
  fs.mkdirSync(path.join(pub, 'hosted-hashes', 'pub.dev'), { recursive: true });
  fs.writeFileSync(path.join(pub, 'hosted-hashes', 'pub.dev', 'http-1.2.2.sha256'), 'abc');
  // Globally activated programs, on the person's PATH: never linked, never written.
  fs.mkdirSync(path.join(pub, 'bin'), { recursive: true });
  return pub;
}

describe("the person's home", () => {
  it('gets nothing from squad-kit making a cache home', () => {
    cacheHomeEnv(cache, { wall: 'project', home, env: {} });
    expect(execSync('ls -A', { cwd: home, encoding: 'utf8' }).trim()).toBe('');
  });
});
