import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { BrowserModule } from '../src/modules/browser/types.js';
import { fakeBrowser } from './fakes/browser.js';
import { freePort } from './support/tiny-app.js';

import { inGuard } from './support/in-guard.js';
/**
 * One turn per copy (MA-18: the Builder's tests started `next dev` in the story's copy, and at the same moment it asked
 * for the app, which Next.js refused: one dev server per folder). In a copy, a check run and an app start never
 * overlap: one waits for the other and is told so, with a cap. Different copies never wait for each other. What a
 * finished check left in the copy stops before the app starts, and when the app's framework names another dev server of
 * this copy, squad-kit stops that very process, only when it is a leftover there, and tries once more. The other way
 * round, an app squad-kit runs in a copy stops before a run of the checks there, as the tests may start their own.
 * Real commands run here; no agent does.
 */

const h = vi.hoisted(() => ({ browser: null as BrowserModule | null }));
vi.mock('../src/modules/registry.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/registry.js')>()),
  shotBrowser: () => h.browser!,
}));

const { AgentWindow, STOPPED_FOR_CHECKS, toolsFor } = await import('../src/engine/window.js');
const { startApp } = await import('../src/engine/checks.js');
const { TurnTimeout, inTurn, otherDevServer, startPastOther, takeTurn, turnHolder, waitWords } = await import('../src/engine/copy-turn.js');
const { stopLeftovers } = await import('../src/engine/leftovers.js');

type Setup = ConstructorParameters<typeof AgentWindow>[0];
type Win = InstanceType<typeof AgentWindow>;

let tmp: string;
let lines: string[];
const opened: Win[] = [];
/** Every process this test started itself, by its own number, to stop what is left of them after. */
const started: number[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(what: string, check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** A program left running the way a finished test run leaves one: the shell that started it is gone. */
function orphan(cwd: string): number {
  const out = execFileSync('/bin/sh', ['-c', `"${process.execPath}" -e "setInterval(() => {}, 1000)" >/dev/null 2>&1 & echo $!`], { cwd, encoding: 'utf8' });
  const pid = Number(out.trim());
  started.push(pid);
  return pid;
}

const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n');
const serve = (port: number) => `require('http').createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1')`;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-copy-turn-')));
  lines = [];
  h.browser = fakeBrowser({ '/': { has: [] } }).module;
});

afterEach(async () => {
  for (const w of opened.splice(0)) await w.close();
  for (const pid of started.splice(0)) {
    if (alive(pid)) process.kill(pid, 'SIGKILL');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function win(more: Partial<Setup>): Win {
  const w = new AgentWindow({
    ticket: 'CT-1',
    step: 'build',
    who: 'Builder',
    tools: toolsFor({ app: true }),
    proofDir: path.join(tmp, 'proof'),
    prefix: 'ct-1-builder',
    say: (t) => lines.push(t),
    ...more,
  });
  opened.push(w);
  return w;
}

describe('the turn', () => {
  it('waits in order in one folder, never across folders, and goes to the next one on release', async () => {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    const first = await takeTurn(a, 'checks');
    expect(turnHolder(a)).toBe('checks');
    // Another copy: at once.
    const other = await takeTurn(b, 'app');
    const heard: string[] = [];
    let got = false;
    const second = takeTurn(a, 'app', { onWait: (k) => heard.push(k) }).then((t) => {
      got = true;
      return t;
    });
    await sleep(100);
    expect(got).toBe(false);
    expect(heard).toEqual(['checks']);
    first.release();
    first.release();
    const t2 = await second;
    expect(turnHolder(a)).toBe('app');
    t2.release();
    other.release();
    expect(turnHolder(a)).toBeNull();
    expect(turnHolder(b)).toBeNull();
  });

  it('is one folder under either spelling', async () => {
    const link = path.join(tmp, 'link');
    fs.mkdirSync(path.join(tmp, 'real'));
    fs.symlinkSync(path.join(tmp, 'real'), link);
    const t = await takeTurn(path.join(tmp, 'real'), 'checks');
    expect(turnHolder(link)).toBe('checks');
    t.release();
  });

  it('has a cap: the wait ends with what held it, and its place in the line is given up', async () => {
    const held = await takeTurn(tmp, 'checks');
    const err = await takeTurn(tmp, 'app', { waitMs: 100 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TurnTimeout);
    expect((err as InstanceType<typeof TurnTimeout>).holder).toBe('checks');
    held.release();
    expect(turnHolder(tmp)).toBeNull();
  });

  it('ends on the Stop, and inTurn always lets go, however its work ends', async () => {
    const held = await takeTurn(tmp, 'app');
    const stop = new AbortController();
    const waiting = takeTurn(tmp, 'checks', { signal: stop.signal }).catch((e: Error) => e.message);
    stop.abort();
    expect(await waiting).toBe('You stopped the squad.');
    held.release();
    await expect(inTurn([tmp, tmp], 'checks', async () => {
      expect(turnHolder(tmp)).toBe('checks');
      throw new Error('it failed');
    })).rejects.toThrow('it failed');
    expect(turnHolder(tmp)).toBeNull();
  });

  it('says the wait in plain words', () => {
    expect(waitWords('checks', 'app')).toBe('The tests are running in this copy. The app starts when they finish.');
    expect(waitWords('app', 'checks')).toBe('The app is starting in this copy. The checks run once it is up.');
  });
});

describe("the app's own words: another dev server already runs here", () => {
  const next = 'The app stopped while starting (npm run dev):  ⨯ Another next dev server is already running.\n\n- Local:        http://localhost:3000\n- PID:          94520\n- Dir:          /x\n\nYou can access the existing server at http://localhost:3000,\nor run kill 94520 to stop it and start a new one.';

  it('names the process, and only in those words', () => {
    expect(otherDevServer(next)).toBe(94520);
    expect(otherDevServer('or run kill 94520 to stop it and start a new one.')).toBe(94520);
    expect(otherDevServer('Another next dev server is already running.\nor run taskkill /PID 4242 /F to stop it and start a new one.')).toBe(4242);
    expect(otherDevServer('Error: listen EADDRINUSE: address already in use 127.0.0.1:3000')).toBeNull();
    expect(otherDevServer('Another next dev server is already running in this directory.\nStop the other server before starting a new one.')).toBeNull();
  });

  it('stops that process when it may, then starts once more; never a third time', async () => {
    let tries = 0;
    const asked: number[] = [];
    const fake = { url: 'http://127.0.0.1:1', stop: () => undefined };
    const app = await startPastOther(
      async () => {
        tries += 1;
        if (tries === 1) throw new Error(next);
        return fake;
      },
      async (pid) => {
        asked.push(pid);
        return true;
      },
    );
    expect(app).toBe(fake);
    expect(asked).toEqual([94520]);
    tries = 0;
    await expect(startPastOther(async () => {
      tries += 1;
      throw new Error(next);
    }, async () => true)).rejects.toThrow('Another next dev server');
    expect(tries).toBe(2);
  });

  it('says plainly when it may not stop it, and does not try again', async () => {
    let tries = 0;
    const err = await startPastOther(async () => {
      tries += 1;
      throw new Error(next);
    }, async () => false).catch((e: Error) => e.message);
    expect(tries).toBe(1);
    expect(err).toMatch(/^Another dev server already runs in this copy \(process 94520\), and squad-kit may not stop it/);
  });
});

describe('start_app and run_checks in one copy', () => {
  it('start_app waits for the tests running in the same copy, says so, and starts once they finish', async () => {
    const port = await freePort();
    // The app refuses to start while the tests' mark is not there yet: it would have met their server.
    const w = win({
      app: { cwd: tmp, start: `node -e "require('fs').existsSync('tests-done') || process.exit(3); ${serve(port)}"`, url: `http://127.0.0.1:${port}` },
      checks: { cwd: tmp, commands: () => ({ test: 'sleep 1; echo "Tests  1 passed"; touch tests-done' }) },
      limits: { callMs: 300 },
    });
    expect(text(await w.call('run_checks', { which: 'test' }))).toContain('still running');
    const start = await w.call('start_app', {});
    expect(text(start)).toBe('The tests are running in this copy. The app starts when they finish. Call app_status in a moment.');
    expect(text(await w.call('app_status', {}))).toContain('The tests are running in this copy.');
    expect(lines).toContain("The app waits for the tests running in this story's copy, then starts for the Builder");
    await until('the app', async () => text(await w.call('app_status', {})).includes(`The app runs at http://127.0.0.1:${port} and answers`));
    expect(text(await w.call('run_checks', { which: 'test' }))).toContain('test: passed');
  });

  it('run_checks waits for the app starting in the same copy, says so, and runs once it is up', async () => {
    const port = await freePort();
    const w = win({
      app: { cwd: tmp, start: `node -e "setTimeout(() => { require('fs').writeFileSync('app-up', ''); ${serve(port)}; }, 800)"`, url: `http://127.0.0.1:${port}` },
      // The tests pass only once the app was up: they ran after its start ended.
      checks: { cwd: tmp, commands: () => ({ test: 'test -f app-up && echo "Tests  1 passed"' }) },
      limits: { callMs: 300, appWaitMs: 20_000 },
    });
    expect(text(await w.call('start_app', {}))).toContain('still starting');
    expect(text(await w.call('run_checks', { which: 'test' }))).toBe('The app is starting in this copy. The checks run once it is up. Call run_checks again in a moment.');
    expect(lines.filter((l) => l.startsWith('squad-kit ran the tests'))).toEqual([]);
    await until('the app', async () => text(await w.call('app_status', {})).includes('answers'));
    let said = '';
    await until('the tests', async () => (said += text(await w.call('run_checks', { which: 'test' }))).includes('test: passed'));
    // Before they ran, the app squad-kit started there stopped, and the agent was told.
    expect(said.startsWith(STOPPED_FOR_CHECKS)).toBe(true);
  });

  it('a check running in another copy never holds the app back', async () => {
    const one = path.join(tmp, 'one');
    const two = path.join(tmp, 'two');
    fs.mkdirSync(one);
    fs.mkdirSync(two);
    const port = await freePort();
    const busy = win({ checks: { cwd: one, commands: () => ({ test: 'sleep 3' }) }, tools: toolsFor({ app: false, checks: true }), limits: { callMs: 200 } });
    expect(text(await busy.call('run_checks', { which: 'test' }))).toContain('still running');
    expect(turnHolder(one)).toBe('checks');
    const w = win({ app: { cwd: two, start: `node -e "${serve(port)}"`, url: `http://127.0.0.1:${port}` }, limits: { callMs: 10_000 } });
    const began = Date.now();
    expect(text(await w.call('start_app', {}))).toContain(`The app runs at http://127.0.0.1:${port}`);
    expect(Date.now() - began).toBeLessThan(2500);
    expect(turnHolder(one)).toBe('checks');
  });

  it('the wait has a cap: after it the app does not start, and the agent is told why in plain words', async () => {
    const port = await freePort();
    const w = win({
      app: { cwd: tmp, start: `node -e "${serve(port)}"`, url: `http://127.0.0.1:${port}` },
      checks: { cwd: tmp, commands: () => ({ test: 'sleep 4' }) },
      limits: { callMs: 2000, turnMs: 300 },
    });
    expect(text(await w.call('run_checks', { which: 'test' }))).toContain('still running');
    const r = await w.call('start_app', {});
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('squad-kit could not start the app: the tests in this copy were still running after');
    expect(text(r)).toContain('Call run_checks for their result, then start_app again');
    expect(lines).toContain('squad-kit could not start the app for the Builder.');
    // It gave up its place: the copy is the tests' alone.
    expect(turnHolder(tmp)).toBe('checks');
  });

  it("what a finished check left in the app's copy stops first; a check run does not stop anything", async () => {
    const port = await freePort();
    const cleared: [string, number | undefined][] = [];
    const w = win({
      app: { cwd: tmp, start: `node -e "${serve(port)}"`, url: `http://127.0.0.1:${port}` },
      checks: { cwd: tmp, commands: () => ({ test: 'echo "Tests  1 passed"' }) },
      clearCopy: async (dir, only) => {
        cleared.push([dir, only]);
        return false;
      },
      limits: { callMs: 10_000 },
    });
    expect(text(await w.call('run_checks', { which: 'test' }))).toContain('test: passed');
    expect(cleared).toEqual([]);
    expect(text(await w.call('start_app', {}))).toContain('The app runs at');
    expect(cleared).toEqual([[tmp, undefined]]);
  });
});

describe('an app squad-kit runs in the copy stops before its checks', () => {
  /** A test that needs the app's own address for its server: it passes only once nothing else holds it. */
  const ownServer = (port: number) => `node -e "require('net').createServer().once('error', () => process.exit(1)).listen(${port}, '127.0.0.1', function () { console.log('Tests  1 passed'); this.close(); })"`;
  const answers = (port: number) => fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);

  it('run_checks stops the app started for the agent first, and says so; app_status too, until it starts again', async () => {
    const port = await freePort();
    const w = win({
      app: { cwd: tmp, start: `node -e "${serve(port)}"`, url: `http://127.0.0.1:${port}` },
      checks: { cwd: tmp, commands: () => ({ test: ownServer(port) }) },
      limits: { callMs: 10_000 },
    });
    expect(text(await w.call('start_app', {}))).toContain(`The app runs at http://127.0.0.1:${port}`);
    const r = await w.call('run_checks', { which: 'test' });
    expect(text(r).startsWith(`${STOPPED_FOR_CHECKS}\ntest: passed`)).toBe(true);
    expect(STOPPED_FOR_CHECKS).toBe('squad-kit stopped the app it started for you, so the tests could start their own. Call start_app again when you need it.');
    expect(lines).toContain('squad-kit stopped the app for the Builder, so the tests could run');
    expect(text(await w.call('app_status', {}))).toBe('The app is not running: squad-kit stopped it before the checks ran, so the tests could start their own. Call start_app when you need it.');
    expect(text(await w.call('start_app', {}))).toContain(`The app runs at http://127.0.0.1:${port}`);
    expect(text(await w.call('app_status', {}))).toContain('and answers');
    // A run with no app running says nothing about one.
    await w.call('stop_app', {});
    expect(text(await w.call('run_checks', { which: 'test' }))).not.toContain('squad-kit stopped the app');
  });

  it("leaves alone an app in another copy, a product's parts, and an app when there is nothing to run", async () => {
    const dir = (name: string) => {
      const d = path.join(tmp, name);
      fs.mkdirSync(d);
      return d;
    };
    const [other, product, none, checks] = [dir('other'), dir('product'), dir('none'), dir('checks')];
    const ports = [await freePort(), await freePort(), await freePort()];
    const app = (cwd: string, port: number) => ({ cwd, start: `node -e "${serve(port)}"`, url: `http://127.0.0.1:${port}` });
    // Another copy's app, while this copy runs its checks.
    const a = win({ app: app(other, ports[0]!), limits: { callMs: 10_000 } });
    expect(text(await a.call('start_app', {}))).toContain('The app runs at');
    const b = win({ checks: { cwd: checks, commands: () => ({ test: 'echo "Tests  1 passed"' }) }, tools: toolsFor({ app: false, checks: true }), limits: { callMs: 10_000 } });
    expect(text(await b.call('run_checks', { which: 'test' }))).not.toContain('squad-kit stopped the app');
    expect(await answers(ports[0]!)).toBe(true);
    // A product: its parts start and stop as before.
    const p = app(product, ports[1]!);
    const c = win({ app: { ...p, run: () => startApp(p.cwd, p.start, p.url) }, checks: { cwd: product, commands: () => ({ test: 'echo "Tests  1 passed"' }) }, limits: { callMs: 10_000 } });
    expect(text(await c.call('start_app', {}))).toContain('The app runs at');
    expect(text(await c.call('run_checks', { which: 'test' }))).not.toContain('squad-kit stopped the app');
    expect(await answers(ports[1]!)).toBe(true);
    // No saved check: nothing runs, so the app stays.
    const d = win({ app: app(none, ports[2]!), checks: { cwd: none, commands: () => ({}) }, limits: { callMs: 10_000 } });
    expect(text(await d.call('start_app', {}))).toContain('The app runs at');
    expect(text(await d.call('run_checks', { which: 'test' }))).toContain('no saved test command');
    expect(await answers(ports[2]!)).toBe(true);
    expect(lines.filter((l) => l.startsWith('squad-kit stopped the app'))).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('another dev server already runs in the copy', () => {
  /**
   * A framework that allows one dev server per folder, as Next.js does: it keeps a lock with its process number, and
   * refuses while that process lives. Each start is counted in a file of the copy.
   */
  function devServer(copy: string, port: number): string {
    const script = path.join(tmp, 'dev.cjs');
    fs.writeFileSync(
      script,
      [
        "const fs = require('fs');",
        "fs.appendFileSync('starts.txt', 'x');",
        "const held = fs.existsSync('.devlock') ? Number(fs.readFileSync('.devlock', 'utf8')) : 0;",
        'let lives = false;',
        'try { if (held) { process.kill(held, 0); lives = true; } } catch {}',
        'if (lives) {',
        "  console.error(' ⨯ Another next dev server is already running.\\n\\n- PID:          ' + held + '\\n\\nor run kill ' + held + ' to stop it and start a new one.');",
        '  process.exit(1);',
        '}',
        "fs.writeFileSync('.devlock', String(process.pid));",
        `require('http').createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1');`,
      ].join('\n'),
    );
    void copy;
    return `node "${script}"`;
  }

  function starts(copy: string): number {
    return fs.existsSync(path.join(copy, 'starts.txt')) ? fs.readFileSync(path.join(copy, 'starts.txt'), 'utf8').length : 0;
  }

  it.skipIf(inGuard)("stops only that process, when it is a leftover in this copy, then starts the app once more", async () => {
    const copy = path.join(tmp, 'copy');
    fs.mkdirSync(copy);
    const port = await freePort();
    const holder = orphan(copy);
    const bystander = orphan(copy);
    fs.writeFileSync(path.join(copy, '.devlock'), String(holder));
    const w = win({
      app: { cwd: copy, start: devServer(copy, port), url: `http://127.0.0.1:${port}` },
      // The leftovers of this copy only, as the engine's own hook does: never a process anywhere else.
      clearCopy: async (dir, only) => (only ? (await stopLeftovers([dir], { only: [only], graceMs: 1000 })).length > 0 : false),
      limits: { callMs: 20_000 },
    });
    expect(text(await w.call('start_app', {}))).toContain(`The app runs at http://127.0.0.1:${port}`);
    expect(starts(copy)).toBe(2);
    expect(alive(holder)).toBe(false);
    expect(alive(bystander)).toBe(true);
  });

  it('leaves a process in another folder alone, says so plainly, and does not try again', async () => {
    const copy = path.join(tmp, 'copy');
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(copy);
    fs.mkdirSync(elsewhere);
    const port = await freePort();
    const outsider = orphan(elsewhere);
    fs.writeFileSync(path.join(copy, '.devlock'), String(outsider));
    const w = win({
      app: { cwd: copy, start: devServer(copy, port), url: `http://127.0.0.1:${port}` },
      clearCopy: async (dir, only) => (only ? (await stopLeftovers([dir], { only: [only], graceMs: 1000 })).length > 0 : false),
      limits: { callMs: 20_000 },
    });
    const r = await w.call('start_app', {});
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(`Another dev server already runs in this copy (process ${outsider}), and squad-kit may not stop it`);
    expect(starts(copy)).toBe(1);
    expect(alive(outsider)).toBe(true);
    expect(lines).toContain('squad-kit could not start the app for the Builder.');
  });
});
