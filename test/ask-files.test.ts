import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/engine/claude.js';

const calls: RunOptions[] = [];
const answers: unknown[] = [];
vi.mock('../src/engine/claude.js', async (orig) => ({
  ...(await orig<typeof import('../src/engine/claude.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    return { ok: true, structured: answers.shift(), sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

const { boardPaths, readMeta, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const P = await import('../src/engine/prompts.js');

let tmp: string;
let copy: string;
let bp: ReturnType<typeof boardPaths>;
type Steps = { step(id: string, phase: string): Promise<void> };

const DESIGN = { steps: ['Add the switch', 'Save the choice', 'Write the tests'], tests: 3, screens: 1 };

beforeEach(() => {
  calls.length = 0;
  answers.length = 0;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-askfiles-'));
  copy = path.join(tmp, 'copy');
  fs.mkdirSync(copy);
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct' });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function specApproved() {
  const t = actions.createTicket(bp, { title: 'Dark mode' });
  return updateTicket(bp, t.id, (x) => {
    x.squad = null;
    x.worktree = copy;
    x.sessions = { intake: 'i1' };
    x.activity = [{ at: '', who: 'analyst', text: 'Wrote the spec' }, ...x.activity];
    x.story = 'As a night clerk, I want dark mode.';
    x.criteria = [{ given: 'the dashboard', when: 'I switch', then: 'it turns dark' }];
    x.specApproved = { by: 'Momen', at: '' };
  });
}

describe('the "Ask you" card with files', () => {
  it('the Architect can ask with a wireframe; only files the board may show are kept', async () => {
    const t0 = specApproved();
    const wire = path.join(copy, 'wireframe.png');
    fs.writeFileSync(wire, 'png');
    const squad = new LiveSquad(bp) as unknown as Steps;
    answers.push({ ...DESIGN, question: { text: 'Should the switch sit in the top bar or in settings?', options: ['Top bar', 'Settings'], files: [wire, '/etc/hosts'] } });
    await expect(squad.step(t0.id, 'plan-write')).rejects.toThrow(/Waiting for your answer/);
    let t = readTicket(bp, t0.id)!;
    expect(t.waiting?.kind).toBe('ask');
    expect(t.agentQuestion).toMatchObject({ from: 'architect', options: ['Top bar', 'Settings'], files: [fs.realpathSync(wire)] });
    expect(t.activity[0]!.text).toContain('(with 1 file)');

    t = actions.answerAgent(bp, t.id, 'Top bar');
    expect(t.squad?.phase).toBe('answered-architect');
    answers.push({ ...DESIGN, mockup: '<html><body><button>Dark</button></body></html>' });
    await squad.step(t.id, 'answered-architect');
    const call = calls.at(-1)!;
    expect(call.resume).toBe('i1');
    expect(call.prompt).toContain('The person answered: "Top bar"');
    expect(call.prompt).toContain('Approved spec (do not change it)');
    t = readTicket(bp, t.id)!;
    expect(t.agentQuestion).toBeUndefined();
    expect(t.waiting?.kind).toBe('plan');
    expect(fs.readFileSync(t.mockup!, 'utf8')).toContain('<button>Dark</button>');
    expect(path.dirname(t.mockup!)).toBe(path.join(bp.dir, 'attachments', t.id));
  });

  it('asks for a mockup when the ticket has screens, and keeps none when nothing on screen changes', async () => {
    const t0 = specApproved();
    expect(P.designPrompt(t0)).toContain('- mockup: when screens is 1 or more');
    expect(Object.keys(P.DESIGN_SCHEMA.properties)).toEqual(expect.arrayContaining(['mockup', 'question']));
    const squad = new LiveSquad(bp) as unknown as Steps;
    answers.push({ ...DESIGN, screens: 0, mockup: '<html></html>' });
    await squad.step(t0.id, 'plan-write');
    expect(readTicket(bp, t0.id)!.mockup).toBeUndefined();
  });
});
