import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DbError, type DbKind } from './types.js';

/**
 * Reading a database's address, and writing it back with another database's name, in the same form the app's setting
 * uses: a link (`postgres://user:pw@host:5432/clinic`), a JDBC link, a key=value string (`Host=…;Database=…` or
 * `host=… dbname=…`), or for SQLite a file's path (plain, `file:`, `sqlite:`, `jdbc:sqlite:`, `Data Source=`). Only the
 * name changes; everything else stays as the person wrote it. Passwords are read to connect, and never shown: `safe`
 * is the address without one.
 */

export interface Address {
  kind: DbKind;
  /** The database's name; for SQLite, the file's full path. */
  name: string;
  /** For the server kinds: where it runs, without the name or a password. */
  host: string;
  port?: number;
  /** A Unix socket's path, when the address names one instead of a host. */
  socket?: string;
  user?: string;
  password?: string;
  /** Extra settings in the address (sslmode, authSource, replicaSet…), by lower-case name. */
  params: Record<string, string>;
  /** For Mongo: the hosts as written (`h1:27017,h2:27017`) and whether it is a `mongodb+srv` link. */
  hosts?: string;
  srv?: boolean;
  /** The address as given, with the database's name changed. */
  withName(name: string): string;
  /** The address without its password, to show and to log. */
  safe: string;
  /** Who the server is, the same for every way of writing it: never a name or a password. */
  server: string;
}

const LOCAL = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', 'host.docker.internal']);

/** The same name for every way of saying "this computer". */
export function normalHost(host: string | undefined): string {
  const h = (host ?? '').trim().toLowerCase();
  return LOCAL.has(h) ? 'localhost' : h;
}

const DEFAULT_PORT: Partial<Record<DbKind, number>> = { postgres: 5432, mysql: 3306, mongo: 27017 };

const SCHEMES: Record<string, DbKind> = {
  postgres: 'postgres',
  postgresql: 'postgres',
  mysql: 'mysql',
  mysql2: 'mysql',
  mariadb: 'mysql',
  mongodb: 'mongo',
  'mongodb+srv': 'mongo',
  sqlite: 'sqlite',
  sqlite3: 'sqlite',
  file: 'sqlite',
};

/** A guess at the kind from the address's form alone; null when the form does not say. */
export function kindOfAddress(address: string): DbKind | null {
  const a = address.trim();
  const scheme = /^(?:jdbc:)?([a-z][a-z0-9+.-]*):/i.exec(a)?.[1]?.toLowerCase();
  if (scheme && SCHEMES[scheme]) return SCHEMES[scheme]!;
  const pairs = readPairs(a);
  if (pairs) {
    const keys = new Set(pairs.map((p) => p.key));
    if (keys.has('data source') && /\.(db|sqlite3?|db3)$/i.test(pairs.find((p) => p.key === 'data source')!.value)) return 'sqlite';
    if (keys.has('filename')) return 'sqlite';
    if (keys.has('dbname') || keys.has('sslmode')) return 'postgres';
    if (keys.has('uid') || keys.has('pwd')) return 'mysql';
    return null;
  }
  if (/\.(db|sqlite3?|db3)$/i.test(a)) return 'sqlite';
  return null;
}

/** A safe form for a part of a database's name: lower case letters, digits and single underscores. */
export function safePart(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const MAX_NAME = 63;
const shortHash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 6);

/** Fits `<base>_<tail>` into the server's limit for a name, cutting the base and adding a short hash when too long. */
function fitName(base: string, tail: string): string {
  const full = `${base}_${tail}`;
  if (full.length <= MAX_NAME) return full;
  const t = tail.length > 30 ? `${tail.slice(0, 23)}_${shortHash(tail)}` : tail;
  const room = MAX_NAME - t.length - 1 - 7;
  return `${base.slice(0, Math.max(1, room)).replace(/_+$/, '')}_${shortHash(base)}_${t}`;
}

/** The base of every name squad-kit makes from a database's name. */
function baseName(sourceName: string): string {
  return safePart(sourceName) || 'db';
}

/** A story's database's name: `<source name>_<story id>`, safe on every kind of server. */
export function storyName(sourceName: string, storyId: string): string {
  const story = safePart(storyId);
  if (!story) throw new DbError(`The story id "${storyId}" has no letters or digits to name a database with.`, 'bad-address');
  return fitName(baseName(sourceName), story);
}

/** The name of the template database squad-kit keeps on a Postgres server. */
export function templateName(sourceName: string): string {
  return fitName(baseName(sourceName), 'sk_template');
}

/** Names a server needs for itself: squad-kit never makes or drops these. */
export const SYSTEM_NAMES: Record<DbKind, Set<string>> = {
  postgres: new Set(['postgres', 'template0', 'template1']),
  mysql: new Set(['mysql', 'information_schema', 'performance_schema', 'sys']),
  mongo: new Set(['admin', 'local', 'config']),
  sqlite: new Set(),
};

interface Pair {
  key: string;
  value: string;
  /** Where the value is in the text, to change it in place. */
  start: number;
  end: number;
}

/**
 * A key=value address, or null: `Host=db;Database=clinic;Password="a;b"` (separated by `;`) or
 * `host=db dbname=clinic password='x y'` (separated by spaces, as Postgres's own tools write it).
 */
function readPairs(text: string): Pair[] | null {
  if (!/^\s*[A-Za-z][\w ]*=/.test(text) || /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return null;
  const semi = text.includes(';') || !/^\s*\w+=\S*(\s+\w+=\S*)*\s*$/.test(text.replace(/'(?:[^'\\]|\\.)*'/g, 'x'));
  const pairs: Pair[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && (text[i] === ';' || /\s/.test(text[i]!))) i++;
    if (i >= text.length) break;
    const eq = text.indexOf('=', i);
    if (eq < 0) return null;
    const key = text.slice(i, eq).trim().toLowerCase();
    i = eq + 1;
    if (!semi) while (i < text.length && text[i] === ' ') i++;
    let start = i;
    let value = '';
    const q = text[i];
    if (q === '"' || q === "'") {
      i++;
      start = i;
      while (i < text.length) {
        if (text[i] === '\\' && !semi && i + 1 < text.length) {
          value += text[i + 1];
          i += 2;
          continue;
        }
        if (text[i] === q) {
          // A doubled quote is a quote inside the value (connection strings in .NET).
          if (semi && text[i + 1] === q) {
            value += q;
            i += 2;
            continue;
          }
          break;
        }
        value += text[i];
        i++;
      }
      pairs.push({ key, value, start, end: i });
      i++;
    } else {
      while (i < text.length && (semi ? text[i] !== ';' : !/\s/.test(text[i]!))) i++;
      value = text.slice(start, i).trim();
      pairs.push({ key, value, start, end: start + text.slice(start, i).trimEnd().length });
    }
  }
  return pairs.length ? pairs : null;
}

const pick = (pairs: Pair[], ...keys: string[]) => pairs.find((p) => keys.includes(p.key));

/** Writes a value back into a key=value address, quoted when it needs to be. */
function putPair(text: string, p: Pair, value: string): string {
  const quoted = text[p.start - 1] === '"' || text[p.start - 1] === "'";
  const v = quoted ? value : /[;\s'"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return text.slice(0, p.start) + v + text.slice(p.end);
}

interface Link {
  scheme: string;
  user?: string;
  password?: string;
  hosts: string;
  path: string;
  query: string;
  /** The text before and after the database's name in the link, to write it back with another name. */
  before: string;
  after: string;
}

/** A link: `scheme://user:pw@hosts/name?query`. Read by hand, so Mongo's host lists and odd passwords read too. */
function readLink(text: string): Link | null {
  const m = /^((?:jdbc:)?)([a-z][a-z0-9+.-]*):\/\//i.exec(text);
  if (!m) return null;
  const rest = text.slice(m[0].length);
  const endAuthority = rest.search(/[/?#]/);
  const authEnd = endAuthority < 0 ? rest.length : endAuthority;
  const at = rest.lastIndexOf('@', authEnd);
  const auth = at >= 0 ? rest.slice(0, at) : '';
  const hosts = rest.slice(at + 1, authEnd);
  const tail = rest.slice(authEnd);
  const pm = /^(\/[^?#]*)?(\?[^#]*)?(#.*)?$/.exec(tail);
  const p = pm?.[1] ?? '';
  const query = pm?.[2] ?? '';
  const colon = auth.indexOf(':');
  const dec = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const head = text.slice(0, m[0].length + authEnd);
  return {
    scheme: m[2]!.toLowerCase(),
    ...(auth ? { user: dec(colon >= 0 ? auth.slice(0, colon) : auth) } : {}),
    ...(colon >= 0 ? { password: dec(auth.slice(colon + 1)) } : {}),
    hosts,
    path: dec(p.replace(/^\//, '')),
    query,
    before: head + '/',
    after: query + (pm?.[3] ?? ''),
  };
}

function queryParams(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(query.replace(/^\?/, ''))) out[k.toLowerCase()] = v;
  return out;
}

/** The link without its password. */
function linkWithoutPassword(text: string, l: Link): string {
  if (l.password === undefined) return text.replace(/([?&](?:password|pwd)=)[^&#]*/gi, '$1***');
  const m = /^((?:jdbc:)?[a-z][a-z0-9+.-]*:\/\/)/i.exec(text)!;
  const rest = text.slice(m[0].length);
  const authEnd = (() => {
    const e = rest.search(/[/?#]/);
    return e < 0 ? rest.length : e;
  })();
  const at = rest.lastIndexOf('@', authEnd);
  const auth = rest.slice(0, at);
  const user = auth.slice(0, auth.indexOf(':'));
  return (m[1] + `${user}:***@` + rest.slice(at + 1)).replace(/([?&](?:password|pwd)=)[^&#]*/gi, '$1***');
}

function serverOf(kind: DbKind, host: string, port: number | undefined, socket?: string): string {
  if (socket) return `${kind}:socket:${path.resolve(socket)}`;
  return `${kind}:${normalHost(host)}:${port ?? DEFAULT_PORT[kind] ?? ''}`;
}

/** Splits `host:port` (or `[::1]:5432`). */
function hostPort(text: string): { host: string; port?: number } {
  const t = text.trim();
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(t);
  if (v6) return { host: v6[1]!, ...(v6[2] ? { port: Number(v6[2]) } : {}) };
  const m = /^([^:]*)(?::(\d+))?$/.exec(t);
  if (!m) return { host: t };
  let host = m[1]!;
  try {
    host = decodeURIComponent(host);
  } catch {
    // Not encoded.
  }
  return { host, ...(m[2] ? { port: Number(m[2]) } : {}) };
}

function bad(kind: DbKind, why: string): never {
  throw new DbError(`squad-kit could not read the ${label(kind)} address: ${why}.`, 'bad-address');
}

export function label(kind: DbKind): string {
  return { sqlite: 'SQLite', postgres: 'Postgres', mysql: 'MySQL', mongo: 'MongoDB' }[kind];
}

/** Reads an address of the given kind. Throws a DbError ('bad-address') with plain words when it cannot. */
export function readAddress(kind: DbKind, address: string): Address {
  const text = address.trim();
  if (!text) bad(kind, 'it is empty');
  if (kind === 'sqlite') return readSqlite(text);
  const link = readLink(text);
  if (link) {
    if (kind === 'mongo') return readMongoLink(text, link);
    const params = queryParams(link.query);
    const first = link.hosts.split(',')[0] ?? '';
    const hp = hostPort(first);
    const socket = params.host?.startsWith('/') ? params.host : params.socket;
    const name = link.path || params.dbname || params.database || '';
    if (!name) bad(kind, 'it names no database');
    const user = link.user ?? params.user ?? params.username;
    const password = link.password ?? params.password ?? params.pwd;
    return {
      kind,
      name,
      host: hp.host || (socket ? '' : 'localhost'),
      ...(hp.port ? { port: hp.port } : params.port ? { port: Number(params.port) } : {}),
      ...(socket ? { socket } : {}),
      ...(user ? { user } : {}),
      ...(password !== undefined ? { password } : {}),
      params,
      withName: (n) => {
        if (link.path || (!params.dbname && !params.database)) return link.before + encodeURIComponent(n) + link.after;
        // The name is in the query (`?dbname=clinic`): change it there.
        return text.replace(/([?&](?:dbname|database)=)[^&#]*/i, `$1${encodeURIComponent(n)}`);
      },
      safe: linkWithoutPassword(text, link),
      server: serverOf(kind, hp.host, hp.port ?? (params.port ? Number(params.port) : undefined), socket),
    };
  }
  const pairs = readPairs(text);
  if (!pairs) bad(kind, 'it is not a link or a list of key=value settings');
  const nameP = pick(pairs, 'database', 'dbname', 'initial catalog', 'db');
  if (!nameP || !nameP.value) bad(kind, 'it names no database');
  const hostP = pick(pairs, 'host', 'server', 'data source', 'hostaddr', 'address', 'addr', 'network address');
  const portP = pick(pairs, 'port');
  const hp = hostPort(hostP?.value ?? 'localhost');
  const socketP = pick(pairs, 'socket', 'unix_socket');
  const socket = socketP?.value || (hp.host.startsWith('/') ? hp.host : undefined);
  const user = pick(pairs, 'user', 'username', 'user id', 'userid', 'uid', 'user name')?.value;
  const passP = pick(pairs, 'password', 'pwd');
  const params: Record<string, string> = {};
  for (const p of pairs) params[p.key] = p.value;
  const port = portP ? Number(portP.value) : hp.port;
  const safe = passP ? putPair(text, passP, '***') : text;
  return {
    kind,
    name: nameP.value,
    host: socket ? '' : hp.host,
    ...(port ? { port } : {}),
    ...(socket ? { socket } : {}),
    ...(user ? { user } : {}),
    ...(passP ? { password: passP.value } : {}),
    params,
    withName: (n) => putPair(text, nameP, n),
    safe,
    server: serverOf(kind, hp.host, port, socket),
  };
}

function readMongoLink(text: string, link: Link): Address {
  if (link.scheme !== 'mongodb' && link.scheme !== 'mongodb+srv') bad('mongo', 'it is not a mongodb:// link');
  const params = queryParams(link.query);
  if (!link.path) bad('mongo', 'it names no database (add it after the hosts: mongodb://host:27017/name)');
  const hosts = link.hosts
    .split(',')
    .map((h) => {
      const hp = hostPort(h);
      return `${normalHost(hp.host)}:${hp.port ?? (link.scheme === 'mongodb+srv' ? '' : 27017)}`;
    })
    .sort()
    .join(',');
  const first = hostPort(link.hosts.split(',')[0] ?? '');
  return {
    kind: 'mongo',
    name: link.path,
    host: first.host,
    ...(first.port ? { port: first.port } : {}),
    ...(link.user ? { user: link.user } : {}),
    ...(link.password !== undefined ? { password: link.password } : {}),
    params,
    hosts: link.hosts,
    srv: link.scheme === 'mongodb+srv',
    withName: (n) => {
      // The name in a link is also where Mongo looks for the user, unless the link says otherwise: keep that the same. A
      // link with no name signs in on admin. A `?` or `&` already at the end takes the setting as it is.
      const sep = !link.query ? '?' : /[?&]$/.test(link.query) ? '' : '&';
      const keep = link.user && !params.authsource ? `${sep}authSource=${encodeURIComponent(link.path || 'admin')}` : '';
      const q = link.query + keep;
      return link.before + encodeURIComponent(n) + q + link.after.slice(link.query.length);
    },
    safe: linkWithoutPassword(text, link),
    server: `mongo:${link.scheme === 'mongodb+srv' ? 'srv:' : ''}${hosts}`,
  };
}

/** SQLite: a file's path, plain or in one of the forms apps write it in. Must be a full path. */
function readSqlite(text: string): Address {
  let file = text;
  let rewrite = (p: string) => p;
  const pairs = /^\s*(data source|datasource|filename)\s*=/i.test(text) ? readPairs(text) : null;
  if (pairs) {
    const p = pick(pairs, 'data source', 'datasource', 'filename')!;
    file = p.value;
    rewrite = (n) => putPair(text, p, n);
  } else {
    const m = /^(jdbc:sqlite:|sqlite3?:(?:\/\/)?|file:(?:\/\/(?=\/))?)(.*)$/i.exec(text);
    if (m) {
      const prefix = m[1]!;
      const [p, q = ''] = m[2]!.split('?');
      file = decodeURIComponent(p!);
      rewrite = (n) => prefix + n + (q ? `?${q}` : '');
    }
  }
  if (!file || file === ':memory:') bad('sqlite', 'it names no file');
  if (!path.isAbsolute(file)) bad('sqlite', `the file must be given by its full path, not "${file}"`);
  const full = path.resolve(file);
  return {
    kind: 'sqlite',
    name: full,
    host: '',
    params: {},
    withName: rewrite,
    safe: text,
    server: 'sqlite',
  };
}

/** The real path of a file, following links, or its plain full path when it is not there yet. */
export function realFile(file: string): string {
  try {
    return fs.realpathSync.native(file);
  } catch {
    try {
      return path.join(fs.realpathSync.native(path.dirname(file)), path.basename(file));
    } catch {
      return path.resolve(file);
    }
  }
}

/** True when two files are the same file: the same real path, or the same file on disk under two names. */
export function sameFile(a: string, b: string): boolean {
  const ra = realFile(a);
  const rb = realFile(b);
  if (ra === rb) return true;
  // macOS and Windows disks ignore case by default.
  if (process.platform !== 'linux' && ra.toLowerCase() === rb.toLowerCase()) return true;
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.ino === sb.ino && sa.dev === sb.dev;
  } catch {
    return false;
  }
}

/**
 * True when the address is the person's own database. For a server, the same name counts whatever the host, port or
 * user: a story's database is always named differently, so refusing a same-named one elsewhere costs nothing. An
 * address that cannot be read counts as the person's own, so nothing is done to it.
 */
export function isPersonsOwn(kind: DbKind, address: string, personsAddress: string): boolean {
  let a: Address;
  let p: Address;
  try {
    a = readAddress(kind, address);
    p = readAddress(kind, personsAddress);
  } catch {
    return true;
  }
  if (kind === 'sqlite') return sameFile(a.name, p.name);
  return a.name.toLowerCase() === p.name.toLowerCase();
}

/** Refuses the person's own database and the server's own databases, with plain words. */
export function refuseOwn(kind: DbKind, address: string, personsAddress: string, doing: string): void {
  if (isPersonsOwn(kind, address, personsAddress)) {
    throw new DbError(`squad-kit never ${doing} your own database. It only reads it, to make the template.`, 'persons-own');
  }
  const name = readAddress(kind, address).name;
  if (SYSTEM_NAMES[kind].has(name.toLowerCase())) {
    throw new DbError(`squad-kit never ${doing} "${name}": the ${label(kind)} server needs it for itself.`, 'persons-own');
  }
}
