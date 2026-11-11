import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardPaths, writeMeta } from '../src/board/store.js';
import { copyDbEnv, copyDbFiles, forgetWiring, rewireCopy } from '../src/engine/db-env.js';
import { chooseRedisNumber, dropStoryRedis, redisNumberIn, redisView, rewireStoryRedis, setUpStoryRedis, storyRedisNumbers, withRedisNumber, type RedisCli } from '../src/engine/story-redis.js';

/**
 * A story's own Redis database number: chosen once per story, from 1 to 15, never 0 and never another story's; given to
 * the story's copy in the form its setting has; cleared with redis-cli when the copy goes, that number only. No real
 * Redis: a fake redis-cli that only says what it was given. Made-up projects only.
 */

let root: string;
let bp: ReturnType<typeof boardPaths>;
let tools: string;
const write = (file: string, text: string, dir = root) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};
const sh = (cmd: string, cwd = root) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A copy of the project, as a story has it: what git carries. */
function copy(name: string): string {
  const dir = path.join(root, '..', `${path.basename(root)}-${name}`);
  sh(`git worktree add -q --detach "${dir}" main`);
  return fs.realpathSync(dir);
}

const calls: { args: string[]; env: Record<string, string> }[] = [];
const fakeCli: RedisCli = async (_tool, args, env) => {
  calls.push({ args, env });
  return 'OK';
};

beforeEach(() => {
  forgetWiring();
  calls.length = 0;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-redis-')));
  // A redis-cli that is never run here: the fake above runs in its place.
  tools = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-redis-tools-'));
  fs.writeFileSync(path.join(tools, 'redis-cli'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  vi.stubEnv('SQUAD_DB_TOOL_DIRS', tools);
  write('.gitignore', '.env.dev\n.squad/\n');
  write('docker-compose.yml', 'services:\n  api:\n    build: .\n    env_file: .env.dev\n  cache:\n    image: redis:7\n    ports: ["6379:6379"]\n');
  write('src/Shop/appsettings.json', JSON.stringify({ Redis: { ConnectionString: 'cache:6379,abortConnect=false' } }));
  sh('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm start');
  bp = boardPaths(path.join(root, '.squad'));
  writeMeta(bp, {
    project: 'Shop',
    key: 'SH',
    nextNumber: 2,
    engine: 'live',
    runner: 'direct',
    user: { name: 'Momen', role: 'Engineer' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
    commands: {},
    git: { base: 'main', remote: '' },
    scan: { status: 'done', empty: false },
  });
});

afterEach(() => {
  forgetWiring();
  vi.unstubAllEnvs();
  for (const d of fs.readdirSync(path.dirname(root)).filter((d) => d.startsWith(`${path.basename(root)}-`))) fs.rmSync(path.join(path.dirname(root), d), { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(tools, { recursive: true, force: true });
});

describe('the number', () => {
  it('is the same for a story each time, from 1 to 15, never a taken one, and none when all are', () => {
    const n = chooseRedisNumber('SH-1', new Set([0]));
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(15);
    expect(chooseRedisNumber('SH-1', new Set([0]))).toBe(n);
    expect(chooseRedisNumber('SH-1', new Set([0, n!]))).not.toBe(n);
    expect(chooseRedisNumber('SH-1', new Set(Array.from({ length: 16 }, (_, i) => i)))).toBeNull();
  });

  it('is written in the form the setting has', () => {
    expect(withRedisNumber('redis://:pw@localhost:6379', 4)).toBe('redis://:pw@localhost:6379/4');
    expect(withRedisNumber('redis://localhost:6379/0?protocol=3', 4)).toBe('redis://localhost:6379/4?protocol=3');
    expect(withRedisNumber('localhost:6379,abortConnect=false', 4)).toBe('localhost:6379,abortConnect=false,defaultDatabase=4');
    expect(withRedisNumber('localhost:6379,defaultDatabase=2,ssl=false', 4)).toBe('localhost:6379,ssl=false,defaultDatabase=4');
    expect(redisNumberIn('localhost:6379,defaultDatabase=2')).toBe(2);
    expect(redisNumberIn('redis://localhost/3')).toBe(3);
    expect(redisNumberIn('redis://localhost')).toBe(0);
  });
});

describe("a story's copy", () => {
  it('gets its own number on the shared server, through the setting the app reads, kept on this computer', () => {
    const dir = copy('sh-1');
    const r = setUpStoryRedis(bp, 'SH-1', dir, '.')!;
    expect(r).toMatchObject({ story: 'SH-1', server: 'localhost:6379', dir });
    expect(r.number).toBeGreaterThanOrEqual(1);
    expect(copyDbEnv(dir)).toEqual({ Redis__ConnectionString: `localhost:6379,abortConnect=false,defaultDatabase=${r.number}` });
    expect(copyDbEnv(path.join(dir, 'src'))).toEqual(copyDbEnv(dir));
    expect(storyRedisNumbers(bp)).toEqual([r]);
    expect(fs.existsSync(path.join(bp.localDir, 'database', 'redis.json'))).toBe(true);
    // Used again: the same number.
    expect(setUpStoryRedis(bp, 'SH-1', dir, '.')!.number).toBe(r.number);
  });

  it("never 0, never the person's own number, never another story's", () => {
    write('src/Shop/appsettings.json', JSON.stringify({ Redis: { ConnectionString: 'cache:6379,defaultDatabase=2' } }));
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm "own number"');
    const seen = new Set<number>();
    for (let i = 1; i <= 14; i += 1) {
      const r = setUpStoryRedis(bp, `SH-${i}`, copy(`sh-${i}`), '.')!;
      expect(r.number).not.toBe(0);
      expect(r.number).not.toBe(2);
      expect(seen.has(r.number)).toBe(false);
      seen.add(r.number);
    }
    // 1 to 15 less 2: fourteen stories, and the fifteenth shares the app's own, said in the log.
    expect(setUpStoryRedis(bp, 'SH-15', copy('sh-15'), '.')).toBeNull();
  });

  it('writes the number into a settings file git leaves out, and again after the local files are placed', () => {
    const dir = copy('sh-1');
    write('.env.dev', 'REDIS_URL=redis://cache:6379\nREDIS_DB=0\n', dir);
    const r = setUpStoryRedis(bp, 'SH-1', dir, '.')!;
    expect(copyDbEnv(dir)).toMatchObject({ REDIS_URL: `redis://localhost:6379/${r.number}`, REDIS_DB: String(r.number) });
    // The file keeps the service's name, for an app that runs in Compose.
    expect(fs.readFileSync(path.join(dir, '.env.dev'), 'utf8')).toBe(`REDIS_URL=redis://cache:6379/${r.number}\nREDIS_DB=${r.number}\n`);
    expect(copyDbFiles(dir)).toEqual([path.join(dir, '.env.dev')]);
    fs.writeFileSync(path.join(dir, '.env.dev'), 'REDIS_URL=redis://cache:6379\nREDIS_DB=0\n');
    rewireCopy(dir);
    expect(fs.readFileSync(path.join(dir, '.env.dev'), 'utf8')).toContain(`REDIS_DB=${r.number}`);
    // A tracked file is never written.
    expect(fs.readFileSync(path.join(dir, 'src/Shop/appsettings.json'), 'utf8')).not.toContain('defaultDatabase');
  });

  it('a Redis on another computer is left as it is', () => {
    write('src/Shop/appsettings.json', JSON.stringify({ Redis: { ConnectionString: 'redis.example.net:6379,abortConnect=false' } }));
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm remote');
    const dir = copy('sh-1');
    expect(setUpStoryRedis(bp, 'SH-1', dir, '.')).toBeNull();
    expect(copyDbEnv(dir)).toEqual({});
    expect(redisView(bp, ['.'])).toMatchObject({ here: false, words: "The app's Redis is on another computer (redis.example.net). squad-kit leaves it as it is, so stories share it with your own app." });
  });

  it('after a restart, the copy gets the same number again', () => {
    const dir = copy('sh-1');
    const r = setUpStoryRedis(bp, 'SH-1', dir, '.')!;
    forgetWiring();
    expect(copyDbEnv(dir)).toEqual({});
    expect(rewireStoryRedis(bp, 'SH-1', dir, '.')).toBe(true);
    expect(copyDbEnv(dir).Redis__ConnectionString).toContain(`defaultDatabase=${r.number}`);
  });
});

describe('when the copy goes', () => {
  it('clears that number only, with redis-cli, and the password in its environment', async () => {
    write('src/Shop/appsettings.json', JSON.stringify({ Redis: { ConnectionString: 'cache:6379,password=s3cret,abortConnect=false' } }));
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm password');
    const dir = copy('sh-1');
    const r = setUpStoryRedis(bp, 'SH-1', dir, '.')!;
    const other = setUpStoryRedis(bp, 'SH-2', copy('sh-2'), '.')!;
    expect(await dropStoryRedis(bp, 'SH-1', fakeCli)).toBe(true);
    expect(calls).toEqual([{ args: ['-h', 'localhost', '-p', '6379', '-n', String(r.number), 'FLUSHDB'], env: { REDISCLI_AUTH: 's3cret' } }]);
    expect(storyRedisNumbers(bp)).toEqual([other]);
    expect(copyDbEnv(dir)).toEqual({});
    // Gone already: nothing more.
    expect(await dropStoryRedis(bp, 'SH-1', fakeCli)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('never 0, and never a number another story still has', async () => {
    const dir = copy('sh-1');
    setUpStoryRedis(bp, 'SH-1', dir, '.');
    const file = path.join(bp.localDir, 'database', 'redis.json');
    const list = JSON.parse(fs.readFileSync(file, 'utf8')) as { stories: { number: number }[] };
    // Records changed by hand: one says 0, another shares SH-2's number.
    fs.writeFileSync(file, JSON.stringify({ stories: [{ ...list.stories[0], number: 0 }, { ...list.stories[0], story: 'SH-3', repo: 'web', number: 7 }, { ...list.stories[0], story: 'SH-2', number: 7 }] }));
    expect(await dropStoryRedis(bp, 'SH-1', fakeCli)).toBe(false);
    expect(await dropStoryRedis(bp, 'SH-3', fakeCli)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('without redis-cli, the keys stay and the log says so', async () => {
    vi.stubEnv('SQUAD_DB_TOOL_DIRS', path.join(tools, 'none'));
    setUpStoryRedis(bp, 'SH-1', copy('sh-1'), '.');
    expect(await dropStoryRedis(bp, 'SH-1', fakeCli)).toBe(false);
    expect(calls).toEqual([]);
    expect(storyRedisNumbers(bp)).toEqual([]);
  });
});

describe('Harness', () => {
  it("says it read only, beside the database, with each story's number", () => {
    const r = setUpStoryRedis(bp, 'SH-1', copy('sh-1'), '.')!;
    expect(redisView(bp, ['.'])).toEqual({
      server: 'localhost:6379',
      here: true,
      own: 0,
      stories: [{ story: 'SH-1', number: r.number }],
      words: "Each story's app gets its own Redis database number on localhost:6379, from 1 to 15, so cache keys and locks never mix. Your own app keeps 0. A story's keys are cleared when its copy goes.",
    });
  });

  it('nothing when the app has no Redis', () => {
    fs.rmSync(path.join(root, 'src'), { recursive: true });
    expect(redisView(bp, ['.'])).toBeNull();
  });
});
