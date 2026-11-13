import { describe, it, expect } from 'vitest';
import { NO_APP_WHY, SCREENS_WHY, SEES_WHY, aboutWhatSomeoneSees, changedLine, cleanProof, isScreenFile, keepProof, lockForScreens, proposedProofs, withLocks } from '../src/board/proof-lock.js';
import { hasAppToStart } from '../src/board/apps.js';
import type { BoardMeta } from '../src/board/types.js';
import { readTicketDocs, ticketDocs } from '../src/board/docs.js';
import type { Criterion, ProofShot } from '../src/board/types.js';

/**
 * squad-kit's own rules for how a "done when" is proved: code, never an agent's word. A line about what someone sees is
 * locked to Screen, a story that changes screen files keeps a picture, an agent cannot unlock a line, and the kinds are
 * kept in the project's own spec.md and proof.md. An old spec with no kinds reads and writes as before.
 */

const line = (then: string, given = 'a customer', when = 'they pay'): Criterion => ({ given, when, then });

describe('the lock rules', () => {
  it('locks a line about what someone sees, in English and in Arabic, and only by its result', () => {
    expect(aboutWhatSomeoneSees(line('I see Paid and my receipt number'))).toBe(true);
    expect(aboutWhatSomeoneSees(line('the page shows the 10:30 slot as free'))).toBe(true);
    expect(aboutWhatSomeoneSees(line('a message says the card was refused'))).toBe(true);
    expect(aboutWhatSomeoneSees(line('أشوف «مدفوع» ورقم الإيصال'))).toBe(true);
    // The mockup's other lines are not about a screen.
    expect(aboutWhatSomeoneSees(line('the booking is saved as paid, with its amount'))).toBe(false);
    expect(aboutWhatSomeoneSees(line('the payment call answers with the receipt number'))).toBe(false);
    expect(aboutWhatSomeoneSees(line('a booking not paid within 15 minutes is freed for other customers'))).toBe(false);
    expect(aboutWhatSomeoneSees(line('card numbers are never saved'))).toBe(false);
    expect(aboutWhatSomeoneSees(line('يتحفظ الحجز كمدفوع مع المبلغ'))).toBe(false);
    // "shows" in an API's answer is not a screen; a click is the action, not the result.
    expect(aboutWhatSomeoneSees(line('the API response shows the receipt number'))).toBe(false);
    expect(aboutWhatSomeoneSees({ then: 'the booking is stored as paid' })).toBe(false);
    expect(aboutWhatSomeoneSees(line('the booking is stored as paid', 'a customer', 'they click Pay'))).toBe(false);
  });

  it("takes the Analyst's kinds, locks what someone sees, and never takes a lock from an agent", () => {
    const out = proposedProofs([
      { ...line('I see Paid and my receipt number'), proof: { kind: 'data', why: 'The table shows it.', locked: false } },
      { ...line('the booking is saved as paid'), proof: { kind: 'data', why: 'Nothing new on a screen.' } },
      { ...line('the payment call answers with the receipt number'), proof: { kind: 'api', why: 'Other apps call it.', locked: true } },
      { ...line('card numbers are never saved'), proof: { kind: 'none', why: '' } },
      { ...line('a booking not paid in 15 minutes is freed'), proof: { kind: 'nope' } },
    ]);
    expect(out[0]!.proof).toEqual({ kind: 'screen', why: SEES_WHY, locked: true });
    expect(out[1]!.proof).toEqual({ kind: 'data', why: 'Nothing new on a screen.' });
    expect(out[2]!.proof).toEqual({ kind: 'api', why: 'Other apps call it.' });
    // Not on a screen with no reason keeps a picture, as before; an unknown kind too.
    expect(out[3]!.proof).toEqual({ kind: 'screen' });
    expect(out[4]!.proof).toEqual({ kind: 'screen' });
    expect(cleanProof({ kind: 'none', why: 'Speed only.' })).toEqual({ kind: 'none', why: 'Speed only.' });
  });

  it('leaves an answer with no kinds at all as an old spec', () => {
    const out = proposedProofs([line('I see Paid'), line('the booking is saved')]);
    expect(out.every((c) => c.proof === undefined)).toBe(true);
    expect(withLocks(out)).toEqual(out);
    expect(lockForScreens(out, true)).toBeNull();
  });

  it('keeps a picture when the story changes screen files and no line has one', () => {
    const criteria = proposedProofs([
      { ...line('the booking is saved as paid'), proof: { kind: 'data' } },
      { ...line('the list shows the new status badge', 'staff', 'they open bookings'), proof: { kind: 'test' } },
      { ...line('card numbers are never saved'), proof: { kind: 'none', why: 'Nothing to show.' } },
    ]);
    // "shows" with nothing pointing away is about a screen: rule 1 already locked line 2.
    expect(criteria[1]!.proof?.locked).toBe(true);
    const noScreen = criteria.map((c, i) => (i === 1 ? { ...c, proof: { kind: 'test' as const } } : c));
    expect(lockForScreens(noScreen, false)).toBeNull();
    const locked = lockForScreens(noScreen, true)!;
    expect(locked.line).toBe(2);
    expect(locked.criteria[1]!.proof).toEqual({ kind: 'screen', why: SCREENS_WHY, locked: true });
    // A Screen line already there: nothing to add.
    expect(lockForScreens(criteria, true)).toBeNull();
    expect(isScreenFile('src/app/bookings/page.tsx')).toBe(true);
    expect(isScreenFile('src/styles/app.css')).toBe(true);
    expect(isScreenFile('src/app/bookings/page.test.tsx')).toBe(false);
    expect(isScreenFile('tests/e2e/booking.spec.ts')).toBe(false);
    expect(isScreenFile('src/lib/payments.ts')).toBe(false);
  });

  it('a hand edit keeps the kind and looks at the lock again; a change cannot unlock a line', () => {
    const data: Criterion = { ...line('the booking is saved'), proof: { kind: 'data', why: 'The table shows it.' } };
    expect(keepProof(data, line('the booking is saved as paid')).proof).toEqual({ kind: 'data', why: 'The table shows it.' });
    expect(keepProof(data, line('I see the booking as paid')).proof).toEqual({ kind: 'screen', why: SEES_WHY, locked: true });
    expect(keepProof(undefined, line('x'))).toEqual(line('x'));
    const locked: Criterion = { ...line('I see Paid'), proof: { kind: 'screen', why: SEES_WHY, locked: true } };
    expect(changedLine(locked, { kind: 'none', why: 'no' }, line('I see Paid'), true).proof).toMatchObject({ kind: 'screen', locked: true });
    expect(changedLine(data, undefined, line('the booking is saved with its amount'), true).proof).toEqual({ kind: 'data', why: 'The table shows it.' });
    expect(changedLine(undefined, { kind: 'test', why: 'A timer.' }, line('the slot is freed'), true).proof).toEqual({ kind: 'test', why: 'A timer.' });
    expect(changedLine(undefined, undefined, line('the slot is freed'), true).proof).toEqual({ kind: 'screen' });
    expect(changedLine(undefined, undefined, line('the slot is freed'), false).proof).toBeUndefined();
  });
});

describe('a project with no app to start', () => {
  it('knows one: no start command and address, no product of parts, no phone app, and code already there', () => {
    const meta = (more: Partial<BoardMeta>) => ({ project: 'Tool', commands: { test: 'npm test' }, ...more }) as BoardMeta;
    expect(hasAppToStart(meta({}))).toBe(false);
    expect(hasAppToStart(meta({ commands: { start: 'npm run dev', url: 'http://localhost:3000' } }))).toBe(true);
    expect(hasAppToStart(meta({ commands: { test: 'flutter test' } }))).toBe(true);
    // A new project makes its app in its first stories.
    expect(hasAppToStart(meta({ scan: { empty: true } as BoardMeta['scan'] }))).toBe(true);
  });

  it('has no lock, and a picture, a call or rows becomes a test', () => {
    const out = proposedProofs(
      [
        { ...line('I see the report in the terminal'), proof: { kind: 'screen' } },
        { ...line('the list shows three rows'), proof: { kind: 'data', why: 'Rows.' } },
        { ...line('the exit code is 0'), proof: { kind: 'test', why: 'A test runs the tool.' } },
        { ...line('it stays fast'), proof: { kind: 'none', why: 'Speed only.' } },
      ],
      false,
    );
    expect(out.map((c) => c.proof)).toEqual([{ kind: 'test', why: NO_APP_WHY }, { kind: 'test', why: NO_APP_WHY }, { kind: 'test', why: 'A test runs the tool.' }, { kind: 'none', why: 'Speed only.' }]);
    expect(withLocks([{ ...line('I see it'), proof: { kind: 'test' } }], false)[0]!.proof).toEqual({ kind: 'test' });
    expect(keepProof({ ...line('x'), proof: { kind: 'test' } }, line('I see the total'), false).proof).toEqual({ kind: 'test' });
    expect(changedLine(undefined, { kind: 'screen' }, line('I see the total'), true, false).proof).toEqual({ kind: 'test', why: NO_APP_WHY });
  });
});

describe('the kinds in the project files', () => {
  const base = { id: 'MA-21', title: 'Pay by card when booking', ask: 'Customers pay by card.' };

  it('writes each kind under its "done when" in spec.md and reads it back', () => {
    const criteria: Criterion[] = [
      { ...line('I see Paid'), proof: { kind: 'screen', why: SEES_WHY, locked: true } },
      { ...line('the booking is saved as paid'), proof: { kind: 'data', why: 'Nothing new on a screen: the bookings table shows it.' } },
      { ...line('card numbers are never saved'), proof: { kind: 'none', why: 'Nothing to show. The Reviewer checks the code.' } },
      { ...line('الحجز يتحفظ كمدفوع'), proof: { kind: 'api' } },
    ];
    const docs = ticketDocs({ ...base, story: 'As a customer…', criteria });
    expect(docs['spec.md']).toContain('   Proof: screen, locked. About what someone sees, so it needs a picture');
    expect(docs['spec.md']).toContain('   Proof: data. Nothing new on a screen: the bookings table shows it.');
    expect(readTicketDocs(docs).criteria).toEqual(criteria);
  });

  it('an old spec with no kinds reads and writes exactly as before', () => {
    const criteria = [line('I see Paid'), line('the booking is saved')];
    const docs = ticketDocs({ ...base, story: 'As a customer…', criteria });
    expect(docs['spec.md']).not.toContain('Proof:');
    expect(readTicketDocs(docs).criteria).toEqual(criteria);
  });

  it("keeps each proof row's kind, its test and the Reviewer's check in proof.md", () => {
    const proof: ProofShot[] = [
      { criterion: 'A booking not paid in 15 minutes is freed', before: 'ma-21-test-4.test.json', after: 'ma-21-test-4.test.json', beforeLabel: 'Test', afterLabel: 'Test', kind: 'test', shows: 'met', test: { name: 'Bookings > frees an unpaid slot', file: 'tests/booking.test.ts', steps: ['Makes a booking at 10:00', 'Moves the clock to 10:16'], before: 'failed', after: 'passed', seconds: 0.4 } },
      { criterion: 'Card numbers are never saved', before: 'ma-21-none-5.none.json', after: 'ma-21-none-5.none.json', beforeLabel: 'Not on a screen', afterLabel: 'Not on a screen', kind: 'none', shows: 'met', checked: 'Checked the code and the tables: only the last 4 digits are kept.', note: 'Nothing to show.' },
      { criterion: 'I see Paid', before: 'a.png', after: 'b.png', beforeLabel: 'Before', afterLabel: 'After', shows: 'met' },
    ];
    const back = readTicketDocs(ticketDocs({ ...base, proof })).proof!;
    expect(back[0]).toMatchObject({ kind: 'test', test: proof[0]!.test, shows: 'met' });
    expect(back[1]).toMatchObject({ kind: 'none', checked: proof[1]!.checked, note: 'Nothing to show.' });
    expect(back[2]!.kind).toBeUndefined();
  });

  it('keeps the kind a change gives a line in the spec change record', () => {
    const t = {
      ...base,
      story: 'As a customer…',
      criteria: [line('the booking is saved')],
      changes: [{ id: 'c1', ask: 'Prove line 1 with a test', by: 'Momen', at: '2026-11-13T10:00:00Z', status: 'proposed' as const, parts: [{ part: 'criterion' as const, index: 0, before: 'Given a customer, when they pay, then the booking is saved.', after: 'Given a customer, when they pay, then the booking is saved. Proved by: Test.', criterion: { ...line('the booking is saved'), proof: { kind: 'test' as const, why: 'A rule.' } } }] }],
    };
    const back = readTicketDocs(ticketDocs(t));
    expect(back.changes![0]!.parts![0]!.criterion!.proof).toEqual({ kind: 'test', why: 'A rule.' });
  });
});
