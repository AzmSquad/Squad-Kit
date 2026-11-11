import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeLog } from '../core/app-log.js';
import { now, type BoardPaths } from '../board/store.js';
import { findTool, runTool, secretsOf } from './db/run.js';
import { unwireCopyRedis, wireCopyRedis, type RedisWiring, type SettingForm } from './db-env.js';
import { git } from './git.js';
import { appSettings, composeServices, safeAddress, serverOf, serverPlace, settingsIn, type AppSetting, type Setting } from './service-hosts.js';

/**
 * A story's own Redis database number. A story's app that uses the same Redis server as the person's own app would share
 * its cache keys and locks, so each story's copy gets a number of its own on that server, from 1 to 15: never 0, which
 * the person's app uses, and never another story's. squad-kit keeps it on this computer, beside the story databases,
 * and gives it to the app through the setting it reads (`redis://host:6379/4`, `host:6379,defaultDatabase=4`, or a
 * REDIS_DB of its own). When the story's copy goes, that number's keys are cleared with redis-cli, that number only.
 * A Redis on another computer is left as it is.
 */

export interface StoryRedisRecord {
  story: string;
  repo: string;
  /** The copy it is for. */
  dir: string;
  /** The Redis database number, 1 to 15. */
  number: number;
  /** The server, as `localhost:6379`. */
  server: string;
  at: string;
}

const MIN = 1;
const MAX = 15;

const recordFile = (bp: BoardPaths): string => path.join(bp.localDir, 'database', 'redis.json');

/** The story Redis numbers this computer has now. */
export function storyRedisNumbers(bp: BoardPaths): StoryRedisRecord[] {
  try {
    const list = (JSON.parse(fs.readFileSync(recordFile(bp), 'utf8')) as { stories?: StoryRedisRecord[] }).stories;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function changeRecords(bp: BoardPaths, change: (list: StoryRedisRecord[]) => StoryRedisRecord[]): void {
  const next = change(storyRedisNumbers(bp));
  fs.mkdirSync(path.dirname(recordFile(bp)), { recursive: true, mode: 0o700 });
  const tmp = `${recordFile(bp)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ stories: next }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, recordFile(bp));
}

/** A number for a story, the same each time while it is free: from 1 to 15, none of the taken ones. Null when all are. */
export function chooseRedisNumber(story: string, taken: Set<number>): number | null {
  const start = parseInt(createHash('sha1').update(story).digest('hex').slice(0, 8), 16) % (MAX - MIN + 1);
  for (let i = 0; i <= MAX - MIN; i += 1) {
    const n = MIN + ((start + i) % (MAX - MIN + 1));
    if (!taken.has(n)) return n;
  }
  return null;
}

/** The database number a Redis address names: `/4` in a link, `defaultDatabase=4` in a StackExchange list. 0 when it names none. */
export function redisNumberIn(address: string): number {
  const t = address.trim();
  const link = /^rediss?:\/\/[^/?#]*\/(\d+)/i.exec(t);
  if (link) return Number(link[1]);
  return Number(/(?:^|,)\s*defaultdatabase\s*=\s*(\d+)/i.exec(t)?.[1] ?? 0);
}

/** The Redis address with another database number, in the same form: `redis://host:6379/4`, or `host:6379,…,defaultDatabase=4`. */
export function withRedisNumber(address: string, n: number): string {
  const t = address.trim();
  const link = /^(rediss?:\/\/[^/?#]*)(\/[^?#]*)?(.*)$/i.exec(t);
  if (link) return `${link[1]}/${n}${link[3]}`;
  return [...t.split(',').filter((p) => !/^\s*defaultdatabase\s*=/i.test(p)), `defaultDatabase=${n}`].join(',');
}

/** A setting that holds only a host, with the port and number in settings of their own: REDIS_HOST. */
const HOST_ONLY = /(?:^|_)(?:HOST|HOSTNAME|SERVER|ADDR)$/i;
/** A setting that holds the number alone: REDIS_DB, REDIS_DATABASE, Redis__DefaultDatabase. */
const NUMBER_NAME = /^(?:[A-Za-z0-9]+_+)*redis_+(?:db|database|default_?database|db_?index|index)$/i;

/** The copy's own settings file to write a value into: only one git leaves out, so it never goes in a commit. */
function fileOf(dir: string, s: Setting): RedisWiring['files'][number] | null {
  const form: SettingForm | null = s.form === 'env' ? 'env' : s.form === 'json' ? 'json' : s.form === 'properties' ? 'properties' : null;
  if (!form || !git(dir, ['check-ignore', '--', s.file], { allowFail: true })) return null;
  return { path: s.file, key: s.key, form, value: '' };
}

/** Each story hears each line once, in the log. */
const said = new Set<string>();
function logOnce(story: string, text: string, level: 'info' | 'warn' = 'info'): void {
  if (said.has(`${story}\n${text}`)) return;
  said.add(`${story}\n${text}`);
  writeLog({ level, ticket: story, text });
}

/**
 * Gives a story's copy its own Redis database number, when the app's Redis is on this computer: kept from before, or a
 * new one. Its address goes to every command in the copy, and into the copy's own settings file when git leaves that
 * out. The record, or null when the app has no Redis setting, it is on another computer, or there is no number free.
 */
export function setUpStoryRedis(bp: BoardPaths, story: string, dir: string, repo: string): StoryRedisRecord | null {
  const all = settingsIn(dir);
  const redis = appSettings(dir, all).filter((s) => s.kind === 'redis');
  if (!redis.length) {
    unwireCopyRedis(dir);
    return null;
  }
  const services = composeServices(dir);
  const places = redis.map((s) => ({ s, place: serverPlace(s.value, services, { redis: true }) }));
  const away = places.find((p) => !p.place.here);
  if (away && !away.place.here) logOnce(story, `The app's Redis (${away.s.name}) is on another computer (${away.place.host}), so squad-kit leaves it as it is: ${story} shares it.`);
  const local = places.flatMap((p) => (p.place.here ? [{ s: p.s, address: p.place.address }] : []));
  const server = local.length ? serverOf(local[0]!.address, true) : null;
  if (!server) {
    unwireCopyRedis(dir);
    return null;
  }
  const records = storyRedisNumbers(bp);
  const mine = records.find((r) => r.story === story && r.server === server);
  const onServer = local.filter((l) => serverOf(l.address, true) === server);
  // 0 and whatever number the person's own settings name are theirs; the other stories' are theirs.
  const taken = new Set([0, ...onServer.map((l) => redisNumberIn(l.s.value)), ...records.filter((r) => r.story !== story && r.server === server).map((r) => r.number)]);
  const number = mine?.number ?? chooseRedisNumber(story, taken);
  if (!number) {
    logOnce(story, `Every Redis database number from ${MIN} to ${MAX} on ${server} is taken by other stories, so ${story} shares the app's own.`, 'warn');
    unwireCopyRedis(dir);
    return null;
  }
  const w: RedisWiring = { env: {}, files: [] };
  const put = (s: Setting, envValue: string, fileValue: string) => {
    w.env[s.name] = envValue;
    const f = fileOf(dir, s);
    if (f) w.files.push({ ...f, value: fileValue });
  };
  for (const { s, address } of onServer) if (!HOST_ONLY.test(s.name)) put(s, withRedisNumber(address, number), withRedisNumber(s.value, number));
  for (const s of all) if (NUMBER_NAME.test(s.name) && /^\d+$/.test(s.value)) put(s, String(number), String(number));
  if (!Object.keys(w.env).length) {
    logOnce(story, `The app's Redis settings have no place for a database number, so ${story} shares the app's own Redis database.`);
    unwireCopyRedis(dir);
    return null;
  }
  wireCopyRedis(dir, w);
  const record: StoryRedisRecord = { story, repo, dir: path.resolve(dir), number, server, at: mine?.at ?? now() };
  changeRecords(bp, (list) => [...list.filter((r) => !(r.story === story && r.repo === repo)), record]);
  if (!mine) logOnce(story, `${story}'s app has its own Redis database number, ${number}, on ${server} (${safeAddress(Object.values(w.env)[0]!)})`);
  return record;
}

/** A copy used again: when its story has a Redis number, the copy gets it again. Nothing new is chosen. */
export function rewireStoryRedis(bp: BoardPaths, story: string, dir: string, repo: string): boolean {
  const had = storyRedisNumbers(bp).find((r) => r.story === story && r.repo === repo && path.resolve(r.dir) === path.resolve(dir));
  if (!had) return false;
  return Boolean(setUpStoryRedis(bp, story, dir, repo));
}

/** What redis-cli needs to sign in to a server, from a Redis address: never on its command line. */
function signIn(address: string): { user?: string; password?: string; tls: boolean } {
  const t = address.trim();
  const link = /^(rediss?):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?/i.exec(t);
  const dec = (s: string | undefined) => {
    try {
      return s ? decodeURIComponent(s) : undefined;
    } catch {
      return s;
    }
  };
  if (link) return { ...(link[2] ? { user: dec(link[2]) } : {}), ...(link[3] ? { password: dec(link[3]) } : {}), tls: link[1]!.toLowerCase() === 'rediss' };
  const opt = (name: string) => new RegExp(`(?:^|,)\\s*${name}\\s*=([^,]*)`, 'i').exec(t)?.[1]?.trim();
  const user = opt('user');
  const password = opt('password');
  return { ...(user ? { user } : {}), ...(password ? { password } : {}), tls: /^true$/i.test(opt('ssl') ?? '') };
}

/** The longest clearing a story's Redis number may take. Nobody waits on it: the keys stay, and the log says so. */
const FLUSH_MS = 30_000;

/** Runs redis-cli: the tool's path and its arguments, with the password in its environment. For tests, a fake. */
export type RedisCli = (tool: string, args: string[], env: Record<string, string>, secrets: string[]) => Promise<string>;
const realCli: RedisCli = (tool, args, env, secrets) => runTool(tool, args, { env, secrets, doing: "Clearing a story's Redis database", timeoutMs: FLUSH_MS });

/**
 * Clears a story's own Redis database number when its copy goes: FLUSHDB on that number only, on this computer's server,
 * through redis-cli. Never 0, never a number another story still has. Without redis-cli, or when the server says no, the
 * keys stay and the log says so. True when a number was cleared.
 */
export async function dropStoryRedis(bp: BoardPaths, story: string, cli: RedisCli = realCli): Promise<boolean> {
  const mine = storyRedisNumbers(bp).filter((r) => r.story === story);
  if (!mine.length) return false;
  for (const r of mine) unwireCopyRedis(r.dir);
  changeRecords(bp, (list) => list.filter((r) => r.story !== story));
  const left = storyRedisNumbers(bp);
  let cleared = false;
  for (const r of mine.filter((x, i) => mine.findIndex((y) => y.server === x.server && y.number === x.number) === i)) {
    if (!Number.isInteger(r.number) || r.number < MIN || r.number > MAX) continue;
    if (left.some((o) => o.server === r.server && o.number === r.number)) continue;
    const tool = findTool('redis-cli');
    if (!tool) {
      writeLog({ level: 'info', ticket: story, text: `redis-cli is not on this computer, so squad-kit did not clear Redis database ${r.number} on ${r.server}, ${story}'s own. Its keys stay until Redis drops them.` });
      continue;
    }
    // Where to sign in: the same server in the person's own settings, or in the story's copy while it is there.
    const known = [...appSettings(path.join(bp.root, r.repo)), ...(fs.existsSync(r.dir) ? appSettings(r.dir) : [])].filter((s: AppSetting) => s.kind === 'redis');
    const services = composeServices(path.join(bp.root, r.repo));
    const same = known.map((s) => serverPlace(s.value, services, { redis: true })).find((p) => p.here && serverOf(p.address, true) === r.server);
    const how = same?.here ? signIn(same.address) : { tls: false };
    const [, host = 'localhost', port = '6379'] = /^\[?([^\]]*?)\]?:(\d+)$/.exec(r.server) ?? [];
    const args = ['-h', host, '-p', port, '-n', String(r.number), ...(how.tls ? ['--tls'] : []), ...(how.user ? ['--user', how.user] : []), 'FLUSHDB'];
    try {
      await cli(tool, args, how.password ? { REDISCLI_AUTH: how.password } : {}, secretsOf(how.password));
      writeLog({ level: 'info', ticket: story, text: `Cleared Redis database ${r.number} on ${r.server}, ${story}'s own` });
      cleared = true;
    } catch (err) {
      writeLog({ level: 'warn', ticket: story, text: `squad-kit could not clear Redis database ${r.number} on ${r.server}, ${story}'s own: ${(err as Error).message}` });
    }
  }
  return cleared;
}

/** What engineers read on Harness, beside the database: read only. */
export interface RedisView {
  /** The app's Redis server, as `localhost:6379`, or the other computer's name. */
  server: string;
  here: boolean;
  /** The number the person's own app uses. */
  own: number;
  stories: { story: string; number: number }[];
  words: string;
}

/** The app's Redis, from the person's own settings, and each story's number on it. Null when the app has no Redis setting. */
export function redisView(bp: BoardPaths, repos: string[]): RedisView | null {
  for (const repo of repos) {
    const dir = path.join(bp.root, repo);
    const s = appSettings(dir).find((x) => x.kind === 'redis');
    if (!s) continue;
    const place = serverPlace(s.value, composeServices(dir), { redis: true });
    if (!place.here) {
      return { server: place.host, here: false, own: redisNumberIn(s.value), stories: [], words: `The app's Redis is on another computer (${place.host}). squad-kit leaves it as it is, so stories share it with your own app.` };
    }
    const server = serverOf(place.address, true) ?? 'localhost:6379';
    const own = redisNumberIn(s.value);
    const stories = storyRedisNumbers(bp).filter((r) => r.server === server).map((r) => ({ story: r.story, number: r.number }));
    const unique = stories.filter((x, i) => stories.findIndex((y) => y.story === x.story) === i);
    return { server, here: true, own, stories: unique, words: `Each story's app gets its own Redis database number on ${server}, from ${MIN} to ${MAX}, so cache keys and locks never mix. Your own app keeps ${own}. A story's keys are cleared when its copy goes.` };
  }
  return null;
}
