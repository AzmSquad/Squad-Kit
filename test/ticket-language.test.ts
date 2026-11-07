import { describe, it, expect } from 'vitest';
import { designPrompt, intakePrompt, planPrompt, proofCheckPrompt, proofPrompt, specPrompt, theirLanguage, ticketContext, writtenInArabic } from '../src/engine/prompts.js';
import type { BoardMeta, Ticket } from '../src/board/types.js';

const story = (over: Partial<Ticket> = {}): Ticket =>
  ({ id: 'A-1', title: 'Show the exit time', ask: 'People want to see when a visitor left.', kind: 'feature', source: { type: 'manual' }, priority: 'normal', stage: 'tickets', status: '', waiting: null, createdAt: 'now', createdBy: 'Me', activity: [], story: 'A story', criteria: [{ given: 'a', when: 'b', then: 'c' }], ...over }) as Ticket;
const arabic = story({ title: 'إضافة وقت الخروج', ask: 'في صفحة الزوار أريد عمودًا جديدًا اسمه وقت الخروج.' });
const meta = { project: 'P', commands: {}, map: [], lessons: [], stack: [], conventions: [], scan: {} } as unknown as BoardMeta;

describe('the language a story is written in', () => {
  it.each([
    [{ title: 'إضافة وقت الخروج', ask: 'أريد عمودًا جديدًا في صفحة الزوار' }, true],
    [{ title: 'إضافة زر Export PDF', ask: 'في صفحة Reports أريد زرًا للتصدير' }, true],
    [{ title: 'Add an exit time', ask: 'The column should say لم يخرج for someone who has not left' }, false],
    [{ title: 'Add an exit time', ask: 'People want to see when a visitor left' }, false],
    [{ title: '123', ask: '' }, false],
    [{ title: 'إضافة وقت الخروج', ask: '' }, true],
  ])('%j is Arabic: %s', (t, yes) => {
    expect(writtenInArabic(t as Ticket)).toBe(yes);
  });

  it('a ticket in English gets the same words as before', () => {
    expect(theirLanguage(story())).toBe('');
    expect(ticketContext(story())).not.toContain('in Arabic');
  });

  it('code, file names, commands and commit messages stay in English', () => {
    expect(theirLanguage(arabic)).toContain('Keep code, file names, page addresses, commands and commit messages in English');
  });

  it.each([
    ['the questions', () => intakePrompt(meta, [], arabic)],
    ['the plan', () => planPrompt(arabic)],
    ['the spec', () => specPrompt(arabic)],
    ['the design', () => designPrompt(arabic)],
    ['the proof', () => proofPrompt(meta, arabic, 'after')],
    ["squad-kit's look at the pictures", () => proofCheckPrompt(arabic, [])],
  ] as const)('%s says so', (_name, prompt) => {
    expect(prompt()).toContain('write in Arabic everything a person reads');
  });
});
