import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildGuard, guardSupport, guardSupportOn, spawnProject } from '../src/engine/project-guard.js';
import { commandHome, ownHomeEnv } from '../src/engine/own-home.js';
import { checkForUpdates } from '../src/core/settings.js';

/**
 * A squad-kit that a project command starts (a story of squad-kit's own code starts one for its pictures) lands in a home
 * folder of its copy's own: never the person's board, its token, its lock or its port. Inside the guard it knows it is
 * there, and runs no guard of its own, which the system would refuse.
 */

const onMac = process.platform === 'darwin' && guardSupport().on;
let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-own-home-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** What a command printed, and how it ended. */
function run(command: string, o: Parameters<typeof spawnProject>[1]): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawnProject(command, o);
    let out = '';
    child.stdout?.on('data', (d) => (out += String(d)));
    child.stderr?.on('data', (d) => (out += String(d)));
    child.on('close', (code) => resolve({ out, code }));
  });
}

describe("a squad-kit started by a project's command", () => {
  it('gets a home of its copy, in the cache that copy may write, with no update check and no browser', () => {
    const cache = path.join(tmp, 'cache');
    const copy = path.join(tmp, 'worktrees', 'SK-1');
    fs.mkdirSync(copy, { recursive: true });
    const home = commandHome(copy, cache);
    expect(home.startsWith(path.join(cache, 'squad-kit-homes', 'SK-1-'))).toBe(true);
    // One home per copy, the same for its agents and its commands, wherever the path came from.
    expect(commandHome(path.join(copy, '.'), cache)).toBe(home);
    expect(commandHome(path.join(tmp, 'worktrees', 'SK-2'), cache)).not.toBe(home);
    // Never the person's own.
    expect(home).not.toContain(path.join(os.homedir(), '.squad-kit'));
    expect(ownHomeEnv(copy, cache)).toEqual({ SQUAD_KIT_HOME: home, SQUAD_KIT_UPDATES: 'off', SQUAD_KIT_BROWSER: 'off' });
    // With no cache, a folder in temp.
    expect(commandHome(copy).startsWith(path.join(os.tmpdir(), 'squad-kit-copies', 'squad-kit-homes'))).toBe(true);
  });

  it("every project command gets it, never the board's own home", async () => {
    const copy = path.join(tmp, 'copy');
    fs.mkdirSync(copy);
    const r = await run('node -e "console.log([process.env.SQUAD_KIT_HOME, process.env.SQUAD_KIT_UPDATES, process.env.SQUAD_KIT_BROWSER, process.env.SQUAD_KIT_IN_GUARD ?? \'none\'].join(\'|\'))"', { cwd: copy });
    expect(r.out.trim()).toBe(`${commandHome(copy)}|off|off|none`);
    expect(r.out).not.toContain(process.env.SQUAD_KIT_HOME!);
  });

  it('looks for no update when its command says so', () => {
    const was = process.env.SQUAD_KIT_UPDATES;
    delete process.env.SQUAD_KIT_UPDATES;
    fs.writeFileSync(path.join(process.env.SQUAD_KIT_HOME!, 'settings.yaml'), 'checkForUpdates: true\n');
    try {
      expect(checkForUpdates()).toBe(true);
      process.env.SQUAD_KIT_UPDATES = 'off';
      expect(checkForUpdates()).toBe(false);
    } finally {
      if (was === undefined) delete process.env.SQUAD_KIT_UPDATES;
      else process.env.SQUAD_KIT_UPDATES = was;
      fs.writeFileSync(path.join(process.env.SQUAD_KIT_HOME!, 'settings.yaml'), 'checkForUpdates: false\n');
    }
  });

  it('inside another guard it runs none of its own, and says why', () => {
    const host = { platform: 'darwin' as const, release: '25.0.0', has: () => true, bwrapWorks: () => true };
    expect(guardSupportOn(host).on).toBe(true);
    const inside = guardSupportOn({ ...host, inGuard: true });
    expect(inside.on).toBe(false);
    expect(inside.why).toMatch(/inside another squad-kit's guard/);
    expect(guardSupportOn({ ...host, platform: 'linux', inGuard: true }).on).toBe(false);
  });

  it("the guard hides the person's usual squad-kit folder too, when this board's home is elsewhere", () => {
    const person = path.join(tmp, 'person');
    const g = buildGuard({ cwd: tmp, root: tmp, home: person, platform: 'darwin', network: 'standard', flutter: null });
    expect(g.noRead).toContain(path.join(person, '.squad-kit'));
    expect(g.noRead).toContain(process.env.SQUAD_KIT_HOME);
  });
});

describe.runIf(onMac)('in the guard on a Mac', () => {
  it("knows it is there, writes only its own home, never reads the person's squad-kit, and a sandbox inside it is refused", async () => {
    const person = path.join(tmp, 'person');
    fs.mkdirSync(path.join(person, '.squad-kit'), { recursive: true });
    fs.writeFileSync(path.join(person, '.squad-kit', 'app.json'), '{"token":"made-up"}');
    const copy = path.join(tmp, 'copy');
    const cache = path.join(tmp, 'cache');
    fs.mkdirSync(copy);
    fs.mkdirSync(cache);
    const guard = buildGuard({ cwd: copy, root: copy, cache, extraWrite: [cache], extraRead: [cache], home: person, platform: 'darwin', network: 'standard', flutter: null });
    const script = [
      'echo "in=$SQUAD_KIT_IN_GUARD"',
      'mkdir -p "$SQUAD_KIT_HOME" && echo ok > "$SQUAD_KIT_HOME/settings.yaml" && echo home=written',
      `cat ${path.join(person, '.squad-kit', 'app.json')} >/dev/null 2>&1 || echo person=hidden`,
      "/usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true 2>/dev/null; echo nested=$?",
    ].join('; ');
    const r = await run(script, { cwd: copy, guard });
    expect(r.out).toContain('in=1');
    expect(r.out).toContain('home=written');
    expect(fs.readFileSync(path.join(commandHome(copy, cache), 'settings.yaml'), 'utf8')).toBe('ok\n');
    expect(r.out).toContain('person=hidden');
    // The system refuses a second sandbox inside the first: "sandbox_apply: Operation not permitted", exit 71.
    expect(r.out).toContain('nested=71');
  });
});
