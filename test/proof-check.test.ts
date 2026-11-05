import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import type { BrowserModule } from '../src/modules/browser/types.js';
import { pngBytes } from './support/png.js';
import { tinyApp } from './support/tiny-app.js';
import { fakeBrowser } from './fakes/browser.js';
import { callTool, savedFiles } from './support/window.js';
import { checkAnswer, isProofCheck, type FakeCheck } from './support/proof-check.js';

/**
 * Proof is verified (E5): every screenshot is a real image of a sensible size, not blank, and the "after" is not the
 * same picture as the "before". A picture that fails goes back to the Tester once, with why; then the proof stops with
 * the reasons. The Tester here is a fake that takes its pictures with squad-kit's own tools, over the run's window;
 * squad-kit's browser is a fake whose pictures the test gives.
 */

type Answer = { shots: { criterion: number; file: string; shows: 'met' | 'broken' | 'not-shown'; note: string }[]; offScreen: { criterion: number; why: string }[] };
let tester: (opts: RunOptions, round: number) => Answer | Promise<Answer> = () => ({ shots: [], offScreen: [] });
/** What squad-kit's own check of the pictures says, by "done when" number: each one met unless it is named here. */
let checks: Record<number, FakeCheck> = {};
const calls: RunOptions[] = [];
const h = vi.hoisted(() => ({ browser: null as BrowserModule | null }));
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    const round = calls.filter((c) => c.schema === opts.schema).length;
    return { ok: true, structured: isProofCheck(opts) ? checkAnswer(opts, checks) : await tester(opts, round), text: '', sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));
vi.mock('../src/modules/registry.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/registry.js')>()),
  shotBrowser: () => h.browser!,
}));

/** The fake Tester presses take_screenshots for a page of the app and gets back the file squad-kit saved. */
async function take(opts: RunOptions, page = '/'): Promise<string> {
  const [file] = savedFiles(await callTool(opts.window!, 'take_screenshots', { shots: [{ page }] }));
  return file!;
}

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
  tester = () => ({ shots: [], offScreen: [] });
  checks = {};
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
  /** The picture squad-kit's browser saves of "/", by the Tester's round (1, 2). */
  let picture: (round: number) => Buffer | string | null;
  let round = 0;

  beforeEach(async () => {
    bp = boardPaths(path.join(tmp, '.squad'));
    seedDemoBoard(bp, { speed: 50 });
    for (const t of listTickets(bp)) removeTicket(bp, t.id);
    // A tiny real app squad-kit starts; its pages are drawn by the fake browser.
    const app = await tinyApp();
    writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', scan: { status: 'done' }, commands: { start: app.start, url: app.url } });
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
    picture = () => pngBytes();
    h.browser = fakeBrowser({
      '/': { picture: () => picture(round) },
      '/b': { picture: (s) => pngBytes(s.width, s.height, () => [0, 0, 0]) },
    }).module;
  });

  const save = (name: string, bytes: Buffer) => fs.writeFileSync(path.join(bp.proofDir, name), bytes);
  /** Each round, the Tester takes one picture of "/" and hands it in for "done when" 1. */
  const oneShot = () => {
    tester = async (opts, n) => {
      round = n;
      return { shots: [{ criterion: 1, file: await take(opts), shows: 'met', note: 'The fourth booking is refused.' }], offScreen: [] };
    };
  };
  const file = (n: number) => `${id.toLowerCase()}-after-${n}.png`;

  it('a blank picture goes back to the Tester once, with why; still blank, the proof stops with the reason', async () => {
    picture = () => pngBytes(1280, 800, () => [255, 255, 255]);
    oneShot();
    await (new LiveSquad(bp) as unknown as Squad).proof(id);
    const runs = calls.filter((c) => c.schema === P.PROOF_SCHEMA);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.prompt).toContain('squad-kit checked your last screenshots and some do not prove anything yet:');
    expect(runs[1]!.prompt).toContain(`- The after screenshot for "It is refused" (${file(1)}): it is blank: one color and nothing on it.`);
    const t = readTicket(bp, id)!;
    expect(t.waiting?.kind).toBe('stuck');
    expect(t.gates?.proof).toBe('fail');
    expect(t.stuck).toMatchObject({ gate: 'proof', kind: 'bad-proof', points: [`The after screenshot for "It is refused" (${file(2)}): it is blank: one color and nothing on it.`] });
    expect(withProblem(t).stuck!.title).toBe('The screenshots did not pass the check');
    expect(t.stuck!.options.map((o) => o.do)).toEqual(['retry', 'continue', 'plan']);
    // A blank picture is never shown as proof.
    expect(t.proof?.some((p) => p.after)).toBeFalsy();
    // Continue anyway: you check the work without that proof, on the record.
    const went = actions.decideStuck(bp, id, 1, { reason: 'The page is right, I looked myself' });
    expect(went.waiting?.kind).toBe('proof');
    expect(went.overrides?.[0]).toMatchObject({ gate: 'proof', reason: 'The page is right, I looked myself' });
  });

  it('a tiny picture and one that is no picture are each sent back; a good retake passes, with the page it was taken at', async () => {
    for (const [bad, why] of [
      ['tiny', 'it is only 60 by 40 pixels'],
      ['text', 'it is not a picture squad-kit can open'],
    ] as const) {
      calls.length = 0;
      updateTicket(bp, id, (x) => {
        x.proof = undefined;
        x.waiting = null;
        x.stuck = undefined;
      });
      for (const f of fs.readdirSync(bp.proofDir)) fs.rmSync(path.join(bp.proofDir, f));
      picture = (n) => (n > 1 ? pngBytes() : bad === 'tiny' ? pngBytes(60, 40) : 'png');
      oneShot();
      await (new LiveSquad(bp) as unknown as Squad).proof(id);
      const runs = calls.filter((c) => c.schema === P.PROOF_SCHEMA);
      expect(runs[1]!.prompt, bad).toContain(`(${file(1)}): ${why}.`);
      const t = readTicket(bp, id)!;
      expect(t.waiting?.kind, bad).toBe('proof');
      expect(t.gates?.proof).toBe('pass');
      // The retake has a name of its own, never the rejected picture's.
      expect(t.proof).toEqual([expect.objectContaining({ criterion: 'It is refused', after: file(2), page: '/', note: 'The fourth booking is refused.' })]);
      expect(t.activity.some((a) => a.text.startsWith("The screenshots did not pass squad-kit's check, so the Tester takes them again"))).toBe(true);
    }
  });

  it('an after that is the same as the before does not show the change: sent back, then a real change passes', async () => {
    save('before-1.png', demo('sk139-before.png'));
    updateTicket(bp, id, (x) => (x.proof = [{ criterion: 'It is refused', before: 'before-1.png', after: '', beforeLabel: 'Before', afterLabel: 'After' }]));
    picture = (n) => (n === 1 ? demo('sk139-before.png') : demo('sk139-after.png'));
    oneShot();
    await (new LiveSquad(bp) as unknown as Squad).proof(id);
    const runs = calls.filter((c) => c.schema === P.PROOF_SCHEMA);
    expect(runs[1]!.prompt).toContain('The after screenshot for "done when" 1 ("It is refused") does not show it clearly yet: The after screenshot is the same as the before one, so it does not show the change.');
    // squad-kit's check was told the two pictures are the very same.
    expect(calls.filter(isProofCheck)[0]!.prompt).toContain('This picture is the very same as the one from before the change.');
    const t = readTicket(bp, id)!;
    expect(t.waiting?.kind).toBe('proof');
    expect(t.proof).toEqual([expect.objectContaining({ before: 'before-1.png', after: file(2), beforeLabel: 'Before', shows: 'met' })]);
  });

  it('the same after after every retake: a plain stop, showing both pictures so you can see why, and no Builder', async () => {
    save('before-1.png', demo('sk139-before.png'));
    updateTicket(bp, id, (x) => (x.proof = [{ criterion: 'It is refused', before: 'before-1.png', after: '', beforeLabel: 'Before', afterLabel: 'After' }]));
    picture = () => demo('sk139-before.png');
    oneShot();
    await (new LiveSquad(bp) as unknown as Squad).proof(id);
    const t = readTicket(bp, id)!;
    expect(t.stuck).toMatchObject({
      kind: 'not-shown',
      question: 'The squad could not show "done when" 1 on a screen. Try it yourself, or ask a question.',
      points: ['"Done when" 1, It is refused: The after screenshot is the same as the before one, so it does not show the change.'],
    });
    expect(t.proof?.[0]).toMatchObject({ before: 'before-1.png', after: file(3), shows: 'not-shown' });
    expect(calls.filter((c) => c.schema === P.BUILD_SCHEMA)).toHaveLength(0);
  });

  it('RO-15: a "done when" that says the screen stays as it was passes on the same picture, and only for it is that proof', async () => {
    save('before-1.png', demo('sk139-before.png'));
    updateTicket(bp, id, (x) => {
      x.criteria = [{ given: 'a laptop', when: 'I open the day view', then: 'the day view looks the same as before' }];
      x.proof = [{ criterion: 'The day view looks the same as before', before: 'before-1.png', after: '', beforeLabel: 'Before', afterLabel: 'After' }];
    });
    picture = () => demo('sk139-before.png');
    // It is the check that says so: the words of the "done when" alone decide nothing.
    checks = { 1: ['met', 'The day view is as it was.', { noChange: true }] };
    oneShot();
    await (new LiveSquad(bp) as unknown as Squad).proof(id);
    const t = readTicket(bp, id)!;
    expect(calls.filter((c) => c.schema === P.PROOF_SCHEMA)).toHaveLength(1);
    expect(t.gates?.proof).toBe('pass');
    expect(t.proof?.[0]).toMatchObject({ before: 'before-1.png', after: file(1), shows: 'met' });
    expect(calls.filter(isProofCheck)[0]!.prompt).toContain('looks the same as before, unchanged, as');
  });

  it('a no-change "done when" the check sees is broken still goes to the Builder, with what the picture shows', async () => {
    save('before-1.png', demo('sk139-before.png'));
    updateTicket(bp, id, (x) => {
      x.criteria = [{ given: 'a laptop', when: 'I open the day view', then: 'the day view looks the same as before' }];
      x.proof = [{ criterion: 'The day view looks the same as before', before: 'before-1.png', after: '', beforeLabel: 'Before', afterLabel: 'After' }];
    });
    picture = () => demo('sk139-before.png');
    checks = { 1: ['broken', 'The day view shows an error page.', { noChange: true }] };
    oneShot();
    const shoot = tester;
    tester = (opts, n) => (opts.schema === P.BUILD_SCHEMA ? ({ summary: 'Fixed it' } as unknown as Answer) : shoot(opts, n));
    await (new LiveSquad(bp) as unknown as Squad).proof(id);
    expect(calls.filter((c) => c.schema === P.BUILD_SCHEMA)[0]!.prompt).toContain('The day view shows an error page.');
  });

  it('a retake that leaves out the bad picture still counts against the proof', async () => {
    updateTicket(bp, id, (x) => {
      x.criteria = [...x.criteria!, { given: 'a refused booking', when: 'the clerk looks', then: 'the clerk sees why' }];
      x.work = { steps: 1, tests: 1, screens: 2 };
    });
    tester = async (opts, n) => {
      if (n > 1) return { shots: [], offScreen: [] };
      return {
        shots: [
          { criterion: 1, file: await take(opts, '/'), shows: 'met', note: 'Refused.' },
          { criterion: 2, file: await take(opts, '/b'), shows: 'met', note: 'Why.' },
        ],
        offScreen: [],
      };
    };
    await (new LiveSquad(bp) as unknown as Squad).proof(id);
    const t = readTicket(bp, id)!;
    expect(t.stuck?.points).toEqual([`The after screenshot for "The clerk sees why" (${file(2)}): it is blank: one color and nothing on it.`]);
    // The good one stays.
    expect(t.proof?.find((p) => p.criterion === 'It is refused')).toMatchObject({ after: file(1), page: '/' });
  });
});
