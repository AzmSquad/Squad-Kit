import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardPaths, readMeta, readTicket, updateTicket, writeMeta, type BoardPaths } from '../src/board/store.js';
import { seedDemoBoard } from '../src/board/demo.js';
import * as actions from '../src/board/actions.js';
import { LiveSquad } from '../src/engine/live.js';
import { notesText } from '../src/engine/prompts.js';

let tmp: string;
let bp: BoardPaths;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-takeover-'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function building() {
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct' });
  const t = actions.createTicket(bp, { title: 'Limit bookings' });
  return updateTicket(bp, t.id, (x) => {
    x.stage = 'implement';
    x.live = true;
    x.squad = { phase: 'build', nextAt: new Date().toISOString() };
    x.worktree = tmp;
    x.sessions = { build: 'b-123' };
    x.gates = { checks: 'pass', review: 'pending', proof: 'pending' };
  });
}

describe('message an agent', () => {
  it('goes to every agent as a note, marked for the one you wrote to', () => {
    const t = actions.addNote(bp, 'SK-150', { text: 'Use the existing autosave hook', to: 'builder' });
    expect(t.notes!.at(-1)).toMatchObject({ kind: 'note', to: 'builder', text: 'Use the existing autosave hook' });
    expect(t.activity[0]!.text).toBe('Message to the Builder: Use the existing autosave hook');
    expect(notesText(t.notes!, true)).toContain('- Note to the builder: Use the existing autosave hook');
    expect(() => actions.addNote(bp, 'SK-150', { text: ' ', to: 'builder' })).toThrow(/Write the message/);
  });
});

describe('take over and give back', () => {
  it('stops the squad, hands you the Builder session, and runs every check again after', () => {
    const t0 = building();
    let t = actions.takeOver(bp, t0.id);
    expect(t.takenOver).toMatchObject({ by: 'Momen', session: 'b-123', cwd: tmp });
    expect(t.waiting?.kind).toBe('yours');
    expect(t.stopRequested).toBe(true);
    expect(t.squad).toBeNull();
    expect(() => actions.takeOver(bp, t0.id)).toThrow(/already yours/);

    // The running step stops quietly: no stuck card while the ticket is yours.
    const squad = new LiveSquad(bp) as unknown as { stopped(id: string, phase?: string): void; update(id: string, fn: (t: typeof t0) => void): typeof t0 };
    squad.stopped(t0.id, 'build');
    t = readTicket(bp, t0.id)!;
    expect(t.stopRequested).toBeUndefined();
    expect(t.stuck).toBeUndefined();
    expect(t.waiting?.kind).toBe('yours');

    // A step that ends late cannot move the ticket on while it is yours.
    squad.update(t0.id, (x) => {
      x.waiting = { kind: 'plan', summary: '' };
      x.squad = { phase: 'test', nextAt: '' };
    });
    t = readTicket(bp, t0.id)!;
    expect(t.waiting?.kind).toBe('yours');
    expect(t.squad).toBeNull();

    t = actions.giveBack(bp, t0.id, 'Moved the limit into settings');
    expect(t.takenOver).toBeUndefined();
    expect(t.waiting).toBeNull();
    expect(t.squad?.phase).toBe('test');
    expect(t.stage).toBe('test');
    expect(t.gates).toEqual({ checks: 'pending', review: 'pending', proof: 'pending' });
    expect(t.notes!.at(-1)!.text).toBe('Moved the limit into settings');
    expect(t.activity[0]!.text).toBe('Gave it back: Moved the limit into settings');
    expect(() => actions.giveBack(bp, t0.id)).toThrow(/not taken over/);
  });

  it('needs code to work on', () => {
    writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct' });
    const t = actions.createTicket(bp, { title: 'Too early' });
    expect(() => actions.takeOver(bp, t.id)).toThrow(/once the Builder has started/);
  });

  it('works on the demo board too', () => {
    const t = actions.takeOver(bp, 'SK-150');
    expect(t.waiting?.kind).toBe('yours');
    expect(t.takenOver?.session).toBe('demo-session');
    expect(actions.giveBack(bp, 'SK-150').squad?.phase).toBe('test');
  });
});
