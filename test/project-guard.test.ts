import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * squad-kit's own guard for the project's own commands (decision 8 of the agent's room plan): the checks, the app and
 * the setup commands run in Seatbelt on a Mac and bubblewrap on Linux, where they work normally and may reach the
 * network, but cannot read the person's keys, squad-kit's own folder or the project's .env files. This covers the
 * profile text, the environment scrub, the bubblewrap arguments, the blocked-path detection and the single gate.
 */

const {
  allowPath,
  buildGuard,
  makeOwnFolders,
  profileText,
  bubblewrapArgs,
  projectEnv,
  isSecretEnv,
  guardSupportOn,
  guardBlockedPath,
  spawnProject,
  GUARD_BLOCKED,
} = await import('../src/engine/project-guard.js');

let base: string;
let home: string;
let root: string;
let cwd: string;
let cache: string;

beforeEach(() => {
  // Not under the system temp: the guard allows temp, so a fake home there would make its own .ssh readable. A real
  // home (~) and project folder are never under temp, so the test keeps them outside it too, here under the worktree.
  base = fs.mkdtempSync(path.join(process.cwd(), '.guardtest-'));
  home = path.join(base, 'home');
  root = path.join(base, 'project');
  // Beside the project, as a real copy is: a command in the project's own folder does not read its .env files.
  cwd = path.join(base, 'copy');
  cache = path.join(home, 'projects', 'p', 'caches', 'ma-12');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(root);
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function guard(allow?: { allowRead?: string[]; allowWrite?: string[] }) {
  return buildGuard({ cwd, root, cache, extraWrite: [path.join(home, 'proof'), cache], extraRead: [cache], home, platform: 'darwin', ...(allow ? { allow } : {}) });
}

describe('the Seatbelt profile', () => {
  it('starts from allow default, denies the private places, and allows the copy and the caches', () => {
    const text = profileText(guard());
    expect(text).toContain('(allow default)');
    // Private reads denied.
    expect(text).toContain(`(deny file-read* (subpath "${path.join(home, '.ssh')}"))`);
    expect(text).toContain(`(deny file-read* (subpath "${path.join(home, 'Library', 'Keychains')}"))`);
    // The project's .env files, by a regex anchored at the person's project folder (never the copy's own).
    expect(text).toMatch(/\(deny file-read\* \(regex #".*\\\.env/);
    // Writes only in the copy and the caches.
    expect(text).toContain('(deny file-write* (subpath "/"))');
    expect(text).toContain(`(allow file-write* (subpath "${cwd}"))`);
    expect(text).toContain(`(allow file-write* (subpath "${cache}"))`);
    // The copy stays readable even though it lives under a denied project folder is not the case here; the squad home is.
    expect(text).toContain(`(allow file-read* (subpath "${cwd}"))`);
    // No background jobs that outlive the command.
    expect(text).toContain('(deny job-creation)');
  });

  it('hides squad-kit’s own folder but allows back the cache inside it', () => {
    const g = buildGuard({ cwd, root, cache: path.join(home, '.squad-kit', 'projects', 'p', 'caches', 'x'), extraWrite: [path.join(home, '.squad-kit', 'projects', 'p', 'caches', 'x')], extraRead: [path.join(home, '.squad-kit', 'projects', 'p', 'caches', 'x')], home, platform: 'darwin' });
    // Note: squadHome() points elsewhere in tests, so just assert ordering: every allow comes after the denies.
    const text = profileText(g);
    const firstAllowRead = text.indexOf('(allow file-read*');
    const lastDenyRead = text.lastIndexOf('(deny file-read*');
    expect(firstAllowRead).toBeGreaterThan(-1);
    expect(lastDenyRead).toBeGreaterThan(-1);
    expect(firstAllowRead).toBeGreaterThan(lastDenyRead);
  });

  it('adds what an engineer allowed, for reading and writing', () => {
    const extra = path.join(os.tmpdir(), 'shared-xyz');
    const text = profileText(guard({ allowRead: [extra], allowWrite: [extra] }));
    expect(text).toContain(`(allow file-read* (subpath "${extra}"))`);
    expect(text).toContain(`(allow file-write* (subpath "${extra}"))`);
  });

  it('reads ~ as the home folder in what an engineer allowed, wherever it was saved from', () => {
    expect(allowPath('~/shared', '/Users/sara')).toBe('/Users/sara/shared');
    expect(allowPath('~', '/Users/sara')).toBe('/Users/sara');
    expect(allowPath(' /opt/data ', '/Users/sara')).toBe('/opt/data');
    const text = profileText(guard({ allowRead: ['~/shared-xyz'], allowWrite: ['~/shared-xyz'] }));
    expect(text).not.toContain('~/shared-xyz');
    expect(text).toContain(`(allow file-read* (subpath "${allowPath('~/shared-xyz', home)}"))`);
    expect(bubblewrapArgs(guard({ allowWrite: ['~/shared-xyz'] }), 'true').join(' ')).not.toContain('~/shared-xyz');
  });
});

describe('the environment scrub', () => {
  it('removes squad-kit’s own variables, the AI keys and the common cloud and code-host tokens', () => {
    for (const name of ['SQUAD_PLANNER_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'AZURE_DEVOPS_PAT', 'GOOGLE_API_KEY', 'JIRA_API_TOKEN', 'NPM_TOKEN', 'SQUAD_WINDOW_KEY']) {
      expect(isSecretEnv(name)).toBe(true);
    }
    // What an app commonly needs is kept.
    for (const name of ['PATH', 'HOME', 'LANG', 'NODE_OPTIONS', 'DATABASE_URL', 'PORT', 'CI', 'TERM']) {
      expect(isSecretEnv(name)).toBe(false);
    }
  });

  it('projectEnv drops the secrets from the real environment and keeps the rest', () => {
    process.env.GITHUB_TOKEN = 'ghp_secret';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws_secret';
    process.env.SQUAD_WINDOW_KEY = 'k';
    process.env.MY_APP_SETTING = 'keep-me';
    try {
      const env = projectEnv({ CI: '1' });
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(env.SQUAD_WINDOW_KEY).toBeUndefined();
      expect(env.MY_APP_SETTING).toBe('keep-me');
      expect(env.CI).toBe('1');
    } finally {
      delete process.env.GITHUB_TOKEN;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      delete process.env.SQUAD_WINDOW_KEY;
      delete process.env.MY_APP_SETTING;
    }
  });
});

describe('the bubblewrap arguments (Linux)', () => {
  it('binds the whole computer read-only, makes the copy and the caches writable, and hides the private places', () => {
    const args = bubblewrapArgs(buildGuard({ cwd, root, cache, extraWrite: [cache], extraRead: [cache], home, platform: 'linux' }), 'npm test');
    expect(args.slice(0, 3)).toEqual(['--ro-bind', '/', '/']);
    const joined = args.join(' ');
    expect(joined).toContain(`--bind ${cwd} ${cwd}`);
    expect(joined).toContain(`--bind-try ${cache} ${cache}`);
    expect(joined).toContain(`--tmpfs ${path.join(home, '.ssh')}`);
    // The command runs through a shell at the end.
    expect(args.slice(-3)).toEqual(['/bin/sh', '-c', 'npm test']);
  });

  it("the setup after a merge reads its own checkout's .env files, and the project's others stay hidden", () => {
    const checkout = path.join(root, 'web');
    fs.mkdirSync(checkout);
    fs.writeFileSync(path.join(checkout, '.env'), 'DATABASE_URL=file:./dev.db');
    fs.writeFileSync(path.join(root, '.env'), 'API_KEY=PARENT SECRET');
    const spec = buildGuard({ cwd: checkout, root, cache, extraWrite: [cache], extraRead: [cache], home, platform: 'linux' });
    const hidden = (s: typeof spec) => bubblewrapArgs(s, 'true').flatMap((a, i, all) => (a === '--ro-bind-try' && all[i + 1] === '/dev/null' ? [all[i + 2]] : []));
    expect(hidden(spec)).toEqual(expect.arrayContaining([path.join(checkout, '.env'), path.join(root, '.env')]));
    expect(hidden({ ...spec, ownEnv: true })).toContain(path.join(root, '.env'));
    expect(hidden({ ...spec, ownEnv: true })).not.toContain(path.join(checkout, '.env'));
  });

  it('does not stop at a folder that is not on this computer', () => {
    const gone = path.join(base, 'not-there-yet');
    const spec = buildGuard({ cwd, root, cache, extraWrite: [gone], extraRead: [], home, platform: 'linux', allow: { allowWrite: [path.join(base, 'nor-this')] } });
    spec.noRead.push(path.join(base, 'no-private-folder'), path.join(base, 'no-private-file.json'));
    const args = bubblewrapArgs(spec, 'true');
    const bound = args.flatMap((a, i) => (a === '--bind' ? [args[i + 1]] : []));
    expect(bound).toEqual([spec.cwd]);
    const joined = args.join(' ');
    expect(joined).toContain(`--bind-try ${gone}`);
    expect(joined).not.toContain('no-private-folder');
    expect(joined).not.toContain('no-private-file.json');
  });

  it('makes squad-kit own folders before the command runs, and no others', () => {
    const own = path.join(base, 'own-home');
    const proof = path.join(own, 'proof');
    const elsewhere = path.join(base, 'elsewhere');
    makeOwnFolders({ write: [proof, elsewhere] } as never, own);
    expect(fs.existsSync(proof)).toBe(true);
    expect(fs.existsSync(elsewhere)).toBe(false);
  });
});

describe('is the guard here', () => {
  it('a Mac with sandbox-exec, Linux with bubblewrap, nothing on Windows', () => {
    expect(guardSupportOn({ platform: 'darwin', release: '', has: (p) => p === '/usr/bin/sandbox-exec', bwrapWorks: () => false }).on).toBe(true);
    expect(guardSupportOn({ platform: 'darwin', release: '', has: () => false, bwrapWorks: () => false }).on).toBe(false);
    expect(guardSupportOn({ platform: 'linux', release: '6.0', has: (p) => p === 'bwrap', bwrapWorks: () => true }).on).toBe(true);
    const noBwrap = guardSupportOn({ platform: 'linux', release: '6.0', has: () => false, bwrapWorks: () => false });
    expect(noBwrap.on).toBe(false);
    expect(noBwrap.fix).toMatch(/bubblewrap/);
    expect(guardSupportOn({ platform: 'win32', release: '', has: () => true, bwrapWorks: () => true }).on).toBe(false);
  });
});

describe('a file the guard blocked', () => {
  it('finds a denied path in the command output, and ignores an ordinary failure', () => {
    const g = guard();
    const ssh = path.join(home, '.ssh', 'id_rsa');
    expect(guardBlockedPath(`Error: EPERM: operation not permitted, open '${ssh}'`, g)).toBe(ssh);
    expect(guardBlockedPath(`cat: ${ssh}: Operation not permitted`, g)).toBe(ssh);
    // A path inside the copy is allowed, so it is not the guard.
    expect(guardBlockedPath(`cat: ${path.join(cwd, 'x')}: Operation not permitted`, g)).toBeNull();
    // An ordinary test failure is not mistaken for the guard.
    expect(guardBlockedPath('AssertionError: expected 1 to equal 2', g)).toBeNull();
  });

  it('the plain sentence names no path and no technical word', () => {
    expect(GUARD_BLOCKED).toBe('A check needed a file outside its copy, and squad-kit blocked it. An engineer can allow it in Settings.');
    expect(GUARD_BLOCKED).not.toMatch(/sandbox|seatbelt|EPERM|\/Users|~\//i);
  });
});

describe('the single gate', () => {
  it('runs a command in the guard on a Mac: it cannot read a file outside its copy', async () => {
    if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) return;
    const secret = path.join(home, '.ssh', 'id_rsa');
    fs.writeFileSync(secret, 'PRIVATE KEY');
    const out = await new Promise<string>((resolve) => {
      const child = spawnProject(`cat ${secret}; echo "copy ok" > ${path.join(cwd, 'out.txt')}; cat ${path.join(cwd, 'out.txt')}`, { cwd, guard: guard() });
      let s = '';
      child.stdout!.on('data', (c) => (s += c));
      child.stderr!.on('data', (c) => (s += c));
      child.on('close', () => resolve(s));
    });
    expect(out).toMatch(/Operation not permitted|not permitted/i);
    expect(out).toContain('copy ok');
    expect(out).not.toContain('PRIVATE KEY');
  });

  it("a hostile test on a Mac reads no key, nothing of squad-kit's, no .env of the project, and writes only in its copy", async () => {
    if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) return;
    fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY');
    const squad = path.join(process.env.SQUAD_KIT_HOME!, 'secrets-guard-test.yaml');
    fs.writeFileSync(squad, 'token: SQUAD SECRET');
    fs.writeFileSync(path.join(root, '.env'), 'API_KEY=PARENT SECRET');
    fs.mkdirSync(path.join(root, 'apps', 'web'), { recursive: true });
    fs.writeFileSync(path.join(root, 'apps', 'web', '.env.local'), 'API_KEY=DEEP SECRET');
    // The copy's own .env (squad-kit copies the person's into it for the app) stays the command's to read.
    fs.writeFileSync(path.join(cwd, '.env'), 'PORT=3000');
    const desktop = path.join(home, 'Desktop');
    fs.mkdirSync(desktop, { recursive: true });
    const script = [
      // A listing that worked prints "LISTED <name>"; a refused one only the error, which names the folder.
      `ls ${path.join(home, '.ssh')} | sed 's/^/LISTED /'`,
      `cat ${path.join(home, '.ssh', 'id_ed25519')}`,
      `cat ${squad}`,
      `ls ${process.env.SQUAD_KIT_HOME} | sed 's/^/LISTED /'`,
      `cat ${path.join(root, '.env')}`,
      `cat ${path.join(root, 'apps', 'web', '.env.local')}`,
      `echo bad > ${path.join(desktop, 'note.txt')}`,
      `cat ${path.join(cwd, '.env')}`,
      `echo ok > ${path.join(cwd, 'wrote.txt')}`,
    ].join('; ');
    const out = await new Promise<string>((resolve) => {
      const child = spawnProject(script, { cwd, guard: guard() });
      let s = '';
      child.stdout!.on('data', (c) => (s += c));
      child.stderr!.on('data', (c) => (s += c));
      child.on('close', () => resolve(s));
    });
    for (const secret of ['PRIVATE KEY', 'LISTED', 'SQUAD SECRET', 'PARENT SECRET', 'DEEP SECRET']) expect(out).not.toContain(secret);
    expect(out.match(/Operation not permitted/g)).toHaveLength(7);
    expect(fs.existsSync(path.join(desktop, 'note.txt'))).toBe(false);
    expect(out).toContain('PORT=3000');
    expect(fs.readFileSync(path.join(cwd, 'wrote.txt'), 'utf8')).toBe('ok\n');
    fs.rmSync(squad, { force: true });
  });

  it("the setup after a merge on a Mac reads its own checkout's .env, and still no key or other .env of the project", async () => {
    if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) return;
    // The person's own checkout, inside the project folder, as the setup after a merge runs it.
    const checkout = path.join(root, 'web');
    fs.mkdirSync(checkout);
    fs.writeFileSync(path.join(checkout, '.env'), 'DATABASE_URL=OWN SETTING');
    fs.writeFileSync(path.join(root, '.env'), 'API_KEY=PARENT SECRET');
    fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY');
    const script = [path.join(checkout, '.env'), path.join(root, '.env'), path.join(home, '.ssh', 'id_ed25519')].map((f) => `cat ${f}`).join('; ');
    const run = (ownEnv: boolean) =>
      new Promise<string>((resolve) => {
        const spec = buildGuard({ cwd: checkout, root, cache, extraWrite: [cache], extraRead: [cache], home, platform: 'darwin' });
        const child = spawnProject(script, { cwd: checkout, guard: { ...spec, ...(ownEnv ? { ownEnv } : {}) } });
        let s = '';
        child.stdout!.on('data', (c) => (s += c));
        child.stderr!.on('data', (c) => (s += c));
        child.on('close', () => resolve(s));
      });
    const setup = await run(true);
    expect(setup).toContain('DATABASE_URL=OWN SETTING');
    for (const secret of ['PARENT SECRET', 'PRIVATE KEY']) expect(setup).not.toContain(secret);
    // Any other command in that checkout still reads none of them.
    const other = await run(false);
    for (const secret of ['OWN SETTING', 'PARENT SECRET', 'PRIVATE KEY']) expect(other).not.toContain(secret);
  });

  it('only project-guard.ts spawns a project command through a shell', () => {
    const src = path.resolve(__dirname, '../src');
    const files = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(path.join(dir, d.name)) : /\.ts$/.test(d.name) ? [path.join(dir, d.name)] : []));
    // A project command runs through a shell (shell: true). Only the one gate may do that; everything else goes through it.
    const allowed = new Set([path.join(src, 'engine', 'project-guard.ts')]);
    const offenders = files(src)
      .filter((f) => !allowed.has(f))
      .filter((f) => /\bshell:\s*true\b/.test(fs.readFileSync(f, 'utf8')))
      // These shell spawns are not project commands: the clipboard helper, self-update and the CLI's own restart.
      .filter((f) => !/\b(clipboard|update|upgrade|console)\.ts$/.test(f));
    expect(offenders).toEqual([]);
  });
});
