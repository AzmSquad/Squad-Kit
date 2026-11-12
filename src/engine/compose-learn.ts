import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { ProjectCommands } from '../board/types.js';
import { envFilesOf } from './env-file.js';
import { onPath, realHost } from './tools/detect.js';

/**
 * What a first read learns from a part's Docker Compose files, for a part squad-kit starts on this computer, outside
 * Docker. The env file Compose gives the app its settings from (`env_file:` on the service that builds the part's code,
 * or `--env-file` in a compose command the README or Makefile shows) becomes the part's env file (env-file.ts). And a
 * compose start with fixed names is never saved as the start. squad-kit gives each compose run of its own a project name
 * of its own (compose-run.ts), which wins over a `name:` in the file and keeps volumes and networks apart. A
 * `container_name` is one name on the whole computer, whatever the project: the run would clash with the person's own
 * containers by that name, or take the name before their own stack starts. A project name written in the command is the
 * daily stack's own, and its containers would be replaced. Nothing here runs Docker; it reads files with firm limits.
 */

const COMPOSE_FILE = /^(?:docker-)?compose(?:[.-][\w.-]+)?\.ya?ml$/i;
const OWN_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const OWN_OVERRIDES = ['compose.override.yaml', 'compose.override.yml', 'docker-compose.override.yaml', 'docker-compose.override.yml'];
/** A file for another place than this computer, or an example for people to copy. */
const NOT_HERE = /(?:^|[.\-_])(?:prod|production|beta|staging|stage|uat|preprod|live|release|example|sample|template|dist)(?:[.\-_]|$)/i;
const SKIP_DIRS = new Set(['node_modules', 'bin', 'obj', 'dist', 'build', 'vendor', 'target', 'coverage']);
const FILE_BYTES = 256 * 1024;

function read(file: string): string {
  try {
    return fs.statSync(file).size > FILE_BYTES ? '' : fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** A path in the repo as people write it: forward slashes, no `./`. Empty for one outside the repo. */
function inRepo(p: string): string {
  const clean = path.posix.normalize(p.trim().replace(/\\/g, '/')).replace(/\/$/, '');
  return clean === '.' || clean === '..' || clean.startsWith('../') || path.posix.isAbsolute(clean) ? '' : clean;
}

/** A compose command, also with settings written before it: `COMPOSE_PROJECT_NAME=shop docker compose up`. */
export function composeCommand(command: string | undefined): boolean {
  return /^\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:docker\s+compose|docker-compose)(?:\s|$)/.test(command ?? '');
}

/** The part's compose files, at its top and one folder down, plain ones first. None for another place. */
function composeFiles(dir: string): string[] {
  const out: string[] = [];
  const look = (rel: string) => {
    let list: fs.Dirent[];
    try {
      list = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      if (e.isFile() && COMPOSE_FILE.test(e.name) && !NOT_HERE.test(e.name.replace(/\.ya?ml$/i, ''))) out.push(rel ? `${rel}/${e.name}` : e.name);
      else if (!rel && e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) look(e.name);
    }
  };
  look('');
  const dots = (f: string) => path.posix.basename(f).split('.').length;
  return out.sort((a, b) => a.split('/').length - b.split('/').length || dots(a) - dots(b) || a.localeCompare(b));
}

interface Service {
  name: string;
  /** The compose file it is in. */
  file: string;
  /** Where its code is built from, in the repo, when it builds the part's own code. */
  build?: string;
  container?: string;
  /** The env files compose gives it, as paths in the repo. */
  envFiles: string[];
}

/** The services of these compose files, and a project name a file gives itself. */
function servicesIn(dir: string, files: string[]): { services: Service[]; project?: string } {
  const services: Service[] = [];
  let project: string | undefined;
  for (const file of files) {
    let doc: { name?: unknown; services?: Record<string, Record<string, unknown> | null> } | undefined;
    try {
      doc = yaml.load(read(path.join(dir, file))) as typeof doc;
    } catch {
      continue;
    }
    if (!doc || typeof doc !== 'object') continue;
    if (typeof doc.name === 'string' && doc.name.trim()) project ??= doc.name.trim();
    const from = path.posix.dirname(file);
    for (const [name, raw] of Object.entries(doc.services && typeof doc.services === 'object' ? doc.services : {})) {
      const s = raw ?? {};
      const build = typeof s.build === 'string' ? s.build : s.build && typeof s.build === 'object' ? String((s.build as { context?: unknown }).context ?? '.') : undefined;
      const list = Array.isArray(s.env_file) ? s.env_file : s.env_file ? [s.env_file] : [];
      const envFiles = list
        .map((f) => (f && typeof f === 'object' ? (f as { path?: unknown }).path : f))
        .filter((f): f is string => typeof f === 'string')
        .map((f) => inRepo(path.posix.join(from, f)))
        .filter((f) => f && !NOT_HERE.test(path.posix.basename(f)));
      const container = typeof s.container_name === 'string' && s.container_name.trim() ? s.container_name.trim() : undefined;
      services.push({ name, file, ...(build !== undefined ? { build: inRepo(path.posix.join(from, build)) } : {}), ...(container ? { container } : {}), envFiles });
    }
  }
  return { services, ...(project ? { project } : {}) };
}

/** The env files compose commands in some text read with `--env-file`, as paths in the repo. */
export function envFileFlags(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (!/(?:docker\s+compose|docker-compose)(?:\s|$)/.test(line)) continue;
    for (const m of line.matchAll(/\s--env-file(?:=|\s+)(['"]?)([^\s'"`]+)\1/g)) {
      const f = inRepo(m[2]!);
      if (f && !NOT_HERE.test(path.posix.basename(f)) && !out.includes(f)) out.push(f);
    }
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The env file to give a part that starts on this computer, and where it was found: from the compose service that builds
 * the part's code (the one the start names first), else from `--env-file` in a compose command. Null when the part
 * starts in Compose, has no start, has an env file already, or nothing says one.
 */
export function envFileToLearn(dir: string, commands: ProjectCommands): { envFile: string; from: string } | null {
  const start = commands.start?.trim();
  if (!start || composeCommand(start) || envFilesOf(commands).length) return null;
  const apps = servicesIn(dir, composeFiles(dir)).services.filter((s) => s.build !== undefined && s.envFiles.length);
  const named = (s: Service) => Boolean(s.build && start.includes(s.build)) || new RegExp(`(?:^|[^\\w-])${escape(s.name)}(?:[^\\w-]|$)`, 'i').test(start);
  const app = apps.find(named) ?? apps[0];
  if (app) return { envFile: app.envFiles.join(', '), from: `${app.file} gives the ${app.name} service its settings from it` };
  const readme = ['README.md', 'readme.md', 'Readme.md', 'README'].find((f) => fs.existsSync(path.join(dir, f)));
  const places: [string, string][] = [...(readme ? ([[readme, read(path.join(dir, readme))]] as [string, string][]) : []), ['Makefile', read(path.join(dir, 'Makefile'))], ['its commands', Object.values(commands).join('\n')]];
  for (const [where, text] of places) {
    const flags = envFileFlags(text);
    if (flags.length) return { envFile: flags.join(', '), from: `a compose command in ${where} reads it with --env-file` };
  }
  return null;
}

/**
 * What in a compose start would take the names of the person's daily stack, in words for engineers, or null: a fixed
 * `container_name` in the files it runs, or a project name written in the command or in the file.
 */
export function composeStartRisk(dir: string, command: string | undefined): string | null {
  if (!command || !composeCommand(command)) return null;
  const words = command.trim().split(/\s+/);
  const named: string[] = [];
  let project: string | undefined;
  for (let i = 0; i < words.length && words[i] !== 'up'; i += 1) {
    const w = words[i]!;
    if (w.startsWith('COMPOSE_PROJECT_NAME=')) project = w.slice(21);
    else if (w === '-p' || w === '--project-name') project = words[i + 1];
    else if (w.startsWith('--project-name=')) project = w.slice(15);
    else if (w === '-f' || w === '--file') named.push(words[(i += 1)] ?? '');
    else if (w.startsWith('--file=')) named.push(w.slice(7));
  }
  const here = (f: string) => fs.existsSync(path.join(dir, f));
  const files = named.length ? named.map(inRepo).filter(Boolean) : [...OWN_FILES.filter(here).slice(0, 1), ...OWN_OVERRIDES.filter(here)];
  const found = servicesIn(dir, files);
  const fixed = found.services.flatMap((s) => (s.container ? [s.container] : []));
  if (fixed.length) return `fixed container names (${fixed.slice(0, 3).join(', ')}${fixed.length > 3 ? ', …' : ''})`;
  const name = project?.replace(/^['"]|['"]$/g, '') || found.project;
  return name ? `the project name ${name}` : null;
}

/** The program a command runs: `dotnet` in `dotnet run …`, after any settings written before it. */
function programOf(command: string): string {
  return command.trim().split(/\s+/).find((w) => !/^[A-Za-z_]\w*=/.test(w)) ?? '';
}

/** True when a program is on this computer, as the checks and the app will find it. */
export function onThisComputer(program: string): boolean {
  return Boolean(program && onPath(realHost(), program));
}

/**
 * A first read's commands with what the compose files teach, changed in place. A compose start with fixed names is never
 * saved: the start squad-kit finds for this computer takes its place when its program is here, or there is none. A part
 * that starts on this computer gets the env file Compose gives its app. Each change is one line, for the log.
 */
export function learnFromCompose(dir: string, commands: ProjectCommands, found: ProjectCommands, here: (program: string) => boolean = onThisComputer): string[] {
  const changed: string[] = [];
  const risk = composeStartRisk(dir, commands.start);
  if (risk) {
    const was = commands.start!;
    delete commands.start;
    delete commands.url;
    const host = found.start && !composeCommand(found.start) ? found.start : undefined;
    const program = host ? programOf(host) : '';
    const why = `The read's start command (${was}) runs Docker Compose with ${risk}, which your own Docker stack uses too, so squad-kit never saves it as the start`;
    if (host && here(program)) {
      commands.start = host;
      if (found.url) commands.url = found.url;
      changed.push(`${why}: it starts the app on this computer instead, with ${host}.`);
    } else changed.push(`${why}. ${host ? `Its start for this computer needs ${program}, which is not on this computer: ${host}` : 'It found no start for this computer'}. An engineer can set one in Settings.`);
  }
  const learned = envFileToLearn(dir, commands);
  if (learned) {
    commands.envFile = learned.envFile;
    changed.push(`The app starts on this computer, and ${learned.from}, so squad-kit gives the app the settings in ${learned.envFile}, with its own database, Redis and port on top.`);
  }
  return changed;
}
