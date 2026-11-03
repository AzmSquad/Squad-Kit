import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import { pngBytes } from './support/png.js';

/**
 * Proof is verified (E5): every screenshot is a real image of a sensible size, not blank, saved in this step, and the
 * "after" is not the same picture as the "before". A picture that fails goes back to the Tester once, with why; then
 * the proof stops with the reasons. The Tester here is a fake that saves the files the test gives it.
 */

let tester: (opts: RunOptions, round: number) => { shots: { criterion: number; file: string }[] } = () => ({ shots: [] });
const calls: RunOptions[] = [];
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    const round = calls.filter((c) => c.schema === opts.schema).length;
    return { ok: true, structured: tester(opts, round), text: '', sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

const { isBlank, readPicture, samePicture, shotProblem } = await import('../src/engine/proof-check.js');
const { boardPaths, listTickets, readMeta, readTicket, removeTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { withProblem } = await import('../src/board/problem.js');
const { LiveSquad } = await import('../src/engine/live.js');
const P = await import('../src/engine/prompts.js');

const DEMO = fileURLToPath(new URL('../templates/demo/proof/', import.meta.url));
const demo = (f: string) => fs.readFileSync(path.join(DEMO, f));

let tmp: string;
beforeEach(() => {
  calls.length = 0;
  tester = () => ({ shots: [] });
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-proof-check-')));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The same picture with other bytes: the PNG's data packed again at another level. */
function repacked(png: Buffer): Buffer {
  const at = png.indexOf('IDAT') - 4;
  const len = png.readUInt32BE(at);
  const data = deflateSync(inflateSync(png.subarray(at + 8, at + 8 + len)), { level: 1 });
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length);
  head.write('IDAT', 4, 'latin1');
  return Buffer.concat([png.subarray(0, at), head, data, Buffer.alloc(4), png.subarray(at + 12 + len)]);
}

describe('squad-kit reads the pictures itself', () => {
  it('reads a real screenshot pixel by pixel (palette PNG, filtered rows), and sees it is not blank', () => {
    const light = readPicture(demo('sk139-after.png'))!;
    expect(light).toMatchObject({ format: 'png', width: 1280, height: 800 });
    const dark = readPicture(demo('sk148-dark.png'))!;
    // The header: white on the light page, near black on the dark one.
    const at = (p: typeof light, x: number, y: number) => [...p.pixels!.subarray((y * p.width + x) * 4, (y * p.width + x) * 4 + 3)];
    expect(at(light, 600, 20).every((v) => v > 240)).toBe(true);
    expect(at(dark, 600, 20).every((v) => v < 40)).toBe(true);
    expect(isBlank(light)).toBe(false);
    expect(isBlank(readPicture(pngBytes())!)).toBe(false);
  });

  it('knows a blank picture, the same picture, and the size of a JPEG', () => {
    expect(isBlank(readPicture(pngBytes(400, 240, () => [255, 255, 255]))!)).toBe(true);
    expect(isBlank(readPicture(pngBytes(400, 240, (x, y) => (x === 5 && y === 5 ? [0, 0, 0] : [20, 20, 20])))!)).toBe(true);
    // sk148-light.png is a copy of sk139-before.png; the after is another picture.
    expect(samePicture(demo('sk139-before.png'), demo('sk148-light.png'))).toBe(true);
    expect(samePicture(demo('sk139-before.png'), demo('sk139-after.png'))).toBe(false);
    // Other bytes, the same pixels: still the same picture.
    const png = pngBytes();
    const again = repacked(png);
    expect(again.equals(png)).toBe(false);
    expect(samePicture(png, again)).toBe(true);
    expect(samePicture(png, pngBytes(400, 240, undefined, 1))).toBe(false);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x20, 0x05, 0x00, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(readPicture(jpeg)).toEqual({ format: 'jpeg', width: 1280, height: 800 });
    expect(readPicture(Buffer.from('not a picture'))).toBeNull();
  });

  it('says in plain words what is wrong with each screenshot', () => {
    const since = Date.now();
    const file = (name: string, bytes: Buffer | string) => {
      const p = path.join(tmp, name);
      fs.writeFileSync(p, bytes);
      return p;
    };
    expect(shotProblem(path.join(tmp, 'gone.png'), since)).toBe('the file is missing');
    expect(shotProblem(file('empty.png', ''), since)).toBe('the file is empty');
    expect(shotProblem(file('text.png', 'png'), since)).toBe('it is not a picture squad-kit can open');
    expect(shotProblem(file('tiny.png', pngBytes(60, 40)), since)).toBe('it is only 60 by 40 pixels');
    expect(shotProblem(file('blank.png', pngBytes(1280, 800, () => [255, 255, 255])), since)).toBe('it is blank: one color and nothing on it');
    const old = file('old.png', pngBytes());
    fs.utimesSync(old, new Date(since - 3_600_000), new Date(since - 3_600_000));
    expect(shotProblem(old, since)).toBe('it was saved before this step started, so it is not a new screenshot');
    expect(shotProblem(file('good.png', pngBytes()), since)).toBeNull();
  });
});

describe('the live proof step checks every screenshot', () => {
  type Squad = { proof(id: string): Promise<void> };
  let bp: ReturnType<typeof boardPaths>;
  let id: string;

  beforeEach(() => {
    bp = boardPaths(path.join(tmp, '.squad'));
    seedDemoBoard(bp, { speed: 50 });
    for (const t of listTickets(bp)) removeTicket(bp, t.id);
    // An app that cannot start: the Tester still runs (it sees why), and no real browser is needed.
    writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', scan: { status: 'done' }, commands: { start: 'exit 3', url: 'http://127.0.0.1:47395' } });
    const wt = path.join(tmp, 'copy');
    fs.mkdirSync(wt);
    fs.mkdirSync(bp.proofDir, { recursive: true });
    const t0 = actions.createTicket(bp, { title: 'Refuse the fourth booking' });
    id = t0.id;
    updateTicket(bp, id, (x) => {
      x.stage = 'review';
      x.live = true;
      x.squad = null;
      x.worktree = wt;
      x.sessions = { tester: 't-1' };
      x.criteria = [{ given: 'a person with 3 bookings', when: 'they book again', then: 'it is refused' }];
      x.work = { steps: 1, tests: 1, screens: 1 };
      x.gates = { checks: 'pass', review: 'pass', proof: 'pending' };
    });
  });

  const save = (name: string, bytes: Buffer) => fs.writeFileSync(path.join(bp.proofDir, name), bytes);

  it('a blank picture goes back to the Tester once, with why; still blank, the proof stops with the reason', async () => {
    tester = (_opts, round) => {
      save(`shot-${round}.png`, pngBytes(1280, 800, () => [255, 255, 255]));
      return { shots: [{ criterion: 1, file: `shot-${round}.png` }] };
    };
    await (new LiveSquad(bp) as unknown as Squad).proof(id);
    const runs = calls.filter((c) => c.schema === P.PROOF_SCHEMA);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.prompt).toContain('squad-kit checked your last screenshots and some do not prove anything yet:');
    expect(runs[1]!.prompt).toContain('- The after screenshot for "It is refused" (shot-1.png): it is blank: one color and nothing on it.');
    const t = readTicket(bp, id)!;
    expect(t.waiting?.kind).toBe('stuck');
    expect(t.gates?.proof).toBe('fail');
    expect(t.stuck).toMatchObject({ gate: 'proof', kind: 'bad-proof', points: ['The after screenshot for "It is refused" (shot-2.png): it is blank: one color and nothing on it.'] });
    expect(withProblem(t).stuck!.title).toBe('The screenshots did not pass the check');
    expect(t.stuck!.options.map((o) => o.do)).toEqual(['retry', 'continue', 'plan']);
    // A blank picture is never shown as proof.
    expect(t.proof?.some((p) => p.after)).toBeFalsy();
    // Continue anyway: you check the work without that proof, on the record.
    const went = actions.decideStuck(bp, id, 1, { reason: 'The page is right, I looked myself' });
    expect(went.waiting?.kind).toBe('proof');
    expect(went.overrides?.[0]).toMatchObject({ gate: 'proof', reason: 'The page is right, I looked myself' });
  });

  it('an old file, a tiny one and one that is no picture are each sent back; a good retake passes', async () => {
    for (const [bad, why] of [
      ['old', 'it was saved before this step started, so it is not a new screenshot'],
      ['tiny', 'it is only 60 by 40 pixels'],
      ['text', 'it is not a picture squad-kit can open'],
    ] as const) {
      calls.length = 0;
      updateTicket(bp, id, (x) => {
        x.proof = undefined;
        x.waiting = null;
        x.stuck = undefined;
      });
      tester = (_opts, round) => {
        const name = `${bad}-${round}.png`;
        if (round === 1) {
          save(name, bad === 'tiny' ? pngBytes(60, 40) : bad === 'text' ? Buffer.from('png') : pngBytes());
          if (bad === 'old') fs.utimesSync(path.join(bp.proofDir, name), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
        } else save(name, pngBytes());
        return { shots: [{ criterion: 1, file: name }] };
      };
      await (new LiveSquad(bp) as unknown as Squad).proof(id);
      const runs = calls.filter((c) => c.schema === P.PROOF_SCHEMA);
      expect(runs[1]!.prompt, bad).toContain(`(${bad}-1.png): ${why}.`);
      const t = readTicket(bp, id)!;
      expect(t.waiting?.kind, bad).toBe('proof');
      expect(t.gates?.proof).toBe('pass');
      expect(t.proof).toEqual([expect.objectContaining({ criterion: 'It is refused', after: `${bad}-2.png` })]);
      expect(t.activity.some((a) => a.text.startsWith("The screenshots did not pass squad-kit's check, so the Tester takes them again"))).toBe(true);
    }
  });

  it('an after that is the same as the before does not show the change: sent back, then a real change passes', async () => {
    save('before-1.png', demo('sk139-before.png'));
    updateTicket(bp, id, (x) => (x.proof = [{ criterion: 'It is refused', before: 'before-1.png', after: '', beforeLabel: 'Before', afterLabel: 'After' }]));
    tester = (_opts, round) => {
      save(`after-${round}.png`, round === 1 ? demo('sk148-light.png') : demo('sk139-after.png'));
      return { shots: [{ criterion: 1, file: `after-${round}.png` }] };
    };
    await (new LiveSquad(bp) as unknown as Squad).proof(id);
    const runs = calls.filter((c) => c.schema === P.PROOF_SCHEMA);
    expect(runs[1]!.prompt).toContain('- The after screenshot for "It is refused" is the same as the before one, so it does not show the change.');
    const t = readTicket(bp, id)!;
    expect(t.waiting?.kind).toBe('proof');
    expect(t.proof).toEqual([expect.objectContaining({ before: 'before-1.png', after: 'after-2.png', beforeLabel: 'Before' })]);
  });

  it('the same after again: the proof stops, showing both pictures so you can see why', async () => {
    save('before-1.png', demo('sk139-before.png'));
    updateTicket(bp, id, (x) => (x.proof = [{ criterion: 'It is refused', before: 'before-1.png', after: '', beforeLabel: 'Before', afterLabel: 'After' }]));
    tester = (_opts, round) => {
      save(`after-${round}.png`, demo('sk148-light.png'));
      return { shots: [{ criterion: 1, file: `after-${round}.png` }] };
    };
    await (new LiveSquad(bp) as unknown as Squad).proof(id);
    const t = readTicket(bp, id)!;
    expect(t.stuck).toMatchObject({ kind: 'bad-proof', points: ['The after screenshot for "It is refused" is the same as the before one, so it does not show the change.'] });
    expect(t.proof?.[0]).toMatchObject({ before: 'before-1.png', after: 'after-2.png' });
  });

  it('a retake that leaves out the bad picture still counts against the proof', async () => {
    updateTicket(bp, id, (x) => {
      x.criteria = [...x.criteria!, { given: 'a refused booking', when: 'the clerk looks', then: 'the clerk sees why' }];
      x.work = { steps: 1, tests: 1, screens: 2 };
    });
    tester = (_opts, round) => {
      if (round > 1) return { shots: [] };
      save('a-1.png', pngBytes());
      save('b-1.png', pngBytes(1280, 800, () => [0, 0, 0]));
      return { shots: [{ criterion: 1, file: 'a-1.png' }, { criterion: 2, file: 'b-1.png' }] };
    };
    await (new LiveSquad(bp) as unknown as Squad).proof(id);
    const t = readTicket(bp, id)!;
    expect(t.stuck?.points).toEqual(['The after screenshot for "The clerk sees why" (b-1.png): it is blank: one color and nothing on it.']);
    // The good one stays.
    expect(t.proof?.find((p) => p.criterion === 'It is refused')?.after).toBe('a-1.png');
  });
});
