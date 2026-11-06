import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { boardPaths, listDecisions, readMeta, readTicket, removeTicket, listTickets, updateTicket, writeMeta, type BoardPaths } from '../src/board/store.js';
import { seedDemoBoard } from '../src/board/demo.js';
import { ensureLiveBoard, setupProject } from '../src/engine/setup.js';
import { approveOverview, overviewView, readTalk, tellIdea, setupView } from '../src/board/first-run.js';
import { saveScan, readingNow, readStarted } from '../src/engine/onboard.js';
import { readIdea, readSaid } from '../src/engine/onboard-live.js';
import { readOverview } from '../src/board/overview.js';
import { designPrompt, intakePrompt, planPrompt, scanPrompt } from '../src/engine/prompts.js';
import { oldStop } from '../src/board/stale-stop.js';
import { createTicket } from '../src/board/actions.js';
import { projectApps } from '../src/board/apps.js';
import yaml from 'js-yaml';

/**
 * A project from an empty folder: the overview asks one plain question, "What do you want to build?". The answer goes to
 * the Architect's read. There is no made-up rule from an empty folder, no technical first story: the Architect picks the
 * technology itself when the first story is planned. And the small words around the first read, and old stops.
 */

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-new-project-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function emptyProject(): BoardPaths {
  const dir = path.join(tmp, 'new-idea');
  fs.mkdirSync(dir);
  setupProject(dir);
  return ensureLiveBoard(boardPaths(path.join(dir, '.squad')), 'new-idea').bp;
}

/** The answer the real run gave for a folder with only squad-kit's one-line README. */
const FROM_THE_RUN = {
  empty: true,
  summary: 'A brand-new project called case2-new that has no code yet, only a one-line README.',
  map: [{ area: 'Code', detail: 'None yet.' }, { area: 'Team setup', detail: 'Squad settings and notes are in .squad/. They only name the project and say TypeScript.' }],
  decisions: [{ title: 'TypeScript as main language', why: 'The settings say so.' }],
  commands: {},
  ideas: [
    { title: 'Describe what the project should do', why: 'The README has only a name.' },
    { title: 'Choose the tech stack and set up an empty app', why: 'Pick a language and a database.' },
    { title: 'Build one small working page with a test', why: 'Something real to try.' },
  ],
};

/** The setup's steps as the live squad leaves them: the read is over, so the overview waits for the person. */
function readDone(bp: BoardPaths, idea = ''): void {
  saveScan(bp, FROM_THE_RUN, [], undefined, idea);
  const m = readMeta(bp);
  for (const st of m.setup!.steps) {
    if (st.state !== 'skipped') st.state = 'done';
  }
  m.setup!.readyAt = new Date().toISOString();
  writeMeta(bp, m);
}

describe('the first read of an empty folder', () => {
  it('has no false "taken from your code" rule, no map and no first stories, as nobody said what to build yet', () => {
    const bp = emptyProject();
    readDone(bp);
    const v = overviewView(bp);
    expect(v.empty).toBe(true);
    expect(v.handover).toBe('ready');
    expect(v.rules).toEqual([]);
    expect(listDecisions(bp)).toEqual([]);
    expect(v.ideas).toEqual([]);
    expect(v.map).toEqual([]);
    expect(v.idea).toBeUndefined();
    expect(readMeta(bp).commands ?? {}).toEqual({});
  });

  it('a folder with only the README is empty, whatever the answer says', () => {
    const bp = emptyProject();
    saveScan(bp, { ...FROM_THE_RUN, empty: false }, []);
    expect(readMeta(bp).scan?.empty).toBe(true);
    expect(listDecisions(bp)).toEqual([]);
  });

  it('the Architect is told to leave it all empty, and that .squad says nothing about the project', () => {
    const bp = emptyProject();
    const p = scanPrompt(readMeta(bp), []);
    expect(p).toContain('leave map, decisions, commands, users, can, worth, parts, links and runs empty');
    expect(p).toContain("folder is squad-kit's own and says nothing about the project");
    expect(p).toContain('you pick it yourself when the');
    expect(p).not.toContain('give three ideas for how to start');
  });
});

describe('"What do you want to build?"', () => {
  it('goes to the Architect\'s read, as data, in the person\'s own language', () => {
    const bp = emptyProject();
    readDone(bp);
    const said = 'صفحة صغيرة يكتب فيها الموظفون أسماء الزوار';
    const v = tellIdea(bp, said);
    expect(v.ready).toBe(false);
    expect(readMeta(bp).scan?.status).toBe('pending');
    expect(readIdea(bp)).toBe(said);
    expect(readTalk(bp)).toMatchObject({ open: false, thinking: false, reread: true, idea: said });
    expect(readTalk(bp)!.messages.map((m) => m.text)).toEqual([said]);
    // It is not "what you got wrong".
    expect(readSaid(bp)).toContain(said);
    const p = scanPrompt(readMeta(bp), [], undefined, '', said);
    expect(p).toContain(`<data>\n${said}\n</data>`);
    expect(p).toContain('This project has no code yet. The person said what they want to build.');
    expect(p).toContain('in their language');
    expect(p).toContain('never about technology or setting things up');
    expect(p).not.toContain('the person said some of it was wrong');
  });

  it('then the overview has first stories for it, and none about technology', () => {
    const bp = emptyProject();
    readDone(bp);
    tellIdea(bp, 'A page where staff write down visitors');
    readDone(bp, 'A page where staff write down visitors');
    const v = overviewView(bp);
    expect(v.idea).toBe('A page where staff write down visitors');
    expect(v.ideas.map((i) => i.title)).toEqual(['Describe what the project should do', 'Build one small working page with a test']);
    expect(readOverview(bp).ideas.some((i) => /tech stack/i.test(i.title))).toBe(false);
    expect(v.rules).toEqual([]);
    // Looks right works as always.
    expect(approveOverview(bp).handover).toBe('approved');
  });

  it('needs words, and is only for a project with no code', () => {
    const bp = emptyProject();
    readDone(bp);
    expect(() => tellIdea(bp, '   ')).toThrow('Write what you want to build first.');
    writeMeta(bp, { ...readMeta(bp), scan: { status: 'done', empty: false } });
    expect(() => tellIdea(bp, 'A page')).toThrow(/has code already/);
  });

  it('no app card asks how to start an app while the Architect reads a folder that started empty', () => {
    const bp = emptyProject();
    readDone(bp);
    expect(projectApps(readMeta(bp))).toEqual([]);
    tellIdea(bp, 'A page where staff write down visitors');
    expect(readMeta(bp).scan?.status).toBe('pending');
    expect(projectApps(readMeta(bp))).toEqual([]);
    // Nor does the page show a project's cards meanwhile.
    expect(overviewView(bp)).toMatchObject({ empty: true, handover: 'reading' });
  });

  it('the terminal has it too', () => {
    const cli = fs.readFileSync(path.resolve(__dirname, '../src/cli.ts'), 'utf8');
    expect(cli).toContain("--build <what...>");
    const api = fs.readFileSync(path.resolve(__dirname, '../src/console/api/overview.ts'), 'utf8');
    expect(api).toContain("'/api/v1/overview/idea'");
  });
});

describe('the page', () => {
  const page = fs.readFileSync(path.resolve(__dirname, '../console-ui/src/pages/Overview.tsx'), 'utf8');

  it('asks the one question, with a box that takes Arabic, and has no Something is wrong there', () => {
    expect(page).toContain('<h2>What do you want to build?</h2>');
    const ask = page.slice(page.indexOf('function AskIdea'), page.indexOf('/** The handover:'));
    expect(ask).toContain('dir="auto"');
    expect(ask).toContain('/api/v1/overview/idea');
    expect(ask).not.toContain('Something is wrong');
    expect(page).toContain('Change what I said');
    expect(page).not.toContain('proposes the stack');
  });
});

describe('the Architect picks the technology with the first story', () => {
  const t = { id: 'CN-1', title: 'Visitor list', story: 'As staff, I want a list.', criteria: [{ given: 'a', when: 'b', then: 'c' }], questions: [], notes: [], activity: [] } as never;

  it('and saves it as a decision engineers can see, never asking the person', () => {
    const bp = emptyProject();
    saveScan(bp, FROM_THE_RUN, []);
    const meta = readMeta(bp);
    for (const p of [designPrompt(t, undefined, meta), planPrompt(t, undefined, meta)]) {
      expect(p).toContain('This project has no code yet, so this ticket picks its technology');
      expect(p).toContain('pick what installs with no compiler');
      expect(p).toContain('never ask the person');
      expect(p).toContain('so engineers can see it');
    }
    const intake = intakePrompt(meta, [], t);
    expect(intake).toContain('the Architect picks the technology itself');
    expect(intake).not.toContain('Must you use a technology the client chose?');
  });

  it('a project with code goes on as before', () => {
    const bp = emptyProject();
    const meta = { ...readMeta(bp), scan: { status: 'done' as const, empty: false } };
    expect(designPrompt(t, undefined, meta)).not.toContain('picks its technology');
    expect(intakePrompt(meta, [], t)).toContain('Must you use a technology the client chose?');
  });
});

describe('the words around the first read', () => {
  it('never "Read 1 of 98 files" or "Read all 1 files"', () => {
    const bp = emptyProject();
    readStarted(bp, { label: 'Claude Code', ready: true });
    readingNow(bp, 'Reading the code', 1, 'Reading README.md');
    let read = setupView(bp)!.steps.find((s) => s.id === 'read')!;
    expect(read.note).toBe('Reading the code · 1 file');
    expect(setupView(bp)!.reads).toEqual(['Reading README.md']);
    readingNow(bp, 'Reading the code', 9, 'Searching for "x"');
    read = setupView(bp)!.steps.find((s) => s.id === 'read')!;
    expect(read.note).toBe('Reading the code · 9 files');

    const m = readMeta(bp);
    m.setup!.proof = { ...m.setup!.proof, files: 1, read: 1 };
    writeMeta(bp, m);
    saveScan(bp, FROM_THE_RUN, []);
    expect(setupView(bp)!.steps.find((s) => s.id === 'read')!.note).toBe('Read the project: 1 file');
  });

  it('98 files, one opened by name: it says what it read, not what it counted', () => {
    const dir = path.join(tmp, 'many');
    fs.mkdirSync(dir);
    for (let i = 0; i < 98; i += 1) fs.writeFileSync(path.join(dir, `f${i}.ts`), '');
    execSync('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm start', { cwd: dir });
    setupProject(dir);
    const bp = ensureLiveBoard(boardPaths(path.join(dir, '.squad')), 'many').bp;
    readStarted(bp, { label: 'Claude Code', ready: true });
    readingNow(bp, 'Reading the code', 1);
    saveScan(bp, { empty: false, summary: 'An app', map: [], decisions: [], commands: {} }, []);
    expect(setupView(bp)!.steps.find((s) => s.id === 'read')!.note).toBe('Read the project: 98 files');
  });
});

describe('old records', () => {
  const OLD = {
    gate: 'proof' as const,
    question: "The Tester could not take the screenshots. The browser was blocked: Chromium's Mach port setup is denied in this sandbox.",
    options: [{ do: 'retry' as const, name: 'Try again', note: '' }],
  };

  function demoBoard(): BoardPaths {
    const bp = boardPaths(path.join(tmp, '.squad'));
    seedDemoBoard(bp, { speed: 50 });
    for (const t of listTickets(bp)) removeTicket(bp, t.id);
    return bp;
  }

  it('RO-6: a merged ticket never shows its old technical stop, and the next save drops it from the file', () => {
    const bp = demoBoard();
    const { id } = createTicket(bp, { title: 'Rooms show a floor and equipment', ask: 'Show them.' });
    updateTicket(bp, id, (x) => {
      x.stage = 'release';
      x.mergedAt = '2026-11-04T19:08:44.189Z';
      x.status = 'Merged into main · goes out in v0.1.0';
      x.waiting = null;
    });
    // The record as RO-6 has it: from before the fixes.
    const state = path.join(bp.stateDir, `${id}.yaml`);
    fs.appendFileSync(state, yaml.dump({ stuck: OLD }));
    fs.utimesSync(state, new Date(), new Date(Date.now() + 2000));
    expect(fs.readFileSync(state, 'utf8')).toContain('Mach port');

    const t = readTicket(bp, id)!;
    expect(t.stuck).toBeUndefined();
    expect(t.waiting).toBeNull();
    expect(t.stage).toBe('release');
    // The file still has it until the ticket is next saved, and then it is gone.
    expect(fs.readFileSync(state, 'utf8')).toContain('Mach port');
    updateTicket(bp, id, (x) => (x.status = 'Merged into main · goes out in v0.1.0'));
    expect(fs.readFileSync(state, 'utf8')).not.toContain('Mach port');
    expect(readTicket(bp, id)!.stuck).toBeUndefined();
  });

  it('the rule, for every stage past review', () => {
    expect(oldStop({ stuck: OLD, stage: 'release', mergedAt: '2026-11-04', waiting: null })).toBe(true);
    expect(oldStop({ stuck: OLD, stage: 'done', waiting: null })).toBe(true);
    expect(oldStop({ stuck: OLD, stage: 'release', waiting: null })).toBe(true);
    expect(oldStop({ stuck: OLD, stage: 'release', waiting: { kind: 'stuck', summary: 'x' } })).toBe(true);
    // A real stop on an accepted ticket that is not merged yet: the pull request did not open.
    expect(oldStop({ stuck: { question: 'The push did not work.', options: [] }, stage: 'release', waiting: { kind: 'stuck', summary: 'x' } })).toBe(false);
    // Not past review yet.
    expect(oldStop({ stuck: OLD, stage: 'review', waiting: { kind: 'stuck', summary: 'x' } })).toBe(false);
    expect(oldStop({ stuck: undefined, stage: 'done', waiting: null })).toBe(false);
  });
});
