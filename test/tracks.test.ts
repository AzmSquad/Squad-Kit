import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardPaths, readMeta, readTicket, updateTicket, type BoardPaths } from '../src/board/store.js';
import { seedDemoBoard } from '../src/board/demo.js';
import { tick as tickBoard } from '../src/board/engine.js';
import * as actions from '../src/board/actions.js';
import { planPrompt } from '../src/engine/prompts.js';
import { draftTicket } from '../src/engine/draft.js';

let tmp: string;
let bp: BoardPaths;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-tracks-'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Runs the demo squad until the ticket waits for the person, starts building, or 200 steps pass. */
function runUntil(id: string, done: (t: NonNullable<ReturnType<typeof readTicket>>) => boolean) {
  for (let i = 0; i < 200; i++) {
    updateTicket(bp, id, (t) => {
      if (t.squad) t.squad.nextAt = new Date(0).toISOString();
    });
    tickBoard(bp);
    const t = readTicket(bp, id)!;
    if (done(t)) return t;
  }
  throw new Error('never got there');
}

describe('Full and Express tracks', () => {
  it('Full is the default and stops for your questions', () => {
    const t = actions.createTicket(bp, { title: 'Dark mode for the dashboard' });
    expect(t.track).toBe('full');
    const after = runUntil(t.id, (x) => Boolean(x.waiting));
    expect(after.waiting?.kind).toBe('questions');
  });

  it('Express skips the questions and the plan approval, but still builds and checks', () => {
    const t = actions.createTicket(bp, { title: 'Fix the typo on the login page', track: 'express' });
    const after = runUntil(t.id, (x) => x.stage === 'implement' || Boolean(x.waiting));
    expect(after.waiting).toBeNull();
    expect(after.stage).toBe('implement');
    expect(after.squad?.phase).toBe('build');
    expect(after.story).toBeTruthy();
    const lines = after.activity.map((a) => a.text);
    expect(lines).toContain('Express track: no questions, straight to the plan');
    expect(lines.some((l) => l.startsWith('Express track: approved the plan on its own'))).toBe(true);
    const tested = runUntil(t.id, (x) => x.stage === 'test' || x.stage === 'review' || Boolean(x.waiting));
    expect(['test', 'review']).toContain(tested.stage);
  });

  it('an Express plan asks for no questions', () => {
    const t = actions.createTicket(bp, { title: 'Typo', track: 'express' });
    expect(planPrompt(t, undefined, readMeta(bp))).toContain('Express track');
  });

  it('the Analyst suggests Express for a typo', async () => {
    expect((await draftTicket(bp, { text: 'Typo on the login button' })).track).toBe('express');
    expect((await draftTicket(bp, { text: 'Add bulk assign for team leads' })).track).toBe('full');
  });

  it('a Full ticket cannot be approved as Express', () => {
    const t = actions.createTicket(bp, { title: 'Big one' });
    expect(() => actions.approveExpress(bp, t.id)).toThrow(/Full track/);
  });
});
