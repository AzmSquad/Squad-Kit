import { describe, it, expect } from 'vitest';
import { doingWords, optionsOf, placeOf, requirementsPath, sourceRef, stopKind, waitingOn, waitsLine } from '../console-ui/src/lib/auto.js';
import type { Ticket } from '../console-ui/src/api/types.js';
import type { BreakdownView } from '../console-ui/src/api/requirements-types.js';

/** The ticket side of Builds by itself, as the board works it out: the stop tag, the link back, who waits for an answer. */

const ticket = (more: Partial<Ticket>): Ticket => ({
  id: 'RO-31',
  title: 'Refund on cancel',
  ask: '',
  kind: 'feature',
  source: { type: 'manual' },
  priority: 'normal',
  stage: 'specs',
  status: '',
  waiting: null,
  createdAt: '2026-11-04T10:00:00.000Z',
  createdBy: 'Momen',
  activity: [],
  track: 'auto',
  breakdown: { id: 'BR-1', item: 'S-14' },
  ...more,
});

const s = (key: string, title: string, dependsOn: string[] = []) => ({ key, title, story: '', criteria: [], size: 'M' as const, dependsOn });

const view = (on: boolean, merged: string[] = []): Pick<BreakdownView, 'epics' | 'progress' | 'state'> => ({
  epics: [
    {
      key: 'E-2',
      title: 'Payments',
      stories: [],
      features: [{ key: 'F-4', title: 'Invoices and refunds', stories: [s('S-13', 'Email the invoice'), s('S-14', 'Refund on cancel'), s('S-16', 'Partial refunds', ['S-14']), s('S-17', 'Refund report', ['S-16'])] }],
    },
    { key: 'E-3', title: 'Admin', features: [], stories: [s('S-20', 'Audit log')] },
  ],
  progress: merged.map((key) => ({ key, state: 'merged' as const, line: 'Merged' })),
  state: { activity: [], ...(on ? { build: { on: true, by: 'Momen', at: '2026-11-04T10:00:00.000Z' } } : {}) },
});

describe('the ticket side of Builds by itself', () => {
  it('names the stop only for a story that builds by itself', () => {
    const q = { from: 'architect' as const, text: 'Which refund rule?', options: [], at: '2026-11-04T10:00:00.000Z' };
    expect(stopKind(ticket({ waiting: { kind: 'ask', summary: 'Two parts clash' }, agentQuestion: { ...q, kind: 'clash' } }))).toBe('clash');
    expect(stopKind(ticket({ waiting: { kind: 'ask', summary: 'Missing in the BRD' }, agentQuestion: { ...q, kind: 'gap' } }))).toBe('gap');
    expect(stopKind(ticket({ waiting: { kind: 'stuck', summary: 'Checks failed' }, stuck: { gate: 'checks', question: '', options: [] } }))).toBe('check');
    expect(stopKind(ticket({ track: 'full', waiting: { kind: 'ask', summary: 'Two parts clash' }, agentQuestion: { ...q, kind: 'clash' } }))).toBeNull();
    expect(stopKind(ticket({}))).toBeNull();
  });

  it('links back to the story on the Requirements page, by its names', () => {
    expect(requirementsPath('BR-1', 'S-14')).toBe('/requirements/BR-1?item=S-14');
    expect(requirementsPath('BR-2')).toBe('/requirements/BR-2');
    expect(placeOf(view(true), 'S-14')).toBe('Payments › Invoices and refunds › S-14');
    expect(placeOf(view(true), 'S-20')).toBe('Admin › S-20');
    expect(placeOf(undefined, 'S-14')).toBe('S-14');
  });

  it('shows the suggested choice without its marker, and what the agent was doing', () => {
    expect(optionsOf(['No refund within 24 hours (suggested)', 'Keep the full refund'])).toEqual([
      { text: 'No refund within 24 hours', suggested: true },
      { text: 'Keep the full refund', suggested: false },
    ]);
    expect(doingWords({ stage: 'specs' })).toBe('planning');
    expect(doingWords({ stage: 'implement' })).toBe('building');
  });

  it('says which stories wait for the answer, and that the others keep building', () => {
    expect(waitingOn(view(true), 'S-14')).toEqual(['S-16 Partial refunds', 'S-17 Refund report']);
    expect(waitsLine(view(true), ticket({}))).toBe('S-16 Partial refunds and S-17 Refund report wait for your answer. The other stories keep building.');
    expect(waitsLine(view(false, ['S-16', 'S-17']), ticket({}))).toBe('');
    expect(waitsLine(view(true), ticket({ breakdown: { id: 'BR-1', item: 'S-20' } }))).toBe('No other story waits for it: the others keep building.');
  });

  it('opens a stop\'s source in the BRD at its place, and leaves answers and tickets to be said or linked', () => {
    expect(sourceRef({ text: 'BRD 4.2, page 18', section: '4.2', page: 18 })).toEqual({ section: '4.2', page: 18 });
    expect(sourceRef({ text: 'your answer to question 1' })).toBeNull();
    expect(sourceRef({ text: 'RO-12 Cancel and refund', ticket: 'RO-12' })).toBeNull();
  });
});
