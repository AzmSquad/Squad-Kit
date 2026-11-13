import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import { codeAt } from './support/code-at.js';

/**
 * A change outside the plan is not hidden in the Activity tab. The Reviewer names it, squad-kit keeps it on the ticket
 * as a small list, and the person sees it at their check, on the proof page, on a stop, on the ticket and in the release
 * note. It never blocks. The AI tool is a fake that answers at once.
 */

const answers: unknown[] = [];
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => ({ ok: true, structured: answers.shift() ?? { summary: 'Fixed' }, text: '', sessionId: opts.resume ?? opts.sessionId ?? 's-1' }) as RunResult,
}));

const { boardPaths, listTickets, readMeta, readTicket, removeTicket, ticketDir, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { alsoChangedLine, cleanAlsoChanged } = await import('../src/board/also-changed.js');
const P = await import('../src/engine/prompts.js');

type Squad = { review(id: string): Promise<void> };

let tmp: string;
let bp: ReturnType<typeof boardPaths>;

beforeEach(() => {
  answers.length = 0;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-also-')));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  for (const t of listTickets(bp)) removeTicket(bp, t.id);
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', scan: { status: 'done' }, commands: {}, blueprint: undefined, impactChecks: [], techDrafts: [] });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const squad = () => new LiveSquad(bp) as unknown as Squad;

function inReview(title = 'Need help link'): string {
  const t = actions.createTicket(bp, { title, ask: 'A help link on sign-up.' });
  updateTicket(bp, t.id, (x) => {
    x.squad = null;
    x.worktree = tmp;
    x.baseCommit = 'abc';
    x.stage = 'review';
    x.sessions = { review: 'r1', build: 'b1' };
    x.story = 'As an owner, I want a help link.';
    x.gates = { checks: 'pass', review: 'pending', proof: 'pending' };
  });
  return t.id;
}

describe('the Reviewer names what the plan did not include', () => {
  it('is asked for it, in plain words, and it does not block', () => {
    const prompt = P.reviewPrompt(readMeta(bp), [], readTicket(bp, inReview())!, 1);
    expect(prompt).toContain('alsoChanged: each thing this change touches that the story, its "done when" and the plan did not ask for');
    expect(prompt).toContain('It does not block');
    expect((P.REVIEW_SCHEMA.properties as Record<string, unknown>).alsoChanged).toBeTruthy();
    expect(P.REVIEW_SCHEMA.required).not.toContain('alsoChanged');
  });

  it('an approval keeps it on the ticket, and the story goes on to the proof', async () => {
    const id = inReview();
    answers.push({ approved: true, summary: 'Looks good', comments: [], alsoChanged: ['the Services screen', '  ', 'the Services screen.'] });
    await squad().review(id);
    const t = readTicket(bp, id)!;
    expect(t.alsoChanged).toEqual(['the Services screen']);
    expect(t.gates?.review).toBe('pass');
    expect(t.squad?.phase).toBe('proof');
    expect(t.activity.map((a) => a.text)).toContain('Also changed, not in the plan: the Services screen.');
  });

  it('review notes keep it too, and the stop after the last round has it', async () => {
    const id = inReview();
    updateTicket(bp, id, (x) => (x.reviewRound = 1));
    answers.push({ approved: false, summary: 'Not yet', comments: ['Count cancelled bookings too.'], alsoChanged: ['the Services screen'] });
    await squad().review(id);
    const t = readTicket(bp, id)!;
    expect(t.stuck?.gate).toBe('review');
    expect(t.alsoChanged).toEqual(['the Services screen']);
  });

  it('each round reads the whole change, so the last one says: a change that went is gone from the list', async () => {
    const id = inReview();
    answers.push({ approved: true, summary: 'Good', comments: [], alsoChanged: ['the Services screen'] });
    await squad().review(id);
    expect(readTicket(bp, id)!.alsoChanged).toEqual(['the Services screen']);
    answers.push({ approved: true, summary: 'Good', comments: [], alsoChanged: ['the price list', 'the footer'] });
    await squad().review(id);
    expect(readTicket(bp, id)!.alsoChanged).toEqual(['the price list', 'the footer']);
    answers.push({ approved: true, summary: 'Good', comments: [] });
    await squad().review(id);
    expect(readTicket(bp, id)!.alsoChanged).toBeUndefined();
  });

  it('a plain, short list: only words, cut to size, a few at most', () => {
    expect(cleanAlsoChanged(undefined)).toEqual([]);
    expect(cleanAlsoChanged('the Services screen')).toEqual([]);
    expect(cleanAlsoChanged(['a', 3, null, ' b. ', 'a'])).toEqual(['a', 'b']);
    expect(cleanAlsoChanged(['1', '2', '3', '4', '5', '6', '7'])).toHaveLength(5);
    expect(cleanAlsoChanged(['x'.repeat(500)])[0]).toHaveLength(200);
    expect(alsoChangedLine(['the Services screen', 'the footer'])).toBe('Also changed, not in the plan: the Services screen; the footer.');
    expect(alsoChangedLine([])).toBe('');
    expect(alsoChangedLine(undefined)).toBe('');
  });

  it('is kept with the project, so a teammate and a restart see it', () => {
    const id = inReview();
    updateTicket(bp, id, (x) => (x.alsoChanged = ['the Services screen']));
    expect(readTicket(bp, id)!.alsoChanged).toEqual(['the Services screen']);
    expect(fs.readFileSync(path.join(ticketDir(bp, id), 'ticket.md'), 'utf8')).toContain('the Services screen');
  });
});

describe('where the person sees it', () => {
  const release = (tickets: string[]) => ({ version: 'v1.0.0', status: 'draft', from: 'v0.9.0', tickets, notes: '', addons: { changelog: true, tag: true, pipeline: false, whatsapp: false } }) as never;

  it('in the release note text, on the line of its own story', () => {
    const id = inReview();
    const other = inReview('Another');
    updateTicket(bp, id, (x) => {
      x.releaseNote = '**Help link on sign-up.** New owners can email support.';
      x.alsoChanged = ['the Services screen'];
    });
    updateTicket(bp, other, (x) => (x.releaseNote = '**Another.**'));
    const notes = actions.composeNotes(bp, release([id, other]));
    expect(notes).toContain('- **Help link on sign-up.** New owners can email support. Also changed, not in the plan: the Services screen.');
    expect(notes.split('\n')).toContain('- **Another.**');
  });

  it('on Builds by itself too: nobody checks it by hand, so the release note and the ticket keep it', () => {
    const id = inReview();
    updateTicket(bp, id, (x) => {
      x.track = 'auto';
      x.stage = 'release';
      x.mergedAt = new Date().toISOString();
      x.alsoChanged = ['the Services screen'];
    });
    expect(readTicket(bp, id)!.alsoChanged).toEqual(['the Services screen']);
    expect(actions.composeNotes(bp, release([id]))).toContain('Also changed, not in the plan: the Services screen.');
  });

  it('on the board, in plain words, and nothing when there is nothing to say', async () => {
    vi.stubGlobal('sessionStorage', { getItem: () => 'tok' });
    vi.stubGlobal('window', { location: { pathname: '/' } });
    // React lives with the board's own packages, and the root type check does not read its JSX.
    const board = (file: string) => import(/* @vite-ignore */ new URL(`../console-ui/${file}`, import.meta.url).pathname);
    const { renderToStaticMarkup } = await board('node_modules/react-dom/server.node.js');
    const { createElement } = await board('node_modules/react/index.js');
    const { AlsoChanged } = await board('src/components/Verdict.tsx');
    const html = renderToStaticMarkup(createElement(AlsoChanged, { t: { alsoChanged: ['the Services screen', 'the footer'] } }));
    expect(html).toContain('<b>Also changed, not in the plan:</b> the Services screen; the footer.');
    expect(renderToStaticMarkup(createElement(AlsoChanged, { t: {} }))).toBe('');
    vi.unstubAllGlobals();
  });

  it('every place shows it: the Your turn panel, the stops, the ticket and the proof page', () => {
    const read = (f: string) => fs.readFileSync(new URL(`../console-ui/src/${f}`, import.meta.url), 'utf8');
    const drawer = codeAt('console-ui/src/pages/TicketDrawer.tsx', 'console-ui/src/pages/drawer');
    // A panel ends where the next function, or the next file's imports, begin.
    const panel = (name: string) => {
      const from = drawer.indexOf(`function ${name}(`);
      const end = drawer.slice(from + 1).search(/\n(?:export )?function |\nimport /);
      return drawer.slice(from, end < 0 ? undefined : from + 1 + end);
    };
    for (const name of ['ProofPanel', 'WorkingPanel', 'ProofTab', 'NowPanel', 'AskPanel']) expect(panel(name), name).toContain('<AlsoChanged t={t}');
    expect(read('pages/Proof.tsx')).toContain('<AlsoChanged t={t}');
  });

  it('in the terminal, on squad show', async () => {
    const id = inReview();
    updateTicket(bp, id, (x) => (x.alsoChanged = ['the Services screen']));
    let said = '';
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((said += String(s)), true));
    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      const { runShow } = await import('../src/commands/board.js');
      await runShow(id);
    } finally {
      process.chdir(cwd);
      out.mockRestore();
    }
    expect(said).toContain('Also changed, not in the plan: the Services screen.');
  });
});
