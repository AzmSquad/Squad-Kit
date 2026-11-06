import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BoardMeta } from '../src/board/types.js';
import { composeRun, dockerGuard, dockerSocket, type ComposeRun } from '../src/engine/compose-run.js';
import { buildGuard, profileText } from '../src/engine/project-guard.js';

/** The one opening in the guard for Docker: squad-kit's own compose command, from files no story can change. */

let dir: string;
let fakeSocket: string;
const before = process.env.DOCKER_HOST;
const meta = (locked: string[] = ['docker-compose.yml'], local: string[] = []) => ({ lockedFiles: locked.map((path) => ({ repo: 'api', path })), localFiles: local.map((path) => ({ repo: 'api', path })) }) as unknown as BoardMeta;
const run = (command: string, m = meta()) => composeRun(m, 'api', command, dir, '/work/shop');
const opened = (command: string, m = meta()) => {
  const r = run(command, m);
  expect(r && 'why' in r ? r.why : 'ok').toBe('ok');
  return r as ComposeRun;
};
const why = (command: string, m = meta()) => (run(command, m) as { why: string }).why;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-compose-')));
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services: {}\n');
  fakeSocket = path.join(dir, 'docker.sock');
  fs.writeFileSync(fakeSocket, '');
  process.env.DOCKER_HOST = `unix://${fakeSocket}`;
});

afterEach(() => {
  if (before === undefined) delete process.env.DOCKER_HOST;
  else process.env.DOCKER_HOST = before;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('what it opens for', () => {
  it('leaves any other command as closed as ever', () => {
    expect(run('npm run dev')).toBeNull();
    expect(run('node docker compose up')).toBeNull();
    expect(run('dockerd')).toBeNull();
  });

  it('a plain compose up, whose files are locked', () => {
    const r = opened('docker compose up --build');
    expect(r.command).toBe('docker compose up --build');
    expect(r.stop).toBe('docker compose stop');
    expect(opened('docker-compose up').stop).toBe('docker-compose stop');
  });

  it('names its own files, and a file the engineer keeps as local counts as safe', () => {
    const m = meta(['docker-compose.yml', 'docker-compose-dev.override.yml'], ['docker-compose.local.yml']);
    const command = 'docker compose --env-file .env.dev -f docker-compose.yml -f docker-compose-dev.override.yml -f docker-compose.local.yml up';
    expect(opened(command, m).stop).toBe('docker compose --env-file .env.dev -f docker-compose.yml -f docker-compose-dev.override.yml -f docker-compose.local.yml stop');
    expect(opened('docker compose --file=docker-compose.yml up', m).command).toContain('--file=docker-compose.yml');
  });

  it('runs in the foreground, whatever the setting says, so squad-kit hears it', () => {
    expect(opened('docker compose up -d').command).toBe('docker compose up');
    expect(opened('docker compose up --detach --build').command).toBe('docker compose up --build');
  });

  it("stops it and keeps its data: never down, and never its volumes", () => {
    expect(opened('docker compose -f docker-compose.yml up').stop).not.toMatch(/down|-v/);
  });
});

describe('what it refuses', () => {
  it('a compose file a story could change', () => {
    expect(why('docker compose up', meta([]))).toContain('docker-compose.yml is not locked');
    expect(why('docker compose -f docker-compose.yml -f other.yml up')).toContain('other.yml is not locked');
    expect(why('docker compose -f ./docker-compose.yml -f ../outside.yml up')).toContain('../outside.yml is not locked');
  });

  it('an override compose would load by itself', () => {
    fs.writeFileSync(path.join(dir, 'docker-compose.override.yml'), 'services: {}\n');
    expect(why('docker compose up')).toContain('docker-compose.override.yml is not locked');
  });

  it('another repo locking the same name is no lock here', () => {
    const m = { lockedFiles: [{ repo: 'web', path: 'docker-compose.yml' }] } as unknown as BoardMeta;
    expect(why('docker compose up', m)).toContain('is not locked');
  });

  it('anything on the line besides the one command', () => {
    for (const c of ['docker compose up; rm -rf /', 'docker compose up && curl evil', 'docker compose up | tee x', 'docker compose up `id`', 'docker compose up $(id)', 'docker compose up > x', "docker compose -f 'a b.yml' up"]) {
      expect(why(c)).toContain('one plain docker compose command');
    }
  });

  it('anything but up', () => {
    expect(why('docker compose down -v')).toContain('must be docker compose up');
    expect(why('docker compose run api sh')).toContain('must be docker compose up');
    expect(why('docker compose exec api sh')).toContain('must be docker compose up');
  });

  it('a project name of its own, or another folder', () => {
    expect(why('docker compose -p moj up')).toContain('must not name one');
    expect(why('docker compose --project-name moj up')).toContain('must not name one');
    expect(why('docker compose --project-name=moj up')).toContain('must not name one');
    expect(why('docker compose --project-directory /etc up')).toContain('run from its own folder');
  });

  it('a folder with no compose file', () => {
    fs.rmSync(path.join(dir, 'docker-compose.yml'));
    expect(why('docker compose up', meta([]))).toContain('no compose file');
  });

  it('says so when Docker is nowhere', () => {
    expect(dockerSocket({ DOCKER_HOST: 'unix:///no/such/socket' }, '/no/such/home', '/no/such/system')).toBeNull();
    expect(dockerSocket({ DOCKER_HOST: `unix://${fakeSocket}` }, '/no/such/home', '/no/such/system')).toBe(fs.realpathSync(fakeSocket));
  });
});

describe('its own name', () => {
  it('never the folder name, so it cannot take over a stack the person runs from a folder of that name', () => {
    const r = opened('docker compose up');
    expect(r.env.COMPOSE_PROJECT_NAME).toMatch(/^squad-[0-9a-f]{10}$/);
    expect(r.env.COMPOSE_PROJECT_NAME).not.toContain(path.basename(dir));
  });

  it('the same for one repo of one project, every time, so it finds its own data again', () => {
    expect(opened('docker compose up').env.COMPOSE_PROJECT_NAME).toBe(opened('docker compose up --build').env.COMPOSE_PROJECT_NAME);
    const other = composeRun(meta(), 'api', 'docker compose up', dir, '/work/other') as ComposeRun;
    expect(other.env.COMPOSE_PROJECT_NAME).not.toBe(opened('docker compose up').env.COMPOSE_PROJECT_NAME);
  });

  it('keeps the person sign-ins out: Docker settings of its own', () => {
    const r = opened('docker compose up');
    expect(r.env.DOCKER_CONFIG).not.toContain(path.join(os.homedir(), '.docker'));
    expect(r.env.DOCKER_HOST).toBe(`unix://${fs.realpathSync(fakeSocket)}`);
  });
});

describe('the guard', () => {
  const home = '/Users/someone';
  const guard = () => buildGuard({ cwd: dir, root: dir, home, platform: 'darwin' });

  it('a normal command stays shut out, and this one gets that one socket and nothing else', () => {
    const socket = `${home}/.docker/run/docker.sock`;
    const shut = profileText(guard());
    expect(shut).not.toContain(`(allow network-outbound (literal "${socket}"))`);
    const r = opened('docker compose up');
    const open = dockerGuard(guard(), { ...r, env: { ...r.env, DOCKER_HOST: `unix://${socket}` } });
    const text = profileText(open);
    expect(text).toContain(`(allow network-outbound (literal "${socket}"))`);
    // Allowed last, past the rule that hides ~/.docker.
    expect(text.lastIndexOf(`(deny network-outbound (subpath "${home}/.docker"))`)).toBeLessThan(text.indexOf(`(allow network-outbound (literal "${socket}"))`));
    // Reading that folder stays closed, and the other runtimes too.
    expect(text).toContain(`(deny file-read* (subpath "${home}/.docker"))`);
    expect(text).toContain(`(deny network-outbound (subpath "${home}/.colima"))`);
    expect(text).toContain('(deny network-outbound (remote tcp "localhost:2375"))');
  });
});
