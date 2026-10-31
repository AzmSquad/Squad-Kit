import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardPaths, readTicket, type BoardPaths } from '../src/board/store.js';
import { seedDemoBoard } from '../src/board/demo.js';
import * as actions from '../src/board/actions.js';
import { draftTicket } from '../src/engine/draft.js';
import { draftPrompt, intakePrompt } from '../src/engine/prompts.js';
import { readMeta } from '../src/board/store.js';

let tmp: string;
let bp: BoardPaths;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-new-ticket-'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const b64 = (text: string) => Buffer.from(text).toString('base64');

describe('a ticket written by hand', () => {
  it('keeps its criteria, rules, edge cases and files, and every agent reads them', () => {
    const t = actions.createTicket(bp, {
      title: 'Limit bookings per day',
      ask: 'Clerks book too many slots for one person.',
      kind: 'bug',
      criteria: ['The clerk sees an error on the 4th booking', '  '],
      rules: ['At most 3 bookings a day per person'],
      edgeCases: ['The person cancels one and books again'],
      files: [
        { name: 'chat.png', data: b64('png') },
        { name: 'chat.png', data: b64('second') },
        { name: '../../evil name?.txt', data: b64('x') },
      ],
    });
    const saved = readTicket(bp, t.id)!;
    expect(saved.kind).toBe('bug');
    expect(saved.brief).toEqual({
      criteria: ['The clerk sees an error on the 4th booking'],
      rules: ['At most 3 bookings a day per person'],
      edgeCases: ['The person cancels one and books again'],
    });
    const dir = path.join(bp.dir, 'attachments', t.id);
    expect(saved.attachments!.map((f) => path.relative(dir, f))).toEqual(['chat.png', 'chat-2.png', 'evil name_.txt']);
    expect(fs.readFileSync(saved.attachments![1]!, 'utf8')).toBe('second');

    const prompt = intakePrompt(readMeta(bp), [], saved);
    expect(prompt).toContain('At most 3 bookings a day per person');
    expect(prompt).toContain('The person cancels one and books again');
    expect(prompt).toContain('The clerk sees an error on the 4th booking');
    expect(prompt).toContain(saved.attachments![0]);
  });

  it('leaves out an empty brief', () => {
    const t = actions.createTicket(bp, { title: 'Plain one', criteria: [' '], rules: [] });
    expect(readTicket(bp, t.id)!.brief).toBeUndefined();
    expect(readTicket(bp, t.id)!.attachments).toBeUndefined();
  });

  it('refuses too many or too large files', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, data: b64('x') }));
    expect(() => actions.createTicket(bp, { title: 'Too many', files: many })).toThrow(/at most 10/);
    const big = { name: 'big.bin', data: Buffer.alloc(actions.MAX_UPLOAD_BYTES + 1).toString('base64') };
    expect(() => actions.createTicket(bp, { title: 'Too big', files: [big] })).toThrow(/larger than 10 MB/);
  });
});

describe('a ticket filled in from a pasted message', () => {
  it('asks for text or a file', async () => {
    await expect(draftTicket(bp, { text: '  ' })).rejects.toThrow(/Paste the idea/);
  });

  it('on the demo board, takes the title from the first line', async () => {
    const d = await draftTicket(bp, { text: 'Urgent: booking page crashes\nThe manager says it fails after 3 bookings.' });
    expect(d.title).toBe('Urgent: booking page crashes');
    expect(d.kind).toBe('bug');
    expect(d.priority).toBe('high');
    expect(d.ask).toContain('fails after 3 bookings');
  });

  it('gives the Analyst the text and the attached files, read only', () => {
    const p = draftPrompt(readMeta(bp), 'المدير يقول: لا أكثر من ٣ مواعيد', ['/tmp/x/chat.png']);
    expect(p).toContain('لا أكثر من ٣ مواعيد');
    expect(p).toContain('/tmp/x/chat.png');
    expect(p).toContain('Do not write or change any files');
    expect(p).toContain('same language as the text');
  });
});
