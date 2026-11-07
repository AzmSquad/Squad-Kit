import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * Work saved without the project's commit hooks (the work so far, before the base comes in or a hand over) never gets
 * past them. A hook looks only at what is staged, so at accept it runs on the whole change. Real git and real hooks.
 */

// Real commits with real hooks in every test: slow on a busy computer, and no test here is about time.
vi.setConfig({ testTimeout: 60_000 });

vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => ({ ok: true, structured: { summary: 'Done' }, text: '', sessionId: opts.resume ?? opts.sessionId ?? 's-1' }),
}));

const { boardPaths, readMeta, readTicket, updateTicket, writeMeta, writeTicket } = await import('../src/board/store.js');
const actions = await import('../src/board/actions.js');
const auto = await import('../src/board/auto.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { commitAll } = await import('../src/engine/git.js');
const { addWorktree } = await import('./support/copy.js');
const { ticketDocs, readTicketDocs } = await import('../src/board/docs.js');
const { ensureLiveBoard, setupProject } = await import('../src/engine/setup.js');

let tmp: string;
let project: string;
let bp: ReturnType<typeof boardPaths>;

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function hook(name: string, body: string) {
  const dir = path.join(project, '.git', 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

/** What a tool like lint-staged does: it looks only at what is staged. */
const REFUSES_THE_WORK = `if git diff --cached --name-only | grep -q limit.txt; then echo "lint errors in limit.txt"; exit 1; fi; exit 0`;

function ticket(id: string, extra: Record<string, unknown> = {}): string {
  const wt = addWorktree(project, id, 'main');
  fs.writeFileSync(path.join(wt.dir, 'limit.txt'), 'limit = 3\n');
  writeTicket(bp, {
    id,
    title: 'Raise the limit',
    ask: '',
    kind: 'feature',
    source: { type: 'manual' },
    priority: 'normal',
    stage: 'review',
    status: '',
    waiting: { kind: 'proof', summary: '' },
    createdAt: new Date().toISOString(),
    createdBy: 'Momen',
    activity: [],
    worktree: wt.dir,
    branch: wt.branch,
    baseCommit: wt.baseCommit,
    gates: { checks: 'pass', review: 'pass', proof: 'pass' },
    ...extra,
  } as never);
  return wt.dir;
}

/** The work so far, saved as the live squad does before the base comes in. */
async function savedWithoutTheHook(dir: string, id: string) {
  const saved = await commitAll(dir, 'Work so far', 'chore: work so far');
  expect(saved.hookSaid).toContain('lint errors');
  updateTicket(bp, id, (x) => (x.hookOwed = true));
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-owed-')));
  project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  sh('git init -q -b main', project);
  fs.writeFileSync(path.join(project, 'limit.txt'), 'limit = 2\n');
  sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm start', project);
  setupProject(project);
  bp = ensureLiveBoard(boardPaths(path.join(project, '.squad')), 'App').bp;
  writeMeta(bp, { ...readMeta(bp), scan: { status: 'done', empty: false }, runner: 'direct', commands: {}, git: { base: 'main', remote: '' } });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Builds by itself', () => {
  const onAuto = { track: 'auto', proof: [], waiting: null };

  it('never merges work a hook refused: the card waits for the person', async () => {
    hook('pre-commit', REFUSES_THE_WORK);
    const dir = ticket('AP-1', onAuto);
    await savedWithoutTheHook(dir, 'AP-1');
    const t = await auto.acceptByItselfBeside(bp, 'AP-1');
    expect(t.mergedAt).toBeUndefined();
    expect(t.waiting?.kind).toBe('stuck');
    expect(t.stuck?.kind).toBe('hook');
    expect(t.stuck?.detail).toContain('lint errors in limit.txt');
    expect(t.hookOwed).toBe(true);
    expect(t.activity.map((a) => a.text).join('\n')).toContain("Not accepted by itself: the project's own check said no");
    expect(sh('git show main:limit.txt', project)).toBe('limit = 2');
  });

  it('the plain call in the same step never goes past it: the hooks run in one place, and it says so', async () => {
    hook('pre-commit', REFUSES_THE_WORK);
    const dir = ticket('AP-1', onAuto);
    await savedWithoutTheHook(dir, 'AP-1');
    expect(() => auto.acceptByItself(bp, 'AP-1')).toThrow(/has not looked at AP-1 yet/);
    expect(readTicket(bp, 'AP-1')!.mergedAt).toBeUndefined();
    expect(sh('git show main:limit.txt', project)).toBe('limit = 2');
  });

  it('merges once the hook passes on the whole change, and nothing is owed any more', async () => {
    hook('pre-commit', REFUSES_THE_WORK);
    const dir = ticket('AP-1', onAuto);
    await savedWithoutTheHook(dir, 'AP-1');
    hook('pre-commit', `git diff --cached --name-only >> "${tmp}/saw"; exit 0`);
    const t = await auto.acceptByItselfBeside(bp, 'AP-1');
    expect(fs.readFileSync(path.join(tmp, 'saw'), 'utf8')).toContain('limit.txt');
    expect(t.mergedAt).toBeTruthy();
    expect(t.hookOwed).toBeUndefined();
    expect(sh('git show main:limit.txt', project)).toBe('limit = 3');
    void dir;
  });
});

describe('the other tracks', () => {
  it('Looks right shows the hook the whole change, so it really says no', async () => {
    hook('pre-commit', REFUSES_THE_WORK);
    const dir = ticket('AP-1');
    await savedWithoutTheHook(dir, 'AP-1');
    const tip = sh('git rev-parse HEAD', dir);
    await expect(actions.approveBeside(bp, 'AP-1')).rejects.toBeInstanceOf(actions.HookStopped);
    const t = readTicket(bp, 'AP-1')!;
    expect(t.stuck?.kind).toBe('hook');
    expect(t.mergedAt).toBeUndefined();
    // Nothing is lost: the branch is where it was and holds the work.
    expect(sh('git merge-base --is-ancestor ' + tip + ' HEAD && echo yes', dir)).toBe('yes');
    expect(sh('git show HEAD:limit.txt', dir)).toBe('limit = 3');
    expect(fs.readFileSync(path.join(dir, 'limit.txt'), 'utf8')).toBe('limit = 3\n');
  });

  it('the plain call does not go round it either, and the branch stays where it is', async () => {
    hook('pre-commit', REFUSES_THE_WORK);
    const dir = ticket('AP-1');
    await savedWithoutTheHook(dir, 'AP-1');
    const tip = sh('git rev-parse HEAD', dir);
    expect(() => actions.approve(bp, 'AP-1')).toThrow(/has not looked at AP-1 yet/);
    expect(readTicket(bp, 'AP-1')!.mergedAt).toBeUndefined();
    expect(sh('git rev-parse --abbrev-ref HEAD', dir)).toBe('squad/ap-1');
    expect(sh('git rev-parse HEAD', dir)).toBe(tip);
  });

  it('passes on the whole change: the branch moves forward, and later edits go with it', async () => {
    hook('pre-commit', REFUSES_THE_WORK);
    const dir = ticket('AP-1');
    await savedWithoutTheHook(dir, 'AP-1');
    const tip = sh('git rev-parse HEAD', dir);
    fs.writeFileSync(path.join(dir, 'later.txt'), 'later\n');
    hook('pre-commit', `git diff --cached --name-only >> "${tmp}/saw"; exit 0`);
    const t = await actions.approveBeside(bp, 'AP-1');
    const saw = fs.readFileSync(path.join(tmp, 'saw'), 'utf8');
    expect(saw).toContain('limit.txt');
    expect(saw).toContain('later.txt');
    expect(t.mergedAt).toBeTruthy();
    expect(t.hookOwed).toBeUndefined();
    expect(sh('git merge-base --is-ancestor ' + tip + ' squad/ap-1 && echo yes', project)).toBe('yes');
    expect(sh('git log --format=%s -1 squad/ap-1', project)).toBe('Raise the limit (AP-1)');
    expect(sh('git status --porcelain', dir)).toBe('');
    expect(sh('git show main:later.txt', project)).toBe('later');
  });

  it('a commit-msg hook still gets its second try in the usual form', async () => {
    hook('pre-commit', REFUSES_THE_WORK);
    const dir = ticket('AP-1');
    await savedWithoutTheHook(dir, 'AP-1');
    hook('pre-commit', 'exit 0');
    hook('commit-msg', `grep -qE '^(feat|fix|chore)(\\(.+\\))?: ' "$1" || { echo "subject may not be empty"; exit 1; }`);
    const t = await actions.approveBeside(bp, 'AP-1');
    expect(t.mergedAt).toBeTruthy();
    expect(sh('git log --format=%s -1 squad/ap-1', project)).toBe('feat: raise the limit (AP-1)');
  });

  it('Save without this check is the person going past it: a reason, on the record, and nothing owed', async () => {
    hook('pre-commit', REFUSES_THE_WORK);
    const dir = ticket('AP-1');
    await savedWithoutTheHook(dir, 'AP-1');
    await expect(actions.approveBeside(bp, 'AP-1')).rejects.toBeInstanceOf(actions.HookStopped);
    const skip = readTicket(bp, 'AP-1')!.stuck!.options.findIndex((o) => o.do === 'skip-hooks');
    const t = actions.decideStuck(bp, 'AP-1', skip, { reason: 'needs a licence here' });
    expect(t.mergedAt).toBeTruthy();
    expect(t.hookOwed).toBeUndefined();
    expect(t.overrides?.[0]).toMatchObject({ gate: 'hooks', reason: 'needs a licence here' });
    expect(sh('git show main:limit.txt', project)).toBe('limit = 3');
    void dir;
  });

  it('Try the save again still runs the hook on the whole change', async () => {
    hook('pre-commit', REFUSES_THE_WORK);
    const dir = ticket('AP-1');
    await savedWithoutTheHook(dir, 'AP-1');
    await expect(actions.approveBeside(bp, 'AP-1')).rejects.toBeInstanceOf(actions.HookStopped);
    const again = readTicket(bp, 'AP-1')!.stuck!.options.findIndex((o) => o.do === 'save-again');
    await expect(actions.decideStuckBeside(bp, 'AP-1', again)).rejects.toBeInstanceOf(actions.HookStopped);
    expect(readTicket(bp, 'AP-1')!.mergedAt).toBeUndefined();
    void dir;
  });
});

describe('where the debt starts', () => {
  it('bringing in the base marks the ticket when the hook said no to the work so far', async () => {
    hook('pre-commit', REFUSES_THE_WORK);
    const dir = ticket('AP-1');
    const squad = new LiveSquad(bp) as unknown as { bringInBase(t: unknown, base: string): unknown };
    await squad.bringInBase(readTicket(bp, 'AP-1')!, 'main');
    const t = readTicket(bp, 'AP-1')!;
    expect(t.hookOwed).toBe(true);
    expect(t.activity.at(-1)?.text).toContain('The check runs on the whole change before it goes in');
    expect(sh('git status --porcelain', dir)).toBe('');
  });

  it('the mark travels with the ticket, so another computer owes it too', () => {
    const docs = ticketDocs({ id: 'AP-1', title: 'x', hookOwed: true } as never);
    expect(readTicketDocs(docs).hookOwed).toBe(true);
  });
});

describe('Let the Builder fix it, when the hook itself is what is wrong', () => {
  it('says so in plain words the next time, and it stays the person\'s call', async () => {
    hook('pre-commit', 'echo "the rule itself is wrong"; exit 1');
    ticket('AP-1');
    await expect(actions.approveBeside(bp, 'AP-1')).rejects.toBeInstanceOf(actions.HookStopped);
    const card = readTicket(bp, 'AP-1')!;
    expect(card.stuck!.options[0]!.note).toContain('It cannot change the check itself: that stays with you or an engineer');
    expect(card.stuck!.question).not.toContain('The Builder tried');
    const asked = actions.decideStuck(bp, 'AP-1', 0);
    expect(asked.changeRequest).toContain('that is for the person or an engineer to decide');
    updateTicket(bp, 'AP-1', (x) => {
      x.stage = 'review';
      x.squad = null;
      x.waiting = { kind: 'proof', summary: '' };
    });
    await expect(actions.approveBeside(bp, 'AP-1')).rejects.toBeInstanceOf(actions.HookStopped);
    const q = readTicket(bp, 'AP-1')!.stuck!.question;
    expect(q).toContain('If the check itself is what needs changing, that is for you or an engineer');
    expect(q).not.toMatch(/commit hook|pre-commit/);
  });
});
