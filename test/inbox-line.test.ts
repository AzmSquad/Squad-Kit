import { describe, expect, it } from 'vitest';
import { inboxLine } from '../src/commands/board.js';
import type { Ticket } from '../src/board/types.js';

const base = { id: 'AB-1', title: 'X', ask: '', kind: 'feature', stage: 'implement', activity: [] } as unknown as Ticket;

describe('squad inbox, one line per ticket', () => {
  it('says why each ticket waits, in the same order as the banner', () => {
    expect(inboxLine({ ...base, waiting: { kind: 'proof', summary: 'Proof ready to check' } } as Ticket)).toBe('Proof ready to check');
    expect(inboxLine({ ...base, outdated: [{ adr: 'AB-7.1', why: '', change: '', at: '' }] })).toBe('AB-7.1 came after this plan and changes it');
    expect(inboxLine({ ...base, outdated: [{ adr: 'AB-7.1', why: '', change: '', at: '' }, { adr: 'AB-9.1', why: '', change: '', at: '' }] })).toBe(
      'AB-7.1 and AB-9.1 came after this plan and change it',
    );
    expect(inboxLine({ ...base, quiet: { kind: 'stuck', detail: 'npm test has printed nothing for 5 min' } } as Ticket)).toBe('Looks stuck: npm test has printed nothing for 5 min');
  });
});
