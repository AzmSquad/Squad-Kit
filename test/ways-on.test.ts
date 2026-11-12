import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import { passing, plainError } from '../src/modules/claude/direct.js';

import { inGuard } from './support/in-guard.js';
/**
 * Dead ends that are ways on now: a network blip waits and tries again, a clash at release gets the clash card, a ticket
 * nobody can touch can be taken, a failed first read says so, Stop during the usage limit stops, and an old process
 * number is never trusted. The AI tool is a fake; git is real.
 */

let answer: (opts: RunOptions) => Promise<RunResult> | RunResult = (opts) => ({ ok: true, structured: {}, text: '', sessionId: opts.resume ?? opts.sessionId ?? 's-1' });
let runs = 0;
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions) => {
    runs += 1;
    return answer(opts);
  },
}));

const { boardPaths, readMeta, readRelease, readTicket, updateTicket, writeMeta, writeTicket } = await import('../src/board/store.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { ensureLiveBoard, setupProject } = await import('../src/engine/setup.js');
const { addWorktree } = await import('./support/copy.js');
const { takeBack } = await import('../src/engine/handover.js');
const { takenOver } = await import('../src/engine/process-group.js');
const { currentStep } = await import('../src/board/setup-state.js');
const { setupLine, setupView, stopSetup } = await import('../src/board/first-run.js');

let tmp: string;
let project: string;
let bp: ReturnType<typeof boardPaths>;
let squad: InstanceType<typeof LiveSquad>;

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tick = () => (squad as unknown as { tick(): void }).tick();
const settle = async () => {
  for (let i = 0; i < 60 && (squad as unknown as { running: Set<string> }).running.size; i += 1) await new Promise((r) => setTimeout(r, 50));
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-ways-'));
  runs = 0;
  answer = (opts) => ({ ok: true, structured: {}, text: '', sessionId: opts.resume ?? opts.sessionId ?? 's-1' });
  project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
  fs.writeFileSync(path.join(project, 'limit.txt'), 'limit = 2\n');
  execFileSync('git', ['add', '-A'], { cwd: project });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'start'], { cwd: project });
  setupProject(project);
  bp = ensureLiveBoard(boardPaths(path.join(project, '.squad')), 'App').bp;
  writeMeta(bp, { ...readMeta(bp), scan: { status: 'done' }, runner: 'direct', commands: {} });
  squad = new LiveSquad(bp);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a network or service blip', () => {
  const OFFLINE = 'Claude Code could not reach the internet. Check the connection, then press Try again.';
  const due = (id: string) =>
    updateTicket(bp, id, (x) => {
      x.squad = { phase: 'analyst-read', nextAt: new Date(Date.now() - 1000).toISOString() };
    });

  it('waits and tries again by itself, with no stop card and no failed try', async () => {
    const t = actions.createTicket(bp, { title: 'A thing' });
    answer = () => ({ ok: false, sessionId: 's', text: '', error: OFFLINE });
    due(t.id);
    tick();
    await settle();
    const x = readTicket(bp, t.id)!;
    expect(x.waiting).toBeNull();
    expect(x.stuck).toBeUndefined();
    expect(x.status).toBe('Waiting for the connection. Tries again in 1 minute');
    expect(x.blips).toBe(1);
    expect(Date.parse(x.squad!.nextAt)).toBeGreaterThan(Date.now() + 50_000);
    expect(x.activity.map((a) => a.text).join('\n')).toContain('Not a failed try');
  });

  it('becomes a plain stop only when it does not pass, and Try again starts over', async () => {
    const t = actions.createTicket(bp, { title: 'A thing' });
    answer = () => ({ ok: false, sessionId: 's', text: '', error: OFFLINE });
    for (let i = 0; i < 5; i += 1) {
      due(t.id);
      tick();
      await settle();
    }
    const x = readTicket(bp, t.id)!;
    expect(x.waiting?.kind).toBe('stuck');
    expect(x.stuck?.question).toBe(OFFLINE);
    expect(x.blips).toBeUndefined();
    expect(runs).toBe(5);
  });

  describe('at each step that runs an agent', () => {
    /** A ticket whose build is due in its own conversation, on its own copy. */
    function building(id: string, phase: string, extra: Record<string, unknown> = {}) {
      const wt = addWorktree(project, id, 'main');
      writeTicket(bp, { id, title: 'A thing', ask: '', kind: 'feature', source: { type: 'manual' }, priority: 'normal', stage: 'implement', status: '', waiting: null, createdAt: new Date().toISOString(), createdBy: 'Momen', activity: [], worktree: wt.dir, branch: wt.branch, baseCommit: wt.baseCommit, story: 'x', steps: [{ title: 'one', status: 'todo' }], specApproved: { by: 'Momen', at: new Date().toISOString() }, gates: { checks: 'pending', review: 'pending', proof: 'pending' }, sessions: { build: 'sess-1' }, live: true, squad: { phase, nextAt: new Date(Date.now() - 1000).toISOString() }, ...extra } as never);
    }

    it('a blip at the Builder is no failed try, and so never raises the model level', async () => {
      building('AP-4', 'build');
      const seen: RunOptions[] = [];
      answer = (opts) => {
        seen.push(opts);
        return { ok: false, sessionId: 's', text: '', error: OFFLINE };
      };
      tick();
      await settle();
      let x = readTicket(bp, 'AP-4')!;
      expect(x.fails ?? 0).toBe(0);
      expect(x.blips).toBe(1);
      expect(x.waiting).toBeNull();
      expect(x.activity.map((a) => a.text).join('\n')).toContain('Not a failed try');
      updateTicket(bp, 'AP-4', (y) => {
        y.squad!.nextAt = new Date(Date.now() - 1000).toISOString();
      });
      tick();
      await settle();
      x = readTicket(bp, 'AP-4')!;
      expect(x.fails ?? 0).toBe(0);
      expect(x.blips).toBe(2);
      expect(seen).toHaveLength(2);
      expect(seen[1]!.model).toBe(seen[0]!.model);
      expect(seen[1]!.effort).toBe(seen[0]!.effort);
    });
  });

  it('another stop stays a stop at once', async () => {
    const t = actions.createTicket(bp, { title: 'A thing' });
    answer = () => ({ ok: false, sessionId: 's', text: '', error: 'The agent declined to do this step.' });
    due(t.id);
    tick();
    await settle();
    expect(readTicket(bp, t.id)!.waiting?.kind).toBe('stuck');
  });

  it('knows the words that pass, from the raw errors too', () => {
    for (const raw of ['Connection error.', 'socket hang up', 'getaddrinfo ENOTFOUND api.anthropic.com', 'API error: 503', 'overloaded_error 529']) {
      expect(passing(plainError(raw))).toBe(true);
    }
    expect(passing('The agent declined to do this step.')).toBe(false);
    expect(passing(plainError('not logged in'))).toBe(false);
  });
});

describe('a clash at release', () => {
  it('gets the clash card with its ways out, and leaves the release, so the rest can go', async () => {
    writeMeta(bp, { ...readMeta(bp), git: { base: 'main', remote: '' } });
    const wt = addWorktree(project, 'AP-1', 'main');
    fs.writeFileSync(path.join(wt.dir, 'limit.txt'), 'limit = 3\n');
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm mine', wt.dir);
    // Newer work changed the same line, while the ticket waits for the release, not merged yet.
    fs.writeFileSync(path.join(project, 'limit.txt'), 'limit = 9\n');
    sh('git add limit.txt && git -c user.name=t -c user.email=t@t commit -qm theirs', project);
    const draft = actions.ensureDraftRelease(bp, 'minor');
    writeTicket(bp, {
      id: 'AP-1',
      title: 'Raise the limit',
      ask: '',
      kind: 'feature',
      source: { type: 'manual' },
      priority: 'normal',
      stage: 'release',
      status: '',
      waiting: null,
      release: draft.version,
      createdAt: new Date().toISOString(),
      createdBy: readMeta(bp).user.name,
      activity: [],
      worktree: wt.dir,
      branch: wt.branch,
      baseCommit: wt.baseCommit,
    });
    const { writeRelease } = await import('../src/board/store.js');
    writeRelease(bp, { ...draft, tickets: ['AP-1'] });

    await expect(actions.releaseVersion(bp, draft.version)).rejects.toThrow(/clashes with newer changes in main/);
    const t = readTicket(bp, 'AP-1')!;
    expect(t.waiting?.kind).toBe('stuck');
    expect(t.stuck?.gate).toBe('merge');
    expect(readRelease(bp, draft.version)?.tickets ?? []).not.toContain('AP-1');
    expect(sh('git status --porcelain --untracked-files=no', project)).toBe('');
  }, 40_000);
});

describe('a ticket nobody can touch', () => {
  it('can be taken, with a reason on the record, and it carries on here', () => {
    const t = actions.createTicket(bp, { title: 'A thing' });
    updateTicket(bp, t.id, (x) => {
      x.owner = 'Ahmd';
      x.squad = null;
      x.live = false;
      x.waiting = null;
    });
    expect(() => takeBack(bp, t.id, ' ')).toThrow(/Write why/);
    const x = takeBack(bp, t.id, 'the name was misspelled');
    expect(x.owner).toBe(readMeta(bp).user.name);
    expect(x.handedOver).toMatchObject({ from: 'Ahmd', to: readMeta(bp).user.name });
    expect(x.activity[0]?.text ?? '').toBeDefined();
    expect(x.activity.map((a) => a.text).join('\n')).toContain('Took it from Ahmd. Why: the name was misspelled');
    expect(() => takeBack(bp, t.id, 'again')).toThrow(/yours already/);
  });
});

describe('a first read that failed', () => {
  const failRead = () => {
    const meta = readMeta(bp);
    const steps = (meta.setup?.steps ?? []).map((s) => (s.id === 'read' ? { ...s, state: 'failed' as const, error: 'Claude Code is not installed.' } : ['files', 'tool'].includes(s.id) ? { ...s, state: 'done' as const } : { ...s, state: 'todo' as const }));
    writeMeta(bp, { ...meta, setup: { ...meta.setup!, steps } });
  };

  it('says so, instead of "step 4 of 7" as if it ran', () => {
    failRead();
    const m = readMeta(bp);
    expect(currentStep(m.setup!)?.id).toBe('read');
    const line = setupLine(setupView(bp)!);
    expect(line).toContain('Claude Code is not installed.');
    expect(line).not.toMatch(/step \d of/);
  });
});

describe('Stop while the usage limit holds the first read', () => {
  it('stops at once instead of "Stopping…" until the reset, and Start again works', async () => {
    const meta = readMeta(bp);
    const steps = (meta.setup?.steps ?? []).map((s) => (s.id === 'read' ? { ...s, state: 'now' as const } : s));
    writeMeta(bp, { ...meta, scan: { status: 'running' }, setup: { ...meta.setup!, steps } });
    const { startPause, endPause } = await import('../src/engine/usage-limit.js');
    startPause({ name: 'Claude', resetsAt: new Date(Date.now() + 3_600_000).toISOString() } as never, { project: 'App' });
    try {
      stopSetup(bp);
      expect(readMeta(bp).setup?.stopping).toBe(true);
      tick();
      const after = readMeta(bp);
      expect(after.setup?.stopping).toBeUndefined();
      expect(after.setup?.steps.find((s) => s.id === 'read')?.state).toBe('stopped');
      expect(after.scan?.status).toBe('failed');
      const { setupAgain } = await import('../src/board/first-run.js');
      expect(() => setupAgain(bp)).not.toThrow();
    } finally {
      endPause();
    }
  });
});

describe('a process number from before a crash or a reboot', () => {
  it.skipIf(inGuard)('is not trusted when the process with that number started later', () => {
    const long = new Date(Date.now() - 24 * 3_600_000).toISOString();
    if (process.platform === 'win32') return;
    // This test process started after that record: the number counts as someone else's now.
    expect(takenOver(process.pid, long)).toBe(true);
    // Written after it started, as a running app's record is.
    expect(takenOver(process.pid, new Date().toISOString())).toBe(false);
    // A process that is gone, or no record of when: as before.
    expect(takenOver(999_999, long)).toBe(false);
    expect(takenOver(process.pid, undefined)).toBe(false);
  });
});
