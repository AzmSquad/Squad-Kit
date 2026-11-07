import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execSync } from 'node:child_process';
import { Hono } from 'hono';
import yaml from 'js-yaml';
import { chooseProject } from '../src/core/paths.js';
import { runRelease } from '../src/commands/board.js';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * What a team adds to its harness: one file, read fresh at each step from the main folder, rules that can only add care,
 * checklists on the existing routes, and gates squad-kit runs itself. Real git and real commands; no real AI runs.
 */

const calls: RunOptions[] = [];
let answer: Record<string, unknown> = {};
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    return { ok: true, structured: answer, sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

const { boardPaths, readMeta, readRelease, readTicket, updateTicket, writeMeta, writeTicket } = await import('../src/board/store.js');
const { fetchPushed, projectFromPushed } = await import('../src/engine/handover.js');
const { stageReleaseDocs } = await import('../src/engine/project-git.js');
const { addAddition, harnessFile, mergeHarness, readHarness, removeAddition, rulesFor, ruleNote, setAdditionState, checklistAsk, checklistsFor, answerLists, NOT_AN_ADDITION, MAX_RULES, MAX_RULE_CHARS, MAX_CHECKLIST_QUESTIONS } = await import('../src/board/additions.js');
const { lookInFolder, MAX_FOLDER_FILES } = await import('../src/board/additions-folder.js');
const { CANT_RUN, addTriedGate, gatesChanged, noteGates, runGate, runGatesAt, tryGate } = await import('../src/engine/gate-run.js');
const { ownCheck, runChecks, runCommand } = await import('../src/engine/checks.js');
const { ticketGuard } = await import('../src/engine/project-guard.js');
const { worktreeRoot } = await import('../src/engine/git.js');
const { addWorktree } = await import('./support/copy.js');
const { watchLane, checkLane } = await import('../src/engine/lane.js');
const { harnessView } = await import('../src/engine/harness.js');
const { mountBoardApi } = await import('../src/console/api/board.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad, MAX_CHECK_TRIES } = await import('../src/engine/live.js');
const { claudeRunOptions } = await import('../src/modules/claude/index.js');
const { sandboxAsk } = await import('../src/engine/sandbox.js');
const P = await import('../src/engine/prompts.js');

type Bp = ReturnType<typeof boardPaths>;

let tmp: string;
let project: string;
let bp: Bp;

const sh = (cmd: string, cwd = project) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const script = (file: string, body: string, dir = project) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
};
const ME = 'Momen';
const rule = (name: string, text = 'Keep it small.', agents = ['all']) => ({ kind: 'rule' as const, name, agents, text });
const list = (name: string, agent: 'reviewer' | 'tester' = 'reviewer', questions = ['Is it small?', 'Is it clear?']) => ({ kind: 'checklist' as const, name, agent, questions });
/** A gate as it is after its try: tried, and set to the state a test wants. */
function gate(name: string, command: string, more: { when?: 'checks' | 'merge' | 'release'; on_fail?: 'stop' | 'warn'; state?: 'try' | 'on' | 'off'; part?: string } = {}) {
  const a = addAddition(bp, ME, { kind: 'gate', name, command, when: more.when ?? 'checks', on_fail: more.on_fail ?? 'stop', ...(more.part ? { part: more.part } : {}), tried: { at: new Date().toISOString(), by: ME, result: 'passed', seconds: 1 } });
  if (more.state && more.state !== 'try') setAdditionState(bp, ME, a.id, more.state);
  return a;
}

function liveMeta(extra: Record<string, unknown> = {}) {
  writeMeta(bp, {
    project: 'App',
    key: 'AP',
    nextNumber: 2,
    engine: 'live',
    runner: 'direct',
    user: { name: ME, role: 'Project manager' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
    commands: { test: 'node -e "console.log(\'Tests 3 passed\')"' },
    git: { base: 'main', remote: '' },
    scan: { status: 'done', empty: false },
    ...extra,
  } as Parameters<typeof writeMeta>[1]);
}

/** A story with its copy of the code, at the given stage. */
function story(more: Record<string, unknown> = {}, id = 'AP-1') {
  const wt = addWorktree(project, id, 'main');
  writeTicket(bp, {
    id,
    title: 'Raise the limit',
    ask: '',
    kind: 'feature',
    source: { type: 'manual' },
    priority: 'normal',
    stage: 'test',
    status: '',
    waiting: null,
    live: true,
    createdAt: new Date().toISOString(),
    createdBy: ME,
    activity: [],
    worktree: wt.dir,
    branch: wt.branch,
    baseCommit: wt.baseCommit,
    gates: { checks: 'pending', review: 'pending', proof: 'pending' },
    sessions: { build: '11111111-1111-4111-8111-111111111111' },
    ...more,
  } as Parameters<typeof writeTicket>[1]);
  return wt.dir;
}

const squad = () => new LiveSquad(bp) as unknown as { step(id: string, phase: string): Promise<void>; protectedFiles(cwd?: string): string[]; cannotShow(id: string, rows: unknown[], retook: boolean, noes: unknown[]): void };

beforeEach(() => {
  calls.length = 0;
  answer = { summary: 'Fixed' };
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-additions-')));
  project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  sh('git init -q -b main');
  fs.writeFileSync(path.join(project, 'limit.txt'), 'limit = 2\n');
  sh('git add -A && git commit -qm start');
  bp = boardPaths(path.join(project, '.squad'));
  liveMeta();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the one file', () => {
  it('missing or empty is simply no additions', () => {
    expect(readHarness(bp)).toEqual({ additions: [], log: [] });
    fs.writeFileSync(harnessFile(bp), '');
    expect(readHarness(bp)).toEqual({ additions: [], log: [] });
  });

  it('broken YAML and merge clash markers say so, and nothing is written over them', () => {
    fs.writeFileSync(harnessFile(bp), 'additions: [ { nope');
    expect(readHarness(bp).broken).toMatch(/not written correctly/);
    expect(() => addAddition(bp, ME, rule('A'))).toThrow(/Nothing was changed/);
    const clash = 'additions:\n<<<<<<< HEAD\n  - id: a\n=======\n  - id: b\n>>>>>>> theirs\n';
    fs.writeFileSync(harnessFile(bp), clash);
    expect(readHarness(bp).broken).toMatch(/merge clash/);
    expect(() => removeAddition(bp, ME, 'a')).toThrow();
    expect(fs.readFileSync(harnessFile(bp), 'utf8')).toBe(clash);
  });

  it('a gate with no command is no addition to run past: the file counts as broken', () => {
    fs.writeFileSync(harnessFile(bp), yaml.dump({ additions: [{ id: 'g', kind: 'gate', name: 'G', state: 'on', when: 'checks', on_fail: 'stop' }] }));
    expect(readHarness(bp).broken).toMatch(/not complete/);
  });

  it('keeps what it does not know when it saves: fields, kinds and the top of the file', () => {
    fs.writeFileSync(harnessFile(bp), yaml.dump({ schema: 3, additions: [{ id: 'r1', kind: 'rule', name: 'R', state: 'on', from: 'typed', added_by: 'x', added_at: 'y', agents: ['all'], text: 'T', colour: 'blue' }, { id: 'w', kind: 'webhook', url: 'u' }], log: [] }));
    expect(readHarness(bp).additions.map((a) => a.id)).toEqual(['r1']);
    setAdditionState(bp, ME, 'r1', 'off');
    const doc = yaml.load(fs.readFileSync(harnessFile(bp), 'utf8')) as { schema: number; additions: Record<string, unknown>[] };
    expect(doc.schema).toBe(3);
    expect(doc.additions[0]).toMatchObject({ colour: 'blue', state: 'off' });
    expect(doc.additions[1]).toEqual({ id: 'w', kind: 'webhook', url: 'u' });
  });

  it('every add, change and removal stays on the log, with who and when', () => {
    const a = addAddition(bp, 'Sara', list('L'));
    setAdditionState(bp, 'Omar', a.id, 'on');
    removeAddition(bp, 'Lina', a.id);
    const { additions, log } = readHarness(bp);
    expect(additions).toEqual([]);
    expect(log.map((l) => [l.did, l.by, l.name])).toEqual([['added', 'Sara', 'L'], ['on', 'Omar', 'L'], ['removed', 'Lina', 'L']]);
    expect(log.every((l) => Date.parse(l.at) > 0)).toBe(true);
  });

  it('two programs saving at once lose nothing', async () => {
    const runner = path.join(tmp, 'save.ts');
    const store = path.resolve('src/board/additions.ts');
    fs.writeFileSync(runner, `import { addAddition } from ${JSON.stringify(store)};
const bp = { squadDir: ${JSON.stringify(bp.squadDir)} } as never;
for (let i = 0; i < 12; i += 1) addAddition(bp, process.argv[2]!, { kind: 'checklist', name: process.argv[2]! + i, agent: 'reviewer', questions: ['Q'] });
`);
    const save = (who: string) =>
      new Promise<void>((resolve, reject) => {
        execFile(path.resolve('node_modules/.bin/tsx'), [runner, who], { cwd: process.cwd() }, (err) => (err ? reject(err) : resolve()));
      });
    await Promise.all([save('a'), save('b')]);
    const { additions, log } = readHarness(bp);
    expect(additions).toHaveLength(24);
    expect(new Set(additions.map((a) => a.name)).size).toBe(24);
    expect(log).toHaveLength(24);
    expect(fs.readdirSync(bp.squadDir).filter((f) => f.startsWith('harness.yaml.'))).toEqual([]);
  });

  it('Arabic names and words come back as they were typed', () => {
    const a = addAddition(bp, 'مؤمن', rule('قاعدة الأسماء', 'اكتب الأسماء بوضوح.'));
    const again = readHarness(bp).additions.find((x) => x.id === a.id)!;
    expect(again).toMatchObject({ name: 'قاعدة الأسماء', text: 'اكتب الأسماء بوضوح.', added_by: 'مؤمن' });
    expect(fs.readFileSync(harnessFile(bp), 'utf8')).toContain('قاعدة الأسماء');
  });

  it('the same name again is already added', () => {
    addAddition(bp, ME, rule('Names'));
    expect(() => addAddition(bp, ME, rule(' names '))).toThrow(/already added/);
    expect(addAddition(bp, ME, list('Names')).name).toBe('Names');
  });

});

describe('two people on one project', () => {
  /** What a teammate's copy of the file holds, as text, made by the same code on another folder. */
  const theirCopy = (make: (other: Bp) => void): string => {
    const other = boardPaths(path.join(tmp, 'other', '.squad'));
    fs.mkdirSync(other.squadDir, { recursive: true });
    make(other);
    return fs.readFileSync(harnessFile(other), 'utf8');
  };
  const names = () => readHarness(bp).additions.map((a) => a.name).sort();

  it('what each one added stays, and so does the record of it', () => {
    addAddition(bp, 'Sara', rule('Mine'));
    const text = mergeHarness(bp, theirCopy((o) => addAddition(o, 'Omar', rule('Theirs'))));
    expect(names()).toEqual(['Mine', 'Theirs']);
    expect(readHarness(bp).log.map((l) => l.by).sort()).toEqual(['Omar', 'Sara']);
    expect(yaml.load(text)).toEqual(yaml.load(fs.readFileSync(harnessFile(bp), 'utf8')));
  });

  it('taken in twice, nothing doubles', () => {
    const theirs = theirCopy((o) => addAddition(o, 'Omar', rule('Theirs')));
    mergeHarness(bp, theirs);
    mergeHarness(bp, theirs);
    expect(names()).toEqual(['Theirs']);
    expect(readHarness(bp).log).toHaveLength(1);
  });

  it('removed by one, an old copy of the other does not bring it back', () => {
    const theirs = theirCopy((o) => addAddition(o, 'Omar', rule('Old')));
    mergeHarness(bp, theirs);
    removeAddition(bp, 'Sara', readHarness(bp).additions[0]!.id);
    mergeHarness(bp, theirs);
    expect(names()).toEqual([]);
    expect(readHarness(bp).log.map((l) => l.did)).toEqual(['added', 'removed']);
  });

  it('changed by one, it stays changed when the other holds the older state', () => {
    const added = addAddition(bp, 'Sara', rule('Shared'));
    const old = fs.readFileSync(harnessFile(bp), 'utf8');
    vi.useFakeTimers({ now: Date.now() + 60_000, toFake: ['Date'] });
    try {
      setAdditionState(bp, 'Sara', added.id, 'off');
    } finally {
      vi.useRealTimers();
    }
    mergeHarness(bp, old);
    expect(readHarness(bp).additions[0]!.state).toBe('off');
  });

  it('a copy that cannot be read is never mixed in, and a broken file here is left for an engineer', () => {
    addAddition(bp, 'Sara', rule('Mine'));
    const before = fs.readFileSync(harnessFile(bp), 'utf8');
    expect(mergeHarness(bp, '<<<<<<< HEAD\nadditions: []\n')).toBe(before);
    expect(names()).toEqual(['Mine']);
    fs.writeFileSync(harnessFile(bp), 'additions: [ { nope');
    expect(mergeHarness(bp, before)).toBe(before);
    expect(fs.readFileSync(harnessFile(bp), 'utf8')).toBe('additions: [ { nope');
  });

  it('a release never takes away what a teammate added', () => {
    addAddition(bp, 'Sara', rule('Mine'));
    const copy = path.join(tmp, 'release-copy');
    fs.mkdirSync(path.join(copy, '.squad'), { recursive: true });
    execSync('git init -q -b main', { cwd: copy });
    fs.writeFileSync(path.join(copy, '.squad', 'harness.yaml'), theirCopy((o) => addAddition(o, 'Omar', rule('Theirs'))));
    stageReleaseDocs(bp, copy, { version: 'v1.0.0', tickets: [], notes: '', status: 'draft' } as never, []);
    const inRelease = yaml.load(fs.readFileSync(path.join(copy, '.squad', 'harness.yaml'), 'utf8')) as { additions: { name: string }[] };
    expect(inRelease.additions.map((a) => a.name).sort()).toEqual(['Mine', 'Theirs']);
    expect(names()).toEqual(['Mine', 'Theirs']);
  });

  it("a teammate's additions reach this computer once they are on the base", async () => {
    const remote = path.join(tmp, 'remote.git');
    execSync(`git init -q --bare -b main "${remote}"`);
    sh(`git remote add origin "${remote}" && git push -q origin main`);
    const mate = path.join(tmp, 'mate');
    execSync(`git clone -q "${remote}" "${mate}"`);
    fs.mkdirSync(path.join(mate, '.squad'));
    fs.writeFileSync(path.join(mate, '.squad', 'harness.yaml'), theirCopy((o) => addAddition(o, 'Omar', { kind: 'gate', name: 'Their gate', command: 'true', when: 'checks', on_fail: 'stop' })));
    execSync('git add -A && git -c user.name=o -c user.email=o@x commit -qm added && git push -q origin main', { cwd: mate });
    addAddition(bp, 'Sara', rule('Mine'));
    await fetchPushed(bp);
    expect(names()).toEqual(['Mine', 'Their gate']);
  });

  it('a new computer picks them up with the settings, before any release', () => {
    const remote = path.join(tmp, 'remote.git');
    execSync(`git init -q --bare -b main "${remote}"`);
    sh(`git remote add origin "${remote}" && git push -q origin main`);
    const mate = path.join(tmp, 'mate');
    execSync(`git clone -q "${remote}" "${mate}"`);
    fs.mkdirSync(path.join(mate, '.squad'));
    fs.writeFileSync(path.join(mate, '.squad', 'config.yaml'), 'board:\n  id: b1\n');
    fs.writeFileSync(path.join(mate, '.squad', 'harness.yaml'), theirCopy((o) => addAddition(o, 'Omar', rule('Theirs'))));
    execSync('git checkout -q -b squad/ab-1 && git add -A && git -c user.name=o -c user.email=o@x commit -qm hand && git push -q origin squad/ab-1', { cwd: mate });
    const fresh = path.join(tmp, 'fresh');
    execSync(`git clone -q "${remote}" "${fresh}"`);
    fs.mkdirSync(path.join(fresh, '.squad'));
    expect(projectFromPushed(path.join(fresh, '.squad'))).toBeTruthy();
    expect(fs.readFileSync(path.join(fresh, '.squad', 'harness.yaml'), 'utf8')).toContain('Theirs');
  });

  it('the page says whether the team gets them', () => {
    expect(harnessView(readMeta(bp), bp).additions.shared).toBe(true);
    writeMeta(bp, { ...readMeta(bp), documentsInGit: false });
    expect(harnessView(readMeta(bp), bp).additions.shared).toBe(false);
  });
});

describe('looking in a folder that fights back', () => {
  it('a folder that is not there is said plainly', () => {
    expect(() => lookInFolder(path.join(tmp, 'nope'), [], {})).toThrow(/can't open that folder/);
  });

  it('a folder it may not open is left out, and the rest is still found', () => {
    const f = path.join(tmp, 'std');
    fs.mkdirSync(path.join(f, 'closed'), { recursive: true });
    fs.writeFileSync(path.join(f, 'AGENTS.md'), '# Style\nSmall functions.\n');
    fs.chmodSync(path.join(f, 'closed'), 0);
    try {
      const look = lookInFolder(f, [], {});
      expect(look.finds.map((x) => x.name)).toContain('Style');
      expect(look.left).toBeGreaterThanOrEqual(process.getuid?.() === 0 ? 0 : 1);
    } finally {
      fs.chmodSync(path.join(f, 'closed'), 0o755);
    }
  });
});

describe('release gates and copies left behind', () => {
  it('a copy left by an app that ended goes when the next try starts; a recent one stays', async () => {
    const root = worktreeRoot(project);
    const old = path.join(root, 'gate-copy-old');
    const recent = path.join(root, 'gate-copy-new');
    fs.mkdirSync(old, { recursive: true });
    fs.mkdirSync(recent, { recursive: true });
    const long = new Date(Date.now() - 3 * 60 * 60_000);
    fs.utimesSync(old, long, long);
    await tryGate(bp, ME, { command: 'true' });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('rules', () => {
  it('are sent after the core prompts, with the words that say they only add care. Off means not sent', async () => {
    seedDemoBoard(bp, { speed: 50 });
    writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct' });
    const a = addAddition(bp, ME, rule('Plain names', 'Use plain names.', ['architect']));
    addAddition(bp, ME, rule('Only the Tester', 'Look twice.', ['tester']));
    const t = actions.createTicket(bp, { title: 'Fix the typo', track: 'express' });
    answer = { story: 'As a clerk, I want the word right.', criteria: [{ given: 'a', when: 'b', then: 'c' }], steps: ['x'], tests: 1, screens: 0, releaseNote: 'n' };
    await squad().step(t.id, 'plan-write');
    const sent = calls[0]!.appendSystemPrompt!;
    expect(sent.indexOf(P.PROCESS_RULE)).toBeGreaterThanOrEqual(0);
    expect(sent.indexOf('Use plain names.')).toBeGreaterThan(sent.indexOf(P.PROCESS_RULE));
    expect(sent).toMatch(/They can only add care\. squad-kit's process comes first/);
    expect(sent).not.toContain('Look twice.');
    setAdditionState(bp, ME, a.id, 'off');
    expect(rulesFor(bp, 'architect')).toBe('');
  });

  it('has On and Off only, and its limits are real', () => {
    const a = addAddition(bp, ME, rule('R'));
    expect(a.state).toBe('on');
    expect(() => setAdditionState(bp, ME, a.id, 'try')).toThrow(/no Try first/);
    expect(() => addAddition(bp, ME, rule('Long', 'x'.repeat(MAX_RULE_CHARS + 1)))).toThrow(new RegExp(String(MAX_RULE_CHARS)));
    for (let i = 1; i < MAX_RULES; i += 1) addAddition(bp, ME, rule(`R${i}`));
    expect(() => addAddition(bp, ME, rule('One too many'))).toThrow(new RegExp(String(MAX_RULES)));
    const limits = harnessView(readMeta(bp), bp).limits.map((l) => l.id);
    expect(limits).toEqual(expect.arrayContaining(['MAX_RULES', 'MAX_RULE_CHARS', 'MAX_CHECKLIST_QUESTIONS', 'MAX_FOLDER_FILES', 'MAX_FOLDER_FILE_BYTES']));
  });

  it('a rule that asks for a commit, a push or a pull request gets a note, and changes nothing the agent may do', () => {
    for (const asks of ['Always commit your work.', 'git push when done', 'Open a pull request at the end.']) expect(ruleNote(asks)).toMatch(/squad-kit does those itself/);
    expect(ruleNote('Keep names short.')).toBeUndefined();
    addAddition(bp, ME, rule('Own it', 'Always commit, push and open a pull request yourself.'));
    const dir = project;
    const options = claudeRunOptions({ cwd: dir, prompt: 'x', permissions: ['read', 'edit', 'run'], instructions: rulesFor(bp, 'builder'), protectedFiles: squad().protectedFiles(dir) } as never);
    expect(options.disallowedTools).toEqual(expect.arrayContaining(['Bash(git commit:*)', 'Bash(git push:*)', 'Bash(gh pr:*)']));
  });

  it('the guard really stops a commit in a copy: its git folder is closed, whatever a rule says', async () => {
    if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) return;
    const copy = story();
    const before = sh('git rev-parse HEAD', copy);
    fs.writeFileSync(path.join(copy, 'limit.txt'), 'limit = 9\n');
    const guard = ticketGuard(bp, { cwd: copy, id: 'AP-1' });
    const r = await runCommand(copy, 'git add -A && git commit -qm sneaked', 20_000, { guard });
    expect(r.ok).toBe(false);
    expect(sh('git rev-parse HEAD', copy)).toBe(before);
    // An agent's own shell: its git folder is closed in the sandbox the AI tool runs in, and its keys are out of reach.
    const ask = sandboxAsk({ cwd: copy, root: project, read: [], proof: bp.proofDir, secrets: [] });
    expect(ask.noWrite).toEqual(expect.arrayContaining([path.join(copy, '.git'), path.join(project, '.git')]));
    // The pull request host's address is not among the places it can reach. A push has only the deny rule and the hidden keys: github.com is open, for packages.
    expect(ask.hosts).not.toContain('api.github.com');
    expect(ask.hosts).toContain('github.com');
  });

  it('a commit made anyway is seen by the lane, whatever a rule says', async () => {
    const copy = story();
    const lane = await watchLane(copy, []);
    fs.writeFileSync(path.join(copy, 'limit.txt'), 'limit = 9\n');
    sh('git add -A && git commit -qm sneaked', copy);
    expect((await checkLane(lane)).moved).toMatch(/moved from/);
  });
});

describe('agents cannot change the file', () => {
  it('the file is under the folder every agent is denied, and a change in a story goes back', async () => {
    const copy = story();
    const names = squad().protectedFiles(copy);
    expect(names).toContain('.squad/');
    const options = claudeRunOptions({ cwd: copy, prompt: 'x', permissions: ['read', 'edit', 'run'], protectedFiles: names } as never);
    expect(options.disallowedTools).toEqual(expect.arrayContaining(['Edit(**/.squad/**)', 'Write(**/.squad/**)']));
    fs.mkdirSync(path.join(copy, '.squad'), { recursive: true });
    fs.writeFileSync(path.join(copy, '.squad', 'harness.yaml'), 'additions:\n  - keep me\n');
    const lane = await watchLane(copy, names);
    fs.writeFileSync(path.join(copy, '.squad', 'harness.yaml'), 'additions: []\n');
    expect((await checkLane(lane)).restored).toEqual(expect.arrayContaining(['.squad/harness.yaml']));
    expect(fs.readFileSync(path.join(copy, '.squad', 'harness.yaml'), 'utf8')).toContain('keep me');
  });

  it('a story whose diff touches the file: the change does not travel with it', async () => {
    fs.mkdirSync(bp.squadDir, { recursive: true });
    addAddition(bp, ME, rule('The real one'));
    sh('git add -f .squad/harness.yaml && git commit -qm additions');
    const copy = story({ stage: 'review', status: '', waiting: { kind: 'proof', summary: '' }, gates: { checks: 'pass', review: 'pass', proof: 'pass' } });
    fs.writeFileSync(path.join(copy, 'limit.txt'), 'limit = 3\n');
    // Written by a test command, say: no agent's lane looks at that.
    fs.mkdirSync(path.join(copy, '.squad'), { recursive: true });
    fs.writeFileSync(path.join(copy, '.squad', 'harness.yaml'), 'additions: []\n');
    const t = await actions.approveBeside(bp, 'AP-1');
    expect(t.mergedAt).toBeTruthy();
    expect(sh('git show main:.squad/harness.yaml')).toContain('The real one');
    expect(readHarness(bp).additions[0]!.name).toBe('The real one');
  });

  it("the engine reads the project's main folder, never a story's copy", async () => {
    const copy = story();
    gate('Real one', 'exit 1', { state: 'on' });
    // A story that emptied its own copy of the file changes nothing.
    fs.mkdirSync(path.join(copy, '.squad'), { recursive: true });
    fs.writeFileSync(path.join(copy, '.squad', 'harness.yaml'), 'additions: []\n');
    await squad().step('AP-1', 'test');
    expect(readTicket(bp, 'AP-1')!.gates?.checksText).toMatch(/Real one failed/);
  });

  it('the guard leaves the main folder closed: nothing but the copy and a few caches can be written', () => {
    const copy = story();
    const guard = ticketGuard(bp, { cwd: copy, id: 'AP-1' });
    const open = [guard.cwd, ...guard.write];
    // Under the temp folder, as this test is, it would be open anyway. A real project is not.
    expect(open).not.toContain(project);
    expect(open).not.toContain(bp.squadDir);
  });
});

describe('a gate run', () => {
  const dir = () => project;

  it('tells passing, failing and not being able to run apart', async () => {
    expect((await runGate(dir(), 'echo ok')).result).toBe('passed');
    expect((await runGate(dir(), 'echo no; exit 3'))).toMatchObject({ result: 'failed', output: 'no' });
    expect(await runGate(dir(), 'no-such-tool-here --x')).toMatchObject({ result: 'cant-run', why: CANT_RUN.missing });
    script('not-runnable', 'exit 0');
    fs.chmodSync(path.join(project, 'not-runnable'), 0o644);
    expect(await runGate(dir(), './not-runnable')).toMatchObject({ result: 'cant-run', why: CANT_RUN.missing });
    fs.writeFileSync(path.join(project, 'package.json'), '{"scripts":{}}');
    expect(await runGate(dir(), 'npm run nope')).toMatchObject({ result: 'cant-run', why: CANT_RUN.missing });
  });

  it('a hanging one runs out of time and cannot run; a silent one too', async () => {
    expect(await runGate(dir(), 'sleep 30', {}, 150)).toMatchObject({ result: 'cant-run', why: CANT_RUN.time });
    expect(await runGate(dir(), 'sleep 30', { silentMs: 120 })).toMatchObject({ result: 'cant-run', why: CANT_RUN.time });
    // Silent and quick is fine.
    expect((await runGate(dir(), 'sleep 0.1')).result).toBe('passed');
  });

  it('runs once more after a failure, as a project check does', async () => {
    const mark = path.join(tmp, 'flaky');
    const r = await runGate(dir(), `test -f ${mark} && exit 0; touch ${mark}; echo first; exit 1`);
    expect(r.result).toBe('passed');
    expect(r.failedFirst).toContain('first');
  });

  it('keeps very long output short, and strange bytes harmless', async () => {
    const long = await runGate(dir(), `node -e "console.log('x'.repeat(300000)); process.exit(1)"`);
    expect(long.result).toBe('failed');
    expect(long.output.length).toBeLessThanOrEqual(6000);
    const odd = await runGate(dir(), `printf 'bad \\377\\376 \\001\\033 bytes'; exit 1`);
    expect(odd.result).toBe('failed');
    expect(odd.output).toContain('bytes');
    expect(odd.output).not.toMatch(/[\u0001\u001b]/);
    // It saves and reads back on a story.
    story();
    updateTicket(bp, 'AP-1', (t) => noteGates(t, [{ id: 'g', name: 'G', command: 'c', state: 'on', stops: true, result: 'failed', output: odd.output, seconds: 1 }], () => undefined));
    expect(readTicket(bp, 'AP-1')!.added![0]!.output).toContain('bytes');
  });

  it('hides secrets it prints', async () => {
    const token = `ghp_${'a1B2'.repeat(9)}`;
    const r = await runGate(dir(), `echo ${token}; exit 1`);
    expect(r.result).toBe('failed');
    expect(r.output).not.toContain(token);
  });

  it('leaves no process behind', async () => {
    const pidFile = path.join(tmp, 'left.pid');
    const r = await runGate(dir(), `sleep 300 > /dev/null 2>&1 & echo $! > ${pidFile}; exit 0`);
    expect(r.result).toBe('passed');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 8000, interval: 100 });
  });

  it('what it changes in the copy goes back, so it never reaches the commit. The project checks do not do this', async () => {
    const copy = story();
    await runGate(copy, `echo changed > limit.txt; echo new > made.txt; exit 0`);
    expect(fs.readFileSync(path.join(copy, 'limit.txt'), 'utf8')).toBe('limit = 2\n');
    expect(fs.existsSync(path.join(copy, 'made.txt'))).toBe(false);
    expect(sh('git status --short', copy)).toBe('');
    // The Builder's own work in the copy stays.
    fs.writeFileSync(path.join(copy, 'limit.txt'), 'limit = 3\n');
    await runGate(copy, 'echo changed > limit.txt');
    expect(fs.readFileSync(path.join(copy, 'limit.txt'), 'utf8')).toBe('limit = 3\n');
    // What checks.ts does: it leaves such a file, for the save to pick up. Worth knowing; left as it is.
    await runChecks(copy, { test: 'echo changed > limit.txt' });
    expect(fs.readFileSync(path.join(copy, 'limit.txt'), 'utf8')).toBe('changed\n');
  });

  it('a guard refusal cannot run', async () => {
    if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) return;
    const copy = story();
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
    fs.writeFileSync(path.join(home, '.ssh', 'id_rsa'), 'PRIVATE');
    const guard = ticketGuard(bp, { cwd: copy, id: 'AP-1', home });
    const r = await runGate(copy, `cat ${path.join(home, '.ssh', 'id_rsa')}`, { guard });
    expect(r).toMatchObject({ result: 'cant-run', why: CANT_RUN.guard });
  });
});

describe('gates at a point of the line', () => {
  let copy: string;
  beforeEach(() => {
    copy = addWorktree(project, 'AP-9', 'main').dir;
  });
  const place = () => [{ dir: copy, repo: '.' }];

  it('reads the file fresh, runs only what is due, and leaves Off out', async () => {
    gate('Checks one', 'true', { state: 'on' });
    gate('Merge one', 'true', { when: 'merge', state: 'on' });
    gate('Off one', 'exit 1', { state: 'off' });
    expect((await runGatesAt(bp, 'checks', place(), [], () => ({}))).map((d) => d.name)).toEqual(['Checks one']);
    gate('Added since', 'true');
    expect((await runGatesAt(bp, 'checks', place(), [], () => ({}))).map((d) => d.name)).toEqual(['Checks one', 'Added since']);
  });

  it('a broken file comes back as a gate that cannot run, so the team\'s gates are never dropped without a word', async () => {
    fs.writeFileSync(harnessFile(bp), '<<<<<<< HEAD\n');
    const [d] = await runGatesAt(bp, 'checks', place(), [], () => ({}));
    expect(d).toMatchObject({ result: 'cant-run', stops: true });
    expect(d!.why).toMatch(/merge clash/);
  });

  it('turned off while it runs says nothing. Turned to Try first, it stops nothing', async () => {
    const a = gate('Slow', 'sleep 0.4; exit 1', { state: 'on' });
    setTimeout(() => setAdditionState(bp, ME, a.id, 'off'), 80);
    expect(await runGatesAt(bp, 'checks', place(), [], () => ({}))).toEqual([]);
    setAdditionState(bp, ME, a.id, 'on');
    setTimeout(() => setAdditionState(bp, ME, a.id, 'try'), 80);
    expect((await runGatesAt(bp, 'checks', place(), [], () => ({})))[0]).toMatchObject({ state: 'try', stops: false, result: 'failed' });
    setAdditionState(bp, ME, a.id, 'on');
    setTimeout(() => removeAddition(bp, ME, a.id), 80);
    expect(await runGatesAt(bp, 'checks', place(), [], () => ({}))).toEqual([]);
  });

  it('a part no longer there cannot run, and a part this copy is not runs elsewhere', async () => {
    liveMeta({ parts: [{ id: 'web', name: 'Web', repo: '.', folder: 'web', needs: [] }, { id: 'api', name: 'API', repo: 'api', needs: [] }] });
    fs.mkdirSync(path.join(copy, 'web'));
    gate('Web one', 'pwd', { part: 'web', state: 'on' });
    gate('API one', 'true', { part: 'api', state: 'on' });
    gate('Gone one', 'true', { part: 'old', state: 'on' });
    const done = await runGatesAt(bp, 'checks', place(), [], () => ({}));
    expect(done.map((d) => [d.name, d.result])).toEqual([['Web one', 'passed'], ['Gone one', 'cant-run']]);
    expect(done[1]!.why).toBe(CANT_RUN.part);
  });
});

describe('with the checks', () => {
  it('a must-pass gate that fails takes the road of a failed project check', async () => {
    story();
    gate('Secret scan', 'echo found one; exit 1', { state: 'on' });
    await squad().step('AP-1', 'test');
    const t = readTicket(bp, 'AP-1')!;
    expect(t.tries).toBe(1);
    expect(t.fails).toBe(1);
    expect(t.gates?.checksText).toBe('Secret scan failed');
    expect(t.activity.some((a) => a.text.startsWith('Checks failed: Secret scan (try 1 of 3)'))).toBe(true);
    expect(t.added![0]).toMatchObject({ result: 'failed', state: 'on' });
    expect(t.added![0]!.stopped).toBeTruthy();
    // The last try is a card, the same as any check.
    updateTicket(bp, 'AP-1', (x) => (x.tries = MAX_CHECK_TRIES - 1));
    await squad().step('AP-1', 'test');
    expect(readTicket(bp, 'AP-1')!.stuck?.gate).toBe('checks');
    expect(readTicket(bp, 'AP-1')!.stuck?.question).toMatch(/Secret scan/);
  });

  it('a gate that passes goes on, with the record on the story', async () => {
    story();
    gate('Fine', 'true', { state: 'on' });
    await squad().step('AP-1', 'test');
    const t = readTicket(bp, 'AP-1')!;
    expect(t.gates?.checks).toBe('pass');
    expect(t.added![0]).toMatchObject({ name: 'Fine', result: 'passed' });
    expect(t.squad?.phase).toBe('review');
  });

  it('Try first records "would have stopped" and stops nothing, and if it cannot run the row just says so', async () => {
    story();
    gate('New scan', 'exit 1');
    gate('New tool', 'no-such-tool-here');
    await squad().step('AP-1', 'test');
    const t = readTicket(bp, 'AP-1')!;
    expect(t.gates?.checks).toBe('pass');
    expect(t.tries ?? 0).toBe(0);
    expect(t.added!.map((r) => r.result)).toEqual(['would-stop', 'cant-run']);
    expect(t.activity.some((a) => /"New scan" would have stopped/.test(a.text))).toBe(true);
    const row = harnessView(readMeta(bp), bp).stages.find((s) => s.id === 'checks')!.gates.find((g) => g.name === 'New tool')!;
    expect(row.seen?.did).toMatch(/Could not run on AP-1/);
    const scan = harnessView(readMeta(bp), bp).stages.find((s) => s.id === 'checks')!.gates.find((g) => g.name === 'New scan')!;
    expect(scan.seen?.did).toMatch(/Would have stopped 1 story/);
    expect(scan.seen?.stopped).toBe(0);
  });

  it('warn only says so and goes on', async () => {
    story();
    gate('Soft', 'exit 1', { on_fail: 'warn', state: 'on' });
    await squad().step('AP-1', 'test');
    const t = readTicket(bp, 'AP-1')!;
    expect(t.gates?.checks).toBe('pass');
    expect(t.added![0]!.result).toBe('warned');
  });

  it('cannot run: a plain card, and it never counts against the story', async () => {
    story();
    gate('Missing tool', 'no-such-tool-here', { state: 'on' });
    await squad().step('AP-1', 'test');
    const t = readTicket(bp, 'AP-1')!;
    expect(t.waiting?.kind).toBe('stuck');
    expect(t.stuck?.kind).toBe('gate-cant-run');
    expect(t.stuck?.question).toMatch(/"Missing tool" could not run/);
    expect(t.stuck?.options.map((o) => o.name)).toEqual(['Try again', 'Let an engineer look', 'Go on without this check']);
    expect(t.tries ?? 0).toBe(0);
    expect(t.fails ?? 0).toBe(0);
    expect(calls).toHaveLength(0);
    // The Harness page finds the story at the gate's row.
    const row = harnessView(readMeta(bp), bp).stages.find((s) => s.id === 'checks')!.gates.find((g) => g.name === 'Missing tool')!;
    expect(row.needs?.[0]?.id).toBe('AP-1');
  });

  it('a failing project check goes first: the can\'t-run card waits until the code is right', async () => {
    story();
    liveMeta({ commands: { test: 'exit 1' } });
    gate('Missing tool', 'no-such-tool-here', { state: 'on' });
    await squad().step('AP-1', 'test');
    const t = readTicket(bp, 'AP-1')!;
    expect(t.stuck).toBeUndefined();
    expect(t.tries).toBe(1);
  });

  it('On Builds by itself, Go on without this check is not offered: the story waits for a person', async () => {
    story({ track: 'auto' });
    gate('Missing tool', 'no-such-tool-here', { state: 'on' });
    await squad().step('AP-1', 'test');
    const t = readTicket(bp, 'AP-1')!;
    expect(t.stuck?.options.map((o) => o.do)).toEqual(['retry', 'engineer']);
    expect(t.waiting?.kind).toBe('stuck');
  });

  it('Let an engineer look leaves the card where it is', async () => {
    story();
    gate('Missing tool', 'no-such-tool-here', { state: 'on' });
    await squad().step('AP-1', 'test');
    actions.decideStuck(bp, 'AP-1', 1);
    const t = readTicket(bp, 'AP-1')!;
    expect(t.waiting?.kind).toBe('stuck');
    expect(t.status).toBe('Waiting for an engineer');
    expect(t.stuck?.options).toHaveLength(3);
    expect(t.activity.some((a) => a.text === 'Asked an engineer to look')).toBe(true);
  });

  it('Go on needs a reason, keeps it on the record, and the rest of the checks still run', async () => {
    story();
    gate('Missing tool', 'no-such-tool-here', { state: 'on' });
    await squad().step('AP-1', 'test');
    expect(() => actions.decideStuck(bp, 'AP-1', 2)).toThrow(/Write why/);
    actions.decideStuck(bp, 'AP-1', 2, { reason: 'The tool comes next week' });
    let t = readTicket(bp, 'AP-1')!;
    expect(t.overrides?.[0]).toMatchObject({ added: 'Missing tool', reason: 'The tool comes next week', by: ME });
    expect(t.squad?.phase).toBe('test');
    await squad().step('AP-1', 'test');
    t = readTicket(bp, 'AP-1')!;
    expect(t.gates?.checks).toBe('pass');
    expect(t.squad?.phase).toBe('review');
    expect(actions.composeNotes(bp, { version: 'v1', tickets: ['AP-1'] } as never)).toMatch(/without your team's check "Missing tool"/);
  });

  it('a stale row: the gate removed while its card waits, and Try again simply goes on', async () => {
    story();
    const a = gate('Missing tool', 'no-such-tool-here', { state: 'on' });
    await squad().step('AP-1', 'test');
    removeAddition(bp, ME, a.id);
    expect(harnessView(readMeta(bp), bp).additions.items).toEqual([]);
    actions.decideStuck(bp, 'AP-1', 0);
    await squad().step('AP-1', 'test');
    const t = readTicket(bp, 'AP-1')!;
    expect(t.gates?.checks).toBe('pass');
    // What it did stays on the story under its own name.
    expect(t.added![0]!.name).toBe('Missing tool');
  });

  it('a stale row: a story waiting on a gate that is gone stays in sight on the line', async () => {
    story();
    const a = gate('Missing tool', 'no-such-tool-here', { state: 'on' });
    await squad().step('AP-1', 'test');
    removeAddition(bp, ME, a.id);
    const row = harnessView(readMeta(bp), bp).stages.find((s) => s.id === 'checks')!.gates.find((g) => g.id === 'gate-cant-run')!;
    expect(row.needs?.map((n) => n.id)).toEqual(['AP-1']);
    expect(harnessView(readMeta(bp), bp).tiles.needs).toHaveLength(1);
  });

  it('a broken file stops the story like a gate that cannot run, and can be gone past with a reason', async () => {
    story();
    fs.writeFileSync(harnessFile(bp), 'additions: [ { nope');
    await squad().step('AP-1', 'test');
    let t = readTicket(bp, 'AP-1')!;
    expect(t.stuck?.kind).toBe('gate-cant-run');
    expect(t.stuck?.question).toMatch(/can't be read/);
    actions.decideStuck(bp, 'AP-1', 2, { reason: 'An engineer is fixing the file' });
    await squad().step('AP-1', 'test');
    t = readTicket(bp, 'AP-1')!;
    expect(t.gates?.checks).toBe('pass');
  });

  it('added while a story is running: it applies from the next step', async () => {
    story();
    await squad().step('AP-1', 'test');
    expect(readTicket(bp, 'AP-1')!.added).toBeUndefined();
    gate('New one', 'exit 1', { state: 'on' });
    await squad().step('AP-1', 'test');
    expect(readTicket(bp, 'AP-1')!.added![0]!.name).toBe('New one');
  });

  it('a gate named like a project check does not pass for it', async () => {
    story();
    liveMeta({ commands: {} });
    gate('test', 'node -e "console.log(\'Tests 5 passed\')"', { state: 'on' });
    await squad().step('AP-1', 'test');
    // No tests of the project's own ran, whatever the gate is called.
    expect(readTicket(bp, 'AP-1')!.gates?.checks).toBe('unchecked');
  });
});

describe('a story that changes what a gate runs', () => {
  it('stops the way weakened tests stop: a file the command names', async () => {
    script('tools/scan.sh', 'exit 0');
    sh('git add -A && git commit -qm scan');
    const copy = story();
    gate('Scan', './tools/scan.sh', { state: 'on' });
    script('tools/scan.sh', 'exit 0 # easier', copy);
    await squad().step('AP-1', 'test');
    const t = readTicket(bp, 'AP-1')!;
    expect(t.stuck?.kind).toBe('weakened');
    expect(t.stuck?.points?.[0]).toMatch(/tools\/scan\.sh changed, and your team's gate "Scan" runs it/);
    // Continue anyway is remembered for this change, as for weakened tests.
    actions.decideStuck(bp, 'AP-1', t.stuck!.options.findIndex((o) => o.do === 'continue'), { reason: 'Reviewed by hand' });
    await squad().step('AP-1', 'test');
    expect(readTicket(bp, 'AP-1')!.gates?.checks).not.toBe('fail');
  });

  it('the script of npm run x', async () => {
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { scan: 'node a.js', other: 'x' } }));
    sh('git add -A && git commit -qm pkg');
    const copy = story();
    const base = sh('git rev-parse HEAD');
    gate('Scan', 'npm run scan', { state: 'on' });
    fs.writeFileSync(path.join(copy, 'package.json'), JSON.stringify({ scripts: { scan: 'node a.js', other: 'y' } }));
    expect(await gatesChanged(bp, copy, '.', base)).toEqual([]);
    fs.writeFileSync(path.join(copy, 'package.json'), JSON.stringify({ scripts: { scan: 'true', other: 'y' } }));
    expect((await gatesChanged(bp, copy, '.', base))[0]!.text).toMatch(/"scan" script in package\.json changed/);
  });

  it('a gate on Try first or warn only stops nothing, so changing it stops nothing', async () => {
    script('tools/scan.sh', 'exit 0');
    sh('git add -A && git commit -qm scan');
    const copy = story();
    const base = sh('git rev-parse HEAD');
    gate('Scan', './tools/scan.sh');
    gate('Soft', './tools/scan.sh', { on_fail: 'warn', state: 'on' });
    script('tools/scan.sh', 'exit 0 # easier', copy);
    expect(await gatesChanged(bp, copy, '.', base)).toEqual([]);
  });
});

describe('scripts/check', () => {
  it('runs as a check when a project has one, once, and a story that changes it stops', async () => {
    script('scripts/check', 'echo checked');
    sh('git add -A && git commit -qm check');
    const copy = story();
    await squad().step('AP-1', 'test');
    const t = readTicket(bp, 'AP-1')!;
    expect(t.gates?.ran?.map((r) => r.name)).toEqual(['test', 'check']);
    script('scripts/check', 'exit 0 # easier', copy);
    updateTicket(bp, 'AP-1', (x) => (x.squad = null));
    await squad().step('AP-1', 'test');
    expect(readTicket(bp, 'AP-1')!.stuck?.kind).toBe('weakened');
  });

  it('no duplicate when a command already runs it, directly or through a script', () => {
    script('scripts/check', 'echo checked');
    expect(ownCheck(project, {})).toBe('./scripts/check');
    expect(ownCheck(project, { test: './scripts/check' })).toBeUndefined();
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { lint: 'sh scripts/check --fast' } }));
    expect(ownCheck(project, { lint: 'npm run lint' })).toBeUndefined();
    fs.chmodSync(path.join(project, 'scripts/check'), 0o644);
    expect(ownCheck(project, {})).toBeUndefined();
  });

  it('a new scripts/check in the story itself is new work, not a weakened check', async () => {
    const copy = story();
    const base = sh('git rev-parse HEAD');
    script('scripts/check', 'exit 0', copy);
    sh('git add -A && git commit -qm new', copy);
    expect(await gatesChanged(bp, copy, '.', base)).toEqual([]);
  });
});

describe('checklists', () => {
  it('asks the questions, and the answers show. Try first: a no stops nothing. A missing answer is not answered', async () => {
    story({ stage: 'review', reviewRound: 0 });
    addAddition(bp, ME, list('Our list'));
    answer = { approved: true, summary: 'Fine', comments: [], checklist: [{ n: 1, answer: 'no', why: 'It grew' }] };
    await squad().step('AP-1', 'review');
    expect(calls[0]!.prompt).toContain("Your team's checklist");
    expect(calls[0]!.prompt).toContain('1. Is it small?');
    const t = readTicket(bp, 'AP-1')!;
    expect(t.gates?.review).toBe('pass');
    expect(t.added![0]!.answers).toEqual([{ question: 'Is it small?', answer: 'no', why: 'It grew' }, { question: 'Is it clear?' }]);
    expect(t.added![0]!.stopped).toBeUndefined();
    const row = harnessView(readMeta(bp), bp).stages.find((s) => s.id === 'review')!.gates.find((g) => g.name === 'Our list')!;
    expect(row.seen?.did).toMatch(/Would have stopped 1 story/);
  });

  it('On: a Reviewer no is a review finding, on the route and rounds there already are', async () => {
    story({ stage: 'review', reviewRound: 0 });
    const a = addAddition(bp, ME, list('Our list'));
    setAdditionState(bp, ME, a.id, 'on');
    answer = { approved: true, summary: 'Fine', comments: [], checklist: [{ n: 1, answer: 'no', why: 'It grew' }, { n: 2, answer: 'yes' }] };
    await squad().step('AP-1', 'review');
    const t = readTicket(bp, 'AP-1')!;
    expect(t.gates?.review).not.toBe('pass');
    expect(t.fails).toBe(1);
    expect(t.activity.some((x) => /Asked for 1 fix.*Our list.*It grew/.test(x.text))).toBe(true);
    // The Builder got it, as any review note.
    expect(calls.at(-1)!.prompt).toContain('Is it small?');
  });

  it('turned off while the agent worked: its answers say nothing', () => {
    story();
    const a = addAddition(bp, ME, list('Our list'));
    setAdditionState(bp, ME, a.id, 'on');
    const lists = checklistsFor(bp, 'reviewer');
    setAdditionState(bp, ME, a.id, 'off');
    updateTicket(bp, 'AP-1', (t) => {
      expect(answerLists(bp, t, lists, [{ n: 1, answer: 'no' }])).toEqual([]);
      expect(t.added).toBeUndefined();
    });
  });

  it('On: a Tester no goes the same way as a "done when" not shown', () => {
    story({ stage: 'review' });
    squad().cannotShow('AP-1', [], true, [{ list: 'Our list', question: 'Does it work on a phone?', why: 'It scrolls' }]);
    const t = readTicket(bp, 'AP-1')!;
    expect(t.stuck).toMatchObject({ gate: 'proof', kind: 'not-shown' });
    expect(t.stuck?.points?.[0]).toMatch(/Our list.*Does it work on a phone.*It scrolls/);
    expect(t.stuck?.options.map((o) => o.do)).toContain('continue');
  });

  it('a retake keeps the earlier answers it was not asked again', () => {
    story();
    const a = addAddition(bp, ME, list('Our list', 'tester'));
    setAdditionState(bp, ME, a.id, 'on');
    const lists = checklistsFor(bp, 'tester');
    updateTicket(bp, 'AP-1', (t) => {
      expect(answerLists(bp, t, lists, [{ n: 1, answer: 'no' }, { n: 2, answer: 'yes' }])).toHaveLength(1);
      expect(answerLists(bp, t, lists, [{ n: 1, answer: 'yes' }])).toEqual([]);
      expect(t.added![0]!.answers!.map((x) => x.answer)).toEqual(['yes', 'yes']);
    });
  });

  it('has a limit, and asks nothing when there is no list', () => {
    expect(checklistAsk([])).toBe('');
    expect(() => addAddition(bp, ME, list('Long', 'reviewer', Array.from({ length: MAX_CHECKLIST_QUESTIONS + 1 }, (_, i) => `Q${i}`)))).toThrow(new RegExp(String(MAX_CHECKLIST_QUESTIONS)));
  });
});

describe('before merge: the road of a refused commit hook', () => {
  function proofReady(more: Record<string, unknown> = {}) {
    const copy = story({ stage: 'review', status: '', waiting: { kind: 'proof', summary: '' }, gates: { checks: 'pass', review: 'pass', proof: 'pass' }, ...more });
    fs.writeFileSync(path.join(copy, 'limit.txt'), 'limit = 3\n');
    return copy;
  }

  it('passing: it saves as usual, and a file the gate changed stays out of the commit', async () => {
    const copy = proofReady();
    gate('Formats', 'echo sneaked > sneaked.txt; true', { when: 'merge', state: 'on' });
    const t = await actions.approveBeside(bp, 'AP-1');
    expect(t.mergedAt).toBeTruthy();
    expect(t.added![0]!.result).toBe('passed');
    expect(sh('git show --stat --format= HEAD', copy)).not.toContain('sneaked');
  });

  it('failing: the hook card, with its ways out', async () => {
    proofReady();
    gate('Audit', 'echo nope; exit 1', { when: 'merge', state: 'on' });
    await expect(actions.approveBeside(bp, 'AP-1')).rejects.toBeInstanceOf(actions.HookStopped);
    const t = readTicket(bp, 'AP-1')!;
    expect(t.stuck?.kind).toBe('hook');
    expect(t.stuck?.question).toMatch(/"Audit" runs on every save, and it said no/);
    expect(t.stuck?.detail).toContain('nope');
    expect(t.stuck?.options.map((o) => o.do)).toEqual(['retry', 'yourself', 'save-again', 'skip-hooks', 'plan']);
    expect(t.fails ?? 0).toBe(0);
    expect(t.mergedAt).toBeUndefined();
  });

  it('going past a failed gate needs a reason, and the project\'s own hooks still get their say', async () => {
    proofReady();
    gate('Audit', 'exit 1', { when: 'merge', state: 'on' });
    await expect(actions.approveBeside(bp, 'AP-1')).rejects.toBeInstanceOf(actions.HookStopped);
    const at = readTicket(bp, 'AP-1')!.stuck!.options.findIndex((o) => o.do === 'skip-hooks');
    await expect(actions.decideStuckBeside(bp, 'AP-1', at)).rejects.toThrow(/Write why/);
    fs.writeFileSync(path.join(project, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\necho hook > "${tmp}/hook-ran"\n`, { mode: 0o755 });
    const t = await actions.decideStuckBeside(bp, 'AP-1', at, { reason: 'Known and tracked' });
    expect(t.mergedAt).toBeTruthy();
    expect(t.overrides?.[0]).toMatchObject({ added: 'Audit', reason: 'Known and tracked' });
    expect(fs.existsSync(path.join(tmp, 'hook-ran'))).toBe(true);
    expect(actions.composeNotes(bp, { version: 'v1', tickets: ['AP-1'] } as never)).toMatch(/Known and tracked/);
  });

  it('cannot run: its own card, and no Builder', async () => {
    proofReady();
    gate('Audit', 'no-such-tool-here', { when: 'merge', state: 'on' });
    await expect(actions.approveBeside(bp, 'AP-1')).rejects.toBeInstanceOf(actions.HookStopped);
    const t = readTicket(bp, 'AP-1')!;
    expect(t.stuck?.kind).toBe('gate-cant-run');
    expect(t.stuck?.options.map((o) => o.do)).toEqual(['save-again', 'engineer', 'skip-hooks']);
    expect(t.fails ?? 0).toBe(0);
  });

  it('Try again after it was fixed saves. Removed meanwhile, it saves too', async () => {
    proofReady();
    const a = gate('Audit', 'no-such-tool-here', { when: 'merge', state: 'on' });
    await expect(actions.approveBeside(bp, 'AP-1')).rejects.toBeInstanceOf(actions.HookStopped);
    removeAddition(bp, ME, a.id);
    const t = await actions.decideStuckBeside(bp, 'AP-1', 0);
    expect(t.mergedAt).toBeTruthy();
  });

  it('on Builds by itself the card has no way past', async () => {
    proofReady({ track: 'auto' });
    gate('Audit', 'no-such-tool-here', { when: 'merge', state: 'on' });
    expect(await actions.holdingSave(bp, 'AP-1', (closing) => actions.saveBeforeAccept(bp, 'AP-1', closing))).toBe(false);
    expect(readTicket(bp, 'AP-1')!.stuck?.options.map((o) => o.do)).toEqual(['save-again', 'engineer']);
  });
});

describe('before release', () => {
  async function ready() {
    const copy = story({ stage: 'review', status: '', waiting: { kind: 'proof', summary: '' }, gates: { checks: 'pass', review: 'pass', proof: 'pass' } });
    fs.writeFileSync(path.join(copy, 'limit.txt'), 'limit = 3\n');
    const t = await actions.approveBeside(bp, 'AP-1');
    return t.release!;
  }

  it('runs on the code about to go out, before anything changes, and holds it back with the reason on the release', async () => {
    const version = await ready();
    const mark = path.join(tmp, 'seen.txt');
    gate('Sign off', `cat limit.txt > ${mark}; exit 1`, { when: 'release', state: 'on' });
    const head = sh('git rev-parse main');
    await expect(actions.releaseVersion(bp, version)).rejects.toThrow(/did not go out: "Sign off" did not pass\. Nothing changed/);
    expect(sh('git rev-parse main')).toBe(head);
    expect(sh('git tag --list')).toBe('');
    const held = readRelease(bp, version)!;
    expect(held.status).toBe('draft');
    expect(held.gateStop?.[0]).toMatchObject({ name: 'Sign off', result: 'failed' });
    // No copy stays behind.
    expect(sh('git worktree list')).not.toContain('gate-copy');
    // Go on needs a reason: it stays on the notes and the story.
    const r = await actions.releaseVersion(bp, version, 'The sign off is by hand this time');
    expect(r.status).toBe('released');
    expect(r.gateStop).toBeUndefined();
    expect(r.notes).toMatch(/Went out without your team's check "Sign off"\. Momen: The sign off is by hand this time/);
    expect(readTicket(bp, 'AP-1')!.overrides?.[0]).toMatchObject({ added: 'Sign off', release: version });
  });

  it('the terminal says how to go on, and goes on with the reason on the record, as the page does', async () => {
    const version = await ready();
    gate('Sign off', 'exit 1', { when: 'release', state: 'on' });
    chooseProject(project);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(runRelease(version, { yes: true })).rejects.toThrow('To go on anyway, say why: ');
      await expect(runRelease(version, { yes: true, goOn: '   ' })).rejects.toThrow('Say why it goes on');
      expect(readRelease(bp, version)!.status).toBe('draft');
      await runRelease(version, { yes: true, goOn: 'The sign off is by hand this time' });
    } finally {
      out.mockRestore();
      chooseProject(null);
    }
    const r = readRelease(bp, version)!;
    expect(r.status).toBe('released');
    expect(r.notes).toMatch(/Went out without your team's check "Sign off"\. Momen: The sign off is by hand this time/);
  });

  it('Try again after a fix goes out, and an empty harness makes no copy at all', async () => {
    const version = await ready();
    const a = gate('Sign off', 'no-such-tool-here', { when: 'release', state: 'on' });
    await expect(actions.releaseVersion(bp, version)).rejects.toThrow(/could not run/);
    expect(readRelease(bp, version)!.gateStop?.[0]!.result).toBe('cant-run');
    setAdditionState(bp, ME, a.id, 'off');
    const r = await actions.releaseVersion(bp, version);
    expect(r.status).toBe('released');
    expect(r.gateStop).toBeUndefined();
  });

  it('what a gate wrote on the story goes out in the release, so its file is clean after', async () => {
    const version = await ready();
    gate('Sign off', 'exit 0', { when: 'release', state: 'on' });
    const r = await actions.releaseVersion(bp, version);
    expect(r.status).toBe('released');
    expect(readTicket(bp, 'AP-1')!.added?.at(-1)?.name).toBe('Sign off');
    expect(sh('git show main:.squad/tickets/AP-1/ticket.md')).toContain('Sign off');
    expect(sh('git status --porcelain -- .squad/tickets/AP-1')).toBe('');
  });

  it('Try first and warn only say so on the story, and the release goes out', async () => {
    const version = await ready();
    gate('Soft', 'exit 1', { when: 'release' });
    const r = await actions.releaseVersion(bp, version);
    expect(r.status).toBe('released');
    expect(readTicket(bp, 'AP-1')!.added?.at(-1)?.result).toBe('would-stop');
  });
});

describe('Try it now', () => {
  it('runs on clean code, not on what is being worked on, and leaves no copy', async () => {
    fs.writeFileSync(path.join(project, 'limit.txt'), 'dirty\n');
    const r = await tryGate(bp, ME, { command: 'grep -q "limit = 2" limit.txt' });
    expect(r.result).toBe('passed');
    expect(sh('git worktree list')).not.toContain('gate-copy');
  });

  it('cannot run: cannot be saved. Fails today: saved on Try first, with a line. Not tried: refused', async () => {
    const input = { kind: 'gate' as const, name: 'G', when: 'checks' as const, on_fail: 'stop' as const };
    expect(() => addTriedGate(bp, ME, { ...input, command: 'exit 7' })).toThrow(/Try it now first/);
    expect((await tryGate(bp, ME, { command: 'no-such-tool-here' })).result).toBe('cant-run');
    expect(() => addTriedGate(bp, ME, { ...input, command: 'no-such-tool-here' })).toThrow(/can't be saved/);
    expect((await tryGate(bp, ME, { command: 'exit 7' })).result).toBe('failed');
    const { added, failsToday } = addTriedGate(bp, ME, { ...input, command: 'exit 7' });
    expect(failsToday).toBe(true);
    expect(added.state).toBe('try');
    // It can't must-pass until it passes.
    expect(() => setAdditionState(bp, ME, added.id, 'on')).toThrow(/fails on today's code/);
    const warn = addTriedGate(bp, ME, { ...input, name: 'W', command: 'exit 7', on_fail: 'warn' });
    expect(setAdditionState(bp, ME, warn.added.id, 'on').state).toBe('on');
  });

  it('tried again on its row, it remembers', async () => {
    await tryGate(bp, ME, { command: 'test -f later.txt' });
    const { added } = addTriedGate(bp, ME, { kind: 'gate', name: 'G', when: 'checks', on_fail: 'stop', command: 'test -f later.txt' });
    fs.writeFileSync(path.join(project, 'later.txt'), 'x');
    sh('git add later.txt && git commit -qm later');
    expect((await tryGate(bp, ME, { id: added.id })).result).toBe('passed');
    expect(setAdditionState(bp, ME, added.id, 'on').state).toBe('on');
  });

  it('the demo board says so plainly', async () => {
    seedDemoBoard(bp, { speed: 50 });
    await expect(tryGate(bp, ME, { command: 'true' })).rejects.toThrow(/The demo has no code/);
    expect(harnessView(readMeta(bp), bp).additions.demo).toBe(true);
    expect(addAddition(bp, ME, rule('On the demo')).state).toBe('on');
  });
});

describe('from a folder', () => {
  const folder = () => path.join(tmp, 'team-standard');
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(folder(), file)), { recursive: true });
    fs.writeFileSync(path.join(folder(), file), text);
  };

  it('finds rules, checkbox lists, scripts and our own format, and never runs anything', () => {
    const mark = path.join(tmp, 'ran');
    write('AGENTS.md', '# Style\nUse plain names.\n\n# Commit steps\nRun git commit and git push.\n\n## Contract\nSign it first.\n');
    write('rules/naming.md', 'Names are short.\n');
    write('docs/ship.md', '# Before we ship\n- [ ] Is the copy right?\n- [x] Is it on a phone?\n\nSome words.\n');
    write('docs/notes.md', '# Notes\nJust words, not a rule.\n');
    write('package.json', JSON.stringify({ scripts: { audit: 'x', release: 'x', dev: 'x', test: 'x', preinstall: `touch ${mark}` } }));
    fs.mkdirSync(path.join(folder(), 'scripts'));
    fs.writeFileSync(path.join(folder(), 'scripts', 'check'), `#!/bin/sh\ntouch ${mark}\n`, { mode: 0o755 });
    write('harness.yaml', yaml.dump({ additions: [{ kind: 'rule', name: 'From ours', text: 'Be kind.' }, { kind: 'gate', name: 'Our gate', command: 'npm run a', when: 'merge' }] }));
    const look = lookInFolder(folder(), [], { test: 'npm test' });
    const named = Object.fromEntries(look.finds.map((f) => [f.name, f]));
    expect(look.name).toBe('team-standard');
    expect(named['Style']).toMatchObject({ kind: 'rule', text: 'Use plain names.' });
    expect(named['naming']).toMatchObject({ kind: 'rule', source: 'rules/naming.md' });
    expect(named['Before we ship']).toMatchObject({ kind: 'checklist', questions: ['Is the copy right?', 'Is it on a phone?'] });
    expect(named['Notes']).toBeUndefined();
    expect(named['audit']).toMatchObject({ kind: 'gate', command: 'npm run audit' });
    expect(named['scripts/check']).toMatchObject({ kind: 'gate', command: './scripts/check' });
    expect(named['From ours']).toMatchObject({ kind: 'rule' });
    expect(named['Our gate']).toMatchObject({ kind: 'gate', when: 'merge' });
    expect(named['dev']).toBeUndefined();
    // What repeats our own process stays out, and says why.
    expect(named['Commit steps']!.out).toMatch(/already does this/);
    expect(named['Contract']!.out).toMatch(/already does this/);
    expect(named['release']!.out).toMatch(/already does this/);
    expect(named['test']!.out).toMatch(/already runs this/);
    expect(fs.existsSync(mark)).toBe(false);
  });

  it('text files only, a limit on size and count, no links leading out, never keys', () => {
    write('AGENTS.md', '# Fine\nOK.\n');
    write('.env.md', '# Secret\nPASSWORD=hunter2\n');
    write('.env.rules/x.md', 'secret\n');
    write('rules/big.md', 'x'.repeat(250_000));
    write('rules/binary.md', 'a\u0000b');
    fs.writeFileSync(path.join(tmp, 'outside.md'), '# Outside\nFrom outside.\n');
    fs.mkdirSync(path.join(folder(), 'rules'), { recursive: true });
    fs.symlinkSync(path.join(tmp, 'outside.md'), path.join(folder(), 'rules', 'link.md'));
    write('rules/login.md', `Use ghp_${'a1B2'.repeat(9)} to log in.`);
    const look = lookInFolder(folder(), [], {});
    const words = JSON.stringify(look.finds);
    expect(words).not.toContain('hunter2');
    expect(words).not.toContain('From outside');
    expect(words).not.toContain('ghp_');
    expect(look.finds.map((f) => f.name)).toEqual(['Fine', 'login']);
    expect(look.left).toBeGreaterThanOrEqual(3);
  });

  it('stops at its file limit and says so, and a very big folder of other files stays quick', () => {
    for (let i = 0; i <= MAX_FOLDER_FILES + 5; i += 1) write(`docs/n${i}.md`, 'words\n');
    expect(lookInFolder(folder(), [], {}).more).toBe(true);
    const big = path.join(tmp, 'big');
    fs.mkdirSync(big);
    for (let i = 0; i <= MAX_FOLDER_FILES * 50; i += 1) fs.writeFileSync(path.join(big, `f${i}.bin`), '');
    expect(lookInFolder(big, [], {}).more).toBe(true);
  });

  it('the same name again shows as already added', () => {
    write('AGENTS.md', '# Style\nUse plain names.\n');
    addAddition(bp, ME, rule('style'));
    expect(lookInFolder(folder(), readHarness(bp).additions, {}).finds[0]!.already).toBe(true);
  });

  it('the API brings in only what can be ticked, from the folder as it is, and a gate still needs its try', async () => {
    write('AGENTS.md', '# Style\nUse plain names.\n\n# Release steps\nTag it.\n');
    write('package.json', JSON.stringify({ scripts: { audit: 'x' } }));
    const app = new Hono();
    mountBoardApi(app, { paths: { squadDir: bp.squadDir } as never });
    const post = (url: string, body: unknown) => app.request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    const look = (await (await post('/api/v1/harness/folder', { path: folder() })).json()) as { finds: { key: string; name: string }[] };
    const key = (n: string) => look.finds.find((f) => f.name === n)!.key;
    const r = (await (await post('/api/v1/harness/folder/add', { path: folder(), picks: [{ key: key('Style'), agent: 'builder' }, { key: key('Release steps') }, { key: key('audit') }, { key: 'made-up' }] })).json()) as { added: string[]; left: { name: string; why: string }[] };
    expect(r.added).toEqual(['Style']);
    expect(r.left[0]).toMatchObject({ name: 'audit' });
    expect(r.left[0]!.why).toMatch(/Try it now first/);
    const added = readHarness(bp).additions[0]!;
    expect(added).toMatchObject({ kind: 'rule', from: 'team-standard', agents: ['builder'], text: 'Use plain names.' });
    // Added once: the same pick again adds nothing, and an import never weakens what is there.
    setAdditionState(bp, ME, added.id, 'off');
    const again = (await (await post('/api/v1/harness/folder/add', { path: folder(), picks: [{ key: key('Style') }] })).json()) as { added: string[] };
    expect(again.added).toEqual([]);
    expect(readHarness(bp).additions[0]!.state).toBe('off');
  });
});

describe('the page and its numbers', () => {
  const row = (id: string, name: string) => harnessView(readMeta(bp), bp).stages.find((s) => s.id === id)!.gates.find((g) => g.name === name);

  it('additions show at their stage, marked as the team\'s, and Off leaves the line and the count', () => {
    const before = harnessView(readMeta(bp), bp).tiles.working;
    const r = addAddition(bp, ME, rule('For the Tester', 'Look twice.', ['tester']));
    addAddition(bp, ME, rule('For all', 'Be kind.'));
    addAddition(bp, ME, list('Questions', 'tester'));
    const g = gate('Audit', 'npm audit', { when: 'release', state: 'on' });
    const view = harnessView(readMeta(bp), bp);
    expect(view.tiles.working).toBe(before + 4);
    expect(row('proof', 'For the Tester')?.team).toEqual({ state: 'on', kind: 'rule' });
    expect(row('build', 'For all')?.team?.kind).toBe('rule');
    expect(row('proof', 'Questions')?.cells?.auto).toEqual({ word: 'Runs', note: 'Try first' });
    expect(row('release', 'Audit')?.d).toEqual(expect.arrayContaining([['Command', 'npm audit']]));
    expect(row('release', 'Audit')?.cells?.full).toEqual({ word: 'Runs' });
    setAdditionState(bp, ME, r.id, 'off');
    setAdditionState(bp, ME, g.id, 'off');
    const after = harnessView(readMeta(bp), bp);
    expect(after.tiles.working).toBe(before + 2);
    expect(row('proof', 'For the Tester')).toBeUndefined();
    expect(after.additions.items.map((a) => a.state)).toEqual(['off', 'on', 'try', 'off']);
  });

  it('counts: a story it stopped is not also a pass, and the week\'s stop reaches the tiles', () => {
    const a = gate('Audit', 'x', { state: 'on' });
    story({}, 'AP-1');
    story({}, 'AP-2');
    const at = new Date().toISOString();
    updateTicket(bp, 'AP-1', (t) => (t.added = [{ id: a.id, name: 'Audit', kind: 'gate', state: 'on', at, result: 'passed', stopped: at }]));
    updateTicket(bp, 'AP-2', (t) => (t.added = [{ id: a.id, name: 'Audit', kind: 'gate', state: 'on', at, result: 'passed' }]));
    const seen = row('checks', 'Audit')!.seen!;
    expect(seen).toMatchObject({ passed: 1, stopped: 1, week: 1 });
    const view = harnessView(readMeta(bp), bp);
    expect(view.stages.find((s) => s.id === 'checks')!.stopped).toBeGreaterThanOrEqual(1);
    expect(view.tiles.stopped).toBe(1);
    expect(view.additions.items[0]!.seen).toMatchObject({ passed: 1, stopped: 1 });
  });

  it('a broken file is a notice on the page, not an error', () => {
    fs.writeFileSync(harnessFile(bp), '>>>>>>> theirs\n');
    const a = harnessView(readMeta(bp), bp).additions;
    expect(a.broken).toMatch(/merge clash/);
    expect(a.items).toEqual([]);
  });

  it('says plainly when there is no guard, and asks for a part only in a product with parts', () => {
    expect(typeof harnessView(readMeta(bp), bp).additions.guarded).toBe('boolean');
    expect(harnessView(readMeta(bp), bp).additions.parts).toEqual([]);
    liveMeta({ parts: [{ id: 'web', name: 'Web', repo: '.', needs: [] }, { id: 'api', name: 'API', repo: 'api', needs: [] }, { id: 'db', name: 'Database', shared: true, needs: [] }] });
    expect(harnessView(readMeta(bp), bp).additions.parts.map((p) => p.id)).toEqual(['web', 'api']);
    const ui = fs.readFileSync('console-ui/src/pages/HarnessAdd.tsx', 'utf8');
    expect(ui).toContain('NO_GUARD');
  });

  it("the API refuses any attempt on squad-kit's own gates", async () => {
    const app = new Hono();
    mountBoardApi(app, { paths: { squadDir: bp.squadDir } as never });
    const before = JSON.stringify(harnessView(readMeta(bp), bp).stages);
    for (const id of ['checks', 'weakened', 'review', 'add:checks']) {
      const off = await app.request(`/api/v1/harness/additions/${id}/state`, { method: 'POST', body: JSON.stringify({ state: 'off' }), headers: { 'content-type': 'application/json' } });
      expect(off.status).toBe(400);
      expect(((await off.json()) as { error: string }).error).toBe(NOT_AN_ADDITION);
      const gone = await app.request(`/api/v1/harness/additions/${id}/remove`, { method: 'POST' });
      expect(gone.status).toBe(400);
    }
    expect(JSON.stringify(harnessView(readMeta(bp), bp).stages)).toBe(before);
    // A hand-written line in the file with the same id is one of the team's, and leaves the real one alone.
    addAddition(bp, ME, rule('R'));
    expect(harnessView(readMeta(bp), bp).stages.find((s) => s.id === 'checks')!.gates.map((g) => g.id)).toContain('checks');
  });

  it('a row added through the API says what happens next', async () => {
    const app = new Hono();
    mountBoardApi(app, { paths: { squadDir: bp.squadDir } as never });
    const r = await app.request('/api/v1/harness/additions', { method: 'POST', body: JSON.stringify(rule('Own it', 'Please push your work.')), headers: { 'content-type': 'application/json' } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { note?: string }).note).toMatch(/squad-kit does those itself/);
  });

});
