import { describe, it, expect } from 'vitest';
import { addDecided } from '../src/board/auto.js';
import { saysTheSame } from '../src/board/same-words.js';
import type { Ticket } from '../src/board/types.js';

/**
 * "Decided for you" says each thing once (RO-7, 2026-11-04): the Reviewer's second round wrote d18 to d21, which
 * repeat d14 to d16 (and d5) almost word for word. An entry that says the same as one the ticket has is skipped; the
 * words are made plain and compared by how many they share. These are RO-7's real entries.
 */

const D14 = '4 Dec 2026, the example day in done-when 2, is a Friday, so it is refused because the office is closed, not because it is too far ahead; Thursday 3 Dec is the latest day that can be booked.';
const D15 = 'When a booking breaks several limits, the message lists them in this order: length, days ahead, office hours, office days.';
const D16 = "The 30 days are counted from today's date, so a booking on day 30 is allowed and day 31 is refused.";
const D18 = '4 Dec is a Friday, so on 4 Nov it is refused because the office is closed, as the ticket notes already say. Thursday 3 Dec is the last day that can be booked.';
const D19 = 'When a booking breaks several limits, the message lists them in a fixed order: length, days ahead, office hours, office days.';
const D20 = "The 30 days are counted from today's date, so a booking exactly 30 days ahead is allowed.";
const D21 = 'A booking may end exactly at 18:00 or start exactly at 08:00.';
const D5 = 'A booking may start exactly at 08:00 and end exactly at 18:00.';

const ticket = (decided: { id: string; text: string }[]): Ticket =>
  ({
    id: 'RO-7',
    title: 'Staff bookings follow the fair-use limits',
    track: 'auto',
    breakdown: { id: 'BR-1', item: 'S-21' },
    activity: [],
    decided: decided.map((d) => ({ ...d, by: 'reviewer', at: '2026-11-04T10:30:54.664Z', item: 'S-21', ticket: 'RO-7' })),
  }) as unknown as Ticket;

describe('Decided for you', () => {
  it("skips RO-7's d18 to d20, which repeat d14 to d16, and keeps d21, which says something new to them", () => {
    const t = ticket([
      { id: 'd14', text: D14 },
      { id: 'd15', text: D15 },
      { id: 'd16', text: D16 },
    ]);
    const added = addDecided(t, 'reviewer', [D18, D19, D20, D21]);
    expect(added.map((d) => d.text)).toEqual([D21]);
    expect(added[0]!.id).toBe('d17');
    expect(t.decided!.map((d) => d.id)).toEqual(['d14', 'd15', 'd16', 'd17']);
    expect(t.activity.map((a) => a.text)).toEqual([`Decided for you (d17): ${D21}`]);
  });

  it("skips d21 too once the ticket has d5, which says the same, and repeats within one answer", () => {
    const t = ticket([{ id: 'd5', text: D5 }]);
    expect(addDecided(t, 'reviewer', [D21])).toEqual([]);
    expect(addDecided(t, 'builder', [D16, D20]).map((d) => d.text)).toEqual([D16]);
  });

  it('never takes two lines that say the opposite, or two different choices, for the same', () => {
    const pairs: [string, string][] = [
      [D14, D18],
      [D15, D19],
      [D16, D20],
      [D5, D21],
    ];
    for (const [a, b] of pairs) expect(saysTheSame(a, b), b).toBe(true);
    const different: [string, string][] = [
      ['A booking on day 30 is allowed.', 'A booking on day 30 is not allowed.'],
      ["Bookings can't be made on Fridays.", 'Bookings can be made on Fridays.'],
      ['A booking may start exactly at 08:00.', 'A booking may end exactly at 18:00.'],
      [D14, 'A Friday or Saturday booking is refused even when it is within 30 days, so the office-days rule wins over the 30-day example in done-when 2.'],
      [D15, D16],
    ];
    for (const [a, b] of different) expect(saysTheSame(a, b), b).toBe(false);
  });

  it('keeps each Arabic entry: lines in another script are words too, never empty and all the same', () => {
    const REFUND = 'يتم رد الرسوم كاملة عند إلغاء الجلسة قبل موعدها بيوم';
    const HOURS = 'تعمل المحكمة من الأحد إلى الخميس من الثامنة صباحا';
    const SLOT = 'تبقى الجلسة محجوزة لمدة عشر دقائق بعد اختيارها';
    expect(saysTheSame(REFUND, HOURS)).toBe(false);
    const t = ticket([]);
    expect(addDecided(t, 'architect', [REFUND, HOURS, SLOT]).map((d) => d.text)).toEqual([REFUND, HOURS, SLOT]);
    // The same line again is still one entry, with other marks or a full stop.
    expect(addDecided(t, 'reviewer', [REFUND, `${HOURS}.`, 'تَبْقَى الجلسة محجوزة لمدة عشر دقائق بعد اختيارها'])).toEqual([]);
    expect(t.decided!.map((d) => d.id)).toEqual(['d1', 'd2', 'd3']);
    // Short lines must match word for word, in any language.
    expect(saysTheSame('نعم موافق', 'لا موافق')).toBe(false);
  });
});
