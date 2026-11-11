import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import type { BrowserModule } from '../src/modules/browser/types.js';
import type { Found, FoundBook } from '../src/engine/tools/detect.js';
import { tinyApp } from './support/tiny-app.js';
import { fakeBrowser } from './fakes/browser.js';
import { callTool, savedFiles } from './support/window.js';
import { checkAnswer, isProofCheck } from './support/proof-check.js';

/**
 * A Flutter app's proof on a Mac without Xcode: with a web version, squad-kit takes pictures of it meanwhile, labels
 * them "Web version", and says so on the story in one plain line with the Tools page line. With no web version, there
 * are no pictures and the story stops for the person with the reason: it never takes its proof without pictures.
 */

type Answer = { shots: { criterion: number; file: string; shows: 'met'; note: string }[]; offScreen: never[] };
let tester: (opts: RunOptions) => Promise<Answer> = async () => ({ shots: [], offScreen: [] });
const calls: RunOptions[] = [];
const h = vi.hoisted(() => ({ browser: null as BrowserModule | null }));
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    return { ok: true, structured: isProofCheck(opts) ? checkAnswer(opts) : await tester(opts), text: '', sessionId: opts.resume ?? opts.sessionId ?? 't-1' } as RunResult;
  },
}));
vi.mock('../src/modules/registry.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/registry.js')>()),
  shotBrowser: () => h.browser!,
}));

const { boardPaths, listTickets, readMeta, readTicket, removeTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { writeFound } = await import('../src/engine/tools/detect.js');
const { useDetectHost } = await import('../src/engine/tools/index.js');
const { usePrecacheRunner } = await import('../src/engine/flutter-downloads.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;
let id: string;
let copy: string;
type Squad = { proof(id: string): Promise<void> };

const NO_XCODE: Record<string, Found> = {
  flutter: { state: 'found', version: '3.44.8', where: '/fl' },
  xcode: { state: 'missing' },
  simulator: { state: 'missing', note: 'It comes with Xcode.' },
  cocoapods: { state: 'found', version: '1.16.2' },
  java: { state: 'found', version: '21.0.5' },
  maestro: { state: 'found', version: '2.12.1', where: '/Users/pm/.local/bin/maestro' },
};

beforeEach(async () => {
  calls.length = 0;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-phone-proof-')));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  for (const t of listTickets(bp)) removeTicket(bp, t.id);
  copy = path.join(tmp, 'copy');
  // The story's copy holds a Flutter app for the iPhone and the web.
  fs.mkdirSync(path.join(copy, 'ios'), { recursive: true });
  fs.mkdirSync(path.join(copy, 'web'), { recursive: true });
  fs.writeFileSync(path.join(copy, 'pubspec.yaml'), 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
  // A Flutter app with iPhone and web folders: Flutter's own downloads never really run here.
  usePrecacheRunner(async () => ({ ok: true, output: '' }));
  writeFound({ at: new Date().toISOString(), system: 'mac', tools: NO_XCODE as FoundBook['tools'] });
  useDetectHost(null);
  const t0 = actions.createTicket(bp, { title: 'Sign up' });
  id = t0.id;
  updateTicket(bp, id, (x) => {
    x.stage = 'review';
    x.live = true;
    x.squad = null;
    x.worktree = copy;
    x.sessions = { tester: 't-1' };
    x.criteria = [{ given: 'Sara is new', when: 'she signs up', then: 'she sees Welcome Sara' }];
    x.work = { steps: 1, tests: 1, screens: 1 };
    x.gates = { checks: 'pass', review: 'pass', proof: 'pending' };
  });
  h.browser = fakeBrowser({ '/': { has: ['label:Name', 'button:Sign up'], opens: { 'button:Sign up': '/welcome' } } }).module;
});
afterEach(() => {
  useDetectHost(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ticket = () => readTicket(bp, id)!;

describe("a phone app's proof without the iPhone tools", () => {
  it('takes pictures of the web version meanwhile, labelled so, and says why in one plain line with the Tools page line', async () => {
    const app = await tinyApp();
    writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', scan: { status: 'done' }, commands: { start: app.start, url: app.url } });
    tester = async (opts) => {
      const [a] = savedFiles(await callTool(opts.window!, 'take_screenshots', { shots: [{ page: '/', steps: [{ action: 'click', target: { role: 'button', name: 'Sign up' } }], size: 'phone' }] }));
      return { shots: [{ criterion: 1, file: a!, shows: 'met', note: 'Sara sees her welcome.' }], offScreen: [] };
    };
    await (new LiveSquad(bp) as unknown as Squad).proof(id);
    const t = ticket();
    const line = 'iPhone pictures need Xcode. squad-kit took pictures of the web version meanwhile.';
    expect(t.activity.map((a) => a.text)).toContain(line);
    expect(t.picturesNote).toEqual({ text: line, link: '/tools#xcode' });
    expect(t.proof?.[0]).toMatchObject({ device: 'Web version', page: '/welcome' });
    expect(t.waiting?.kind).toBe('proof');
  });

  it('with no web version either: no pictures, and the story stops for the person with the reason, never merging unseen', async () => {
    writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', scan: { status: 'done' }, commands: {} });
    fs.rmSync(path.join(copy, 'web'), { recursive: true });
    await (new LiveSquad(bp) as unknown as Squad).proof(id);
    const t = ticket();
    expect(calls).toHaveLength(0);
    expect(t.gates?.proof).toBe('fail');
    expect(t.waiting?.kind).toBe('stuck');
    expect(t.stuck?.question).toBe("squad-kit can't take the phone pictures yet: Xcode and iPhone simulator aren't on this computer.");
    expect(t.stuck?.options.map((o) => o.do)).toContain('retry');
  });
});
