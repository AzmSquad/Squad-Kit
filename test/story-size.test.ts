import { describe, expect, it } from 'vitest';
import { checkSize, countAsks } from '../src/engine/story-size.js';
import { cleanParts, cleanSplit, splitProblem } from '../src/engine/split-prompts.js';
import { PAYMENTS, PAYMENTS_AR, PAYMENT_PARTS, brdLike, businessPaste } from './support/split.js';

/**
 * squad-kit's own count of a story's size, before any AI: one story, the middle the Analyst judges, a few stories, or a
 * whole requirements document. Clear cases are decided here; a long business text with no requirement numbers is
 * still caught.
 */

describe('the fixed check', () => {
  it('a short story is one story: nothing to judge', () => {
    for (const text of ["Show the hearing time in each person's local time.", 'As a customer, I want to cancel my booking up to 2 hours before, so that the slot frees up.', 'اعرض وقت الجلسة بتوقيت المستخدم المحلي.']) {
      expect(checkSize({ text }).size).toBe('one');
    }
  });

  it('the four-part payments paste is left to the Analyst, with its separate asks counted', () => {
    const c = checkSize({ text: PAYMENTS });
    expect(c).toMatchObject({ size: 'middle', asks: 4, requirementIds: 0 });
    expect(c.found).toEqual(['4 separate asks']);
  });

  it('the same paste in Arabic counts the same way', () => {
    expect(checkSize({ text: PAYMENTS_AR })).toMatchObject({ size: 'middle', asks: 4 });
    expect(countAsks('اعرض وقت الجلسة، عشان الموظف يعرف.')).toBe(1);
  });

  it('a long business text with no requirement numbers is still caught by its words, never one story', () => {
    const text = businessPaste();
    const c = checkSize({ text });
    expect(c.requirementIds).toBe(0);
    expect(c.size).toBe('few');
    expect(c.found.join(' ')).toMatch(/words/);
    // Its first part alone, about 200 words naming many roles and screens, goes to the Analyst, who can still say one.
    const first = text.split('\n\n').slice(0, 4).join('\n\n');
    expect(checkSize({ text: first })).toMatchObject({ size: 'middle' });
    expect(checkSize({ text: first }).breadth).toBeGreaterThanOrEqual(12);
  });

  it('an ordinary story with its own lists is left to the Analyst: the lists add words, never asks', () => {
    const ask =
      'A member can cancel their own booking from My bookings. The room becomes free for others right away, and the member gets an email that says the booking is cancelled, with the room, the day and the time, so they know it worked and nobody waits for them at reception. Reception sees it go from the daily list too.';
    const lists = [
      'The member sees Cancel on each upcoming booking',
      'A cancelled booking is gone from My bookings',
      'The room shows as free at that time',
      'The member gets a cancel email',
      'Reception no longer sees the guests of that booking',
      'Only the member who booked can cancel it',
      'A cancel within one hour counts as a late cancel',
      'The booking already started',
      'The member cancels twice in a row',
      'The email cannot be sent',
    ];
    const c = checkSize({ text: ask, lists });
    expect(c.size).toBe('middle');
    expect(c.asks).toBeLessThan(8);
  });

  it('numbered list items are no headings, and "US 1" with a space is no requirement number', () => {
    const c = checkSize({ text: 'Members book a room in three steps:\n1. Pick a room\n2. Pick a time\n3. Confirm the booking' });
    expect(c.headings).toBe(0);
    expect(c.size).not.toBe('few');
    expect(checkSize({ text: 'Do US 1 first, then US 2 and US 3 from the last sprint.' }).requirementIds).toBe(0);
    expect(checkSize({ text: 'Do US-1 first, then US-2 and US-3.' }).requirementIds).toBe(3);
  });

  it('a short bug with its stack trace, or a pasted table, is not counted as words', () => {
    const trace = Array.from({ length: 60 }, (_, i) => `    at Object.<anonymous> (/app/src/booking/${i}.js:${i + 10}:5)`).join('\n');
    const bug = `Booking a room for tomorrow shows a blank page.\n\n\`\`\`\nTypeError: Cannot read properties of undefined (reading 'slots')\n${trace}\n\`\`\``;
    expect(checkSize({ text: bug }).size).toBe('one');
    // The same trace pasted with no code fence.
    expect(checkSize({ text: `Booking a room for tomorrow shows a blank page.\nTypeError: Cannot read properties of undefined\n${trace}` }).size).toBe('one');
    const table = ['| Room | Floor | Seats |', '| --- | --- | --- |', ...Array.from({ length: 40 }, (_, i) => `| Room ${i} | ${i % 5} | ${4 + (i % 8)} |`)].join('\n');
    expect(checkSize({ text: `Show the rooms below on the Rooms page.\n${table}` }).size).toBe('one');
  });

  it('a BRD-like text is a whole requirements document, by its numbers, its words or its pages', () => {
    const c = checkSize({ text: brdLike() });
    expect(c.size).toBe('brd');
    expect(c.requirementIds).toBe(48);
    expect(c.found).toEqual(expect.arrayContaining(['48 requirement numbers']));
    // A short list of a few requirement numbers is a few stories, not a document.
    expect(checkSize({ text: brdLike(1, 4) }).size).toBe('few');
    // Long plain text with no structure at all: by its words.
    expect(checkSize({ text: 'Members book rooms and reception prints badges. '.repeat(400) }).size).toBe('brd');
  });

  it('reads an attached document: a text file adds its words, a PDF its pages; pictures add nothing', () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64');
    expect(checkSize({ text: 'Here is the BRD.', files: [{ name: 'brd.md', data: b64(brdLike()) }] }).size).toBe('brd');
    const pdf = `%PDF-1.4\n${Array.from({ length: 12 }, (_, i) => `${i + 3} 0 obj << /Type /Page >> endobj`).join('\n')}`;
    const withPdf = checkSize({ text: 'Here is the BRD for the next release.', files: [{ name: 'RoomFlow BRD.pdf', data: b64(pdf) }] });
    expect(withPdf).toMatchObject({ size: 'brd', pages: 12 });
    expect(withPdf.found).toContain('a document of 12 pages');
    expect(checkSize({ text: 'Fix the logo', files: [{ name: 'shot.png', data: b64('png') }] }).size).toBe('one');
    // A broken document adds nothing here; Requirements says why when it reads it for real.
    expect(checkSize({ text: 'Fix the logo', files: [{ name: 'broken.docx', data: b64('not a zip') }] }).size).toBe('one');
  });
});

describe("the Analyst's split", () => {
  const middle = checkSize({ text: PAYMENTS });
  const parts = [...PAYMENT_PARTS.slice(0, 2), { ...PAYMENT_PARTS[2]!, needs: [1, 3, 9] }, { ...PAYMENT_PARTS[3]!, size: 'X' }];

  it('keeps its parts in order, each needing only parts before it, with a size it knows', () => {
    const s = cleanSplit({ split: { size: 'few', why: 'Four stories in one.', parts } }, middle, '2026-11-12T10:00:00Z')!;
    expect(s.size).toBe('few');
    expect(s.parts.map((p) => p.title)).toEqual(parts.map((p) => p.title));
    expect(s.parts[2]!.needs).toEqual([1]);
    expect(s.parts[3]!.size).toBe('M');
    expect(s.found).toEqual(['4 separate asks']);
  });

  it('one story stays one; a document by squad-kit\'s own count stays a document', () => {
    expect(cleanSplit({ split: { size: 'one', why: 'One story.' } }, middle, 'x')).toBeNull();
    const brd = checkSize({ text: brdLike() });
    expect(cleanSplit({ split: { size: 'few', why: '', parts } }, brd, 'x')).toMatchObject({ size: 'brd', parts: [] });
    expect(cleanSplit({ split: { size: 'brd', why: '', areas: [{ name: 'Booking', stories: 6 }, { name: '', stories: 3 }] } }, middle, 'x')!.areas).toEqual([{ name: 'Booking', stories: 6 }]);
  });

  it('drops a part with no title first, then numbers the needs again: no part ever waits for itself', () => {
    const parts = cleanParts(
      [
        { title: 'A', line: '', size: 'S', needs: [] },
        { title: ' ', line: 'no title', size: 'S', needs: [1] },
        { title: 'C', line: '', size: 'M', needs: [1] },
        { title: 'D', line: '', size: 'M', needs: [3] },
      ],
      0,
    );
    expect(parts.map((p) => [p.title, p.needs])).toEqual([
      ['A', []],
      ['C', [1]],
      ['D', [2]],
    ]);
  });

  it('a bug report is one story: never split, never asked again', () => {
    expect(cleanSplit({ kind: 'bug', split: { size: 'few', why: '', parts: PAYMENT_PARTS } }, checkSize({ text: businessPaste() }), 'x')).toBeNull();
    expect(splitProblem({ kind: 'bug', split: { size: 'one', why: '' } }, 'few')).toBeNull();
  });

  it('asks again for a split it cannot use, and never takes "one" for a text that is clearly bigger', () => {
    const few = checkSize({ text: businessPaste() });
    expect(splitProblem({ split: { size: 'one', why: '' } }, few.size)).toMatch(/cannot be "one"/);
    expect(splitProblem({ split: { size: 'few', why: '', parts: parts.slice(0, 1) } }, 'middle')).toMatch(/fewer than 2 parts/);
    expect(splitProblem({ split: { size: 'one', why: '' } }, 'middle')).toBeNull();
  });
});
