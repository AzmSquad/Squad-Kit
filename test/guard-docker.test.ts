import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { GUARD_BLOCKED_DOCKER, blockedDocker, bubblewrapArgs, buildGuard, guardBlockedDetail, guardBlockedPath, guardSupport, profileText, spawnProject, type GuardSpec } from '../src/engine/project-guard.js';

/**
 * A container runtime is a way round the guard: a command that reaches its socket can start a container with any folder
 * mounted in it, and read there what the guard hides from it. So no command connects to one, on a Mac with a real
 * connect in the real guard. No Docker is needed for that: a fixture socket stands in for each one. When Docker answers on
 * this computer, its real socket and a real mount are tried as well.
 */

const onMac = process.platform === 'darwin' && guardSupport().on;

let base: string;
let home: string;
let copy: string;
let client: string;
const servers: ChildProcess[] = [];

/** A socket that says hello, served from its own folder: a path to a socket may be 104 characters at most. */
async function serve(file: string): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const child = spawn(process.execPath, ['-e', "require('net').createServer((c)=>{c.on('error',()=>{});c.end('hi')}).listen(process.argv[1])", path.basename(file)], { cwd: path.dirname(file), stdio: 'ignore' });
  servers.push(child);
  for (let i = 0; i < 200 && !fs.existsSync(file); i += 1) await new Promise((r) => setTimeout(r, 25));
  expect(fs.existsSync(file)).toBe(true);
}

/** Runs a connect in the guard: what the connect said, or what came out instead. Only `CONNECTED` and an error's code are told apart. */
function connect(guard: GuardSpec, target: string, cwd = copy): Promise<string> {
  return new Promise((done) => {
    const child = spawnProject(`cd ${JSON.stringify(cwd)} && ${JSON.stringify(process.execPath)} ${JSON.stringify(client)} ${JSON.stringify(target)}`, { cwd: copy, guard });
    let said = '';
    child.stdout?.on('data', (d: Buffer) => (said += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (said += d.toString()));
    child.on('close', () => done(said.trim()));
  });
}

/** A path that fits the limit as it is; or from its own folder, which is all the same to the guard. */
const reach = (guard: GuardSpec, file: string) => (file.length < 100 ? connect(guard, file) : connect(guard, path.basename(file), path.dirname(file)));
const guardFor = (allow?: { allowRead?: string[]; allowWrite?: string[] }) => buildGuard({ cwd: copy, root: base, home, platform: process.platform, ...(allow ? { allow } : {}) });

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(process.cwd(), '.dk-')));
  home = path.join(base, 'h');
  copy = path.join(base, 'c');
  fs.mkdirSync(home);
  fs.mkdirSync(copy);
  client = path.join(copy, 'c.mjs');
  fs.writeFileSync(client, `import net from 'node:net';\nconst [a, b] = process.argv.slice(2);\nconst c = b ? net.connect(Number(b), a) : net.connect(a);\nc.on('connect', () => { console.log('CONNECTED'); c.destroy(); });\nc.on('error', (e) => console.log(e.code));\n`);
});

afterEach(() => {
  for (const s of servers.splice(0)) s.kill();
  delete process.env.DOCKER_HOST;
  fs.rmSync(base, { recursive: true, force: true });
});

describe.runIf(onMac)('on a Mac, a real connect in the real guard', () => {
  it('Docker\'s socket is refused, and a socket in the copy still connects', async () => {
    const docker = path.join(home, '.docker', 'run', 'docker.sock');
    const own = path.join(copy, 'db.sock');
    await serve(docker);
    await serve(own);
    const guard = guardFor();
    expect(await connect(guard, docker)).toBe('EPERM');
    expect(await connect(guard, own)).toBe('CONNECTED');
  });

  it.each([
    '.docker/desktop/docker.sock',
    '.colima/default/docker.sock',
    '.lima/default/sock/docker.sock',
    '.rd/docker.sock',
    '.orbstack/run/docker.sock',
    '.finch/finch.sock',
    '.local/share/containers/podman/machine/podman.sock',
    'Library/Containers/com.docker.docker/Data/docker.raw.sock',
    'Library/Containers/com.docker.docker/Data/docker-cli.sock',
    'Library/Containers/com.docker.docker/Data/backend.sock',
    'Library/Group Containers/HUAUUMT7XC.dev.orbstack/run/docker.sock',
    'Library/Application Support/rancher-desktop/lima/0/sock/docker',
  ])('so is %s', async (rel) => {
    const file = path.join(home, rel);
    await serve(file);
    expect(await reach(guardFor(), file)).toBe('EPERM');
  });

  it('no way round: a link in the copy, a linked folder, a path from another folder', async () => {
    const docker = path.join(home, '.docker', 'run', 'docker.sock');
    await serve(docker);
    fs.symlinkSync(docker, path.join(copy, 'l.sock'));
    fs.symlinkSync(path.dirname(docker), path.join(copy, 'd'));
    const guard = guardFor();
    expect(await connect(guard, path.join(copy, 'l.sock'))).toBe('EPERM');
    expect(await connect(guard, path.join(copy, 'd', 'docker.sock'))).toBe('EPERM');
    expect(await connect(guard, path.relative(copy, docker))).toBe('EPERM');
    // Nor a hard link to it, or a move: the real one is where it was.
    const moved = spawnSync('/usr/bin/sandbox-exec', ['-p', profileText(guard), '/bin/sh', '-c', `ln "${docker}" "${copy}/h.sock"; mv "${docker}" "${copy}/m.sock"`], { cwd: copy });
    expect(moved.status).not.toBe(0);
    expect(fs.existsSync(path.join(copy, 'h.sock'))).toBe(false);
    expect(fs.existsSync(path.join(copy, 'm.sock'))).toBe(false);
  });

  it('the place DOCKER_HOST names, and the real place of a link: as /var/run/docker.sock is on many Macs', async () => {
    const real = path.join(base, 'r', 'a.sock');
    await serve(real);
    fs.mkdirSync(path.join(base, 'v'));
    fs.symlinkSync(real, path.join(base, 'v', 'docker.sock'));
    process.env.DOCKER_HOST = `unix://${path.join(base, 'v', 'docker.sock')}`;
    const guard = guardFor();
    expect(guard.noConnect).toContain(real);
    expect(await connect(guard, real)).toBe('EPERM');
    expect(await connect(guard, path.join(base, 'v', 'docker.sock'))).toBe('EPERM');
  });

  it('the system\'s own places are in the profile, by both their names', () => {
    const text = profileText(guardFor());
    for (const place of ['/var/run/docker.sock', '/private/var/run/docker.sock', '/var/run/podman', '/private/var/run/podman', '/var/run/finch.sock', '/private/tmp/podman']) {
      expect(text).toContain(`(deny network-outbound (subpath "${place}"))`);
    }
  });

  it('Docker\'s port is refused, by every name of this computer, and another port is not', async () => {
    const guard = guardFor();
    for (const [host, port] of [['127.0.0.1', 2375], ['127.0.0.1', 2376], ['::1', 2375], ['::1', 2376], ['localhost', 2375]] as const) {
      expect(await connectPort(guard, host, port)).toBe('EPERM');
    }
    const server = net.createServer((c) => {
      c.on('error', () => undefined);
      c.end('hi');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    expect(await connectPort(guard, '127.0.0.1', port)).toBe('CONNECTED');
    server.close();
  });

  it('what common things need still connects: DNS on a Mac, and a local database in the temp folder', async () => {
    const guard = guardFor();
    expect(await connect(guard, '/var/run/mDNSResponder')).toBe('CONNECTED');
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-')));
    const pg = path.join(temp, '.s.PGSQL.5432');
    await serve(pg);
    expect(await reach(guard, pg)).toBe('CONNECTED');
    fs.rmSync(temp, { recursive: true, force: true });
  });

  it('a person\'s own choice stays: the folder or the socket they allowed, and nothing more', async () => {
    const docker = path.join(home, '.docker', 'run', 'docker.sock');
    const colima = path.join(home, '.colima', 'default', 'docker.sock');
    await serve(docker);
    await serve(colima);
    for (const allow of [{ allowRead: [path.dirname(docker)] }, { allowWrite: [path.dirname(docker)] }, { allowWrite: [docker] }]) {
      const guard = guardFor(allow);
      expect(await connect(guard, docker)).toBe('CONNECTED');
      expect(await connect(guard, colima)).toBe('EPERM');
    }
    expect(await connect(guardFor(), docker)).toBe('EPERM');
  });
});

const dockerCommand = spawnSync('docker', ['--version'], { stdio: 'ignore' }).status === 0;

describe.runIf(onMac && dockerCommand)('the real docker command, in the real guard, with a fixture socket', () => {
  it('its own words at the refusal read plainly, and no container is started', async () => {
    const socket = path.join(home, '.docker', 'run', 'docker.sock');
    await serve(socket);
    const guard = guardFor();
    const settings = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-settings-'));
    const said = await new Promise<string>((done) => {
      const child = spawnProject('docker ps', { cwd: copy, guard, env: { DOCKER_CONFIG: settings, DOCKER_HOST: `unix://${socket}` } });
      let words = '';
      child.stdout?.on('data', (d: Buffer) => (words += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (words += d.toString()));
      child.on('close', () => done(words));
    });
    fs.rmSync(settings, { recursive: true, force: true });
    expect(said).toMatch(/not permitted/i);
    expect(guardBlockedPath(said, guard)).toBe(socket);
    expect(blockedDocker(socket, guard)).toBe(true);
    expect(guardBlockedDetail(socket, 'a test', guard)).toContain('Docker is not open');
  });
});

/** A connect to a port, as `connect` to a socket. */
function connectPort(guard: GuardSpec, host: string, port: number): Promise<string> {
  return new Promise((done) => {
    const child = spawnProject(`${JSON.stringify(process.execPath)} ${JSON.stringify(client)} ${JSON.stringify(host)} ${port}`, { cwd: copy, guard });
    let said = '';
    child.stdout?.on('data', (d: Buffer) => (said += d.toString()));
    child.on('close', () => done(said.trim()));
  });
}

/** Docker's own socket, when it answers here and the small image is on this computer. */
function dockerHere(): string | null {
  try {
    execSync('docker image inspect busybox:1.36', { stdio: 'ignore', timeout: 20_000 });
    const host = execSync("docker context inspect --format '{{.Endpoints.docker.Host}}'", { encoding: 'utf8', timeout: 20_000 }).trim();
    return host.startsWith('unix://') ? host.slice('unix://'.length) : null;
  } catch {
    return null;
  }
}

describe.runIf(onMac && Boolean(dockerHere()))('with Docker answering on this computer', () => {
  /** A command that sets the socket's address itself, with settings of its own: all it takes. */
  function inGuard(line: string, guard: GuardSpec, socket: string): Promise<{ code: number | null; said: string }> {
    const settings = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-settings-'));
    return new Promise((done) => {
      const child = spawnProject(line, { cwd: copy, guard, env: { DOCKER_CONFIG: settings, DOCKER_HOST: `unix://${socket}` } });
      let said = '';
      child.stdout?.on('data', (d: Buffer) => (said += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (said += d.toString()));
      child.on('close', (code) => {
        fs.rmSync(settings, { recursive: true, force: true });
        done({ code, said });
      });
    });
  }
  const realGuard = (allow?: { allowRead?: string[]; allowWrite?: string[] }) => buildGuard({ cwd: copy, root: base, home: os.homedir(), platform: process.platform, ...(allow ? { allow } : {}) });

  it('a mount of a hidden folder is refused, and says so plainly', async () => {
    const socket = dockerHere()!;
    const hidden = path.join(base, 'hidden');
    fs.mkdirSync(hidden);
    fs.writeFileSync(path.join(hidden, 'marker.txt'), 'THE-MARKER\n');
    const guard = realGuard();
    guard.noRead.push(hidden);
    const direct = await inGuard(`cat "${hidden}/marker.txt"`, guard, socket);
    expect(direct.said).not.toContain('THE-MARKER');
    const through = await inGuard(`docker run --rm --pull never --network none --name sk-guard-test-${process.pid} -v "${hidden}:/x:ro" busybox:1.36 cat /x/marker.txt`, guard, socket);
    expect(through.code).not.toBe(0);
    expect(through.said).not.toContain('THE-MARKER');
    const target = guardBlockedPath(through.said, guard);
    expect(target).toBeTruthy();
    expect(blockedDocker(target!, guard)).toBe(true);
    expect(guardBlockedDetail(target!, 'a test', guard)).toContain('Docker is not open');
  });

  it('with no settings of its own the docker command is refused too, and says so plainly', async () => {
    const guard = realGuard();
    const r = await new Promise<string>((done) => {
      const child = spawnProject('docker ps', { cwd: copy, guard });
      let said = '';
      child.stdout?.on('data', (d: Buffer) => (said += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (said += d.toString()));
      child.on('close', () => done(said));
    });
    const target = guardBlockedPath(r, guard);
    expect(target).toBeTruthy();
    expect(blockedDocker(target!, guard)).toBe(true);
  });

  it('a person who allowed the socket\'s folder can reach Docker, read only', async () => {
    const socket = dockerHere()!;
    const allowed = await inGuard("docker version --format '{{.Server.Version}}'", realGuard({ allowWrite: [path.dirname(fs.realpathSync(socket))] }), socket);
    expect(allowed.code).toBe(0);
    expect(allowed.said.trim()).toMatch(/^\d+\./);
    expect(guardBlockedPath(allowed.said, realGuard({ allowWrite: [path.dirname(fs.realpathSync(socket))] }))).toBeNull();
  });
});

describe('Finch on a Mac keeps its machine in the app\'s own folder', () => {
  it('its socket and the keys into its machine are shut, and only on a Mac', () => {
    const on = (platform: NodeJS.Platform) => buildGuard({ cwd: copy, root: base, home: '/home/me', platform });
    expect(on('darwin').noConnect).toContain('/Applications/Finch/lima/data/finch/sock');
    expect(on('darwin').noRead).toContain('/Applications/Finch/lima/data/_config');
    expect(on('linux').noConnect).not.toContain('/Applications/Finch/lima/data/finch/sock');
    expect(on('linux').noRead).not.toContain('/Applications/Finch/lima/data/_config');
  });
});

describe('a refusal reads plainly', () => {
  const guard = () => buildGuard({ cwd: '/w/copy', root: '/w', home: '/home/me', platform: 'linux' });

  it.each([
    ['the docker command, on a socket', 'permission denied while trying to connect to the Docker daemon socket at unix:///home/me/.docker/run/docker.sock: Head "http://%2Fhome%2Fme%2F.docker%2Frun%2Fdocker.sock/_ping": dial unix /home/me/.docker/run/docker.sock: connect: operation not permitted', '/home/me/.docker/run/docker.sock'],
    ['the docker command, with nothing there', 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', '/var/run/docker.sock'],
    ['the docker command, on its port', 'Cannot connect to the Docker daemon at tcp://localhost:2375. Is the docker daemon running?', 'localhost:2375'],
    ['Go, on a port', 'dial tcp 127.0.0.1:2376: connect: operation not permitted', 'localhost:2376'],
    ['Node, on a socket', 'Error: connect EPERM /var/run/docker.sock', '/var/run/docker.sock'],
    ['Node, on a port', 'Error: connect EPERM 127.0.0.1:2375 - Local (0.0.0.0:0)', 'localhost:2375'],
    ['a test library that does not say where', 'Error: Could not find a working container runtime strategy', 'Docker'],
    ['another one', 'java.lang.IllegalStateException: Could not find a valid Docker environment. Please see logs and check configuration', 'Docker'],
    ['Python', "docker.errors.DockerException: Error while fetching server API version: ('Connection aborted.', PermissionError(1, 'Operation not permitted'))", 'Docker'],
  ])('%s', (_, said, target) => {
    const g = guard();
    expect(guardBlockedPath(said, g)).toBe(target);
    expect(blockedDocker(target, g)).toBe(true);
    const detail = guardBlockedDetail(target, 'npm test', g);
    expect(detail).toContain('Docker is not open');
    expect(detail).toContain('npm test');
  });

  it('a socket of the project\'s own is no such refusal, nor is one a person allowed', () => {
    const g = guard();
    expect(guardBlockedPath('Error: connect ECONNREFUSED /w/copy/db.sock', g)).toBeNull();
    const allowed = buildGuard({ cwd: '/w/copy', root: '/w', home: '/home/me', platform: 'linux', allow: { allowWrite: ['/var/run'] } });
    expect(guardBlockedPath('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', allowed)).toBeNull();
  });

  it('a library that does not say where is no such refusal once a person allowed a socket', () => {
    const allowed = buildGuard({ cwd: '/w/copy', root: '/w', home: '/home/me', platform: 'linux', allow: { allowWrite: ['/home/me/.docker/run'] } });
    expect(guardBlockedPath('Error: Could not find a working container runtime strategy', allowed)).toBeNull();
  });

  it('the one plain sentence names Docker and how to go on, and no path', () => {
    expect(GUARD_BLOCKED_DOCKER).toContain('Docker');
    expect(GUARD_BLOCKED_DOCKER).toContain('Settings');
    expect(GUARD_BLOCKED_DOCKER).not.toMatch(/\/|sock/);
  });
});

describe('the shape on Linux: read only is no bar to a connection, so the sockets are hidden', () => {
  function at(args: string[], flag: string, place: string): number {
    return args.findIndex((a, i) => a === place && args[i - 1] === flag);
  }

  it('a socket goes behind an empty file, a folder behind an empty mount, before anything is opened', () => {
    const uhome = path.join(base, 'u');
    const socket = path.join(uhome, '.rd', 'docker.sock');
    fs.mkdirSync(path.dirname(socket), { recursive: true });
    fs.writeFileSync(socket, '');
    fs.mkdirSync(path.join(uhome, '.colima'));
    fs.mkdirSync(path.join(uhome, '.docker', 'desktop'), { recursive: true });
    process.env.DOCKER_HOST = `unix://${socket}`;
    const args = bubblewrapArgs(buildGuard({ cwd: copy, root: base, home: uhome, platform: 'linux' }), 'x');
    expect(at(args, '/dev/null', socket)).toBeGreaterThan(-1);
    expect(args[at(args, '/dev/null', socket) - 2]).toBe('--ro-bind-try');
    expect(at(args, '--tmpfs', path.join(uhome, '.colima'))).toBeGreaterThan(-1);
    expect(at(args, '--tmpfs', path.join(uhome, '.docker'))).toBeGreaterThan(-1);
    // After what is opened, as temp holds a runtime's socket too.
    expect(at(args, '--tmpfs', path.join(uhome, '.colima'))).toBeGreaterThan(at(args, '--bind', copy));
  });

  it('a socket with no dot in its name does not stop bubblewrap: it never takes a folder\'s mount', async () => {
    const uhome = path.join(base, 'u');
    const socket = path.join(uhome, '.rd', 'docker');
    await serve(socket);
    process.env.DOCKER_HOST = `unix://${socket}`;
    const args = bubblewrapArgs(buildGuard({ cwd: copy, root: base, home: uhome, platform: 'linux' }), 'x');
    expect(at(args, '/dev/null', socket)).toBeGreaterThan(-1);
    expect(at(args, '--tmpfs', socket)).toBe(-1);
  });

  it('what a person allowed comes back after the hiding, as a later mount wins', () => {
    const uhome = path.join(base, 'u');
    const socket = path.join(uhome, '.colima', 'default', 'docker.sock');
    fs.mkdirSync(path.dirname(socket), { recursive: true });
    fs.writeFileSync(socket, '');
    const allowed = path.dirname(socket);
    const args = bubblewrapArgs(buildGuard({ cwd: copy, root: base, home: uhome, platform: 'linux', allow: { allowRead: [allowed] } }), 'x');
    expect(at(args, '--ro-bind-try', allowed)).toBeGreaterThan(at(args, '--tmpfs', path.join(uhome, '.colima')));
  });

  it('the rootless place and the system\'s places are on the list', () => {
    const was = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = '/run/user/1234';
    try {
      const { noConnect } = buildGuard({ cwd: copy, root: base, home: '/home/me', platform: 'linux' });
      for (const place of ['/var/run/docker.sock', '/run/docker.sock', '/run/podman', '/run/user/1234/docker.sock', '/run/user/1234/podman', '/home/me/.docker', '/home/me/.colima', '/home/me/.lima', '/home/me/.local/share/containers/podman']) expect(noConnect).toContain(place);
    } finally {
      if (was === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = was;
    }
  });
});
