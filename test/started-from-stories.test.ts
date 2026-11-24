import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardPaths, readMeta, updateTicket, writeMeta, type BoardPaths } from '../src/board/store.js';
import { ensureLiveBoard, setupProject } from '../src/engine/setup.js';
import { approveOverview, overviewView, setupAgain, setupLine, setupView, tellIdea } from '../src/board/first-run.js';
import { saveScan } from '../src/engine/onboard.js';
import { createTicket } from '../src/board/actions.js';
import { firstCodeMerged } from '../src/board/first-story.js';
import { runOverview } from '../src/commands/overview.js';

/**
 * A project with no code whose work started from stories, pulled from the tracker or written by hand, before anyone
 * answered "What do you want to build?". The Overview shows the stories, not the question, and nothing waits for the
 * person there. Real files; no AI runs.
 */

let tmp: string;
let dir: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-started-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function emptyProject(): BoardPaths {
  dir = path.join(tmp, 'new-app');
  fs.mkdirSync(dir);
  setupProject(dir);
  return ensureLiveBoard(boardPaths(path.join(dir, '.squad')), 'new-app').bp;
}

/** The setup as the live squad leaves it on an empty folder: every step over, the question waits. */
function readDone(bp: BoardPaths): void {
  saveScan(bp, { empty: true, summary: 'A planned phone app. No code exists yet.', map: [], decisions: [], commands: {}, ideas: [] }, []);
  const m = readMeta(bp);
  for (const st of m.setup!.steps) if (st.state !== 'skipped') st.state = 'done';
  // The note the live squad's last step saves (engine/onboard.ts).
  m.setup!.steps.find((x) => x.id === 'overview')!.note = 'One question for you: what do you want to build?';
  m.setup!.readyAt = new Date().toISOString();
  writeMeta(bp, m);
}

const fromAzure = (bp: BoardPaths, n: number, title: string) =>
  createTicket(bp, { title, ask: title, source: { type: 'azure', ref: `AB#${n}`, id: String(n), itemType: 'User Story' } });

describe('a project with no code, before any story', () => {
  it('asks the one question, and the Overview waits for the person', () => {
    const bp = emptyProject();
    readDone(bp);
    const v = overviewView(bp);
    expect(v).toMatchObject({ empty: true, handover: 'ready' });
    expect(v.stories).toBeUndefined();
    expect(setupView(bp)).toMatchObject({ ready: true, approved: false });
    expect(setupLine(setupView(bp)!)).toBe('One question for you: what do you want to build?');
  });
});

describe('the work started from stories', () => {
  it('a story from the tracker ends the question: the stories show, and nothing waits for the person', () => {
    const bp = emptyProject();
    readDone(bp);
    const t = fromAzure(bp, 101, 'Create the phone app');
    updateTicket(bp, t.id, (x) => {
      x.stage = 'test';
    });
    const v = overviewView(bp);
    expect(v.handover).toBe('approved');
    expect(v.empty).toBe(true);
    // Nobody approved anything: no "Momen approved this on…".
    expect(v.approved).toBeUndefined();
    expect(v.stories).toEqual({ from: 'Azure DevOps', open: [{ id: t.id, title: 'Create the phone app', stage: 'test' }] });
    // No badge on Overview, no "One question for you" card on the board or the projects page.
    const s = setupView(bp)!;
    expect(s).toMatchObject({ ready: true, approved: true, started: true });
    expect(setupLine(s)).toBe('Set up');
    expect(s.steps.find((x) => x.id === 'overview')?.note).toBe('The work started from your stories');
    // Nothing is written: it reads that way from the stories on the board.
    expect(readMeta(bp).setup?.approvedAt).toBeUndefined();
  });

  it('a ticket written by hand counts too, and the stories come oldest first without a tracker name', () => {
    const bp = emptyProject();
    readDone(bp);
    const a = createTicket(bp, { title: 'A page for visitors' });
    const b = createTicket(bp, { title: 'Today’s list' });
    updateTicket(bp, a.id, (x) => {
      x.createdAt = '2026-11-24T03:00:00.000Z';
    });
    updateTicket(bp, b.id, (x) => {
      x.createdAt = '2026-11-24T02:00:00.000Z';
    });
    const v = overviewView(bp);
    expect(v.handover).toBe('approved');
    expect(v.stories?.from).toBeUndefined();
    expect(v.stories?.open.map((x) => x.id)).toEqual([b.id, a.id]);
  });

  it('only open stories show: an archived one does not', () => {
    const bp = emptyProject();
    readDone(bp);
    const a = fromAzure(bp, 1, 'One');
    const b = fromAzure(bp, 2, 'Two');
    updateTicket(bp, a.id, (x) => {
      x.archived = { by: 'Momen', at: new Date().toISOString() };
    });
    expect(overviewView(bp).stories?.open.map((x) => x.id)).toEqual([b.id]);
  });

  it('a story archived or being deleted started nothing: the question comes back', () => {
    const bp = emptyProject();
    readDone(bp);
    const a = fromAzure(bp, 1, 'One');
    const b = fromAzure(bp, 2, 'Two');
    updateTicket(bp, a.id, (x) => {
      x.archived = { by: 'Momen', at: new Date().toISOString() };
    });
    updateTicket(bp, b.id, (x) => {
      x.deleting = { by: 'Momen', at: new Date().toISOString() };
    });
    expect(overviewView(bp)).toMatchObject({ handover: 'ready' });
    expect(overviewView(bp).stories).toBeUndefined();
    expect(setupView(bp)).toMatchObject({ approved: false });
  });

  it('"Read it again" after the stories started runs the setup again, then the stories show again', () => {
    const bp = emptyProject();
    readDone(bp);
    fromAzure(bp, 3, 'Three');
    setupAgain(bp, 'read');
    expect(overviewView(bp).handover).toBe('reading');
    readDone(bp);
    expect(overviewView(bp).handover).toBe('approved');
  });

  it('the person said what to build: the Architect\'s first stories still wait for their check', () => {
    const bp = emptyProject();
    readDone(bp);
    tellIdea(bp, 'A page where staff write down visitors');
    readDone(bp);
    fromAzure(bp, 7, 'Visitors');
    expect(overviewView(bp).handover).toBe('ready');
    expect(setupView(bp)).toMatchObject({ approved: false });
  });

  it('a project with code goes on as before: its read still waits for the check', () => {
    const bp = emptyProject();
    readDone(bp);
    writeMeta(bp, { ...readMeta(bp), scan: { ...readMeta(bp).scan!, empty: false } });
    fromAzure(bp, 9, 'Something');
    const v = overviewView(bp);
    expect(v.handover).toBe('ready');
    expect(v.stories).toBeUndefined();
  });

  it('the first merge keeps it over, still approved by nobody, once the project has code', () => {
    const bp = emptyProject();
    readDone(bp);
    const t = fromAzure(bp, 101, 'Create the project');
    firstCodeMerged(bp);
    const m = readMeta(bp);
    expect(m.scan?.empty).toBe(false);
    expect(m.setup).toMatchObject({ fromStories: true });
    expect(m.setup?.approvedAt).toBeTruthy();
    const v = overviewView(bp);
    expect(v.handover).toBe('approved');
    expect(v.approved).toBeUndefined();
    expect(v.stories).toBeUndefined();
    // The setup page never asks the old question again.
    const s = setupView(bp)!;
    expect(s).toMatchObject({ approved: true, started: true });
    expect(s.steps.find((x) => x.id === 'overview')?.note).toBe('The work started from your stories');
    expect(t.id).toBeTruthy();
    // Read again later: the setup is checked as on any project, and Looks right is the person's own.
    setupAgain(bp, 'read');
    expect(readMeta(bp).setup?.fromStories).toBeUndefined();
    readDone(bp);
    writeMeta(bp, { ...readMeta(bp), scan: { ...readMeta(bp).scan!, empty: false } });
    expect(overviewView(bp).handover).toBe('ready');
    expect(approveOverview(bp).approved?.by).toBe(readMeta(bp).user.name);
  });

  it('a first merge on a project that said what to build leaves its check to the person', () => {
    const bp = emptyProject();
    readDone(bp);
    tellIdea(bp, 'A page where staff write down visitors');
    readDone(bp);
    fromAzure(bp, 7, 'Visitors');
    firstCodeMerged(bp);
    expect(readMeta(bp).setup?.approvedAt).toBeUndefined();
  });

  it('the terminal shows the stories, not the question', async () => {
    const bp = emptyProject();
    readDone(bp);
    const t = fromAzure(bp, 101, 'Create the phone app');
    const cwd = process.cwd();
    const printed: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      printed.push(String(s));
      return true;
    });
    process.chdir(dir);
    try {
      await runOverview({});
    } finally {
      process.chdir(cwd);
      spy.mockRestore();
    }
    const text = printed.join('');
    expect(text).toContain('Your stories');
    expect(text).toContain('from Azure DevOps');
    expect(text).toContain(`${t.id}  Create the phone app`);
    expect(text).toContain(`The first code comes with ${t.id}`);
    expect(text).not.toContain('What do you want to build?');
    expect(bp.root).toBe(dir);
  });
});

describe('the page', () => {
  const page = fs.readFileSync(path.resolve(__dirname, '../console-ui/src/pages/Overview.tsx'), 'utf8');
  const card = fs.readFileSync(path.resolve(__dirname, '../console-ui/src/components/OverviewStories.tsx'), 'utf8');

  it('shows the stories in place of the ideas, with each one\'s stage and a way to it', () => {
    expect(page).toContain('<OverviewStories stories={v.stories}');
    expect(page).toContain('The first code comes with');
    expect(card).toContain('<h3>Your stories</h3>');
    expect(card).toContain('STAGE_NAME[t.stage]');
    expect(card).toContain('search={{ ticket: t.id }}');
    expect(card).toContain('Open the board');
  });
});
