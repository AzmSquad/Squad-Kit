import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { verdictClass, verdictNote, verdictWord } from '../console-ui/src/lib/verdict.js';
import { proofWords } from '../console-ui/src/lib/gates.js';
import { readTicketDocs, ticketDocs } from '../src/board/docs.js';
import { withProblem } from '../src/board/problem.js';
import type { ProofShot, Ticket } from '../src/board/types.js';

/**
 * On Full and Express the person sees each row of the proof marked Met, Not working yet or Not shown yet, with its
 * note, on the proof panel, the full proof page and the stop, and the gate says which. The rows keep their verdict in
 * the ticket's proof.md, with the "done when" that show on no screen in its header.
 */

const met: ProofShot = { criterion: 'The booking shows as Confirmed', before: 'a.png', after: 'b.png', beforeLabel: 'New screen', afterLabel: 'After', note: 'Sara’s booking shows as Confirmed.', shows: 'met' };
const broken: ProofShot = {
  criterion: 'The page fits a phone',
  before: 'c.png',
  after: 'd.png',
  beforeLabel: 'New screen',
  afterLabel: 'After',
  note: 'The day view at phone width.',
  shows: 'broken',
  why: 'At phone width the page runs off the right edge, so it scrolls sideways.',
};
const notShown: ProofShot = {
  criterion: 'The title shows in the day view',
  before: 'e.png',
  after: 'f.png',
  beforeLabel: 'New screen',
  afterLabel: 'After',
  note: 'The upcoming bookings.',
  shows: 'not-shown',
  why: 'The picture shows the upcoming bookings, but the day view is not in it.',
};
const gates = (proof: 'fail' | 'skipped' | 'pass') => ({ gates: { checks: 'pass', review: 'pass', proof } as const });

describe('Met, Not working yet and Not shown yet on the board', () => {
  it('marks each row with its word and its note', () => {
    expect(verdictWord('met')).toBe('Met');
    expect(verdictWord('broken')).toBe('Not working yet');
    expect(verdictWord('not-shown')).toBe('Not shown yet');
    expect(verdictWord(undefined)).toBeNull();
    expect(verdictClass('broken')).toBe('broken');
    expect(verdictClass('not-shown')).toBe('notshown');
    expect(verdictClass(undefined)).toBe('');
    expect(verdictNote(met)).toBe('Sara’s booking shows as Confirmed.');
    expect(verdictNote(broken)).toBe('At phone width the page runs off the right edge, so it scrolls sideways.');
    expect(verdictNote(notShown)).toBe('The picture shows the upcoming bookings, but the day view is not in it.');
    expect(verdictNote({ shows: 'broken', note: 'No message.' })).toBe('No message.');
  });

  it('draws the three verdicts apart', () => {
    const read = (f: string) => fs.readFileSync(new URL(`../console-ui/src/${f}`, import.meta.url), 'utf8');
    const verdict = read('components/Verdict.tsx');
    expect(verdict).toContain('verdictClass(shows)');
    expect(verdict).toContain('className="vx"');
    expect(verdict).toContain('className="vq"');
    for (const c of ['.verdict.broken', '.verdict.notshown', '.critrow.broken', '.critrow.notshown', '.verdictline.notshown']) expect(read('styles/verdict.css')).toContain(c);
    // The proof page and the panel color each row by its verdict, and show its plain note.
    expect(read('pages/Proof.tsx')).toContain('verdictClass(shot.shows)');
    expect(read('pages/TicketDrawer.tsx')).toContain('verdictClass(p.shows)');
    for (const f of ['pages/Proof.tsx', 'pages/TicketDrawer.tsx']) expect(read(f)).toContain('verdictNote(');
    expect(`${read('pages/Proof.tsx')}${read('pages/TicketDrawer.tsx')}${verdict}`).not.toContain('not-met');
  });

  it('says on the gate which it is, or that you went past it', () => {
    expect(proofWords({ ...gates('fail'), proof: [met, broken] })).toBe('A "done when" not working yet');
    expect(proofWords({ ...gates('fail'), proof: [met, notShown] })).toBe('A "done when" not shown yet');
    expect(proofWords({ ...gates('fail'), proof: [notShown, broken] })).toBe('A "done when" not working yet');
    expect(proofWords({ ...gates('skipped'), proof: [met, broken] })).toBe('A "done when" not working, you continued');
    expect(proofWords({ ...gates('skipped'), proof: [met, notShown] })).toBe('A "done when" not shown, you continued');
    expect(proofWords({ ...gates('skipped'), proof: [met] })).toBe('No screenshots, you continued');
    expect(proofWords({ ...gates('pass'), proof: [met] })).toBe('Proof made');
  });

  it('names each stop in its own words', () => {
    const title = (kind: 'broken' | 'not-shown') => withProblem({ id: 'RO-6', title: 'x', stage: 'review', status: '', waiting: { kind: 'stuck', summary: 'x' }, activity: [], stuck: { gate: 'proof', kind, question: 'x', options: [] } } as unknown as Ticket).stuck!.title;
    expect(title('broken')).toBe('A "done when" is not working yet');
    expect(title('not-shown')).toBe('A "done when" is not shown yet');
  });

  it('the proof panel, the proof page and a stop at the proof all show the marks', () => {
    const read = (f: string) => fs.readFileSync(new URL(`../console-ui/src/${f}`, import.meta.url), 'utf8');
    const drawer = read('pages/TicketDrawer.tsx');
    const page = read('pages/Proof.tsx');
    for (const src of [drawer, page]) {
      expect(src).toContain('<VerdictTag shows=');
      expect(src).toContain('<OffScreenList t={t} />');
      expect(src).toContain('proofWords(t)');
    }
    expect(drawer).toContain('What the screenshots show');
  });

  it("keeps each row's verdict and the off-screen list in the ticket's files", () => {
    const docs = ticketDocs({ id: 'RO-6', title: 'Room details', proof: [met, broken, notShown], offScreen: [{ criterion: 'It survives a restart', why: 'A screenshot cannot show a restart.' }] });
    expect(docs['proof.md']).toContain('- Shows: not working\n- Why: At phone width the page runs off the right edge, so it scrolls sideways.');
    expect(docs['proof.md']).toContain('- Shows: not shown\n- Why: The picture shows the upcoming bookings, but the day view is not in it.');
    const back = readTicketDocs(docs);
    expect(back.proof).toEqual([met, broken, notShown]);
    expect(back.offScreen).toEqual([{ criterion: 'It survives a restart', why: 'A screenshot cannot show a restart.' }]);
  });

  it('reads the old "not met" rows by their reason: a picture problem is not shown, anything else broken', () => {
    const old = (why: string) => `# Room details: proof\n\n### The page fits a phone\n\n- Before: c.png (New screen)\n- After: d.png (After)\n- Shows: not met\n- Why: ${why}\n`;
    const shows = (why: string) => readTicketDocs({ 'ticket.md': ticketDocs({ id: 'RO-6', title: 'Room details' })['ticket.md']!, 'proof.md': old(why) }).proof?.[0]?.shows;
    expect(shows("The screenshot does not show clearly that it works: Atlas's line in the day view is not in the picture.")).toBe('not-shown');
    expect(shows('No screenshot shows it.')).toBe('not-shown');
    expect(shows('At phone width the page runs off the right edge.')).toBe('broken');
  });
});
