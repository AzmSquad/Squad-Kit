import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { KindsHost } from '../src/engine/proof-kinds/flow.js';

/**
 * At the proof, a Test line squad-kit could not prove is on the same card as the pictures that are not shown yet: the
 * person sees it before pressing Continue anyway, and it never passes unseen. The live squad runs with its picture
 * steps and its host stubbed: only the proof step's own decisions are real.
 */

const { boardPaths, readMeta, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-kinds-stops-')));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', commands: { start: 'npm run dev', url: 'http://localhost:3000', test: 'npm test' } });
  fs.mkdirSync(path.join(tmp, 'copy', 'tests'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'copy', 'tests', 'slot.test.ts'), "it('frees an unpaid slot', () => {});\n");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('a Test line squad-kit could not prove', () => {
  it('is listed on the card with the pictures not shown yet', async () => {
    const t = actions.createTicket(bp, { title: 'Pay by card', ask: 'Customers pay by card.' });
    updateTicket(bp, t.id, (x) => {
      x.stage = 'review';
      x.criteria = [
        { given: 'I pay', when: 'by card', then: 'I see Paid', proof: { kind: 'screen', locked: true } },
        { given: 'a booking', when: 'it is not paid in 15 minutes', then: 'the slot is freed', proof: { kind: 'test' } },
      ];
      x.proof = [{ criterion: 'I see Paid', before: 'a.png', after: 'b.png', beforeLabel: 'Before', afterLabel: 'After' }];
      x.gates = { checks: 'pass', review: 'pass', proof: 'pending' };
    });
    const squad = new LiveSquad(bp) as unknown as Record<string, unknown> & { proofOnce(id: string): Promise<void> };
    squad.screens = async () => ({ problems: [], planned: [1], said: '', stuck: [], sizes: {} });
    squad.judge = async () => ({ broken: [], notShown: [{ criterion: 1, text: 'I see Paid', why: 'The picture shows the page before paying.' }], offScreen: [] });
    // squad-kit cannot prove the test: here its tool is not even in the copy.
    squad.kindsHost = (id: string): KindsHost => ({
      bp,
      id,
      dir: path.join(tmp, 'copy'),
      testCommand: 'npm test',
      update: (change) => updateTicket(bp, id, change),
      tester: async () => ({ tests: [{ criterion: 2, file: 'tests/slot.test.ts', name: 'frees an unpaid slot', steps: ['Frees the slot'] }] }),
      run: async () => ({ ok: true, output: ' Test Files  1 passed (1)\n      Tests  1 passed (1)', seconds: 1 }),
      onMain: async () => null,
      log: () => {},
    });
    await squad.proofOnce(t.id);
    const x = readTicket(bp, t.id)!;
    expect(x.waiting?.kind).toBe('stuck');
    expect(x.stuck?.points?.some((p) => p.includes('The picture shows the page before paying.'))).toBe(true);
    expect(x.stuck?.points?.some((p) => p.startsWith('"Done when" 2, The slot is freed:'))).toBe(true);
    expect(x.stuck?.options.map((o) => o.name)).toContain('Continue anyway');
  });
});
