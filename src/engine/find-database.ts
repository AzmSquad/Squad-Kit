import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { DatabaseSetting } from '../board/types.js';
import type { DbKind } from './db/types.js';
import { git } from './git.js';

/**
 * Learning a project's database from its own files, with no AI: which kind it is (a SQLite file, Postgres, MySQL,
 * Mongo), where it runs, its name, and the setting that points the app at it. squad-kit reads what the project already
 * says: Prisma's schema.prisma, a Mongo or Postgres address in .env.example, a compose file's database service,
 * appsettings.Development.json's connection strings, Spring's application.properties, and the packages the code uses.
 * A quick look with firm limits: a big project costs it no more than a small one.
 */

export type FoundKind = DbKind | 'sqlserver';

export interface FoundDatabase {
  kind: DbKind;
  /** The repo it is in, as in RepoInfo.path. */
  repo: string;
  name?: string;
  where?: string;
  setting: DatabaseSetting;
  /** The address the person's own copy uses, as found. It may hold a password: never shown, never shared. */
  address?: string;
  /** The files it was learned from, inside the repo. */
  from: string[];
}

export interface DatabaseLook {
  found: FoundDatabase | null;
  /** A database squad-kit cannot copy yet, in plain words. */
  later?: string;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '.squad', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.output', '.turbo', '.cache', 'coverage', '.venv', 'venv', '__pycache__', 'target', 'vendor', 'Pods', '.gradle', '.idea', '.vscode', 'bin', 'obj', 'wwwroot']);
const LIMITS = { depth: 6, entries: 8000, fileBytes: 256 * 1024, code: 600 };

const COMPOSE = /^(?:docker-)?compose(?:[.-][\w.-]+)?\.ya?ml$/i;
const ENV_FILE = /^\.env(?:\.[\w.-]+)?$/;
const EXAMPLE = /(?:^|\.)(?:example|sample|template|dist|defaults|tpl)$/i;
/** An env file for another place than this computer: `.env.prod`, `.env.beta`. The app here reads the others first. */
const OTHER_PLACE = /\.env\.(?:[\w-]+\.)*(?:prod|production|beta|staging|stage|uat|qa|preprod|live|release)(?:\.[\w.-]+)?$/i;
const APPSETTINGS = /^appsettings(?:\.[\w-]+)?\.json$/i;
const SPRING = /^application(?:-[\w-]+)?\.(?:properties|ya?ml)$/;
const CODE = /\.(?:m?[jt]sx?|c[jt]s|py|cs)$/i;

/** Names of settings that hold a database's address: DATABASE_URL, MONGO_URL, MONGODB_URI, APP_DB_DSN and the like. */
const DB_ENV = /^(?:[A-Z0-9]+_)*(?:DATABASE|DB|MONGO|MONGODB|POSTGRES|POSTGRESQL|PG|MYSQL|MARIADB|SQLITE)(?:_[A-Z0-9]+)*_(?:URL|URI|DSN|CONNECTION|CONNECTION_STRING|CONN|CONN_STRING|PATH|FILE)$/;
/** Ones for something beside the app's own database: Prisma's shadow database, a test database. */
const NOT_THE_APPS = /(?:^|_)(?:SHADOW|TEST|TESTS|TESTING|CI|E2E|READ|REPLICA|DIRECT)(?:_|$)/;

const SCHEMES: Record<string, FoundKind> = {
  postgres: 'postgres',
  postgresql: 'postgres',
  postgis: 'postgres',
  mysql: 'mysql',
  mysql2: 'mysql',
  mysqlx: 'mysql',
  mariadb: 'mysql',
  mongodb: 'mongo',
  'mongodb+srv': 'mongo',
  sqlite: 'sqlite',
  sqlite3: 'sqlite',
  file: 'sqlite',
  sqlserver: 'sqlserver',
  mssql: 'sqlserver',
};

const unquote = (s: string): string => s.trim().replace(/^(['"`])(.*)\1$/s, '$2').trim();

/** The key=value pairs of a connection string like `Host=localhost;Database=clinic`, by lower-case key, or null. */
function pairsOf(address: string): Map<string, string> | null {
  if (!/^[\w\s]+=/.test(address) || /^[a-z][\w+.-]*:\/\//i.test(address)) return null;
  const out = new Map<string, string>();
  for (const part of address.split(';')) {
    const at = part.indexOf('=');
    if (at > 0) out.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim());
  }
  return out.size ? out : null;
}

const SQLITE_FILE = /\.(?:db|sqlite3?|db3)$/i;

/** The kind of database from the address's form alone, or null when the form does not say. */
export function kindOf(address: string): FoundKind | null {
  const a = unquote(address);
  const scheme = /^(?:jdbc:)?([a-z][a-z0-9+.-]*):/i.exec(a)?.[1]?.toLowerCase();
  if (scheme && SCHEMES[scheme]) return SCHEMES[scheme]!;
  const pairs = pairsOf(a);
  if (pairs) {
    const has = (...keys: string[]) => keys.some((k) => pairs.has(k));
    if (SQLITE_FILE.test(pairs.get('data source') ?? pairs.get('filename') ?? '')) return 'sqlite';
    if (has('trusted_connection', 'integrated security', 'initial catalog', 'encrypt', 'trustservercertificate', 'multipleactiveresultsets')) return 'sqlserver';
    if (has('host') && has('database', 'username')) return 'postgres';
    if (has('uid', 'pwd') || pairs.get('port') === '3306') return 'mysql';
    return null;
  }
  if (SQLITE_FILE.test(a) && !/\s/.test(a)) return 'sqlite';
  return null;
}

/** What an address says: the database's name, its host and port, and whether it holds a password. */
export function readAddress(address: string): { name?: string; host?: string; port?: string; password: boolean } {
  const a = unquote(address).replace(/^jdbc:/i, '');
  const file = /^(?:file|sqlite3?):(?:\/\/)?(.+)$/i.exec(a);
  if (file) return { name: file[1]!.split('?')[0], password: false };
  const link = /^[a-z][\w+.-]*:\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^/?#]*)(?:\/([^?#]*))?/i.exec(a);
  if (link) {
    const hosts = link[3] ?? '';
    const first = hosts.split(',')[0] ?? '';
    const [host, port] = first.startsWith('[') ? [first.slice(0, first.indexOf(']') + 1), first.slice(first.indexOf(']') + 2)] : first.split(':');
    const name = decodeURIComponent((link[4] ?? '').split('/')[0] ?? '');
    return { ...(name ? { name } : {}), ...(host ? { host } : {}), ...(port ? { port } : {}), password: Boolean(link[2]) };
  }
  const pairs = pairsOf(a);
  if (pairs) {
    const name = pairs.get('database') ?? pairs.get('initial catalog') ?? pairs.get('dbname') ?? (SQLITE_FILE.test(pairs.get('data source') ?? '') ? pairs.get('data source') : undefined) ?? pairs.get('filename');
    const server = pairs.get('host') ?? pairs.get('server') ?? pairs.get('address') ?? pairs.get('addr');
    const [host, port] = (server ?? '').replace(/^tcp:/i, '').split(/[:,]/);
    return { ...(name ? { name } : {}), ...(host ? { host } : {}), ...((pairs.get('port') ?? port) ? { port: pairs.get('port') ?? port } : {}), password: Boolean(pairs.get('password') ?? pairs.get('pwd')) };
  }
  return SQLITE_FILE.test(a) ? { name: a, password: false } : { password: false };
}

/** The address with any password in it replaced by ***, to show to an engineer. */
export function withoutPassword(address: string): string {
  return address
    .replace(/^((?:jdbc:)?[a-z][\w+.-]*:\/\/[^:@/]*:)([^@/]*)@/i, (_m, head: string, pass: string) => (pass ? `${head}***@` : `${head}@`))
    .replace(/((?:^|;)\s*(?:password|pwd)\s*=)([^;]*)/gi, '$1***');
}

/** True when the address holds a password: it then stays in this computer's secrets, never in the shared settings. */
export function hasPassword(address: string): boolean {
  return readAddress(address).password;
}

/* ── the project's files ─────────────────────────────────── */

interface Files {
  prisma: string[];
  compose: string[];
  env: string[];
  appsettings: string[];
  spring: string[];
  csproj: string[];
  packages: string[];
  code: string[];
}

/** The files worth reading, by kind, found with firm limits. Paths are inside the repo, with forward slashes. */
function filesOf(dir: string): Files {
  const out: Files = { prisma: [], compose: [], env: [], appsettings: [], spring: [], csproj: [], packages: [], code: [] };
  let entries = 0;
  const visit = (rel: string, depth: number) => {
    if (depth > LIMITS.depth || entries >= LIMITS.entries) return;
    let list: fs.Dirent[];
    try {
      list = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    if (list.some((e) => e.name === 'pyvenv.cfg')) return;
    for (const e of list) {
      if (++entries >= LIMITS.entries) return;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) visit(p, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (e.name.endsWith('.prisma')) out.prisma.push(p);
      else if (COMPOSE.test(e.name)) out.compose.push(p);
      else if (ENV_FILE.test(e.name) && depth <= 3) out.env.push(p);
      else if (APPSETTINGS.test(e.name)) out.appsettings.push(p);
      else if (SPRING.test(e.name) && (rel.endsWith('resources') || rel === 'config' || rel === '')) out.spring.push(p);
      else if (e.name.endsWith('.csproj')) out.csproj.push(p);
      else if (e.name === 'package.json' && depth <= 3) out.packages.push(p);
      else if (CODE.test(e.name) && out.code.length < LIMITS.code) out.code.push(p);
    }
  };
  visit('', 0);
  return out;
}

function read(file: string): string {
  try {
    return fs.statSync(file).size > LIMITS.fileBytes ? '' : fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** A value with a setting of its own inside, like ${DB_PASSWORD}: the address is not all here. */
const PLACEHOLDER = /\$\{[^}]*\}|\$[A-Z_][A-Z0-9_]*/;

/** KEY=value lines of an env file, quotes taken off. */
function envPairs(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2]!;
    if (!/^['"]/.test(value)) value = value.replace(/\s+#.*$/, '');
    out.set(m[1]!, unquote(value));
  }
  return out;
}

/** The environment's value, or the default in `${NAME:-default}`, or undefined when it is only a name. */
function composeValue(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v);
  const m = /^\$\{[A-Za-z_]\w*:?-([^}]*)\}$/.exec(s);
  if (m) return m[1];
  return PLACEHOLDER.test(s) ? undefined : s;
}

function composeEnv(env: unknown): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  if (Array.isArray(env)) {
    for (const item of env) {
      const s = String(item);
      const at = s.indexOf('=');
      if (at > 0) out.set(s.slice(0, at), composeValue(s.slice(at + 1)));
    }
  } else if (env && typeof env === 'object') {
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) out.set(k, composeValue(v));
  }
  return out;
}

const IMAGE_KIND: [RegExp, FoundKind][] = [
  [/(?:^|\/)(?:postgres|postgresql|postgis|timescaledb[\w-]*)(?::|$)/i, 'postgres'],
  [/(?:^|\/)(?:mysql|mariadb|percona)(?::|$)/i, 'mysql'],
  [/(?:^|\/)(?:mongo|mongodb(?:-community-server)?)(?::|$)/i, 'mongo'],
  [/mssql|sql-?server|azure-sql-edge/i, 'sqlserver'],
];
const KIND_PORT: Record<FoundKind, number> = { postgres: 5432, mysql: 3306, mongo: 27017, sqlite: 0, sqlserver: 1433 };

interface ComposeDb {
  file: string;
  service: string;
  kind: FoundKind;
  name?: string;
  port?: string;
  /** The address from this computer, through the published port. */
  address?: string;
}

/** The port a service publishes on this computer for the container port, from "5433:5432", "127.0.0.1:5433:5432" or the long form. */
function published(ports: unknown, target: number): string | undefined {
  for (const p of Array.isArray(ports) ? ports : []) {
    if (p && typeof p === 'object') {
      const o = p as { target?: unknown; published?: unknown };
      if (Number(o.target) === target && o.published !== undefined) return String(o.published);
      continue;
    }
    const parts = String(p).split('/')[0]!.split(':');
    const inside = Number(parts.at(-1));
    if (inside === target) return parts.length >= 2 ? parts.at(-2) : String(inside);
  }
  return undefined;
}

function composeDbs(dir: string, files: string[]): { dbs: ComposeDb[]; settings: { file: string; env: string; value?: string }[] } {
  const dbs: ComposeDb[] = [];
  const settings: { file: string; env: string; value?: string }[] = [];
  for (const file of files) {
    let doc: unknown;
    try {
      doc = yaml.load(read(path.join(dir, file)));
    } catch {
      continue;
    }
    const services = (doc as { services?: Record<string, unknown> } | undefined)?.services;
    if (!services || typeof services !== 'object') continue;
    for (const [service, raw] of Object.entries(services)) {
      const s = (raw ?? {}) as { image?: unknown; environment?: unknown; ports?: unknown };
      const env = composeEnv(s.environment);
      const kind = IMAGE_KIND.find(([re]) => re.test(String(s.image ?? '')))?.[1];
      if (!kind) {
        for (const [k, v] of env) if (DB_ENV.test(k) && !NOT_THE_APPS.test(k)) settings.push({ file, env: k, ...(v ? { value: v } : {}) });
        continue;
      }
      const port = published(s.ports, KIND_PORT[kind]);
      const get = (...keys: string[]) => keys.map((k) => env.get(k)).find((v) => v);
      const at = `localhost:${port ?? KIND_PORT[kind]}`;
      const userPass = (user?: string, pass?: string) => (user ? `${encodeURIComponent(user)}${pass ? `:${encodeURIComponent(pass)}` : ''}@` : '');
      let name: string | undefined;
      let address: string | undefined;
      if (kind === 'postgres') {
        const user = get('POSTGRES_USER') ?? 'postgres';
        name = get('POSTGRES_DB') ?? user;
        address = `postgres://${userPass(user, get('POSTGRES_PASSWORD'))}${at}/${name}`;
      } else if (kind === 'mysql') {
        const user = get('MYSQL_USER', 'MARIADB_USER') ?? 'root';
        const pass = user === 'root' ? get('MYSQL_ROOT_PASSWORD', 'MARIADB_ROOT_PASSWORD') : get('MYSQL_PASSWORD', 'MARIADB_PASSWORD');
        name = get('MYSQL_DATABASE', 'MARIADB_DATABASE');
        if (name) address = `mysql://${userPass(user, pass)}${at}/${name}`;
      } else if (kind === 'mongo') {
        name = get('MONGO_INITDB_DATABASE');
        const user = get('MONGO_INITDB_ROOT_USERNAME');
        if (name) address = `mongodb://${userPass(user, get('MONGO_INITDB_ROOT_PASSWORD'))}${at}/${name}${user ? '?authSource=admin' : ''}`;
      }
      dbs.push({ file, service, kind, ...(name ? { name } : {}), ...(port ? { port } : {}), ...(address ? { address } : {}) });
    }
  }
  return { dbs, settings };
}

interface PrismaSource {
  file: string;
  kind?: FoundKind;
  env?: string;
  url?: string;
}

const PROVIDER: Record<string, FoundKind> = { postgresql: 'postgres', postgres: 'postgres', mysql: 'mysql', sqlite: 'sqlite', mongodb: 'mongo', sqlserver: 'sqlserver', cockroachdb: 'postgres' };

function prismaSources(dir: string, files: string[]): PrismaSource[] {
  const out: PrismaSource[] = [];
  for (const file of files) {
    const text = read(path.join(dir, file));
    const block = /datasource\s+\w+\s*\{([^}]*)\}/.exec(text)?.[1];
    if (!block) continue;
    const provider = /provider\s*=\s*"(\w+)"/.exec(block)?.[1];
    const env = /url\s*=\s*env\(\s*"([^"]+)"\s*\)/.exec(block)?.[1];
    const url = /url\s*=\s*"([^"]+)"/.exec(block)?.[1];
    out.push({ file, ...(provider && PROVIDER[provider] ? { kind: PROVIDER[provider] } : {}), ...(env ? { env } : {}), ...(url ? { url } : {}) });
  }
  return out;
}

/** JSON with the comments and trailing commas .NET allows in its settings files. */
function looseJson(text: string): unknown {
  const bare = text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str: string | undefined) => str ?? '').replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(bare);
}

interface SettingsKey {
  file: string;
  key: string;
  value: string;
  /** A name given beside the address, like a Mongo settings block's DatabaseName. */
  name?: string;
}

/** Keys in a .NET settings file that hold a database's address: ConnectionStrings first, then any other, two levels down. */
function appsettingsKeys(dir: string, file: string): SettingsKey[] {
  let doc: unknown;
  try {
    doc = looseJson(read(path.join(dir, file)));
  } catch {
    return [];
  }
  const out: SettingsKey[] = [];
  const strings = (doc as { ConnectionStrings?: Record<string, unknown> })?.ConnectionStrings;
  if (strings && typeof strings === 'object') {
    for (const [k, v] of Object.entries(strings)) if (typeof v === 'string' && v.trim()) out.push({ file, key: `ConnectionStrings:${k}`, value: v });
  }
  const walk = (o: unknown, at: string[], depth: number) => {
    if (!o || typeof o !== 'object' || Array.isArray(o) || depth > 2) return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (!at.length && k === 'ConnectionStrings') continue;
      if (typeof v === 'string' && kindOf(v) && /:\/\/|=/.test(v)) {
        const named = Object.entries(o as Record<string, unknown>).find(([n, x]) => /^(?:database(?:name)?|dbname)$/i.test(n) && typeof x === 'string')?.[1] as string | undefined;
        out.push({ file, key: [...at, k].join(':'), value: v, ...(named ? { name: named } : {}) });
      } else walk(v, [...at, k], depth + 1);
    }
  };
  walk(doc, [], 0);
  return out;
}

/** Spring's keys for the database's address, with the environment name a `${NAME:default}` value reads. */
const SPRING_KEYS = ['spring.datasource.url', 'spring.data.mongodb.uri', 'spring.r2dbc.url'];

function springKeys(dir: string, file: string): (SettingsKey & { env?: string; user?: string; pass?: string; db?: string })[] {
  const text = read(path.join(dir, file));
  const flat = new Map<string, string>();
  if (file.endsWith('.properties')) {
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([\w.-]+)\s*[=:]\s*(.*?)\s*$/.exec(line);
      if (m && !line.trim().startsWith('#')) flat.set(m[1]!, m[2]!);
    }
  } else {
    let doc: unknown;
    try {
      doc = yaml.load(text);
    } catch {
      return [];
    }
    const walk = (o: unknown, at: string) => {
      if (!o || typeof o !== 'object' || Array.isArray(o)) return;
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        const key = at ? `${at}.${k}` : k;
        if (v && typeof v === 'object') walk(v, key);
        else if (v !== null && v !== undefined) flat.set(key, String(v));
      }
    };
    walk(doc, '');
  }
  const out: (SettingsKey & { env?: string; user?: string; pass?: string; db?: string })[] = [];
  for (const key of SPRING_KEYS) {
    const raw = flat.get(key);
    if (!raw) continue;
    const holder = /^\$\{([A-Za-z_][\w.]*)(?::([^}]*))?\}$/.exec(raw);
    const value = holder ? (holder[2] ?? '') : raw;
    const user = flat.get('spring.datasource.username');
    const pass = flat.get('spring.datasource.password');
    const db = flat.get('spring.data.mongodb.database');
    out.push({ file, key, value, ...(holder ? { env: holder[1] } : {}), ...(user && !PLACEHOLDER.test(user) ? { user } : {}), ...(pass && !PLACEHOLDER.test(pass) ? { pass } : {}), ...(db ? { db } : {}) });
  }
  return out;
}

/** What the packages a project uses say about its database. */
const PACKAGE_KIND: [RegExp, FoundKind][] = [
  [/^(?:mongoose|mongodb|@nestjs\/mongoose|mongodb\.driver|mongodb\.entityframeworkcore|mongoengine|pymongo|motor)$/i, 'mongo'],
  [/^(?:pg|postgres|pg-promise|@neondatabase\/serverless|npgsql(?:\.entityframeworkcore\.postgresql)?|psycopg2?(?:-binary)?|asyncpg)$/i, 'postgres'],
  [/^(?:mysql|mysql2|pomelo\.entityframeworkcore\.mysql|mysql\.entityframeworkcore|mysqlconnector|pymysql|mysqlclient)$/i, 'mysql'],
  [/^(?:better-sqlite3|sqlite3|sqlite|microsoft\.entityframeworkcore\.sqlite|microsoft\.data\.sqlite)$/i, 'sqlite'],
  [/^(?:microsoft\.entityframeworkcore\.sqlserver|microsoft\.data\.sqlclient|system\.data\.sqlclient|mssql|tedious)$/i, 'sqlserver'],
];

function packageKinds(dir: string, files: Files): FoundKind[] {
  const names: string[] = [];
  for (const f of files.packages) {
    try {
      const p = JSON.parse(read(path.join(dir, f))) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      names.push(...Object.keys({ ...p.dependencies, ...p.devDependencies }));
    } catch {
      // Not readable: it says nothing.
    }
  }
  for (const f of files.csproj) for (const m of read(path.join(dir, f)).matchAll(/<PackageReference\s+Include="([^"]+)"/g)) names.push(m[1]!);
  const kinds: FoundKind[] = [];
  for (const n of names) {
    const k = PACKAGE_KIND.find(([re]) => re.test(n))?.[1];
    if (k && !kinds.includes(k)) kinds.push(k);
  }
  return kinds;
}

const ENV_READS = [
  /process\.env\.([A-Z][A-Z0-9_]*)/g,
  /process\.env\[\s*['"`]([A-Z][A-Z0-9_]*)['"`]\s*\]/g,
  /(?:os\.environ\.get|os\.getenv|environ\.get|Deno\.env\.get|Environment\.GetEnvironmentVariable)\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
  /os\.environ\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
];

/** The database settings the code reads from the environment, and the connection string names .NET code asks for. */
function codeReads(dir: string, files: string[]): { env: Set<string>; connection: Set<string> } {
  const env = new Set<string>();
  const connection = new Set<string>();
  for (const f of files) {
    const text = read(path.join(dir, f));
    if (!text) continue;
    for (const re of ENV_READS) for (const m of text.matchAll(re)) if (DB_ENV.test(m[1]!) || /MONGO/.test(m[1]!)) env.add(m[1]!);
    for (const m of text.matchAll(/GetConnectionString\(\s*"([^"]+)"\s*\)/g)) connection.add(m[1]!);
  }
  return { env, connection };
}

/** The env file the app reads a value from in its own folder: `.env.example` stands for `.env`. */
function realEnvFile(file: string): string {
  const dir = path.posix.dirname(file);
  const base = path.posix.basename(file).replace(/\.(?:example|sample|template|dist|defaults|tpl)$/i, '');
  return dir === '.' ? base : `${dir}/${base}`;
}

interface Candidate {
  setting: DatabaseSetting;
  address?: string;
  kind?: FoundKind;
  name?: string;
  from: string[];
  score: number;
}

/** The project's database in one repo, or null when its files say nothing about one. */
function findIn(root: string, repo: string): (Omit<Candidate, 'kind'> & { kind: FoundKind; where?: string; repo: string }) | null {
  const dir = path.join(root, repo);
  const files = filesOf(dir);
  const prisma = prismaSources(dir, files.prisma);
  const compose = composeDbs(dir, files.compose);
  const kinds = packageKinds(dir, files);
  const reads = codeReads(dir, files.code);
  // Env files: the person's own (.env, .env.local) hold the address their copy uses; examples only stand for them.
  const env = files.env.map((f) => ({ file: f, example: EXAMPLE.test(f), pairs: envPairs(read(path.join(dir, f))) }));
  const envValue = (name: string): { file: string; value: string; example: boolean } | undefined => {
    const hits = env.filter((e) => e.pairs.has(name) && e.pairs.get(name) && !PLACEHOLDER.test(e.pairs.get(name)!));
    const best = hits.find((e) => !e.example && !OTHER_PLACE.test(e.file)) ?? hits.find((e) => !e.example) ?? hits[0];
    return best ? { file: best.file, value: best.pairs.get(name)!, example: best.example } : undefined;
  };
  const envFileOf = (name: string): string => {
    const own = env.find((e) => !e.example && !OTHER_PLACE.test(e.file) && e.pairs.has(name)) ?? env.find((e) => !e.example && e.pairs.has(name)) ?? env.find((e) => e.pairs.has(name));
    return own ? realEnvFile(own.file) : '.env';
  };
  const candidates: Candidate[] = [];

  for (const p of prisma) {
    if (p.env) {
      const v = envValue(p.env);
      candidates.push({ setting: { env: p.env, file: envFileOf(p.env) }, ...(v ? { address: v.value } : {}), ...(p.kind ? { kind: p.kind } : {}), from: [p.file, ...(v ? [v.file] : [])], score: 50 });
    } else if (p.url) candidates.push({ setting: { file: p.file, key: 'datasource url' }, address: p.url, ...(p.kind ? { kind: p.kind } : {}), from: [p.file], score: 35 });
  }

  // .NET: the development settings first, as the app runs with them on this computer.
  const dotnet = [...files.appsettings].sort((a, b) => Number(/development/i.test(b)) - Number(/development/i.test(a)) || a.length - b.length);
  for (const f of dotnet) {
    for (const k of appsettingsKeys(dir, f)) {
      const asked = [...reads.connection].some((n) => k.key === `ConnectionStrings:${n}`);
      const kind = kindOf(k.value) ?? undefined;
      const name = k.name ?? readAddress(k.value).name;
      candidates.push({ setting: { file: f, key: k.key, env: k.key.split(':').join('__') }, address: k.value, ...(kind ? { kind } : {}), ...(name ? { name } : {}), from: [f], score: 40 + (asked ? 5 : 0) + (/development/i.test(f) ? 2 : 0) });
    }
  }

  for (const f of files.spring) {
    for (const k of springKeys(dir, f)) {
      const envName = k.env ?? k.key.toUpperCase().replace(/[.-]/g, '_');
      let address = k.value || undefined;
      if (address && k.user && !readAddress(address).password) address = address.replace(/^((?:jdbc:)?[a-z][\w+.-]*:\/\/)/i, `$1${encodeURIComponent(k.user)}${k.pass ? `:${encodeURIComponent(k.pass)}` : ''}@`);
      const kind = address ? (kindOf(address) ?? undefined) : undefined;
      candidates.push({ setting: { file: f, key: k.key, env: envName }, ...(address ? { address } : {}), ...(kind ? { kind } : {}), ...(k.db ? { name: k.db } : {}), from: [f], score: 40 + (/(?:^|\/)application\.(?:properties|ya?ml)$/.test(f) ? 2 : 0) });
    }
  }

  // Database settings in env files, read by the code or not.
  const named = new Set<string>();
  for (const e of env) for (const [k, v] of e.pairs) if ((DB_ENV.test(k) && !NOT_THE_APPS.test(k)) || (kindOf(v) && /:\/\//.test(v) && !NOT_THE_APPS.test(k))) named.add(k);
  // An env file of this computer with the same name as a settings key (ConnectionStrings__Main): .NET reads it over its
  // own settings file, and so does the app squad-kit starts, so that address is the one the app uses.
  for (const c of candidates) {
    const v = c.setting.key && c.setting.env ? envValue(c.setting.env) : undefined;
    if (!v || v.example || OTHER_PLACE.test(v.file) || !kindOf(v.value)) continue;
    c.address = v.value;
    const name = readAddress(v.value).name;
    if (name) c.name = name;
    c.from.push(v.file);
  }
  for (const k of named) {
    if (candidates.some((c) => c.setting.env === k)) continue;
    const v = envValue(k);
    const kind = v ? (kindOf(v.value) ?? undefined) : undefined;
    candidates.push({ setting: { env: k, file: envFileOf(k) }, ...(v ? { address: v.value } : {}), ...(kind ? { kind } : {}), from: v ? [v.file] : env.filter((e) => e.pairs.has(k)).map((e) => e.file), score: 25 + (reads.env.has(k) ? 15 : 0) + (v ? 5 : 0) });
  }
  // Read by the code only, with no env file: the name is still the setting.
  for (const k of reads.env) {
    if (candidates.some((c) => c.setting.env === k) || NOT_THE_APPS.test(k)) continue;
    candidates.push({ setting: { env: k, file: '.env' }, from: [], score: 22 });
  }
  for (const s of compose.settings) {
    if (candidates.some((c) => c.setting.env === s.env)) {
      candidates.find((c) => c.setting.env === s.env)!.from.push(s.file);
      continue;
    }
    candidates.push({ setting: { env: s.env, file: '.env' }, ...(s.value && kindOf(s.value) ? { kind: kindOf(s.value)! } : {}), from: [s.file], score: 20 });
  }

  const db = compose.dbs[0];
  if (!candidates.length && !db) return null;
  const best = candidates.sort((a, b) => b.score - a.score)[0] ?? { setting: {}, from: [], score: 10 };
  // The kind: the address says best, then the ORM's provider, the database the compose file runs, the packages.
  const kind = (best.address ? kindOf(best.address) : null) ?? best.kind ?? prisma.find((p) => p.kind)?.kind ?? db?.kind ?? kinds[0];
  if (!kind) return null;
  const own = db && db.kind === kind ? db : undefined;
  // An address with the compose file's host name in it (db:5432) is reached here through the published port.
  const address = best.address && !(own && readAddress(best.address).host === own.service) ? best.address : (own?.address ?? best.address);
  const said = address ? readAddress(address) : { password: false, name: undefined, host: undefined, port: undefined };
  const name = best.name ?? said.name ?? own?.name;
  const where = own ? `the ${own.service} service in ${own.file}${own.port ? `, on port ${own.port}` : ''}` : kind === 'sqlite' ? 'a file in the project' : said.host ? `${said.host}${said.port ? `:${said.port}` : ''}` : undefined;
  const from = [...new Set([...best.from, ...(own ? [own.file] : [])])];
  return { ...best, kind, ...(address ? { address } : {}), ...(name ? { name } : {}), ...(where ? { where } : {}), from, repo };
}

/**
 * The project's database, from the files of each repo: the repo whose files say the most wins. A database squad-kit
 * cannot copy yet (SQL Server) is said, and not learned.
 */
export function findDatabase(root: string, repos: string[]): DatabaseLook {
  const found = repos.map((r) => findIn(root, r)).filter((x): x is NonNullable<ReturnType<typeof findIn>> => Boolean(x)).sort((a, b) => b.score - a.score);
  const best = found[0];
  if (!best) return { found: null };
  if (best.kind === 'sqlserver') return { found: null, later: 'This project uses SQL Server. A database of its own for each story comes for SQL Server in a later version; until then stories use it as before.' };
  const { score: _score, kind, ...rest } = best;
  return { found: { ...rest, kind: kind as DbKind } };
}

/* ── whether the app would use a story's own database ─────── */

/** Code files, for git grep: wherever they are in the repo. */
const CODE_GLOBS = ['*.cs', '*.fs', '*.vb', '*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.jsx', '*.mjs', '*.cjs', '*.py', '*.java', '*.kt', '*.scala', '*.go', '*.rb', '*.php', '*.rs', '*.ex', '*.exs', '*.dart', '*.swift'];
/** Code that opens a database by a name written in it: the Mongo drivers of .NET, Java, Python, Node and Go, Mongoose's dbName. */
const OPENS = /(?:(?:\b(?:GetDatabase|getDatabase|get_database|getSiblingDB|useDb)|\bclient\.db|\.Database)\(\s*|\bdbName\s*[:=]\s*)(["'`])([^"'`]+)\1/;
const OPENS_GREP = '((GetDatabase|getDatabase|get_database|getSiblingDB|useDb|client\\.db|\\.Database)\\([[:space:]]*|dbName[[:space:]]*[:=][[:space:]]*)["\'`]';
/** A line about a database, once the name itself is taken out of it. */
const DB_WORDS = /data ?base|db|mongo|catalog|schema|connect|client/i;
/** Names too common to look for in the code: `"postgres"` there is mostly the kind, not the database. */
const COMMON_NAMES = new Set(['postgres', 'postgresql', 'mysql', 'mariadb', 'mongo', 'mongodb', 'test', 'admin', 'app', 'db', 'database', 'default', 'main', 'local', 'dev']);
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec|specs|e2e)\/|[.-](?:test|spec)\.[a-z]+$|Tests?\.(?:cs|fs|java|kt)$|(?:^|\/)test_[^/]*\.py$|_test\.(?:py|go)$/i;
const SERVER_KINDS: DbKind[] = ['postgres', 'mysql', 'mongo'];
/** The most one look in the code takes; a repo too big for it is looked at no further. */
const GREP_MS = 20_000;

/** `file:line: text` lines of a git grep in the repo, or none when it found nothing or could not look. */
function grepLines(dir: string, args: string[]): { file: string; line: string; text: string }[] {
  const out = git(dir, ['grep', '-n', '-I', ...args, '--', ...CODE_GLOBS], { allowFail: true, timeoutMs: GREP_MS });
  return out
    .split('\n')
    .map((l) => /^(.+?):(\d+):(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => ({ file: m[1]!, line: m[2]!, text: m[3]! }));
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A compose service that sets the setting itself, from other settings, rather than passing the environment's on. */
function composeSets(dir: string, files: string[], name: string): { file: string; service: string } | undefined {
  const passes = new RegExp(`^\\$(?:\\{${escapeRe(name)}(?::?-[^}]*)?\\}|${escapeRe(name)})$`);
  for (const file of files) {
    let doc: unknown;
    try {
      doc = yaml.load(read(path.join(dir, file)));
    } catch {
      continue;
    }
    const services = (doc as { services?: Record<string, unknown> } | undefined)?.services;
    if (!services || typeof services !== 'object') continue;
    for (const [service, raw] of Object.entries(services)) {
      const env = (raw as { environment?: unknown } | null)?.environment;
      let value: unknown;
      if (Array.isArray(env)) {
        for (const item of env) {
          const s = String(item);
          const at = s.indexOf('=');
          if (at > 0 && s.slice(0, at) === name) value = s.slice(at + 1);
        }
      } else if (env && typeof env === 'object') value = (env as Record<string, unknown>)[name];
      if (value === undefined || value === null || !String(value).trim()) continue;
      if (!passes.test(String(value).trim())) return { file, service };
    }
  }
  return undefined;
}

/**
 * Why a story's own database, under another name on the same server, would not be the one the app uses: the code
 * names the database itself or opens one by a name of its own, the address names no database at all, or a compose
 * file builds the setting from other settings. Then the story would write to the person's own database whatever
 * squad-kit points it at, so stories use the database as before. Undefined when squad-kit sees nothing of the kind.
 * Only a server's database: a SQLite file is in each copy already. A quick look: git grep, and the files findDatabase reads.
 */
export function storyCopyIgnored(dir: string, db: { kind: DbKind; name?: string; setting: DatabaseSetting }, address?: string): string | undefined {
  if (!SERVER_KINDS.includes(db.kind)) return undefined;
  const setting = db.setting.env ?? db.setting.key ?? 'its setting';
  const takes = `squad-kit gives each story its own copy when the app takes the database's name from ${setting}.`;
  const name = db.name ?? (address ? readAddress(address).name : undefined);
  if (name && !COMMON_NAMES.has(name.toLowerCase())) {
    const quoted = [`"${name}"`, `'${name}'`, `\`${name}\``];
    // A connection string may carry the database's name as its own (GetConnectionString("shop")): that reads the setting.
    const reads = (text: string) => text.replace(/\bGetConnectionString\s*\(\s*(["'`])[^"'`]*\1\s*\)|\bConnectionStrings[:_]+\w+/g, '');
    const hits = grepLines(dir, ['-F', ...quoted.flatMap((q) => ['-e', q])])
      .map((h) => ({ ...h, text: reads(h.text) }))
      .filter((h) => quoted.some((q) => h.text.includes(q)) && DB_WORDS.test(quoted.reduce((t, q) => t.split(q).join(''), h.text)));
    const at = (h: { file: string; line: string }) => `${h.file}:${h.line}`;
    if (hits.length) return `The code names the database ${name} itself, in ${hits.length === 1 ? at(hits[0]!) : `${hits.length} places like ${at(hits[0]!)}`}, so it would not use a story's own copy under another name. ${takes}`;
  }
  for (const h of grepLines(dir, ['-E', '-e', OPENS_GREP])) {
    const other = TEST_PATH.test(h.file) ? undefined : OPENS.exec(h.text)?.[2];
    if (other) return `The code opens the database ${other} by its name, in ${h.file}:${h.line}, so it would not use a story's own copy under another name. ${takes}`;
  }
  const files = filesOf(dir);
  // The setting's value in the project's env files, as written there, and the address squad-kit has.
  const values: { value: string; file: string }[] = [];
  if (db.setting.env) {
    for (const f of files.env) {
      const v = envPairs(read(path.join(dir, f))).get(db.setting.env);
      if (v) values.push({ value: v, file: f });
    }
  }
  if (address) values.push({ value: address, file: '' });
  for (const { value, file } of values) {
    if (!(kindOf(value) || /:\/\//.test(value)) || readAddress(value).name) continue;
    return `The address in ${file || setting} names no database, so the app picks its database some other way and would not use a story's own copy. ${takes}`;
  }
  if (db.setting.env) {
    const set = composeSets(dir, files.compose, db.setting.env);
    if (set) return `${set.file} sets ${db.setting.env} itself for the ${set.service} service, from other settings, so the app there would not see a story's own database.`;
  }
  return undefined;
}
