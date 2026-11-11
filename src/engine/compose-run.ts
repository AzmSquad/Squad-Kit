import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BoardMeta } from '../board/types.js';
import { squadHome } from '../core/home.js';
import type { GuardSpec } from './project-guard.js';

/**
 * A part that runs in Docker. The guard keeps Docker from a project's commands, since a container can mount any folder.
 * squad-kit opens it for one thing only: its own `docker compose up`, from the project's settings, and only when an engineer
 * locked every compose file it names, so no story can change what it mounts. It always has a project name of its own:
 * compose would otherwise take the folder's name, the same as the person's own stack, and take over its containers.
 */

/** A first build can take a long time, and stopping a database should not be rushed. */
export const DOCKER_WAIT_MS = 20 * 60_000;
export const DOCKER_STOP_MS = 2 * 60_000;

export interface ComposeRun {
  /** The plain command to run: in the foreground, so squad-kit hears what it prints and when it ends. */
  command: string;
  /** What stops it, and keeps its data: never `down -v`. */
  stop: string;
  /** Its project name, the socket, and Docker settings of its own, so a person's sign-ins stay hidden. */
  env: Record<string, string>;
}

const OWN_COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const OWN_OVERRIDES = ['compose.override.yaml', 'compose.override.yml', 'docker-compose.override.yaml', 'docker-compose.override.yml'];
const VALUE_FLAGS = new Set(['-f', '--file', '--env-file', '--profile', '--parallel', '--ansi', '--progress', '--project-directory']);

export const isCompose = (command: string): boolean => /^\s*(docker\s+compose|docker-compose)(\s|$)/.test(command);

/** Docker's socket on this computer, where it really is. */
export function dockerSocket(env: NodeJS.ProcessEnv = process.env, home = os.homedir(), system = '/var/run/docker.sock'): string | null {
  const named = /^unix:\/\/(\/.+)$/.exec(env.DOCKER_HOST?.trim() ?? '')?.[1];
  for (const place of [named, path.join(home, '.docker', 'run', 'docker.sock'), system]) {
    if (!place) continue;
    try {
      return fs.realpathSync(place);
    } catch {
      // Not there.
    }
  }
  return null;
}

/**
 * What squad-kit may run for a start command: null when it is no compose command, and it stays as closed as any other. A
 * compose command it cannot open says why, in words for an engineer.
 */
export function composeRun(meta: BoardMeta, repo: string, command: string, dir: string, root: string): ComposeRun | { why: string } | null {
  if (!isCompose(command)) return null;
  const cannot = (why: string) => ({ why: `squad-kit cannot run this part's Docker command: ${why}` });
  if (/[;&|`$<>\n()\\'"]/.test(command)) return cannot('it must be one plain docker compose command, with nothing else on the line.');
  const words = command.trim().split(/\s+/);
  const start = words[0] === 'docker' ? 2 : 1;
  const up = words.indexOf('up', start);
  if (up < 0) return cannot('it must be docker compose up.');
  const named: string[] = [];
  for (let i = start; i < up; i += 1) {
    const w = words[i]!;
    if (w === '-p' || w.startsWith('--project-name')) return cannot('squad-kit gives it its own project name, so it must not name one.');
    if (w === '--project-directory' || w.startsWith('--project-directory=')) return cannot('it must run from its own folder.');
    if (w === '-f' || w === '--file') named.push(words[(i += 1)] ?? '');
    else if (w.startsWith('--file=')) named.push(w.slice(7));
    else if (VALUE_FLAGS.has(w)) i += 1;
  }
  const inFolder = (f: string) => fs.existsSync(path.join(dir, f));
  const files = named.length ? named : [...OWN_COMPOSE_FILES.filter(inFolder).slice(0, 1), ...OWN_OVERRIDES.filter(inFolder)];
  if (!files.length) return cannot('it has no compose file.');
  const safe = (meta.lockedFiles ?? []).concat(meta.localFiles ?? []).filter((f) => f.repo === repo).map((f) => f.path);
  const open = files.filter((f) => !safe.includes(path.normalize(f)));
  if (open.length) return cannot(`${open.join(', ')} ${open.length === 1 ? 'is' : 'are'} not locked, so a story could change what it mounts. An engineer can lock the Docker files in Settings.`);
  const socket = dockerSocket();
  if (!socket) return cannot('Docker is not running on this computer, or squad-kit cannot find it.');
  const name = `squad-${createHash('sha1').update(`${root}\n${repo}`).digest('hex').slice(0, 10)}`;
  const config = path.join(squadHome(), 'docker-config');
  fs.mkdirSync(config, { recursive: true });
  const before = words.slice(0, up);
  // In the foreground, whatever the setting says: a command that ends at once would look like an app that stopped.
  const after = words.slice(up + 1).filter((w) => w !== '-d' && w !== '--detach');
  return {
    command: [...before, 'up', ...after].join(' '),
    stop: [...before, 'stop'].join(' '),
    env: { COMPOSE_PROJECT_NAME: name, DOCKER_HOST: `unix://${socket}`, DOCKER_CONFIG: config },
  };
}

/** The guard for one such command: everything as closed as before, and that one socket open. */
export function dockerGuard(guard: GuardSpec, run: ComposeRun): GuardSpec {
  const socket = run.env.DOCKER_HOST!.replace(/^unix:\/\//, '');
  const under = (place: string, base: string) => place === base || place.startsWith(`${base}/`);
  return { ...guard, noConnect: guard.noConnect.filter((s) => !under(socket, s) && !under(s, socket)), openSocket: socket, read: [...guard.read, run.env.DOCKER_CONFIG!], write: [...guard.write, run.env.DOCKER_CONFIG!] };
}
