import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

const calls: RunOptions[] = [];
const answers: unknown[] = [];
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    return { ok: true, structured: answers.shift(), sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

const { resolveLevel, personLevels, setPersonLevel, describeLevel } = await import('../src/engine/levels.js');
const { readAgent, writeAgent } = await import('../src/engine/agents.js');
const { claudeLaunch, claudeRunOptions, claudeTool } = await import('../src/modules/claude/index.js');
const { boardPaths, readMeta, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;

beforeEach(() => {
  calls.length = 0;
  answers.length = 0;
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
  it("uses squad-kit's defaults: strong where a mistake is expensive, cheaper where the work is clear", () => {
    expect(resolveLevel({ role: 'analyst', step: 'questions' })).toEqual({ level: 'strongest', effort: 'high', from: 'squad-kit' });
    expect(resolveLevel({ role: 'architect', step: 'design' })).toMatchObject({ level: 'strongest', effort: 'high' });
    expect(resolveLevel({ role: 'builder', step: 'build' })).toMatchObject({ level: 'balanced', effort: 'medium' });
    expect(resolveLevel({ role: 'reviewer', step: 'review' })).toMatchObject({ level: 'strongest', effort: 'medium' });
    expect(resolveLevel({ role: 'tester', step: 'proof' })).toMatchObject({ level: 'fast' });
    expect(resolveLevel({ role: 'analyst', step: 'draft' })).toMatchObject({ level: 'fast' });
  });

  it('runs every role balanced on the Express track', () => {
    expect(resolveLevel({ role: 'analyst', step: 'spec', express: true })).toMatchObject({ level: 'balanced', effort: 'medium', why: 'Express track' });
  });

  it('lets the project change a role, and one step of it more precisely', () => {
    const project = { builder: { level: 'strongest' as const }, 'builder.fix': { level: 'fast' as const, effort: 'low' as const } };
    expect(resolveLevel({ role: 'builder', step: 'build' }, project)).toMatchObject({ level: 'strongest', effort: 'medium', from: 'project' });
    expect(resolveLevel({ role: 'builder', step: 'fix' }, project)).toMatchObject({ level: 'fast', effort: 'low', from: 'project' });
  });

  it("lets a person's own choice win over the project's, and an exact model win over every level", () => {
    const project = { 'analyst.questions': { level: 'balanced' as const } };
    expect(resolveLevel({ role: 'analyst', step: 'questions' }, project, { analyst: { level: 'fast' } })).toMatchObject({ level: 'fast', from: 'you' });
    expect(resolveLevel({ role: 'analyst', step: 'questions' }, project, { analyst: { model: 'claude-x' } })).toMatchObject({ model: 'claude-x', from: 'you' });
  });

  it('moves a fix that keeps failing up to the strongest level, unless a model is pinned', () => {
    expect(resolveLevel({ role: 'builder', step: 'fix', tries: 1 })).toMatchObject({ level: 'balanced' });
    expect(resolveLevel({ role: 'builder', step: 'fix', tries: 2 })).toMatchObject({ level: 'strongest', effort: 'high', why: 'after 2 failed tries' });
    expect(resolveLevel({ role: 'builder', step: 'fix', tries: 2 }, { builder: { model: 'pinned-1' } })).toMatchObject({ model: 'pinned-1', level: 'balanced' });
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
    answers.push({ questions: [] });
    await (new LiveSquad(bp) as unknown as { step(id: string, phase: string): Promise<void> }).step(t.id, 'analyst-read');
    expect(calls[0]).toMatchObject({ model: 'opus', effort: 'high' });
    expect(readTicket(bp, t.id)!.activity.some((a) => a.text === 'Runs on Opus (strongest, high effort)')).toBe(true);
  });
});
