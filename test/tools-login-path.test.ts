import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectAll, type DetectHost } from '../src/engine/tools/detect.js';
import { PRINT_PATH, loginShell, mergePath, pathBetweenMarks, readLoginPath } from '../src/engine/tools/login-path.js';

/**
 * Check again sees a tool installed while squad-kit runs: the PATH of the person's login shell is read between two
 * marks and its new folders are added after squad-kit's own. The shells here are tiny made-up scripts.
 */

const START = '__SQUAD_KIT_PATH_START__';
const END = '__SQUAD_KIT_PATH_END__';

describe('the PATH between the marks', () => {
  it('reads only what is between them, whatever the start files print around it', () => {
    expect(pathBetweenMarks(`${START}/usr/bin:/bin${END}`)).toBe('/usr/bin:/bin');
    const noisy = `Welcome back!\n\x1b[32mnvm: using node 22\x1b[0m\nLast login: Mon\n${START}/Users/pm/flutter/bin:/usr/bin${END}\nbye\n`;
    expect(pathBetweenMarks(noisy)).toBe('/Users/pm/flutter/bin:/usr/bin');
  });

  it('nothing to read: no marks, half the marks, or an empty PATH', () => {
    expect(pathBetweenMarks('')).toBeNull();
    expect(pathBetweenMarks('PATH=/usr/bin')).toBeNull();
    expect(pathBetweenMarks(`${START}/usr/bin`)).toBeNull();
    expect(pathBetweenMarks(`${START}${END}`)).toBeNull();
  });

  it('the shell command prints both marks around the PATH', () => {
    expect(PRINT_PATH).toContain(START);
    expect(PRINT_PATH).toContain(END);
    expect(PRINT_PATH).toContain('"$PATH"');
  });
});

describe('adding the new folders', () => {
  it('after the ones there, each once, in order', () => {
    expect(mergePath('/usr/bin:/bin', '/Users/pm/flutter/bin:/usr/bin:/opt/homebrew/bin')).toBe('/usr/bin:/bin:/Users/pm/flutter/bin:/opt/homebrew/bin');
    expect(mergePath('/usr/bin:/usr/bin:/bin', '/bin:/bin')).toBe('/usr/bin:/bin');
  });

  it('empty parts and an empty side change nothing', () => {
    expect(mergePath('/usr/bin::/bin:', '')).toBe('/usr/bin:/bin');
    expect(mergePath(undefined, '/usr/bin')).toBe('/usr/bin');
    expect(mergePath('/usr/bin', null)).toBe('/usr/bin');
    expect(mergePath(undefined, undefined)).toBe('');
    expect(mergePath('C:\\Windows;C:\\Tools', 'C:\\Tools;C:\\flutter\\bin', ';')).toBe('C:\\Windows;C:\\Tools;C:\\flutter\\bin');
  });
});

describe("reading the login shell's PATH", () => {
  let dir: string;
  const shell = (name: string, body: string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-login-path-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('runs the shell as a login shell, and reads the PATH past the noise', async () => {
    // A made-up shell: prints noise, then runs what it is given the way a real one would.
    const sh = shell('noisy-sh', `echo "Welcome back"\n[ "$1" = "-ilc" ] || exit 3\nPATH="/Users/pm/flutter/bin:$PATH" sh -c "$2"`);
    const found = await readLoginPath('mac', { shell: sh, env: { PATH: '/usr/bin:/bin' } });
    expect(found).toBe('/Users/pm/flutter/bin:/usr/bin:/bin');
  });

  it.skipIf(process.platform === 'win32')('a shell that never ends, fails, or is not there: null, within the limit', async () => {
    const t0 = Date.now();
    expect(await readLoginPath('linux', { shell: shell('stuck-sh', 'sleep 5'), limitMs: 300 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(await readLoginPath('linux', { shell: shell('broken-sh', 'echo oops; exit 1') })).toBeNull();
    expect(await readLoginPath('linux', { shell: path.join(dir, 'no-such-shell') })).toBeNull();
  });

  it('Windows keeps the PATH squad-kit started with', async () => {
    expect(await readLoginPath('windows', { shell: '/bin/sh' })).toBeNull();
  });

  it("the person's own shell, else the system's usual one", () => {
    expect(loginShell('mac', { SHELL: '/opt/homebrew/bin/fish' }, () => true)).toBe('/opt/homebrew/bin/fish');
    expect(loginShell('mac', {}, () => true)).toBe('/bin/zsh');
    expect(loginShell('linux', { SHELL: '/gone/zsh' }, () => false)).toBe('/bin/bash');
  });
});

describe('a check finds a tool installed since squad-kit started', () => {
  it("adds the login shell's new folders to the PATH the checks and the agents use", async () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    const h: DetectHost = {
      system: 'mac',
      home: '/Users/pm',
      env,
      run: async () => ({ ok: false, out: '', err: 'not found' }),
      exists: (p) => p === '/Users/pm/flutter/bin/flutter' || p === '/Users/pm/flutter/bin/cache/flutter.version.json',
      read: (p) => (p === '/Users/pm/flutter/bin/cache/flutter.version.json' ? JSON.stringify({ frameworkVersion: '3.47.0' }) : null),
      real: (p) => p,
      list: () => [],
      writable: () => true,
      loginPath: async () => '/Users/pm/flutter/bin:/usr/bin',
    };
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-login-home-'));
    try {
      const book = await detectAll(h, home);
      expect(book.tools.flutter).toMatchObject({ state: 'found', version: '3.47.0', where: '/Users/pm/flutter' });
      expect(env.PATH).toBe('/usr/bin:/bin:/Users/pm/flutter/bin');
      // A shell that could not be read changes nothing.
      h.loginPath = async () => {
        throw new Error('no shell');
      };
      await detectAll(h, home);
      expect(env.PATH).toBe('/usr/bin:/bin:/Users/pm/flutter/bin');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
