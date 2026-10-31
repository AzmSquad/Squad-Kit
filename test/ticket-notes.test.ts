import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardPaths, readMeta, readTicket, updateTicket, writeMeta, type BoardPaths } from '../src/board/store.js';
import { seedDemoBoard } from '../src/board/demo.js';
import * as actions from '../src/board/actions.js';
import { buildPrompt, intakePrompt, notesText, proofPrompt, reviewPrompt } from '../src/engine/prompts.js';

let tmp: string;
let bp: BoardPaths;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-notes-'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('notes on a ticket', () => {
  it('keeps notes, rules and criteria, and writes them in the activity', () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings' });
    actions.addNote(bp, t.id, { text: 'The manager wants this before Sunday' });
    actions.addNote(bp, t.id, { text: 'At most 3 bookings a day', kind: 'rule' });
    const saved = actions.addNote(bp, t.id, { text: 'The clerk sees an error on the 4th booking', kind: 'criterion' });
    expect(saved.notes!.map((n) => n.kind)).toEqual(['note', 'rule', 'criterion']);
    expect(saved.activity[0]!.text).toContain('Added an acceptance criterion');
  });

  it('refuses an empty note or a released ticket', () => {
    const t = actions.createTicket(bp, { title: 'X' });
    expect(() => actions.addNote(bp, t.id, { text: '  ' })).toThrow(/Write the note/);
    updateTicket(bp, t.id, (x) => (x.stage = 'done'));
    expect(() => actions.addNote(bp, t.id, { text: 'late' })).toThrow(/released/);
  });

  it('every agent reads the notes, and a new criterion joins "done when"', () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings' });
    actions.addNote(bp, t.id, { text: 'At most 3 bookings a day', kind: 'rule' });
    actions.addNote(bp, t.id, { text: 'The clerk sees an error on the 4th booking', kind: 'criterion' });
    const saved = updateTicket(bp, t.id, (x) => {
      x.story = 'As a clerk…';
      x.criteria = [{ given: 'a person', when: 'they book', then: 'it saves' }];
    });
    const meta = readMeta(bp);
    expect(intakePrompt(meta, [], saved)).toContain('Business rule (follow it): At most 3 bookings a day');
    for (const p of [buildPrompt(meta, [], saved), reviewPrompt(meta, [], saved, 1), proofPrompt(meta, saved, '/tmp/out', 'after')]) {
      expect(p).toContain('1. Given a person, when they book, then it saves.');
      expect(p).toContain('2. The clerk sees an error on the 4th booking (added by the person)');
    }
  });

  it('a running agent is told the notes are new', () => {
    expect(notesText([{ at: '', by: 'M', kind: 'note', text: 'hi' }], true)).toMatch(/since your last step/);
  });

  it('is queued for Azure on a live board', () => {
    writeMeta(bp, { ...readMeta(bp), engine: 'live' });
    const t = actions.createTicket(bp, { title: 'From Azure', source: { type: 'azure', ref: 'AB#7' } });
    actions.addNote(bp, t.id, { text: 'Use the new logo', kind: 'rule' });
    expect(readTicket(bp, t.id)!.trackerQueue).toContainEqual({ kind: 'note', text: 'Use the new logo', noteKind: 'rule' });
  });
});
