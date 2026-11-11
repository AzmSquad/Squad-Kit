import fs from 'node:fs';
import path from 'node:path';

/**
 * How a story's copy is pointed at its own database (engine/story-db.ts). Every project command in the copy gets the
 * setting in its environment, which wins over a value the person's own environment holds, and the copy's own local
 * settings file gets it too, for an app that reads only that file. Kept here with no imports of squad-kit's own, so the
 * one place that spawns project commands (project-guard.ts) can read it.
 */

export type SettingForm = 'env' | 'properties' | 'json';

export interface CopyWiring {
  /** The environment the copy's commands get: the setting's name and the story's address. */
  env: Record<string, string>;
  /** The copy's own local file that holds the setting, by its path inside the copy. Only a file git leaves out. */
  file?: { path: string; key: string; form: SettingForm };
  /** The story's own database's address. */
  value: string;
}

/** A story's own Redis database number in its copy (engine/story-redis.ts): its settings, in the environment and in files git leaves out. */
export interface RedisWiring {
  env: Record<string, string>;
  files: { path: string; key: string; form: SettingForm; value: string }[];
}

const wired = new Map<string, CopyWiring>();
const redisWired = new Map<string, RedisWiring>();

const inside = (dir: string, p: string): boolean => p === dir || p.startsWith(`${dir}${path.sep}`);

/** Points a copy at its story's database, now and for every command run in it after this. */
export function wireCopy(dir: string, w: CopyWiring): void {
  wired.set(path.resolve(dir), w);
  writeCopyFile(path.resolve(dir), w);
}

/** Gives a copy its story's own Redis database number, the same way. */
export function wireCopyRedis(dir: string, w: RedisWiring): void {
  redisWired.set(path.resolve(dir), w);
  for (const f of w.files) writeCopyFile(path.resolve(dir), { env: {}, value: f.value, file: f });
}

/** Writes the setting into the copy's file again: placing a story's local files writes over that file. */
export function rewireCopy(dir: string): void {
  const w = wired.get(path.resolve(dir));
  if (w) writeCopyFile(path.resolve(dir), w);
  for (const f of redisWired.get(path.resolve(dir))?.files ?? []) writeCopyFile(path.resolve(dir), { env: {}, value: f.value, file: f });
}

export function unwireCopy(dir: string): void {
  wired.delete(path.resolve(dir));
}

export function unwireCopyRedis(dir: string): void {
  redisWired.delete(path.resolve(dir));
}

/** The wiring of the copy a folder is in, or of the one copy inside it (a story's folder on a workspace). */
function wiringFor<W>(map: Map<string, W>, cwd: string): [string, W] | undefined {
  const at = path.resolve(cwd);
  for (const [dir, w] of map) if (inside(dir, at)) return [dir, w];
  const within = [...map].filter(([dir]) => inside(at, dir));
  return within.length === 1 ? within[0] : undefined;
}

/** The environment for a command run in this folder: the story's database setting and Redis number, when the folder is a wired copy. */
export function copyDbEnv(cwd: string | undefined): Record<string, string> {
  if (!cwd) return {};
  return { ...(wiringFor(redisWired, cwd)?.[1].env ?? {}), ...(wiringFor(wired, cwd)?.[1].env ?? {}) };
}

/** True when the folder is a copy pointed at its story's own database. */
export function ownDbWired(cwd: string): boolean {
  return Boolean(wiringFor(wired, cwd));
}

/** The copy's settings files squad-kit wrote an address into, for no agent to read. */
export function copyDbFiles(cwd: string | undefined): string[] {
  if (!cwd) return [];
  const hit = wiringFor(wired, cwd);
  const redis = wiringFor(redisWired, cwd);
  return [...new Set([...(hit?.[1].file ? [path.join(hit[0], hit[1].file.path)] : []), ...(redis?.[1].files ?? []).map((f) => path.join(redis![0], f.path))])];
}

/** The file's place in the copy, or null when a link on the way would send it somewhere else. */
function placeIn(dir: string, rel: string): string | null {
  let at = dir;
  for (const part of rel.split('/').filter((x) => x && x !== '.')) {
    at = path.join(at, part);
    if (fs.lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink()) return null;
  }
  return inside(dir, at) ? at : null;
}

function writeCopyFile(dir: string, w: CopyWiring): void {
  if (!w.file) return;
  const to = placeIn(dir, w.file.path);
  if (!to) return;
  try {
    writeSetting(to, w.file.form, w.file.key, w.value);
  } catch {
    // A file it cannot write keeps the environment, which every command in the copy gets anyway.
  }
}

/** An env file's value, in quotes when it needs them. */
function envValue(v: string): string {
  return /[\s#"'\\$`]/.test(v) ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : v;
}

/** Sets one key in a settings file, keeping the rest as it is. A file that is not there yet is made, for this computer only. */
export function writeSetting(file: string, form: SettingForm, key: string, value: string): void {
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let after: string;
  if (form === 'json') {
    const doc = (before.trim() ? JSON.parse(before) : {}) as Record<string, unknown>;
    let at: Record<string, unknown> = doc;
    const parts = key.split(':');
    for (const p of parts.slice(0, -1)) {
      if (!at[p] || typeof at[p] !== 'object') at[p] = {};
      at = at[p] as Record<string, unknown>;
    }
    at[parts.at(-1)!] = value;
    after = `${JSON.stringify(doc, null, 2)}\n`;
  } else {
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const line = form === 'env' ? new RegExp(`^(\\s*(?:export\\s+)?)${esc}\\s*=.*$`) : new RegExp(`^(\\s*)${esc}\\s*[=:].*$`);
    const text = form === 'env' ? `${key}=${envValue(value)}` : `${key}=${value.replace(/\\/g, '\\\\')}`;
    const lines = before ? before.replace(/\r?\n$/, '').split(/\r?\n/) : [];
    let set = false;
    const out: string[] = [];
    for (const l of lines) {
      const m = line.exec(l);
      if (!m) out.push(l);
      else if (!set) {
        out.push(`${m[1]}${text}`);
        set = true;
      }
    }
    if (!set) out.push(text);
    after = `${out.join('\n')}\n`;
  }
  if (after === before) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, after, { mode: 0o600 });
}

/** For tests: every copy forgotten. */
export function forgetWiring(): void {
  wired.clear();
  redisWired.clear();
}
