import fs from 'node:fs';
import path from 'node:path';
import { writeLog } from '../core/app-log.js';
import { loadSecrets, saveSecrets, type SquadSecrets } from '../core/secrets.js';
import { readMeta, readTicket, writeMeta, now, type BoardPaths } from '../board/store.js';
import type { DatabaseSetting, ProjectDatabase } from '../board/types.js';
import { dbAdapter, readTemplate } from './db/index.js';
import { DbError, type DbAdapter, type DbKind, type DbTemplate, type TemplateInfo } from './db/types.js';
import { unwireCopy, wireCopy, type CopyWiring, type SettingForm } from './db-env.js';
import { repoEnvFiles } from './env-file.js';
import { findDatabase, hasPassword, kindOf, readAddress, storyCopyIgnored, withoutPassword } from './find-database.js';
import { forgetDbMade, git, markDbMade } from './git.js';
import { reposOf } from './repos.js';
import { composeServices, serverPlace, settingsFileAddress, type ServerPlace } from './service-hosts.js';
import { dropStoryRedis, redisView, rewireStoryRedis, setUpStoryRedis, storyRedisNumbers, type RedisView } from './story-redis.js';

/**
 * A database of its own for each story (1.3.5). squad-kit learns the project's database once, from its files; an
 * engineer confirms it and makes a small template of it; then each story's copy gets its own database, made from the
 * template on the same server, and points at it through the learned setting. It goes when the story is merged,
 * released or deleted, and a leftover goes with the other leftovers. The person's own database is only ever read, to
 * make the template: no story is pointed at it, and nothing here creates, changes or drops it.
 *
 * When there is no template yet, or the database cannot be reached, the story goes on as before and engineers get one
 * plain note. A PM is never asked anything: they read at most that the story has its own copy of the database.
 *
 * What is the team's (the kind, name and setting, the switches) is in `.squad/config.yaml`. What is this computer's is
 * in squad-kit's own folder for the project: the template, the story databases there are now, and in the secrets file,
 * every address with a password.
 */

/** What a PM reads on a story that got its own database. */
export const OWN_DB_WORDS = 'The story has its own copy of the database.';

export const DB_KINDS: DbKind[] = ['postgres', 'mysql', 'mongo', 'sqlite'];
export const KIND_NAME: Record<DbKind, string> = { postgres: 'Postgres', mysql: 'MySQL', mongo: 'Mongo', sqlite: 'SQLite' };

const dbDir = (bp: BoardPaths): string => path.join(bp.localDir, 'database');
/** The template's own folder, on this computer, never in git. */
export const templateFolder = (bp: BoardPaths): string => path.join(dbDir(bp), 'template');
const stateFile = (bp: BoardPaths): string => path.join(dbDir(bp), 'state.json');

/** A story's own database, as this computer made it. Its address is in the secrets. */
export interface StoryDbRecord {
  story: string;
  repo: string;
  /** The copy it is for. */
  dir: string;
  kind: DbKind;
  name: string;
  at: string;
}

export interface DbNote {
  at: string;
  story?: string;
  text: string;
}

interface DbState {
  making?: { since: string; by: string };
  /** Why the last template was not made, in plain words. */
  failed?: { at: string; text: string };
  stories: StoryDbRecord[];
  notes: DbNote[];
}

function readState(bp: BoardPaths): DbState {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(bp), 'utf8')) as Partial<DbState>;
    return { ...s, stories: Array.isArray(s.stories) ? s.stories : [], notes: Array.isArray(s.notes) ? s.notes : [] };
  } catch {
    return { stories: [], notes: [] };
  }
}

/** Changes the state in one go, with no wait between the read and the write. */
function changeState(bp: BoardPaths, change: (s: DbState) => void): DbState {
  const s = readState(bp);
  change(s);
  fs.mkdirSync(dbDir(bp), { recursive: true, mode: 0o700 });
  const tmp = `${stateFile(bp)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, stateFile(bp));
  return s;
}

/* ── the secrets ─────────────────────────────────────────── */

function dbSecrets(bp: BoardPaths): NonNullable<SquadSecrets['database']> {
  try {
    return loadSecrets(bp.secretsFile).database ?? {};
  } catch {
    return {};
  }
}

/** Changes the database's part of this computer's secrets. A secrets file that cannot be read is never written over. */
function changeSecrets(bp: BoardPaths, change: (d: NonNullable<SquadSecrets['database']>) => void): void {
  const all = loadSecrets(bp.secretsFile);
  const d = { ...(all.database ?? {}), stories: { ...(all.database?.stories ?? {}) } };
  change(d);
  if (!d.address) delete d.address;
  if (!Object.keys(d.stories).length) delete (d as { stories?: unknown }).stories;
  const { database: _old, ...rest } = all;
  saveSecrets(bp.secretsFile, Object.keys(d).length ? { ...rest, database: d } : rest);
}

/** The address as kept: in the secrets when it has a password, else in the shared settings. */
function keptAddress(bp: BoardPaths, db: ProjectDatabase | undefined): string | undefined {
  return dbSecrets(bp).address ?? db?.address;
}

/**
 * The address the person's own copy uses. A SQLite file named from the app's folder is found from the repo's top
 * folder, or from the folder of Prisma's schema, where Prisma finds it.
 */
export function personsAddress(bp: BoardPaths, db: ProjectDatabase | undefined = readMeta(bp).database): string | undefined {
  const a = keptAddress(bp, db);
  if (!a || db?.kind !== 'sqlite') return a;
  const file = readAddress(a).name;
  if (!file || path.isAbsolute(file)) return a;
  const prisma = db.from?.find((f) => f.endsWith('.prisma'));
  return sqliteAt(a, file, path.join(bp.root, db.repo, prisma ? path.posix.dirname(prisma) : '.', file));
}

/** Takes every password the database's addresses hold out of words for a log or a note. */
function scrub(bp: BoardPaths, text: string): string {
  const s = dbSecrets(bp);
  let out = text;
  for (const a of [s.address, ...Object.values(s.stories ?? {})]) {
    if (!a) continue;
    const pass = /^(?:jdbc:)?[a-z][\w+.-]*:\/\/[^:@/]*:([^@/]+)@/i.exec(a)?.[1] ?? /(?:^|;)\s*(?:password|pwd)\s*=([^;]+)/i.exec(a)?.[1];
    if (pass) out = out.split(pass).join('***').split(decodeURIComponent(pass)).join('***');
  }
  return out;
}

/** One plain note for engineers: in the app log, and on Harness. Each story hears each note once. */
function noteForEngineers(bp: BoardPaths, text: string, story?: string): void {
  const clean = scrub(bp, text);
  if (readState(bp).notes.some((n) => n.story === story && n.text === clean)) return;
  changeState(bp, (s) => (s.notes = [...s.notes, { at: now(), ...(story ? { story } : {}), text: clean }].slice(-30)));
  let project: string | undefined;
  try {
    project = readMeta(bp).project;
  } catch {
    // No board to name.
  }
  writeLog({ level: 'warn', ...(project ? { project } : {}), ...(story ? { ticket: story } : {}), text: clean });
}

/* ── on this computer only ───────────────────────────────── */

/**
 * Where the database's server is, for a story's own copy: squad-kit makes, copies and drops a database only on a server
 * on this computer (localhost in any form, host.docker.internal, or a compose service of the project that publishes its
 * port here), and reaches a compose service through that port. A SQLite file is in each copy already.
 */
function placeOf(bp: BoardPaths, db: Pick<ProjectDatabase, 'kind' | 'repo'>, address: string): ServerPlace {
  if (db.kind === 'sqlite') return { here: true, address };
  return serverPlace(address, composeServices(path.join(bp.root, db.repo)), { kind: db.kind });
}

/** What a story, Harness or the template button says when the database is on another computer. */
export function awayWords(place: Extract<ServerPlace, { here: false }>, who: 'story' | 'stories' | 'template' = 'story'): string {
  const then = who === 'story' ? 'so this story uses no copy of its own' : who === 'stories' ? 'so stories use it as before' : 'so it makes no template of it';
  if (place.service) return `This project's database runs in Docker as the ${place.host} service, which does not publish its port on this computer. squad-kit makes a story's own database only where it reaches it on this computer, ${then}. An engineer can publish the port in the compose file, or point the project at a local database in Settings.`;
  return `This project's database is on another computer (${place.host}). squad-kit makes a story's own database only on this computer, ${then}. An engineer can point the project at a local database in Settings.`;
}

/* ── learning the database ───────────────────────────────── */

const sameSetting = (a: DatabaseSetting, b: DatabaseSetting): boolean => a.env === b.env && a.file === b.file && a.key === b.key;
const sameDatabase = (a: ProjectDatabase | undefined, b: ProjectDatabase): boolean => Boolean(a) && a!.kind === b.kind && a!.repo === b.repo && a!.name === b.name && sameSetting(a!.setting, b.setting);

/**
 * Learns the project's database from its own files, at the first read and when an engineer asks. A database an engineer
 * confirmed stays as it is, unless `again`; found again the same, it keeps its confirmation. An address with a password
 * goes to this computer's secrets only. Nothing here connects to the database.
 */
export function learnDatabase(bp: BoardPaths, opts: { again?: boolean } = {}): { database?: ProjectDatabase; changed: boolean; later?: string } {
  const meta = readMeta(bp);
  const before = meta.database;
  if (before?.confirmed && !opts.again) return { database: before, changed: false };
  // The part's env file is where the app gets its settings first (env-file.ts): its address wins over a settings file's.
  const repos = reposOf(meta).map((r) => r.path);
  const look = findDatabase(bp.root, repos, Object.fromEntries(repos.map((r) => [r, repoEnvFiles(meta, r)])));
  if (!look.found) {
    if (look.later) noteForEngineers(bp, look.later);
    return { ...(before ? { database: before } : {}), changed: false, ...(look.later ? { later: look.later } : {}) };
  }
  const f = look.found;
  const secret = f.address && hasPassword(f.address) ? f.address : undefined;
  const next: ProjectDatabase = {
    kind: f.kind,
    repo: f.repo,
    ...(f.name ? { name: f.name } : {}),
    ...(f.where ? { where: f.where } : {}),
    setting: f.setting,
    ...(f.address && !secret ? { address: f.address } : {}),
    ...(f.from.length ? { from: f.from } : {}),
    ...(before?.hidePersonal ? { hidePersonal: true } : {}),
    ...(before?.sampleRows ? { sampleRows: before.sampleRows } : {}),
  };
  if (before?.confirmed && sameDatabase(before, next)) next.confirmed = before.confirmed;
  writeMeta(bp, { ...meta, database: next });
  // A new address takes the old one's place; none found keeps what an engineer gave.
  if (f.address) changeSecrets(bp, (d) => (d.address = secret));
  return { database: next, changed: !sameDatabase(before, next) };
}

/** The first read of a project learns its database too. It never stops the read. */
export function learnAfterRead(bp: BoardPaths): void {
  try {
    learnDatabase(bp);
  } catch (err) {
    writeLog({ level: 'warn', text: scrub(bp, `Learning the project's database did not work: ${(err as Error).message}`) });
  }
}

export interface DatabaseChange {
  kind?: string;
  name?: string;
  repo?: string;
  env?: string;
  file?: string;
  key?: string;
  address?: string;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * An engineer confirms the database, correcting what squad-kit found when it is wrong. Stories get their own database
 * from then on, once there is a template. A PM never sees this.
 */
export function confirmDatabase(bp: BoardPaths, by: string, change: DatabaseChange = {}): ProjectDatabase {
  const meta = readMeta(bp);
  const repos = reposOf(meta).map((r) => r.path);
  const kind = change.kind?.trim().toLowerCase();
  if (kind && !DB_KINDS.includes(kind as DbKind)) throw new Error(`"${change.kind}" is not a kind squad-kit can copy. Use postgres, mysql, mongo or sqlite.`);
  const before = meta.database;
  if (!before && !kind) throw new Error('squad-kit has not found the project\'s database. Name it: squad db confirm --kind postgres --env DATABASE_URL --address postgres://localhost:5432/app');
  const repo = change.repo?.trim() || before?.repo || (repos.length === 1 ? repos[0]! : '');
  if (!repos.includes(repo)) throw new Error(repo ? `There is no code repo at ${repo}. The repos: ${repos.join(', ')}.` : `Say which repo reads the database: ${repos.join(', ')}.`);
  const setting: DatabaseSetting = { ...(before?.setting ?? {}) };
  if (change.env !== undefined) {
    const env = change.env.trim();
    if (env && !ENV_NAME.test(env)) throw new Error(`"${env}" is not a setting name. Write it as the app reads it, like DATABASE_URL.`);
    if (env) setting.env = env;
    else delete setting.env;
  }
  if (change.file !== undefined) {
    const file = change.file.trim().replace(/\\/g, '/');
    if (file && (file.startsWith('/') || /^[a-z]:/i.test(file) || file.split('/').includes('..'))) throw new Error('The settings file must be inside the repo, like .env or appsettings.Development.json.');
    if (file) setting.file = file;
    else delete setting.file;
  }
  if (change.key !== undefined) {
    const key = change.key.trim();
    if (key) setting.key = key;
    else delete setting.key;
  }
  if (!setting.env && !(setting.file && setting.key)) throw new Error('Name the setting that points the app at the database: --env DATABASE_URL, or --file appsettings.Development.json --key ConnectionStrings:Default.');
  const address = change.address?.trim();
  const finalKind = (kind ?? before!.kind) as DbKind;
  if (address) {
    const said = kindOf(address);
    if (said && said !== finalKind) throw new Error(`That address is for ${said === 'sqlserver' ? 'SQL Server' : KIND_NAME[said]}, not ${KIND_NAME[finalKind]}.`);
  }
  const name = change.name?.trim() || (address ? readAddress(address).name : undefined) || (kind && kind !== before?.kind ? undefined : before?.name);
  const shared = address !== undefined ? (address && !hasPassword(address) ? address : undefined) : before?.address;
  const next: ProjectDatabase = {
    kind: finalKind,
    repo,
    ...(name ? { name } : {}),
    ...(before?.where && finalKind === before.kind ? { where: before.where } : {}),
    setting,
    ...(shared ? { address: shared } : {}),
    ...(before?.from ? { from: before.from } : {}),
    confirmed: { by, at: now() },
    ...(before?.hidePersonal ? { hidePersonal: true } : {}),
    ...(before?.sampleRows ? { sampleRows: before.sampleRows } : {}),
  };
  writeMeta(bp, { ...meta, database: next });
  if (address !== undefined) changeSecrets(bp, (d) => (d.address = address && hasPassword(address) ? address : undefined));
  return next;
}

/** The hiding switch and the sample size, for the whole team. They apply from the next template. */
export function setDatabaseOptions(bp: BoardPaths, o: { hidePersonal?: boolean; sampleRows?: number | null }): ProjectDatabase {
  const meta = readMeta(bp);
  const db = meta.database;
  if (!db) throw new Error("squad-kit has not found the project's database yet. Find it first: squad db find");
  const next: ProjectDatabase = { ...db };
  if (o.hidePersonal === true) next.hidePersonal = true;
  else if (o.hidePersonal === false) delete next.hidePersonal;
  if (o.sampleRows === null) delete next.sampleRows;
  else if (o.sampleRows !== undefined) {
    const n = Math.round(Number(o.sampleRows));
    if (!Number.isFinite(n) || n < 10 || n > 1_000_000) throw new Error('The sample size is a number of rows from 10 to 1,000,000, like 1000.');
    next.sampleRows = n;
  }
  writeMeta(bp, { ...meta, database: next });
  return next;
}

/* ── the template ────────────────────────────────────────── */

/** The template's own record, read from its folder: for engineers to see, with no address in it. */
export function templateInfo(bp: BoardPaths): TemplateInfo | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(templateFolder(bp), 'template.json'), 'utf8')) as TemplateInfo;
  } catch {
    return null;
  }
}

function currentTemplate(bp: BoardPaths, source: string): DbTemplate | null {
  try {
    return readTemplate(templateFolder(bp), source);
  } catch {
    return null;
  }
}

const making = new Map<string, Promise<TemplateInfo>>();

/**
 * Makes the template, or makes it again, with the database's own tools: they only read the person's database. An
 * engineer asks for it; nothing makes one by itself, as it reads the person's own data.
 */
export function makeDbTemplate(bp: BoardPaths, by: string): Promise<TemplateInfo> {
  const run = making.get(bp.squadDir);
  if (run) return run;
  const next = makeOnce(bp, by).finally(() => making.delete(bp.squadDir));
  making.set(bp.squadDir, next);
  return next;
}

/** What making a template needs, or a plain sentence on what is missing. */
export function templateReady(bp: BoardPaths): { db: ProjectDatabase; source: string; adapter: DbAdapter } {
  const db = readMeta(bp).database;
  if (!db) throw new Error("squad-kit has not found the project's database yet. Find it first: squad db find");
  if (!db.confirmed) throw new Error('An engineer confirms the database first: squad db confirm');
  const source = personsAddress(bp, db);
  if (!source) throw new Error("squad-kit needs the database's address to make the template. Give it with: squad db confirm --address …");
  // Nothing is made or read on another computer's server: the template is made only on this one.
  const place = placeOf(bp, db, source);
  if (!place.here) throw new Error(awayWords(place, 'template'));
  // No template for a copy the app would not use: it would only read the person's data for nothing.
  const ignored = storyCopyIgnored(path.join(bp.root, db.repo), db, source);
  if (ignored) throw new Error(ignored);
  const adapter = dbAdapter(db.kind);
  const missing = adapter.missingTools();
  if (missing.length) throw new Error(`Making a template of a ${KIND_NAME[db.kind]} database needs ${missing.join(' and ')} on this computer.`);
  return { db, source: place.address, adapter };
}

async function makeOnce(bp: BoardPaths, by: string): Promise<TemplateInfo> {
  const { db, source, adapter } = templateReady(bp);
  changeState(bp, (s) => (s.making = { since: now(), by }));
  try {
    const t = await adapter.makeTemplate(source, { folder: templateFolder(bp), hidePersonal: Boolean(db.hidePersonal), ...(db.sampleRows ? { sampleRows: db.sampleRows } : {}) });
    changeState(bp, (s) => delete s.failed);
    writeLog({ level: 'info', project: readMeta(bp).project, text: `Made the template of the ${KIND_NAME[db.kind]} database ${t.info.sourceName}: ${t.info.tables.length} tables, ${t.info.bytes} bytes` });
    return t.info;
  } catch (err) {
    const text = scrub(bp, (err as Error).message);
    changeState(bp, (s) => (s.failed = { at: now(), text }));
    throw new Error(text);
  } finally {
    changeState(bp, (s) => delete s.making);
  }
}

/** The same, beside everything else, for a button: what is missing is said at once, and how it went shows on Harness. */
export function makeTemplateBeside(bp: BoardPaths, by: string): void {
  templateReady(bp);
  void makeDbTemplate(bp, by).catch((err: unknown) => noteForEngineers(bp, `The template of the database was not made: ${(err as Error).message}`));
}

/* ── a story's own database ──────────────────────────────── */

export type StoryDbResult =
  /** The copy points at the story's own database. `made` when it was made just now. */
  | { state: 'own'; name: string; made: boolean }
  /** The story uses the database as before; engineers were told why. `say`: what the story itself says, for everyone. */
  | { state: 'as-before'; why: string; say?: string }
  /** The project has no database squad-kit knows, or this copy's repo does not read it. */
  | { state: 'none' };

/** How the copy's own settings file is written, or null when it is not a form squad-kit writes. */
function formOf(file: string): SettingForm | null {
  const base = path.posix.basename(file);
  if (/^\.env(?:\.|$)/.test(base) || base.endsWith('.env')) return 'env';
  if (base.endsWith('.properties')) return 'properties';
  if (base.endsWith('.json')) return 'json';
  return null;
}

/** The copy's settings file to write the address into: only one git leaves out, so the address never goes in a commit. */
function copyFile(dir: string, setting: DatabaseSetting): CopyWiring['file'] | undefined {
  if (!setting.file) return undefined;
  const form = formOf(setting.file);
  const key = form === 'env' ? (setting.key ?? setting.env) : setting.key;
  if (!form || !key) return undefined;
  if (!git(dir, ['check-ignore', '--', setting.file], { allowFail: true })) return undefined;
  return { path: setting.file, key, form };
}

/**
 * Points the copy at an address: in every command's environment, and in its own settings file when git leaves that out.
 * The environment has the address squad-kit reaches from this computer; the file keeps the form the person wrote, with a
 * compose service's name, for an app that runs in Compose.
 */
function wire(dir: string, db: ProjectDatabase, address: string, written = address): void {
  const file = copyFile(dir, db.setting);
  wireCopy(dir, { env: db.setting.env ? { [db.setting.env]: address } : {}, value: written, ...(file ? { file } : {}) });
}

/** A story's address as the person wrote theirs: with the compose service's name, when squad-kit reaches it through a port here. */
function asWritten(adapter: DbAdapter, source: string, here: string, address: string, story: string): string {
  if (source === here) return address;
  try {
    return adapter.storyAddress(source, { id: story });
  } catch {
    return address;
  }
}

const SQLITE_BESIDE = ['', '-wal', '-shm', '-journal'];

/**
 * A story's own SQLite file, and the files SQLite keeps beside it, never go in the story's commit: it holds the person's
 * data. Nor does any step take it for the story's work.
 */
function keepOutOfCommits(dir: string, db: ProjectDatabase, address: string): void {
  if (db.kind !== 'sqlite') return;
  const file = readAddress(address).name;
  if (file) markDbMade(dir, SQLITE_BESIDE.map((end) => `${path.resolve(dir, file)}${end}`));
}

/** The person's own database is a server on this computer (not a SQLite file, which each copy has its own of). */
function ownServerHere(bp: BoardPaths): boolean {
  try {
    const db = readMeta(bp).database;
    const own = db && db.kind !== 'sqlite' ? personsAddress(bp, db) : undefined;
    return !!(db && own && placeOf(bp, db, own).here);
  } catch {
    return false;
  }
}

function asBefore(bp: BoardPaths, story: string, why: string, say?: string, away = false): StoryDbResult {
  // On a server on this computer, "as before" is the person's own data: engineers read that plainly.
  if (!away && ownServerHere(bp)) why = `${why} That is your own database on this computer: the story's app and tests can change its data.`;
  noteForEngineers(bp, why, story);
  return { state: 'as-before', why: scrub(bp, why), ...(say ? { say: scrub(bp, say) } : {}) };
}

/** True when a story's address is, or could be, the person's own database. Refused whatever the adapter says. */
function personsOwn(adapter: DbAdapter, address: string, source: string, dir: string, kind: DbKind): boolean {
  if (address.trim() === source.trim()) return true;
  try {
    if (adapter.isPersonsOwn(address, source)) return true;
  } catch {
    return true;
  }
  // A SQLite story database is a file in the story's copy, never anywhere else.
  if (kind === 'sqlite') {
    const file = adapter.nameOf(address);
    return !path.resolve(file).startsWith(`${path.resolve(dir)}${path.sep}`);
  }
  return false;
}

/** A SQLite file's address with its path changed, in the same form. */
function sqliteAt(address: string, from: string, to: string): string {
  return address.includes(from) ? address.split(from).join(to) : to;
}

/**
 * Gives a story's copy its own database, when its copy is set up and each time it is used again. Made from the template
 * on the same server, with the story's name in it; one made before for this story is used again. Without a template,
 * or when the database cannot be reached, the story goes on as before and engineers get one note. A SQLite file is
 * per copy already: it stays so, from the template's file when there is one. A database on another computer gets no
 * copy, and the story says so. The copy also gets its own Redis database number (story-redis.ts).
 */
export async function setUpStoryDb(bp: BoardPaths, story: string, dir: string, repo: string): Promise<StoryDbResult> {
  try {
    setUpStoryRedis(bp, story, dir, repo);
  } catch (err) {
    writeLog({ level: 'warn', ticket: story, text: scrub(bp, `The story's own Redis number was not set up: ${(err as Error).message}`) });
  }
  const r = await ownDatabase(bp, story, dir, repo);
  if (r.state === 'own' || (r.state === 'as-before' && r.say)) return r;
  return fellBack(bp, story, dir, repo) ?? r;
}

/**
 * A copy with no database of its own that misses a settings file the person has (an untracked .env.dev or
 * appsettings.Development.json no one gave stories): its app reads the project's own settings file instead. When that
 * one's database is on another computer, the story says so plainly, rather than using it in silence.
 */
function fellBack(bp: BoardPaths, story: string, dir: string, repo: string): StoryDbResult | null {
  const db = readMeta(bp).database;
  if (!db || db.repo !== repo || db.kind === 'sqlite') return null;
  // The part's env file too (env-file.ts): without it, the app reads its settings file.
  const missing = [db.setting.file, ...(db.from ?? []), ...repoEnvFiles(readMeta(bp), repo)].find((f): f is string => Boolean(f) && fs.existsSync(path.join(bp.root, repo, f!)) && !fs.existsSync(path.join(dir, f!)));
  const got = missing ? settingsFileAddress(dir, db.setting) : undefined;
  if (!missing || !got) return null;
  const place = placeOf(bp, db, got.value);
  if (place.here) return null;
  const say = `This story's copy has no ${missing}, so its app falls back to the database in ${got.file}, which is on another computer (${place.host}). An engineer can add ${missing} as a local file in Settings, with values for stories.`;
  return asBefore(bp, story, say, say, true);
}

async function ownDatabase(bp: BoardPaths, story: string, dir: string, repo: string): Promise<StoryDbResult> {
  const db = readMeta(bp).database;
  if (!db || db.repo !== repo) return { state: 'none' };
  // A SQLite file is in each copy already: nothing to tell anyone until an engineer confirms it.
  if (!db.confirmed && db.kind === 'sqlite') return { state: 'none' };
  if (!db.confirmed) return asBefore(bp, story, `squad-kit found the project's database, and no engineer has confirmed it yet, so ${story} uses it as before. Confirm it on Harness, under Safety, or with: squad db confirm`);
  if (!db.setting.env && !(db.setting.file && db.setting.key)) return asBefore(bp, story, `squad-kit does not know which setting points the app at the database, so ${story} uses it as before. Name it with: squad db confirm --env DATABASE_URL`);
  const written = personsAddress(bp, db);
  if (!written) return asBefore(bp, story, `squad-kit does not know the database's address, so ${story} uses it as before. Give it with: squad db confirm --address …`);
  // How squad-kit reaches it from this computer: a compose service through the port it publishes here.
  const place = placeOf(bp, db, written);
  const source = place.here ? place.address : written;
  let adapter: DbAdapter;
  try {
    adapter = dbAdapter(db.kind);
  } catch (err) {
    return asBefore(bp, story, `${story} uses the database as before: ${(err as Error).message}`);
  }
  const ref = { id: story, folder: dir };
  const had = readState(bp).stories.find((s) => s.story === story);
  const kept = dbSecrets(bp).stories?.[story];
  // Made before for this story: the copy points at it again. A SQLite file lives in its copy, so a new copy needs a new one.
  if (had && kept && (db.kind !== 'sqlite' || path.resolve(had.dir) === path.resolve(dir))) {
    if (personsOwn(adapter, kept, source, dir, db.kind)) return asBefore(bp, story, `squad-kit refused to point ${story} at your own database, so the story uses it as before.`);
    if (path.resolve(had.dir) !== path.resolve(dir)) {
      unwireCopy(had.dir);
      changeState(bp, (s) => (s.stories = s.stories.map((x) => (x.story === story ? { ...x, dir } : x))));
    }
    wire(dir, db, kept, asWritten(adapter, written, source, kept, story));
    keepOutOfCommits(dir, db, kept);
    return { state: 'own', name: had.name, made: false };
  }
  // Nothing is made on another computer's server.
  if (!place.here) return asBefore(bp, story, awayWords(place).replace('this story', story), awayWords(place));
  // A copy under another name the app would not use: the story would write to the person's database all the same.
  const ignored = storyCopyIgnored(dir, db, source);
  if (ignored) return asBefore(bp, story, `${story} uses the database as before. ${ignored}`);
  const template = currentTemplate(bp, source);
  if (!template) {
    if (db.kind !== 'sqlite') return asBefore(bp, story, `There is no template of the database yet, so ${story} uses it as before. An engineer makes one on Harness, under Safety, or with: squad db template`);
    // No template: the copy keeps its own file, made by its setup. A full path into the person's folder moves into the copy.
    const raw = keptAddress(bp, db)!;
    const file = readAddress(raw).name;
    const own = file && path.isAbsolute(file) ? path.relative(path.join(bp.root, repo), file) : '';
    if (own && !own.startsWith('..')) wire(dir, db, sqliteAt(raw, file!, path.join(dir, own)));
    return { state: 'none' };
  }
  let made;
  try {
    made = await adapter.createStoryDb(template, ref);
  } catch (err) {
    const words = err instanceof DbError && err.reason === 'persons-own' ? `squad-kit refused to point ${story} at your own database, so the story uses it as before.` : `${story} uses the database as before: ${(err as Error).message}`;
    return asBefore(bp, story, words);
  }
  if (personsOwn(adapter, made.address, source, dir, db.kind)) return asBefore(bp, story, `squad-kit refused to point ${story} at your own database, so the story uses it as before.`);
  changeSecrets(bp, (d) => (d.stories = { ...d.stories, [story]: made.address }));
  changeState(bp, (s) => (s.stories = [...s.stories.filter((x) => x.story !== story), { story, repo, dir, kind: db.kind, name: made.name, at: now() }]));
  wire(dir, db, made.address, asWritten(adapter, written, source, made.address, story));
  keepOutOfCommits(dir, db, made.address);
  return { state: 'own', name: made.name, made: !made.existed };
}

/** After a restart: the copies of the stories with a database of their own point at it again, before any step runs. */
export function rewireStoryDbs(bp: BoardPaths): void {
  let db: ProjectDatabase | undefined;
  try {
    db = readMeta(bp).database;
  } catch {
    return;
  }
  for (const r of storyRedisNumbers(bp)) if (fs.existsSync(r.dir)) rewireStoryRedis(bp, r.story, r.dir, r.repo);
  if (!db) return;
  for (const r of readState(bp).stories) if (fs.existsSync(r.dir)) rewireStoryDb(bp, r.story, r.dir, r.repo);
}

/**
 * A copy used again, by a later step: when its story has a database of its own, the copy points at it again. Nothing new
 * is made: a story that started with the database as before keeps it so, and never changes database half-way.
 */
export function rewireStoryDb(bp: BoardPaths, story: string, dir: string, repo: string): boolean {
  let db: ProjectDatabase | undefined;
  try {
    rewireStoryRedis(bp, story, dir, repo);
    db = readMeta(bp).database;
  } catch {
    return false;
  }
  const had = readState(bp).stories.find((s) => s.story === story && s.repo === repo);
  const kept = dbSecrets(bp).stories?.[story];
  if (!db || !had || !kept || path.resolve(had.dir) !== path.resolve(dir)) return false;
  const written = personsAddress(bp, db);
  if (!written) return false;
  let adapter: DbAdapter;
  let source: string;
  try {
    adapter = dbAdapter(db.kind);
    const place = placeOf(bp, db, written);
    source = place.here ? place.address : written;
    if (personsOwn(adapter, kept, source, dir, db.kind)) return false;
  } catch {
    return false;
  }
  wire(dir, db, kept, asWritten(adapter, written, source, kept, story));
  keepOutOfCommits(dir, db, kept);
  return true;
}

/**
 * A story's own database that its copy's setup cannot bring up to date (the newest code renamed a change it already
 * has): dropped and made again from the template, for the setup to run on once more. Only one squad-kit made for this
 * story and this copy. True when it was made again.
 */
export async function remakeStoryDb(bp: BoardPaths, story: string, dir: string, repo: string): Promise<boolean> {
  const had = readState(bp).stories.find((s) => s.story === story && s.repo === repo && path.resolve(s.dir) === path.resolve(dir));
  if (!had || !(await dropDatabase(bp, story))) return false;
  return (await setUpStoryDb(bp, story, dir, repo)).state === 'own';
}

/**
 * The same for a SQLite file a copy keeps itself, with no template: set aside with the files SQLite keeps beside it, so
 * the setup makes it again. Only a file inside the copy that git does not keep, never one anywhere else; what is set
 * aside stays out of commits. The files set aside.
 */
export function setAsideCopyDb(dir: string): string[] {
  const found = findDatabase(dir, ['.']).found;
  const name = found?.kind === 'sqlite' && found.address ? readAddress(found.address).name : undefined;
  if (!name) return [];
  // Prisma reads a file named relative to its schema; most others from the folder the app runs in.
  const schemas = git(dir, ['ls-files', '--', '*schema.prisma'], { allowFail: true }).split('\n').filter(Boolean);
  const files = path.isAbsolute(name) ? [name] : [dir, ...schemas.map((s) => path.dirname(path.join(dir, s)))].map((b) => path.resolve(b, name));
  const inside = `${path.resolve(dir)}${path.sep}`;
  const moved: string[] = [];
  for (const file of new Set(files)) {
    if (!file.startsWith(inside) || !fs.existsSync(file) || git(dir, ['ls-files', '--', path.relative(dir, file)], { allowFail: true })) continue;
    for (const end of SQLITE_BESIDE) {
      if (!fs.existsSync(`${file}${end}`)) continue;
      fs.renameSync(`${file}${end}`, `${file}.out-of-step${end}`);
      moved.push(`${file}.out-of-step${end}`);
    }
  }
  if (moved.length) markDbMade(dir, moved);
  return moved;
}

/** The story databases this computer has now. */
export function storyDbs(bp: BoardPaths): StoryDbRecord[] {
  return readState(bp).stories;
}

/**
 * Drops a story's own database, when it is merged, released or deleted. Only one squad-kit made for a story, and never
 * the person's own: the adapter refuses both. One the server cannot drop now stays on the list for the next tidy-up.
 * Nothing is dropped on another computer. The story's own Redis number is cleared with it (story-redis.ts).
 */
export async function dropStoryDb(bp: BoardPaths, story: string): Promise<boolean> {
  // Its own Redis number goes with it: that number's keys only.
  const redis = await dropStoryRedis(bp, story).catch(() => false);
  return (await dropDatabase(bp, story)) || redis;
}

/** The story's own database alone. */
async function dropDatabase(bp: BoardPaths, story: string): Promise<boolean> {
  const had = readState(bp).stories.find((s) => s.story === story);
  if (!had) return false;
  const address = dbSecrets(bp).stories?.[story];
  const forget = () => {
    const file = had.kind === 'sqlite' && address ? readAddress(address).name : undefined;
    if (file) forgetDbMade(path.join(bp.root, had.repo), SQLITE_BESIDE.map((end) => path.relative(had.dir, path.resolve(had.dir, file)) + end));
    changeState(bp, (s) => (s.stories = s.stories.filter((x) => x.story !== story)));
    changeSecrets(bp, (d) => {
      if (d.stories) delete d.stories[story];
    });
    unwireCopy(had.dir);
  };
  const db = readMeta(bp).database;
  const source = personsAddress(bp, db);
  if (!address) {
    forget();
    return false;
  }
  if (!source) {
    noteForEngineers(bp, `squad-kit could not drop ${had.name}, ${story}'s own database: it does not know your database's address any more, to make sure it is not yours. Drop it yourself when you no longer need it.`, story);
    return false;
  }
  // Nothing is dropped on another computer's server.
  const away = placeOf(bp, had, address);
  if (!away.here) {
    forget();
    noteForEngineers(bp, `squad-kit left ${had.name} alone: it is on another computer (${away.host}), and squad-kit drops a story's database only on this one. Drop it yourself when you no longer need it.`, story);
    return false;
  }
  try {
    const gone = await dbAdapter(had.kind).dropStoryDb(address, source);
    forget();
    if (gone) writeLog({ level: 'info', project: readMeta(bp).project, ticket: story, text: `Dropped ${had.name}, the story's own database` });
    return gone;
  } catch (err) {
    // Not one squad-kit made, or the person's own: it is left alone, for good.
    if (err instanceof DbError && (err.reason === 'not-ours' || err.reason === 'persons-own' || err.reason === 'bad-address')) {
      forget();
      noteForEngineers(bp, `squad-kit left ${had.name} alone: ${(err as Error).message}`, story);
      return false;
    }
    noteForEngineers(bp, `squad-kit could not drop ${had.name}, ${story}'s own database, yet. It tries again later: ${(err as Error).message}`, story);
    return false;
  }
}

/**
 * True when a story no longer needs its own database: it is merged, released, archived or gone. The Squad lead's own
 * copy is no story: its database stays for its next look at the app (engine/lead/own-app.ts).
 */
function doneWith(bp: BoardPaths, story: string): boolean {
  if (story === 'lead') return false;
  let t;
  try {
    t = readTicket(bp, story);
  } catch {
    return false;
  }
  return !t || Boolean(t.mergedAt) || t.stage === 'done' || Boolean(t.archived);
}

/** The leftovers: the databases of stories that are merged, released, archived or deleted go. The ids whose went. */
export async function tidyStoryDbs(bp: BoardPaths): Promise<string[]> {
  const out: string[] = [];
  const ids = new Set([...readState(bp).stories.map((r) => r.story), ...storyRedisNumbers(bp).map((r) => r.story)]);
  for (const id of ids) if (doneWith(bp, id) && (await dropStoryDb(bp, id))) out.push(id);
  return out;
}

const TIDY_MS = 2 * 60_000;
const tidies = new Map<string, { at: number; busy: boolean }>();

/** The tidy-up, beside everything else: every 2 minutes from the squad's turn, and at once after a merge. */
export function tidyStoryDbsBeside(bp: BoardPaths, at = Date.now(), soon = false): void {
  const t = tidies.get(bp.squadDir) ?? { at: 0, busy: false };
  tidies.set(bp.squadDir, t);
  if (t.busy || (!soon && at < t.at)) return;
  if (!readState(bp).stories.length && !storyRedisNumbers(bp).length) {
    t.at = at + TIDY_MS;
    return;
  }
  t.busy = true;
  const go = () =>
    void tidyStoryDbs(bp)
      .catch(() => undefined)
      .finally(() => {
        t.busy = false;
        t.at = Date.now() + TIDY_MS;
      });
  // After a merge, once the merge is written down: the code that merged it writes it right after this.
  if (soon) setTimeout(go, 0).unref();
  else go();
}

/* ── what engineers see ──────────────────────────────────── */

export interface DatabaseView {
  /** The database as learned, with any password shown as ***. */
  database: (Omit<ProjectDatabase, 'address'> & { address?: string; secret: boolean; kindName: string }) | null;
  template: (Omit<TemplateInfo, 'source'> & { source: string }) | null;
  making?: { since: string; by: string };
  failed?: { at: string; text: string };
  /** Why the app would not use a story's own copy, for engineers: stories then use the database as before. */
  blocked?: string;
  /** The app's Redis, and each story's own number on it: read only. */
  redis?: RedisView;
  stories: (StoryDbRecord & { title?: string })[];
  notes: DbNote[];
  /** Tools the database's kind needs that this computer does not have. */
  missing: string[];
  /** One plain sentence for everyone. */
  words: string;
}

export function databaseView(bp: BoardPaths): DatabaseView {
  const db = readMeta(bp).database;
  const s = readState(bp);
  const address = personsAddress(bp, db);
  const info = templateInfo(bp);
  let missing: string[] = [];
  try {
    if (db) missing = dbAdapter(db.kind).missingTools();
  } catch {
    missing = [];
  }
  const live = s.stories.map((r) => ({ ...r, ...(readTicket(bp, r.story)?.title ? { title: readTicket(bp, r.story)!.title } : {}) }));
  const place = db && address ? placeOf(bp, db, address) : undefined;
  const away = place && !place.here ? place : undefined;
  const blocked = away ? awayWords(away, 'stories') : db ? storyCopyIgnored(path.join(bp.root, db.repo), db, address) : undefined;
  const ready = Boolean(db?.confirmed && info && !blocked);
  let redis: RedisView | null = null;
  try {
    redis = redisView(bp, reposOf(readMeta(bp)).map((r) => r.path));
  } catch {
    redis = null;
  }
  return {
    database: db ? { ...db, ...(address ? { address: withoutPassword(address) } : {}), secret: Boolean(dbSecrets(bp).address), kindName: KIND_NAME[db.kind] } : null,
    template: info ? { ...info, source: withoutPassword(info.source) } : null,
    ...(s.making ? { making: s.making } : {}),
    ...(s.failed ? { failed: s.failed } : {}),
    ...(blocked ? { blocked: scrub(bp, blocked) } : {}),
    ...(redis ? { redis } : {}),
    stories: live,
    notes: [...s.notes].reverse().slice(0, 10),
    missing,
    words: ready
      ? 'Each story gets its own copy of the database, made from a small template. Your own database is never changed.'
      : away
        ? "Stories use the database as before. It is on another computer, and squad-kit makes each story's own copy only on this one."
        : blocked
          ? 'Stories use the database as before. The app chooses its database itself, so squad-kit cannot give each story a copy.'
          : db
            ? 'Stories use the database as before, until an engineer sets up a copy for each story.'
            : 'squad-kit has not found a database in this project.',
  };
}
