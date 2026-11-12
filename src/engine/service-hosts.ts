import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { DatabaseSetting } from '../board/types.js';
import { writeLog } from '../core/app-log.js';
import { isCompose } from './compose-run.js';
import { kindOfAddress, normalHost, readAddress } from './db/address.js';
import type { DbKind } from './db/types.js';
import { ownDbWired } from './db-env.js';
import { envFilesIn } from './env-file.js';
import { kindOf } from './find-database.js';

/**
 * Where a database or a Redis runs, as the app's settings say. A project whose daily stack runs in Docker Compose often
 * names a service in its settings (`mongodb://app.db:27017/shop`, `redis:6379,abortConnect=false`): only Docker's own
 * network knows that name. When squad-kit runs the app on this computer, outside that network, the app gets the same
 * address with `localhost` and the port the service publishes here. An app squad-kit runs in Compose keeps it as it is.
 *
 * The same reading says whether a server is on this computer at all: squad-kit makes a story's own database only there
 * (story-db.ts). Nothing here connects to anything; it reads the project's files with firm limits.
 */

export type AddressKind = 'postgres' | 'mysql' | 'mongo' | 'redis';

/** A service in the project's compose files. */
export interface ComposeService {
  /** Its name, container_name, hostname and network aliases, in lower case. */
  names: string[];
  /** The port on this computer for each port inside the container. */
  ports: Record<number, number>;
  /** It shares this computer's network: each port inside is the same port here. */
  hostNetwork?: boolean;
}

const COMPOSE = /^(?:docker-)?compose(?:[.-][\w.-]+)?\.ya?ml$/i;
const ENV_FILE = /^\.env(?:\.[\w.-]+)?$/;
const EXAMPLE = /(?:^|\.)(?:example|sample|template|dist|defaults|tpl)$/i;
const APPSETTINGS = /^appsettings(?:\.[\w-]+)?\.json$/i;
const PROPERTIES = /^application(?:-[\w-]+)?\.properties$/;
/** A file for another place than this computer: production, beta, staging and the like. */
const OTHER_PLACE = /(?:^|[.\-_])(?:prod|production|beta|staging|stage|uat|qa|preprod|live|release|test|tests|testing|ci|e2e)(?:[.\-_]|$)/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.squad', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage', '.venv', 'venv', '__pycache__', 'target', 'vendor', 'Pods', 'bin', 'obj', 'wwwroot']);
const LIMITS = { depth: 4, entries: 4000, fileBytes: 256 * 1024 };

const DEFAULT_PORT: Record<AddressKind, number> = { postgres: 5432, mysql: 3306, mongo: 27017, redis: 6379 };
const SCHEMES: Record<string, AddressKind> = {
  postgres: 'postgres',
  postgresql: 'postgres',
  mysql: 'mysql',
  mysql2: 'mysql',
  mariadb: 'mysql',
  mongodb: 'mongo',
  'mongodb+srv': 'mongo',
  redis: 'redis',
  rediss: 'redis',
};
/** Options only a StackExchange.Redis address has: `cache:6379,abortConnect=false`. */
const REDIS_OPTIONS = /^(?:abortconnect|defaultdatabase|allowadmin|connectretry|connecttimeout|synctimeout|asynctimeout|ssl|sslhost|sslprotocols|servicename|keepalive|tiebreaker|resolvedns|channelprefix|configchannel|configcheckseconds)$/i;

function read(file: string): string {
  try {
    return fs.statSync(file).size > LIMITS.fileBytes ? '' : fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** The files worth reading in a folder, found with firm limits. Paths are inside it, with forward slashes. */
function filesOf(dir: string): { compose: string[]; env: string[]; appsettings: string[]; properties: string[] } {
  const out = { compose: [] as string[], env: [] as string[], appsettings: [] as string[], properties: [] as string[] };
  let entries = 0;
  const visit = (rel: string, depth: number) => {
    if (depth > LIMITS.depth || entries >= LIMITS.entries) return;
    let list: fs.Dirent[];
    try {
      list = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entries >= LIMITS.entries) return;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) visit(p, depth + 1);
        continue;
      }
      if (!e.isFile() || OTHER_PLACE.test(e.name.replace(/\.(?:ya?ml|json|properties)$/i, ''))) continue;
      if (COMPOSE.test(e.name)) out.compose.push(p);
      else if (ENV_FILE.test(e.name) && !EXAMPLE.test(e.name) && !rel) out.env.push(p);
      else if (APPSETTINGS.test(e.name)) out.appsettings.push(p);
      else if (PROPERTIES.test(e.name)) out.properties.push(p);
    }
  };
  visit('', 0);
  // The plain files first, then the ones that add to them: compose.yaml before compose.override.yaml.
  const plainFirst = (a: string, b: string) => path.posix.basename(a).split('.').length - path.posix.basename(b).split('.').length || a.localeCompare(b);
  out.compose.sort(plainFirst);
  // .NET reads appsettings.Development.json over appsettings.json: the one it reads last goes first here.
  out.appsettings.sort((a, b) => -plainFirst(a, b));
  out.properties.sort((a, b) => -plainFirst(a, b));
  return out;
}

/** A compose value with `${NAME:-default}` read as its default; undefined when it names another setting. */
function plainValue(v: unknown): string | undefined {
  if (v === null || v === undefined || typeof v === 'object') return undefined;
  const s = String(v).replace(/\$\{[A-Za-z_]\w*:?-([^}]*)\}/g, '$1');
  return /\$\{|\$[A-Za-z_]/.test(s) ? undefined : s;
}

interface ComposeDoc {
  file: string;
  services: Record<string, Record<string, unknown>>;
}

function composeDocs(dir: string, files: string[]): ComposeDoc[] {
  const out: ComposeDoc[] = [];
  for (const file of files) {
    let doc: unknown;
    try {
      doc = yaml.load(read(path.join(dir, file)));
    } catch {
      continue;
    }
    const services = (doc as { services?: unknown } | undefined)?.services;
    if (services && typeof services === 'object') out.push({ file, services: services as ComposeDoc['services'] });
  }
  return out;
}

/** The ports a service publishes here, from "6380:6379", "127.0.0.1:6380:6379", "${PORT:-6380}:6379/tcp" or the long form. */
function publishes(ports: unknown, into: Record<number, number>): void {
  for (const p of Array.isArray(ports) ? ports : []) {
    if (p && typeof p === 'object') {
      const o = p as { target?: unknown; published?: unknown; protocol?: unknown };
      const target = Number(o.target);
      const published = Number(plainValue(o.published));
      if ((!o.protocol || o.protocol === 'tcp') && target && published) into[target] = published;
      continue;
    }
    const [spec = '', protocol] = (plainValue(p) ?? '').split('/');
    if (protocol && protocol !== 'tcp') continue;
    const m = /^(?:(?:\[[^\]]*\]|[\d.]+):)?(\d+):(\d+)$/.exec(spec.trim());
    if (m) into[Number(m[2])] = Number(m[1]);
  }
}

/**
 * The project's compose services, by every name Docker's network knows them by, and the ports each publishes on this
 * computer. A compose file for another place (docker-compose.prod.yml) is left out.
 */
export function composeServices(dir: string): ComposeService[] {
  const byName = new Map<string, ComposeService>();
  for (const doc of composeDocs(dir, filesOf(dir).compose)) {
    for (const [name, raw] of Object.entries(doc.services)) {
      const s = (raw ?? {}) as { container_name?: unknown; hostname?: unknown; networks?: unknown; ports?: unknown; network_mode?: unknown };
      const one = byName.get(name) ?? { names: [], ports: {} };
      byName.set(name, one);
      const aliases = s.networks && typeof s.networks === 'object' && !Array.isArray(s.networks) ? Object.values(s.networks as Record<string, { aliases?: unknown } | null>).flatMap((n) => (Array.isArray(n?.aliases) ? n.aliases : [])) : [];
      for (const n of [name, s.container_name, s.hostname, ...aliases]) {
        const v = plainValue(n)?.trim().toLowerCase();
        if (v && !one.names.includes(v)) one.names.push(v);
      }
      publishes(s.ports, one.ports);
      if (s.network_mode === 'host') one.hostNetwork = true;
    }
  }
  return [...byName.values()];
}

/* ── the hosts in an address ─────────────────────────────── */

interface Endpoint {
  host: string;
  port?: number;
  /** Where `host[:port]` is in the address, to write it back. */
  start: number;
  end: number;
}

interface Hosts {
  form: 'link' | 'pairs' | 'list';
  kind: AddressKind;
  endpoints: Endpoint[];
  /** A mongodb+srv link: the name is looked up in DNS for the real servers. */
  srv?: boolean;
  /** For key=value: where the Port value is, and how the pairs are separated. */
  portAt?: { start: number; end: number };
  semi?: boolean;
}

/** `host`, `host:port` or `[::1]:port`, at a place in the text. */
function endpoint(text: string, start: number): Endpoint | null {
  const t = text.trim();
  if (!t) return null;
  const at = start + text.indexOf(t);
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(t);
  if (v6) return { host: v6[1]!, ...(v6[2] ? { port: Number(v6[2]) } : {}), start: at, end: at + t.length };
  // An IPv6 address with no brackets (`host=2001:db8::7`) has no port in it.
  if (/^[\da-f]*:[\da-f]*:[\da-f:.]*$/i.test(t)) return { host: t, start: at, end: at + t.length };
  const m = /^([^:/\s]+)(?::(\d+))?$/.exec(t);
  if (!m) return null;
  return { host: m[1]!, ...(m[2] ? { port: Number(m[2]) } : {}), start: at, end: at + t.length };
}

/** The parts of a list, each with where it starts. */
function split(text: string, by: string, from = 0): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  let start = 0;
  for (const part of text.split(by)) {
    out.push({ text: part, start: from + start });
    start += part.length + by.length;
  }
  return out;
}

/**
 * The hosts an address names, with where each is: a link (`mongodb://u:p@h1:27017,h2:27017/db`, `redis://h:6379/0`,
 * `jdbc:postgresql://h/db`), a key=value string (`Host=h;Port=5432;Database=db`, `host=h port=5432 dbname=db`), or a
 * StackExchange.Redis list (`h:6379,abortConnect=false`) when `redis` says so. Null when it is none of these, or names a
 * database squad-kit does not know.
 */
function hostsOf(address: string, redis: boolean | 'address' = false): Hosts | null {
  const text = address;
  const link = /^((?:jdbc:)?)([a-z][a-z0-9+.-]*):\/\//i.exec(text);
  if (link) {
    const scheme = link[2]!.toLowerCase();
    const kind = SCHEMES[scheme];
    if (!kind) return null;
    const from = link[0].length;
    const rest = text.slice(from);
    const stop = rest.search(/[/?#]/);
    const authEnd = stop < 0 ? rest.length : stop;
    const at = rest.lastIndexOf('@', authEnd);
    const hostsStart = from + at + 1;
    // No host (`postgres:///clinic?host=/tmp`): the tools' own default, this computer.
    const raw = text.slice(hostsStart, from + authEnd);
    const endpoints = raw ? split(raw, ',', hostsStart).map((p) => endpoint(p.text, p.start)) : [];
    if (endpoints.some((e) => !e)) return null;
    return { form: 'link', kind, endpoints: endpoints as Endpoint[], ...(scheme === 'mongodb+srv' ? { srv: true } : {}) };
  }
  if (/^\s*[A-Za-z][\w ]*=/.test(text)) {
    // `Host=db;Database=shop` as .NET writes it, or `host=db dbname=shop` as Postgres's own tools do.
    const kind = kindOf(text) ?? kindOfAddress(text);
    if (kind !== 'postgres' && kind !== 'mysql') return null;
    const semi = text.includes(';');
    const pairs = semi ? split(text, ';') : [...text.matchAll(/\S+/g)].map((m) => ({ text: m[0], start: m.index! }));
    const endpoints: Endpoint[] = [];
    let portAt: Hosts['portAt'];
    let port: number | undefined;
    for (const p of pairs) {
      const eq = p.text.indexOf('=');
      if (eq < 0) continue;
      const key = p.text.slice(0, eq).trim().toLowerCase();
      const valueStart = p.start + eq + 1;
      const value = p.text.slice(eq + 1);
      if (key === 'port') {
        const v = value.trim();
        port = Number(v);
        portAt = { start: valueStart + value.indexOf(v), end: valueStart + value.indexOf(v) + v.length };
      } else if (['host', 'server', 'data source', 'address', 'addr', 'network address', 'hostaddr'].includes(key)) {
        for (const e of split(value, ',', valueStart)) {
          const one = endpoint(e.text, e.start);
          if (one) endpoints.push(one);
        }
      }
    }
    for (const e of endpoints) if (e.port === undefined && port) e.port = port;
    return { form: 'pairs', kind, endpoints, ...(portAt ? { portAt } : {}), semi };
  }
  const parts = split(text, ',');
  const hosts = parts.filter((p) => !p.text.includes('='));
  const options = parts.filter((p) => p.text.includes('='));
  if (!hosts.length || parts.indexOf(hosts.at(-1)!) !== hosts.length - 1) return null;
  const endpoints = hosts.map((p) => endpoint(p.text, p.start));
  if (endpoints.some((e) => !e || !HOST_LIKE.test(e.host))) return null;
  // Its own options say it is Redis; else the setting's name does, with a port, or a name for an address.
  const ownOptions = options.some((o) => REDIS_OPTIONS.test(o.text.slice(0, o.text.indexOf('=')).trim()));
  if (!ownOptions && !(redis && (endpoints.every((e) => e!.port) || (redis === 'address' && !options.length)))) return null;
  return { form: 'list', kind: 'redis', endpoints: endpoints as Endpoint[] };
}

/** A host's name or address, not a word like `true` or a number. */
const HOST_LIKE = /^(?!(?:true|false|yes|no|on|off|none|null)$)(?!\d+$)[a-z0-9][\w.-]*$|:/i;

/** A setting's name that says it holds a Redis address: REDIS_URL, Redis__ConnectionString, ConnectionStrings__Redis. */
const REDIS_NAME = /redis/i;
/** A name for an address, not for a switch or a number: Redis__ConnectionString, REDIS_HOST, ConnectionStrings__Redis. */
const ADDRESS_NAME = /conn|url|uri|host|server|endpoint|address|addr|config|^connectionstrings__/i;

/** What a setting's name says of a value with no form of its own: Redis, and whether the name is for an address. */
function redisBy(name: string): boolean | 'address' {
  return REDIS_NAME.test(name) ? (ADDRESS_NAME.test(name) ? 'address' : true) : false;
}

/** The kind of server a setting's value is the address of, or null when it is no database or Redis address. */
export function addressKind(name: string, value: string): AddressKind | null {
  return hostsOf(value.trim(), redisBy(name))?.kind ?? null;
}

/* ── this computer ───────────────────────────────────────── */

/** True when the host is this computer: localhost in any form, a loopback address, a Unix socket, host.docker.internal. */
export function isThisComputer(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return normalHost(h) === 'localhost' || h.startsWith('/') || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h.endsWith('.localhost') || h === '::ffff:127.0.0.1';
}

function serviceOf(host: string, services: ComposeService[]): ComposeService | undefined {
  const h = host.trim().toLowerCase();
  return services.find((s) => s.names.includes(h));
}

/** The port a service publishes here for a port inside it, or undefined when it publishes none for it. */
function publishedPort(s: ComposeService, inside: number): number | undefined {
  return s.ports[inside] ?? (s.hostNetwork ? inside : undefined);
}

/**
 * Rule one: the address with each compose service's name swapped for `localhost` and the port that service publishes on
 * this computer, in the same form. Null when no host in it is a service of the project that publishes its port here, so
 * there is nothing to swap. A mongodb+srv link is never swapped: its name is looked up in DNS. `redis`: the setting is
 * known to hold a Redis address, so a bare `cache:6379` reads as one.
 */
export function swapServiceHost(address: string, services: ComposeService[], redis = false): string | null {
  const h = hostsOf(address, redis ? 'address' : false);
  if (!h || h.srv || !services.length) return null;
  const fallback = DEFAULT_PORT[h.kind];
  const edits: { start: number; end: number; text: string }[] = [];
  let pairPort: number | undefined;
  for (const e of h.endpoints) {
    const s = serviceOf(e.host, services);
    const port = s ? publishedPort(s, e.port ?? fallback) : undefined;
    if (!port) continue;
    const said = /:\d+$/.test(address.slice(e.start, e.end));
    // A host with no port of its own (REDIS_HOST=cache) has nowhere for another one.
    if (!said && port !== fallback && h.form === 'list') continue;
    if (!said && h.form === 'pairs') pairPort = port;
    edits.push({ start: e.start, end: e.end, text: said || (port !== fallback && h.form === 'link') ? `localhost:${port}` : 'localhost' });
  }
  if (!edits.length) return null;
  let tail = '';
  if (pairPort !== undefined) {
    // In key=value, the port is a pair of its own: it changes there, or comes in as one.
    if (h.portAt) {
      if (address.slice(h.portAt.start, h.portAt.end) !== String(pairPort)) edits.push({ ...h.portAt, text: String(pairPort) });
    } else if (pairPort !== fallback) tail = h.semi ? `${/;\s*$/.test(address) ? '' : ';'}Port=${pairPort}` : ` port=${pairPort}`;
  }
  // From the end, so the places before stay where they are.
  let out = address;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out + tail;
}

export type ServerPlace =
  /** On this computer: `address` is how squad-kit reaches it from here (a compose service's name swapped). */
  | { here: true; address: string }
  /** Elsewhere: the first host that is not this computer. `service` when it is a compose service that publishes no port here. */
  | { here: false; host: string; service?: boolean };

/**
 * Rule two: whether a server is on this computer: every host in its address is localhost in some form,
 * host.docker.internal, or a compose service of the project that publishes its port here. A public or private IP, a
 * cloud host and a mongodb+srv link are another computer. A database address in a form only its own kind reads
 * (`Server=db;Database=shop`) is read as that kind; one nothing can read is left to the database's own tools, which
 * refuse it.
 */
export function serverPlace(address: string, services: ComposeService[], o: { redis?: boolean; kind?: DbKind } = {}): ServerPlace {
  const h = hostsOf(address.trim(), o.redis ? 'address' : false);
  let endpoints = h?.endpoints;
  if (h?.srv) return { here: false, host: h.endpoints[0]?.host ?? 'a DNS name' };
  if (!h) {
    if (!o.kind || o.kind === 'sqlite') return { here: true, address };
    try {
      const a = readAddress(o.kind, address);
      if (a.srv) return { here: false, host: a.host };
      endpoints = a.socket ? [] : [{ host: a.host, ...(a.port ? { port: a.port } : {}), start: 0, end: 0 }];
    } catch {
      return { here: true, address };
    }
  }
  const fallback = DEFAULT_PORT[h?.kind ?? (o.kind as AddressKind)];
  for (const e of endpoints ?? []) {
    if (isThisComputer(e.host)) continue;
    const s = serviceOf(e.host, services);
    if (!s) return { here: false, host: e.host };
    if (!publishedPort(s, e.port ?? fallback)) return { here: false, host: e.host, service: true };
  }
  return { here: true, address: swapServiceHost(address, services, o.redis) ?? address };
}

/** The first server an address names, as `host:port`, with `localhost` for this computer; null when it names none. */
export function serverOf(address: string, redis = false): string | null {
  const h = hostsOf(address.trim(), redis ? 'address' : false);
  const e = h?.endpoints[0];
  if (!h || !e) return null;
  const host = isThisComputer(e.host) ? 'localhost' : e.host.toLowerCase();
  return `${host.includes(':') ? `[${host}]` : host}:${e.port ?? DEFAULT_PORT[h.kind]}`;
}

/** The address without a password, in every form: to show and to log. */
export function safeAddress(address: string): string {
  return address
    .replace(/^((?:jdbc:)?[a-z][\w+.-]*:\/\/[^:@/]*:)([^@/]*)@/i, (_m, head: string, pass: string) => (pass ? `${head}***@` : `${head}@`))
    .replace(/((?:^|[;,\s?&])(?:password|pwd)\s*=)([^;,&\s]*)/gi, '$1***');
}

/* ── the app's settings ──────────────────────────────────── */

/** One setting of the app, as a folder has it. */
export interface Setting {
  /** The environment name the app reads it by: ConnectionStrings__Main, REDIS_URL, SPRING_DATASOURCE_URL. */
  name: string;
  value: string;
  /** The file it is in, inside the folder. */
  file: string;
  /** Its key in that file: the name in an env file, `ConnectionStrings:Main` in a .NET settings file. */
  key: string;
  form: 'env' | 'json' | 'properties' | 'compose';
}

/** One setting of the app that holds a database's or a Redis's address. */
export interface AppSetting extends Setting {
  kind: AddressKind;
}

/** KEY=value lines of an env file, quotes taken off. */
function envPairs(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    if (!/^['"]/.test(v)) v = v.replace(/\s+#.*$/, '');
    out.push([m[1]!, v.replace(/^(['"])(.*)\1$/s, '$2')]);
  }
  return out;
}

/** JSON with the comments and trailing commas .NET allows in its settings files. */
function looseJson(text: string): unknown {
  return JSON.parse(text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str: string | undefined) => str ?? '').replace(/,(\s*[}\]])/g, '$1'));
}

/** Every string and number in a .NET settings file three levels down, by its key (`Redis:ConnectionString`). */
function jsonStrings(text: string): [string, string][] {
  let doc: unknown;
  try {
    doc = looseJson(text);
  } catch {
    return [];
  }
  const out: [string, string][] = [];
  const walk = (o: unknown, at: string[]) => {
    if (!o || typeof o !== 'object' || Array.isArray(o) || at.length > 3) return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number') out.push([[...at, k].join(':'), String(v)]);
      else walk(v, [...at, k]);
    }
  };
  walk(doc, []);
  return out;
}

/** The env files compose gives a service (`env_file`), by their paths inside the folder. */
function envFilesOf(doc: ComposeDoc, s: Record<string, unknown>): string[] {
  const list = Array.isArray(s.env_file) ? s.env_file : s.env_file ? [s.env_file] : [];
  return list
    .map((f) => (f && typeof f === 'object' ? (f as { path?: unknown }).path : f))
    .filter((f): f is string => typeof f === 'string')
    .map((f) => path.posix.normalize(path.posix.join(path.posix.dirname(doc.file), f)))
    .filter((f) => !f.startsWith('..') && !EXAMPLE.test(f) && !OTHER_PLACE.test(path.posix.basename(f)));
}

/**
 * The app's settings, as a folder has them: the part's own env file (env-file.ts), the env files compose gives its
 * services and the folder's own (`.env`, `.env.dev`), the compose services' own environment, .NET's appsettings and
 * Spring's application.properties. Files for other places (prod, beta, staging) are left out. When two say the same
 * name, the first wins, in that order.
 */
export function settingsIn(dir: string): Setting[] {
  const files = filesOf(dir);
  const docs = composeDocs(dir, files.compose);
  const out: Setting[] = [];
  const add = (name: string, value: string | undefined, file: string, key: string, form: Setting['form']) => {
    const v = value?.trim();
    if (v && !out.some((s) => s.name === name)) out.push({ name, value: v, file, key, form });
  };
  const services = docs.flatMap((d) => Object.values(d.services).map((s) => ({ doc: d, s: (s ?? {}) as Record<string, unknown> })));
  const envFiles = [...new Set([...envFilesIn(dir), ...services.flatMap(({ doc, s }) => envFilesOf(doc, s)), ...files.env])];
  for (const f of envFiles) for (const [k, v] of envPairs(read(path.join(dir, f)))) add(k, v, f, k, 'env');
  for (const { doc, s } of services) {
    const env = s.environment;
    const pairs: [string, unknown][] = Array.isArray(env) ? env.map((e) => String(e)).filter((e) => e.includes('=')).map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]) : env && typeof env === 'object' ? Object.entries(env as Record<string, unknown>) : [];
    for (const [k, v] of pairs) add(k, plainValue(v), doc.file, k, 'compose');
  }
  for (const f of files.appsettings) for (const [k, v] of jsonStrings(read(path.join(dir, f)))) add(k.split(':').join('__'), v, f, k, 'json');
  for (const f of files.properties) {
    for (const [k, v] of envPairs(read(path.join(dir, f)).replace(/^\s*([\w.-]+)\s*[:=]/gm, '$1='))) add(k.toUpperCase().replace(/[.-]/g, '_'), v, f, k, 'properties');
  }
  return out;
}

/** The app's settings that hold a database's or a Redis's address. */
export function appSettings(dir: string, all: Setting[] = settingsIn(dir)): AppSetting[] {
  return all.flatMap((s) => {
    const kind = addressKind(s.name, s.value);
    return kind ? [{ ...s, kind }] : [];
  });
}

/**
 * The app's database and Redis settings for squad-kit to give an app it starts on this computer, outside the project's
 * Compose network: each address that names a compose service, with `localhost` and the port it publishes here. None for
 * an app squad-kit runs in Compose: its own network knows the names. A story's copy with its own database keeps that
 * one's address, so only its Redis settings change here. Each change is said, without a password: to `log`, or once
 * in the app log.
 */
export function appEnvHere(cwd: string, command: string, log?: (text: string) => void): Record<string, string> {
  try {
    return envHere(cwd, command, log);
  } catch {
    // A project file squad-kit cannot read changes nothing: the app starts as it did.
    return {};
  }
}

function envHere(cwd: string, command: string, log?: (text: string) => void): Record<string, string> {
  if (isCompose(command)) return {};
  const services = composeServices(cwd);
  if (!services.length) return {};
  const own = ownDbWired(cwd);
  // The part's env file gives its own, swapped, with only the names in the log (part-env.ts).
  const partFiles = new Set(envFilesIn(cwd, true));
  const out: Record<string, string> = {};
  for (const s of appSettings(cwd)) {
    if ((own && s.kind !== 'redis') || partFiles.has(s.file)) continue;
    const swapped = swapServiceHost(s.value, services, s.kind === 'redis');
    if (!swapped) continue;
    out[s.name] = swapped;
    const text = `${s.name} in ${s.file} names a Docker service that only Docker's own network knows, so the app squad-kit starts on this computer gets ${safeAddress(swapped)}`;
    if (log) log(text);
    else if (!told.has(`${path.resolve(cwd)}\n${text}`)) {
      // The app log hears it once per copy: a story's app starts again for each round of pictures.
      told.add(`${path.resolve(cwd)}\n${text}`);
      writeLog({ level: 'info', text });
    }
  }
  return out;
}

const told = new Set<string>();

/* ── a settings file missing in a copy ───────────────────── */

/**
 * The address the app in a folder reads for a database setting from its own settings files (appsettings.json,
 * application.properties), when nothing read before them sets it. In a copy that misses a local file, such as an
 * untracked appsettings.Development.json or a .env.dev no one gave stories, this is the address it falls back to.
 * Undefined when an env file or the compose file sets it first, or no settings file holds an address for it.
 */
export function settingsFileAddress(dir: string, setting: DatabaseSetting): { file: string; value: string } | undefined {
  const name = setting.env ?? setting.key?.split(':').join('__');
  if (!name) return undefined;
  const first = settingsIn(dir).find((s) => s.name === name || (s.form === 'json' && setting.key !== undefined && s.key.toLowerCase() === setting.key.toLowerCase()));
  if (!first || (first.form !== 'json' && first.form !== 'properties')) return undefined;
  const kind = addressKind(name, first.value);
  return kind && kind !== 'redis' ? { file: first.file, value: first.value } : undefined;
}
