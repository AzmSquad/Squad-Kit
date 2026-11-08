import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import type { BrowserModule } from '../src/modules/browser/types.js';
import { freePort } from './support/tiny-app.js';
import { fakeBrowser } from './fakes/browser.js';
import { callTool, savedFiles } from './support/window.js';
import { checkAnswer, isProofCheck, type FakeCheck } from './support/proof-check.js';

/**
 * One app for the Reviewer and the Tester (MA-18: squad-kit started the app for the review, stopped it, and started it
 * again for the proof and for a retake, 30 to 60 seconds each on a big app). The app started for the Reviewer's look
 * keeps running into the proof when the review approves: the Tester's pictures and a retake use it while it answers and
 * the copy's code is the same. A review that sends the story back, a Stop, and the proof's end stop it. The checks step
 * waits for an app starting in the same copy, and an app kept in that copy stops before the checks run there. Fake
 * agents press the real tools; the app is a real small one.
 */

type Run = (opts: RunOptions) => Promise<unknown>;
let reviewer: Run;
let tester: Run;
let builder: Run;
let check: Run;
const runs: RunOptions[] = [];
const h = vi.hoisted(() => ({ browser: null as BrowserModule | null }));

vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    runs.push(opts);
    const tools = opts.window?.tools ?? [];
    const who = isProofCheck(opts) ? check : tools.includes('ask_api') ? tester : tools.includes('look_at_page') && !tools.includes('take_screenshots') ? reviewer : builder;
    return { ok: true, structured: await who(opts), text: '', sessionId: opts.resume ?? opts.sessionId ?? 's-1' } as RunResult;
  },
}));
vi.mock('../src/modules/registry.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/registry.js')>()),
  shotBrowser: () => h.browser!,
}));

const { boardPaths, readTicket, updateTicket, writeMeta, readMeta } = await import('../src/board/store.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { addWorktree } = await import('./support/copy.js');
const { takeTurn } = await import('../src/engine/copy-turn.js');

/** The engine's own steps and what it keeps, as the tests reach them. */
type Squad = {
  review(id: string): Promise<void>;
  proof(id: string): Promise<void>;
  checks(id: string): Promise<void>;
  sweepKept(): void;
  dropKept(id: string): Promise<void>;
  kept: Map<string, unknown>;
  windowBase(id: string, role: string, cwd: string): { clearCopy(dir: string, only?: number): Promise<boolean> };
};

let tmp: string;
let project: string;
let port: number;
let bp: ReturnType<typeof boardPaths>;
const squads: Squad[] = [];
/** Every process this test started itself, by its own number. */
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

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const answers = (url: string) => fetch(url, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);

/** A program left running the way a finished test run leaves one: the shell that started it is gone. */
function orphan(cwd: string): number {
  const out = execFileSync('/bin/sh', ['-c', `"${process.execPath}" -e "setInterval(() => {}, 1000)" >/dev/null 2>&1 & echo $!`], { cwd, encoding: 'utf8' });
  const pid = Number(out.trim());
  started.push(pid);
  return pid;
}

function squad(): Squad {
  const s = new LiveSquad(bp) as unknown as Squad;
  squads.push(s);
  return s;
}

/**
 * The project's app: it writes its process number to starts.txt in its copy each time it starts (the file is ignored,
 * so it is no change of the code), and it stops answering once .quiet holds its number.
 */
function appStart(p: number): string {
  return `node -e "const fs = require('fs'); fs.appendFileSync('starts.txt', process.pid + '\\n'); const quiet = () => fs.existsSync('.quiet') && fs.readFileSync('.quiet', 'utf8').trim() === String(process.pid); const s = require('http').createServer((q, r) => { if (quiet()) { s.close(); q.socket.destroy(); return; } r.end('ok'); }).listen(Number(process.env.PORT || ${p}), '127.0.0.1'); setInterval(() => {}, 1000)"`;
}

const starts = (copy: string) => (fs.existsSync(path.join(copy, 'starts.txt')) ? fs.readFileSync(path.join(copy, 'starts.txt'), 'utf8').trim().split('\n').filter(Boolean).map(Number) : []);
const lines = (id: string) => readTicket(bp, id)!.activity.map((a) => a.text);

beforeEach(async () => {
  runs.length = 0;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-kept-app-')));
  project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'data.txt'), 'as it was\n');
  fs.writeFileSync(path.join(project, '.gitignore'), 'starts.txt\n.quiet\n');
  execSync('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm start', { cwd: project });
  bp = boardPaths(path.join(project, '.squad'));
  port = await freePort();
  writeMeta(bp, {
    project: 'App',
    key: 'KA',
    nextNumber: 1,
    engine: 'live',
    runner: 'direct',
    user: { name: 'Momen', role: 'Project manager' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
    commands: { start: appStart(port), url: `http://127.0.0.1:${port}`, test: 'echo "Tests  1 passed"' },
    git: { base: 'main', remote: 'origin' },
    scan: { status: 'done', empty: false },
  });
  h.browser = fakeBrowser({ '/rooms': { has: ['button:Book'], snapshot: '- heading "Rooms"\n- button "Book"' } }).module;
  reviewer = async (opts) => {
    await callTool(opts.window!, 'look_at_page', { page: '/rooms' });
    return { approved: true, summary: 'Fine', comments: [] };
  };
  tester = async (opts) => {
    const [file] = savedFiles(await callTool(opts.window!, 'take_screenshots', { shots: [{ page: '/rooms' }] }));
    return { shots: [{ criterion: 1, file: file!, shows: 'met', note: 'The rooms show.' }], offScreen: [] };
  };
  builder = async () => ({ summary: 'Fixed' });
  check = async (opts) => checkAnswer(opts);
});

afterEach(async () => {
  for (const s of squads.splice(0)) for (const id of [...s.kept.keys()]) await s.dropKept(id);
  for (const pid of started.splice(0)) if (alive(pid)) process.kill(pid, 'SIGKILL');
  fs.rmSync(tmp, { recursive: true, force: true });
});

function story(title = 'Rooms on a phone'): { id: string; copy: string } {
  const t0 = actions.createTicket(bp, { title });
  const wt = addWorktree(project, t0.id, 'main');
  updateTicket(bp, t0.id, (x) => {
    x.worktree = wt.dir;
    x.branch = wt.branch;
    x.baseCommit = wt.baseCommit;
    x.stage = 'review';
    x.live = true;
    x.squad = null;
    x.story = 'As a clerk, I want rooms on my phone.';
    x.criteria = [{ given: 'a phone', when: 'I open rooms', then: 'it fits' }];
    x.work = { steps: 1, tests: 1, screens: 1 };
    x.gates = { checks: 'pass', review: 'pending', proof: 'pending' };
  });
  return { id: t0.id, copy: wt.dir };
}

describe.skipIf(process.platform === 'win32')('one app for the review and the proof', () => {
  it('the proof uses the app the review started: it starts once, and stops when the proof ends', async () => {
    const { id, copy } = story();
    const s = squad();
    await s.review(id);
    expect(readTicket(bp, id)!.squad?.phase).toBe('proof');
    const [pid] = starts(copy);
    expect(starts(copy)).toHaveLength(1);
    // It runs on, waiting for the proof.
    expect(alive(pid!)).toBe(true);
    expect(await answers(`http://127.0.0.1:${port}`)).toBe(true);
    await s.proof(id);
    const t = readTicket(bp, id)!;
    expect(t.waiting?.kind).toBe('proof');
    expect(starts(copy)).toHaveLength(1);
    expect(lines(id)).toContain('The app squad-kit started earlier still runs, so the Tester uses it');
    expect(lines(id)).not.toContain('squad-kit started the app');
    // The proof is over: the app stops, as before.
    await until('the app to stop', () => !alive(pid!));
    expect(s.kept.size).toBe(0);
  });

  it('a retake of a picture uses it too', async () => {
    const { id, copy } = story();
    let checks = 0;
    const unclear: Record<number, FakeCheck> = { 1: ['not-shown', 'The picture does not show the rooms clearly.', { advice: 'Open the rooms page on a phone.', canShow: true }] };
    check = async (opts) => {
      checks += 1;
      return checkAnswer(opts, checks === 1 ? unclear : {});
    };
    const s = squad();
    await s.review(id);
    await s.proof(id);
    expect(runs.filter((r) => r.window?.tools.includes('ask_api'))).toHaveLength(2);
    expect(checks).toBe(2);
    expect(readTicket(bp, id)!.waiting?.kind).toBe('proof');
    expect(starts(copy)).toHaveLength(1);
  });

  it('a new app when the kept one does not answer any more; the old one stops', async () => {
    const { id, copy } = story();
    const s = squad();
    await s.review(id);
    const [first] = starts(copy);
    fs.writeFileSync(path.join(copy, '.quiet'), String(first));
    await until('the app to go quiet', async () => !(await answers(`http://127.0.0.1:${port}`)));
    expect(alive(first!)).toBe(true);
    await s.proof(id);
    expect(readTicket(bp, id)!.waiting?.kind).toBe('proof');
    expect(starts(copy)).toHaveLength(2);
    expect(lines(id)).toContain('squad-kit started the app');
    await until('the old app to stop', () => !alive(first!));
  });

  it("a new app when the copy's code changed since it started; the old one stops", async () => {
    const { id, copy } = story();
    const s = squad();
    await s.review(id);
    const [first] = starts(copy);
    fs.writeFileSync(path.join(copy, 'new-page.txt'), 'a new page\n');
    await s.proof(id);
    expect(starts(copy)).toHaveLength(2);
    expect(lines(id)).not.toContain('The app squad-kit started earlier still runs, so the Tester uses it');
    await until('the old app to stop', () => !alive(first!));
  });

  it('a review that sends the story back stops it before the Builder starts', async () => {
    const { id, copy } = story();
    reviewer = async (opts) => {
      await callTool(opts.window!, 'look_at_page', { page: '/rooms' });
      return { approved: false, summary: 'Not yet', comments: ['The title is missing.'] };
    };
    let seen: boolean | null = null;
    builder = async () => {
      seen = alive(starts(copy)[0]!);
      return { summary: 'Fixed' };
    };
    const s = squad();
    await s.review(id);
    expect(seen).toBe(false);
    expect(s.kept.size).toBe(0);
    expect(readTicket(bp, id)!.squad?.phase).toBe('test');
  });

  it('a Stop, between the review and the proof, stops it at the next turn', async () => {
    const { id, copy } = story();
    const s = squad();
    await s.review(id);
    const [pid] = starts(copy);
    expect(s.kept.size).toBe(1);
    updateTicket(bp, id, (x) => (x.stopRequested = true));
    s.sweepKept();
    await until('the app to stop', () => !alive(pid!));
    expect(s.kept.size).toBe(0);
  });

  it("before an app starts in a copy, a finished check's leftover there stops; the app kept in another copy runs on", async () => {
    const a = story('Rooms on a phone');
    const b = story('Staff page');
    const s = squad();
    await s.review(a.id);
    const [kept] = starts(a.copy);
    const leftover = orphan(b.copy);
    await s.review(b.id);
    expect(starts(b.copy)).toHaveLength(1);
    expect(lines(b.id)).toContain("Stopped a program left running in this ticket's copy");
    await until('the leftover to stop', () => !alive(leftover));
    // squad-kit's own app, kept for the other story's proof, is never a leftover.
    expect(alive(kept!)).toBe(true);
    expect(await answers(`http://127.0.0.1:${port}`)).toBe(true);
  });

  it("squad-kit stops a process for the app only in its own copies of the project", async () => {
    const { id } = story();
    const outside = path.join(tmp, 'elsewhere');
    fs.mkdirSync(outside);
    const program = orphan(outside);
    const base = squad().windowBase(id, 'builder', outside);
    expect(await base.clearCopy(outside, program)).toBe(false);
    expect(await base.clearCopy(outside)).toBe(false);
    expect(alive(program)).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')("the checks step and an app start in the story's copy", () => {
  function checking(): { id: string; copy: string } {
    const st = story();
    updateTicket(bp, st.id, (x) => {
      x.stage = 'test';
      x.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
    });
    return st;
  }

  it('the checks wait for an app starting in the same copy, then run', async () => {
    const { id, copy } = checking();
    const turn = await takeTurn(copy, 'app');
    let done = false;
    const run = squad().checks(id).then(() => (done = true));
    await sleep(800);
    expect(done).toBe(false);
    turn.release();
    await run;
    expect(readTicket(bp, id)!.gates?.checks).toBe('pass');
  });

  it('an app kept in the same copy stops first, with no line on the story; one kept in another copy runs on', async () => {
    const a = story('Rooms on a phone');
    const b = story('Staff page');
    const s = squad();
    await s.review(a.id);
    await s.review(b.id);
    const [mine] = starts(a.copy);
    const [theirs] = starts(b.copy);
    expect(s.kept.size).toBe(2);
    updateTicket(bp, a.id, (x) => {
      x.stage = 'test';
      x.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
    });
    const before = lines(a.id).length;
    await s.checks(a.id);
    expect(readTicket(bp, a.id)!.gates?.checks).toBe('pass');
    await until('the kept app to stop', () => !alive(mine!));
    expect(s.kept.has(a.id)).toBe(false);
    // Only the log says so: the story's lines are about its checks.
    expect(lines(a.id).slice(before).filter((l) => /stopped|Stopped/.test(l))).toEqual([]);
    expect(alive(theirs!)).toBe(true);
    expect(s.kept.has(b.id)).toBe(true);
  });

  it('an app starting in another copy never holds them back', async () => {
    const { id } = checking();
    const other = story('Staff page');
    const turn = await takeTurn(other.copy, 'app');
    try {
      await squad().checks(id);
      expect(readTicket(bp, id)!.gates?.checks).toBe('pass');
    } finally {
      turn.release();
    }
  });
});
