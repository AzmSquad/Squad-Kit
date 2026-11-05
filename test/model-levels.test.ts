import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { Hono } from 'hono';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

const calls: RunOptions[] = [];
const answers: unknown[] = [];
/** The Builder's next run fails, like an error or a time limit. */
let builderFails = false;
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    if (builderFails && opts.permissionMode === 'acceptEdits') {
      builderFails = false;
      return { ok: false, error: 'Claude Code stopped: time limit', sessionId: opts.resume ?? opts.sessionId } as RunResult;
    }
    return { ok: true, structured: answers.length ? answers.shift() : { summary: 'Done' }, sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

const { resolveLevel, personLevels, setPersonLevel, describeLevel, builderLevel, effortOn, parseEffort, parseQuality, standardLevel } = await import('../src/engine/levels.js');
const { readAgent, writeAgent } = await import('../src/engine/agents.js');
const { claudeLaunch, claudeRunOptions, claudeTool } = await import('../src/modules/claude/index.js');
const { boardPaths, readMeta, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { mountBoardApi } = await import('../src/console/api/board.js');
const { buildPaths } = await import('../src/core/paths.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;

beforeEach(() => {
  calls.length = 0;
  answers.length = 0;
  builderFails = false;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-levels-')));
  vi.stubEnv('SQUAD_KIT_HOME', path.join(tmp, 'home'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct' });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('model levels', () => {
  it("uses squad-kit's defaults for Best: the strongest model asks, designs, builds and reviews", () => {
    expect(resolveLevel({ role: 'analyst', step: 'questions' })).toEqual({ level: 'strongest', effort: 'high', from: 'squad-kit' });
    expect(resolveLevel({ role: 'architect', step: 'design' })).toMatchObject({ level: 'strongest', effort: 'high' });
    expect(resolveLevel({ role: 'builder', step: 'build' })).toMatchObject({ level: 'strongest', effort: 'high' });
    expect(resolveLevel({ role: 'builder', step: 'fix' })).toMatchObject({ level: 'strongest', effort: 'high' });
    expect(resolveLevel({ role: 'reviewer', step: 'review' })).toMatchObject({ level: 'strongest', effort: 'high' });
    expect(resolveLevel({ role: 'tester', step: 'proof' })).toMatchObject({ level: 'balanced', effort: 'medium' });
    expect(resolveLevel({ role: 'analyst', step: 'draft' })).toMatchObject({ level: 'fast', effort: 'low' });
    // Reading the project is well-defined work: balanced in every setting.
    for (const quality of ['best', 'balanced', 'thrifty'] as const) {
      expect(resolveLevel({ role: 'architect', step: 'scan', quality })).toMatchObject({ level: 'balanced', effort: 'medium' });
      expect(resolveLevel({ role: 'architect', step: 'blueprint', quality })).toMatchObject({ level: 'balanced', effort: 'medium' });
    }
    expect(resolveLevel({ role: 'builder', step: 'build', quality: 'best' })).toEqual(resolveLevel({ role: 'builder', step: 'build' }));
  });

  it('builds at medium effort on Balanced, and on a lighter model on Thrifty, as before the setting', () => {
    expect(resolveLevel({ role: 'builder', step: 'build', quality: 'balanced' })).toMatchObject({ level: 'strongest', effort: 'medium' });
    expect(resolveLevel({ role: 'builder', step: 'fix', quality: 'balanced' })).toMatchObject({ level: 'strongest', effort: 'medium' });
    expect(resolveLevel({ role: 'reviewer', step: 'review', quality: 'balanced' })).toMatchObject({ level: 'strongest', effort: 'high' });
    expect(resolveLevel({ role: 'analyst', step: 'spec', quality: 'balanced' })).toMatchObject({ level: 'strongest', effort: 'high' });
    expect(resolveLevel({ role: 'builder', step: 'build', quality: 'thrifty' })).toMatchObject({ level: 'balanced', effort: 'medium' });
    expect(resolveLevel({ role: 'builder', step: 'fix', quality: 'thrifty' })).toMatchObject({ level: 'balanced', effort: 'medium' });
    expect(resolveLevel({ role: 'reviewer', step: 'review', quality: 'thrifty' })).toMatchObject({ level: 'strongest', effort: 'medium' });
    expect(resolveLevel({ role: 'analyst', step: 'questions', quality: 'thrifty' })).toMatchObject({ level: 'strongest', effort: 'high' });
    expect(resolveLevel({ role: 'tester', step: 'proof', quality: 'thrifty' })).toMatchObject({ level: 'balanced', effort: 'medium' });
    expect(parseQuality(' Thrifty ')).toBe('thrifty');
    expect(parseQuality('cheap')).toBeUndefined();
  });

  it('runs the Express track lighter: the Builder balanced at high, the Reviewer strongest', () => {
    expect(resolveLevel({ role: 'builder', step: 'build', express: true })).toMatchObject({ level: 'balanced', effort: 'high', why: 'Express track' });
    expect(resolveLevel({ role: 'reviewer', step: 'review', express: true })).toMatchObject({ level: 'strongest', effort: 'high' });
    expect(resolveLevel({ role: 'architect', step: 'design', express: true })).toMatchObject({ level: 'balanced', effort: 'high' });
    expect(resolveLevel({ role: 'tester', step: 'proof', express: true })).toMatchObject({ level: 'balanced', effort: 'medium', why: 'Express track' });
    expect(resolveLevel({ role: 'builder', step: 'build', express: true, quality: 'balanced' })).toMatchObject({ level: 'balanced', effort: 'high' });
    // Thrifty keeps the rule from before: every role balanced.
    expect(resolveLevel({ role: 'analyst', step: 'spec', express: true, quality: 'thrifty' })).toMatchObject({ level: 'balanced', effort: 'medium', why: 'Express track' });
    expect(resolveLevel({ role: 'tester', step: 'proof', express: true, quality: 'thrifty' })).toMatchObject({ level: 'balanced', effort: 'medium' });
    expect(standardLevel({ role: 'reviewer', step: 'review', express: true, quality: 'thrifty' })).toEqual({ level: 'balanced', effort: 'medium' });
  });

  it('the Tester takes the proof balanced at medium effort on every track and setting; its chat level stays', () => {
    for (const quality of ['best', 'balanced', 'thrifty'] as const) {
      for (const express of [false, true]) expect(standardLevel({ role: 'tester', step: 'proof', quality, express }), `${quality} ${express}`).toEqual({ level: 'balanced', effort: 'medium' });
      expect(standardLevel({ role: 'tester', step: 'chat', quality })).toEqual({ level: 'fast', effort: 'low' });
    }
    expect(standardLevel({ role: 'tester', step: 'chat', express: true })).toEqual({ level: 'fast', effort: 'low' });
    expect(standardLevel({ role: 'tester', step: 'chat', express: true, quality: 'balanced' })).toEqual({ level: 'fast', effort: 'low' });
    // Express on Thrifty runs every role balanced, as before.
    expect(standardLevel({ role: 'tester', step: 'chat', express: true, quality: 'thrifty' })).toEqual({ level: 'balanced', effort: 'medium' });
  });

  it('lets the project change a role, and one step of it more precisely', () => {
    const project = { builder: { level: 'balanced' as const }, 'builder.fix': { level: 'fast' as const, effort: 'low' as const } };
    expect(resolveLevel({ role: 'builder', step: 'build' }, project)).toMatchObject({ level: 'balanced', effort: 'high', from: 'project' });
    expect(resolveLevel({ role: 'builder', step: 'fix' }, project)).toMatchObject({ level: 'fast', effort: 'low', from: 'project' });
  });

  it("lets a person's own choice win over the project's, and an exact model win over every level", () => {
    const project = { 'analyst.questions': { level: 'balanced' as const } };
    expect(resolveLevel({ role: 'analyst', step: 'questions' }, project, { analyst: { level: 'fast' } })).toMatchObject({ level: 'fast', from: 'you' });
    expect(resolveLevel({ role: 'analyst', step: 'questions' }, project, { analyst: { model: 'claude-x' } })).toMatchObject({ model: 'claude-x', from: 'you' });
  });

  it('moves the Builder up after a failed run: extra high on Best, high on Balanced, strongest after two on Thrifty', () => {
    expect(resolveLevel({ role: 'builder', step: 'fix', fails: 0 })).toMatchObject({ level: 'strongest', effort: 'high', from: 'squad-kit' });
    expect(resolveLevel({ role: 'builder', step: 'fix', fails: 1 })).toMatchObject({ level: 'strongest', effort: 'xhigh', why: 'after 1 failed try' });
    // A build run again after its own run failed steps up too.
    expect(resolveLevel({ role: 'builder', step: 'build', fails: 1 })).toMatchObject({ level: 'strongest', effort: 'xhigh' });
    expect(resolveLevel({ role: 'builder', step: 'chat', fails: 3 })).toMatchObject({ level: 'balanced', effort: 'medium' });
    expect(resolveLevel({ role: 'builder', step: 'fix', fails: 1, express: true })).toMatchObject({ level: 'strongest', effort: 'xhigh' });
    expect(resolveLevel({ role: 'builder', step: 'fix', fails: 1, quality: 'balanced' })).toMatchObject({ level: 'strongest', effort: 'high', why: 'after 1 failed try' });
    expect(resolveLevel({ role: 'builder', step: 'fix', fails: 1, quality: 'thrifty' })).toMatchObject({ level: 'balanced', effort: 'medium' });
    expect(resolveLevel({ role: 'builder', step: 'fix', fails: 2, quality: 'thrifty' })).toMatchObject({ level: 'strongest', effort: 'high', why: 'after 2 failed tries' });
    // The team's own choice steps up too; a pinned model never does.
    expect(resolveLevel({ role: 'builder', step: 'fix', fails: 1 }, { 'builder.fix': { level: 'fast', effort: 'low' } })).toMatchObject({ level: 'strongest', effort: 'xhigh', from: 'project' });
    expect(resolveLevel({ role: 'builder', step: 'fix', fails: 2, quality: 'thrifty' }, { builder: { model: 'pinned-1' } })).toMatchObject({ model: 'pinned-1', level: 'balanced' });
  });

  it('never runs the Reviewer on a weaker level or effort than the Builder, except on Thrifty', () => {
    expect(builderLevel({})).toEqual({ level: 'strongest', effort: 'high' });
    expect(builderLevel({ fails: 1 })).toEqual({ level: 'strongest', effort: 'xhigh' });
    const builder = builderLevel({ fails: 1 });
    expect(resolveLevel({ role: 'reviewer', step: 'review', builder })).toMatchObject({ level: 'strongest', effort: 'xhigh', why: 'as strong as the Builder' });
    expect(resolveLevel({ role: 'reviewer', step: 'review', builder: builderLevel({}) })).toEqual({ level: 'strongest', effort: 'high', from: 'squad-kit' });
    expect(resolveLevel({ role: 'reviewer', step: 'review', quality: 'balanced', builder: builderLevel({ quality: 'balanced', fails: 1 }) })).toMatchObject({ level: 'strongest', effort: 'high' });
    // The team set a weaker Reviewer: the floor still holds. A pinned model is left alone.
    expect(resolveLevel({ role: 'reviewer', step: 'review', builder }, { reviewer: { level: 'balanced', effort: 'low' } })).toMatchObject({ level: 'strongest', effort: 'xhigh' });
    expect(resolveLevel({ role: 'reviewer', step: 'review', builder }, { reviewer: { model: 'claude-x' } })).toMatchObject({ model: 'claude-x', effort: 'high' });
    expect(resolveLevel({ role: 'reviewer', step: 'chat', builder })).toMatchObject({ effort: 'medium' });
    expect(resolveLevel({ role: 'reviewer', step: 'review', quality: 'thrifty', builder: builderLevel({ quality: 'thrifty', fails: 2 }) })).toMatchObject({ level: 'strongest', effort: 'medium' });
    // The Builder's floor counts the team's choices for the Builder.
    expect(builderLevel({}, { 'builder.build': { effort: 'xhigh' } })).toEqual({ level: 'strongest', effort: 'xhigh' });
  });

  it('has an extra high effort that Claude Code takes, and that other tools run as high', () => {
    expect(parseEffort('xhigh')).toBe('xhigh');
    expect(parseEffort('Extra high')).toBe('xhigh');
    expect(parseEffort('max')).toBeUndefined();
    expect(effortOn(claudeTool, 'xhigh')).toBe('xhigh');
    const plain = { supportsEffort: true, modelFor: () => 'Big' };
    expect(effortOn(plain, 'xhigh')).toBe('high');
    expect(effortOn(plain, 'low')).toBe('low');
    expect(effortOn({ supportsEffort: false }, 'high')).toBeUndefined();
    const r = resolveLevel({ role: 'builder', step: 'fix', fails: 1 });
    expect(describeLevel(r, claudeTool)).toBe('Opus (strongest, extra high effort, after 1 failed try)');
    expect(describeLevel(r, plain)).toBe('Big (strongest, high effort, after 1 failed try)');
    const base = { cwd: tmp, prompt: 'x', permissions: ['edit' as const] };
    expect(claudeRunOptions({ ...base, level: 'strongest', effort: 'xhigh' })).toMatchObject({ model: 'opus', effort: 'xhigh' });
    const launch = claudeLaunch(claudeRunOptions({ ...base, level: 'strongest', effort: 'xhigh' }), '/adapter.js', '/bin/claude');
    expect((launch.meta as { claudeCode: { options: { effort?: string } } }).claudeCode.options.effort).toBe('xhigh');
    writeAgent(bp, 'builder', { levels: { 'builder.fix': { effort: 'xhigh' } } });
    expect(fs.readFileSync(path.join(bp.rulesDir, 'builder.md'), 'utf8')).toContain('effort.fix: xhigh');
    expect(readAgent(bp, 'builder').levels).toEqual({ 'builder.fix': { effort: 'xhigh' } });
    expect(() => writeAgent(bp, 'builder', { levels: { builder: { effort: 'huge' as never } } })).toThrow(/Use xhigh \(extra high\), high, medium or low/);
  });

  it("keeps the Quality setting with the project's board settings, and shows the levels for it", async () => {
    const a = new Hono();
    mountBoardApi(a, { paths: buildPaths(tmp) });
    const put = (body: unknown) => a.request('/api/v1/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(readMeta(bp).quality).toBeUndefined();
    expect((await put({ quality: 'thrifty' })).status).toBe(200);
    expect(readMeta(bp).quality).toBe('thrifty');
    expect((yaml.load(fs.readFileSync(bp.configFile, 'utf8')) as { board: { quality?: string } }).board.quality).toBe('thrifty');
    const bad = await put({ quality: 'cheap' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/best, balanced or thrifty/);
    const agents = (await (await a.request('/api/v1/agents')).json()) as { role: string; efforts: string[]; levels: { step: string; standard: unknown; now: { level: string; effort?: string } }[] }[];
    const builder = agents.find((x) => x.role === 'builder')!;
    expect(builder.efforts).toEqual(['xhigh', 'high', 'medium', 'low']);
    expect(builder.levels.find((l) => l.step === 'build')).toMatchObject({ standard: { level: 'balanced', effort: 'medium' }, now: { level: 'balanced', effort: 'medium' } });
    await put({ quality: 'best' });
    const after = (await (await a.request('/api/v1/agents')).json()) as typeof agents;
    expect(after.find((x) => x.role === 'builder')!.levels.find((l) => l.step === 'build')!.now).toMatchObject({ level: 'strongest', effort: 'high' });
  });

  it('keeps the project choices in the agent file, as levels', () => {
    writeAgent(bp, 'builder', { levels: { builder: { effort: 'high' }, 'builder.fix': { level: 'strongest' } } });
    const text = fs.readFileSync(path.join(bp.rulesDir, 'builder.md'), 'utf8');
    expect(text).toContain('effort: high');
    expect(text).toContain('level.fix: strongest');
    expect(readAgent(bp, 'builder').levels).toEqual({ builder: { effort: 'high' }, 'builder.fix': { level: 'strongest' } });
    expect(() => writeAgent(bp, 'builder', { levels: { 'builder.nope': { level: 'fast' } } })).toThrow(/no step/);
    expect(() => writeAgent(bp, 'builder', { levels: { builder: { level: 'huge' as never } } })).toThrow(/not a level/);
  });

  it("keeps a person's choices on this computer, and clears them", () => {
    setPersonLevel('reviewer.review', { level: 'balanced' });
    expect(personLevels()).toEqual({ 'reviewer.review': { level: 'balanced' } });
    expect(fs.existsSync(path.join(tmp, 'home', 'settings.yaml'))).toBe(true);
    setPersonLevel('reviewer.review', {});
    expect(personLevels()).toEqual({});
  });

  it('turns levels into Claude models and effort', () => {
    const base = { cwd: tmp, prompt: 'x', permissions: ['read' as const] };
    expect(claudeRunOptions({ ...base, level: 'strongest', effort: 'high' })).toMatchObject({ model: 'opus', effort: 'high' });
    expect(claudeRunOptions({ ...base, level: 'fast' })).toMatchObject({ model: 'haiku' });
    expect(claudeRunOptions({ ...base, level: 'fast', model: 'claude-x' })).toMatchObject({ model: 'claude-x' });
    expect(describeLevel({ level: 'balanced', effort: 'medium', from: 'squad-kit' }, claudeTool)).toBe('Sonnet (balanced, medium effort)');
  });

  it('gives the model to the ACP adapter the way it reads it, and the effort as an option', () => {
    const launch = claudeLaunch(claudeRunOptions({ cwd: tmp, prompt: 'x', permissions: ['read'], level: 'fast', effort: 'low' }), '/adapter.js', '/bin/claude');
    expect(launch.env.ANTHROPIC_MODEL).toBe('haiku');
    expect((launch.meta as { claudeCode: { options: { effort?: string } } }).claudeCode.options.effort).toBe('low');
  });

  it('starts each squad step on its level, and says which model on the ticket', async () => {
    const t = actions.createTicket(bp, { title: 'Opening hours' });
    updateTicket(bp, t.id, (x) => (x.squad = null));
    answers.push({ summary: 'Clear', questions: [] });
    await (new LiveSquad(bp) as unknown as { step(id: string, phase: string): Promise<void> }).step(t.id, 'analyst-read');
    expect(calls[0]).toMatchObject({ model: 'opus', effort: 'high' });
    expect(readTicket(bp, t.id)!.activity.some((a) => a.text === 'Runs on Opus (strongest, high effort)')).toBe(true);
  });
});

describe('the live squad steps up after any failed Builder run', () => {
  type Squad = { review(id: string): Promise<void>; reviewFix(id: string): Promise<void>; checks(id: string): Promise<void>; fixFromPerson(id: string): Promise<void> };
  const squad = () => new LiveSquad(bp) as unknown as Squad;
  const runLines = (id: string) => readTicket(bp, id)!.activity.filter((a) => a.text.startsWith('Runs on ')).map((a) => `${a.who}: ${a.text}`).reverse();

  function building(title: string) {
    const t = actions.createTicket(bp, { title });
    updateTicket(bp, t.id, (x) => {
      x.squad = null;
      x.worktree = tmp;
      x.baseCommit = 'abc';
      x.stage = 'review';
      x.sessions = { review: 'r1', build: 'b1' };
      x.gates = { checks: 'pass', review: 'pending', proof: 'pending' };
    });
    return t.id;
  }

  it('counts review notes as a failure in a project with no tests: the fix runs on extra high, and so does the next review', async () => {
    const id = building('Limit bookings');
    answers.push({ approved: false, summary: '', comments: ['Count cancelled bookings too.'] });
    await squad().review(id);
    expect(readTicket(bp, id)!.fails).toBe(1);
    expect(calls.map((c) => [c.model, c.effort])).toEqual([
      ['opus', 'high'],
      ['opus', 'xhigh'],
    ]);
    answers.push({ approved: true, summary: 'Good', comments: [] });
    await squad().review(id);
    expect(calls.at(-1)).toMatchObject({ model: 'opus', effort: 'xhigh' });
    expect(runLines(id)).toEqual([
      'reviewer: Runs on Opus (strongest, high effort)',
      'builder: Runs on Opus (strongest, extra high effort, after 1 failed try)',
      'reviewer: Runs on Opus (strongest, extra high effort, as strong as the Builder)',
    ]);
  });

  it("counts the Builder's own failed run, but not a Stop", async () => {
    const id = building('Opening hours');
    updateTicket(bp, id, (x) => (x.reviewNotes = ['Use the shared clock.']));
    builderFails = true;
    // The tool's raw words are not squad-kit's: the stop is the plain technical one.
    await expect(squad().reviewFix(id)).rejects.toThrow(/on something technical/);
    expect(readTicket(bp, id)!.fails).toBe(1);
    expect(calls.at(-1)).toMatchObject({ model: 'opus', effort: 'high' });
    await squad().reviewFix(id);
    expect(calls.at(-1)).toMatchObject({ model: 'opus', effort: 'xhigh' });

    const other = building('Stopped one');
    updateTicket(bp, other, (x) => {
      x.reviewNotes = ['Anything'];
      x.stopRequested = true;
    });
    builderFails = true;
    await expect(squad().reviewFix(other)).rejects.toThrow();
    expect(readTicket(bp, other)!.fails).toBeUndefined();
  });

  it('counts failed checks too, keeps Thrifty on its old rule, and starts again at your own fix request', async () => {
    writeMeta(bp, { ...readMeta(bp), quality: 'thrifty', commands: { test: 'exit 1' } });
    const id = building('Checks fail');
    await squad().checks(id);
    let t = readTicket(bp, id)!;
    expect([t.tries, t.fails]).toEqual([1, 1]);
    expect(calls.at(-1)).toMatchObject({ model: 'sonnet', effort: 'medium' });
    await squad().checks(id);
    expect(readTicket(bp, id)!.fails).toBe(2);
    expect(calls.at(-1)).toMatchObject({ model: 'opus', effort: 'high' });
    expect(runLines(id).at(-1)).toBe('builder: Runs on Opus (strongest, high effort, after 2 failed tries)');

    updateTicket(bp, id, (x) => (x.changeRequest = 'The button is too small'));
    await squad().fixFromPerson(id);
    t = readTicket(bp, id)!;
    expect(t.fails).toBe(0);
    expect(calls.at(-1)).toMatchObject({ model: 'sonnet', effort: 'medium' });
  });
});
