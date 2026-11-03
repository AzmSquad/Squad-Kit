import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardPaths, readMeta, type BoardPaths } from '../src/board/store.js';
import { seedDemoBoard } from '../src/board/demo.js';
import type { BoardMeta, Ticket } from '../src/board/types.js';
import * as P from '../src/engine/prompts.js';

let tmp: string;
let bp: BoardPaths;
let meta: BoardMeta;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-ro-prompts-'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  meta = { ...readMeta(bp), commands: { test: 'npm test', lint: 'npm run lint' } };
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function ticket(gates?: Ticket['gates']): Ticket {
  return {
    id: 'RO-5',
    title: 'Cancel a booking',
    ask: 'Let people cancel their own bookings.',
    kind: 'feature',
    source: { type: 'manual' },
    priority: 'normal',
    stage: 'review',
    status: '',
    waiting: null,
    createdAt: '2026-11-02T10:00:00.000Z',
    createdBy: 'Momen',
    activity: [],
    baseCommit: 'abc123',
    story: 'As a person, I want to cancel my booking.',
    criteria: [{ given: 'my booking', when: 'I press Cancel', then: 'it is gone' }],
    ...(gates ? { gates } : {}),
  };
}

describe('the Reviewer is told the checks already ran', () => {
  it('gets the result and the commands, and is told not to run them', () => {
    const t = ticket({ checks: 'pass', checksText: '12 tests pass, test, lint OK', review: 'pending', proof: 'pending' });
    const p = P.reviewPrompt(meta, [], t, 1);
    expect(p).toContain('squad-kit already ran the project checks on this copy before your review (test: npm test; lint: npm run lint), and they pass: 12 tests pass, test, lint OK.');
    expect(p).toContain('Do not run them yourself');
    // The second round is told again, since the checks ran again after the fixes.
    expect(P.reviewPrompt(meta, [], t, 2)).toContain('they pass: 12 tests pass, test, lint OK');
  });

  it('says so when checks were skipped, or when the project has none', () => {
    const skipped = P.reviewPrompt(meta, [], ticket({ checks: 'skipped', checksText: 'test failed', review: 'pending', proof: 'pending' }), 1);
    expect(skipped).toContain('they did not pass: test failed. The person chose to go on anyway.');
    const none = P.reviewPrompt({ ...meta, commands: {} }, [], ticket({ checks: 'pass', checksText: 'No checks set up yet', review: 'pending', proof: 'pending' }), 1);
    expect(none).toContain('no test, lint or build commands set up yet, so squad-kit had no checks to run');
  });
});

describe('roles that only read are told how to look around', () => {
  it('every read-only prompt names the read, find and search tools and the simple shell commands', () => {
    const t = ticket();
    const change = { id: 'C1', ask: 'Five a day, not three', from: 'analyst', status: 'writing', at: '' } as unknown as Parameters<typeof P.changePrompt>[3];
    const prompts = {
      scan: P.scanPrompt(meta, []),
      blueprint: P.blueprintPrompt(meta, [], []),
      tech: P.techDecisionPrompt([], 'Vitest'),
      intake: P.intakePrompt(meta, [], t),
      review: P.reviewPrompt(meta, [], t, 1),
      draft: P.draftPrompt(meta, 'make login screen', []),
      beside: P.besidePrompt(meta, [], t, 'analyst', false),
      change: P.changePrompt(meta, [], t, change, []),
    };
    for (const [name, p] of Object.entries(prompts)) {
      expect(p, name).toContain('use your tools for reading a file, finding files by name and searching inside files');
      expect(p, name).toContain('In the shell only simple read commands work (like cat, ls, grep');
      expect(p, name).toContain('anything else is refused');
      // The core prompts stay tool-neutral: no product names.
      expect(p, name).not.toMatch(/Claude|Cursor|Codex/);
    }
    expect(P.chatPrompt('builder', 'Why did you pick this?', 'next')).toContain('in the shell only simple read commands work');
    // The Builder may run anything it needs.
    expect(P.buildPrompt(meta, [], t)).not.toContain('only simple read commands');
  });
});
