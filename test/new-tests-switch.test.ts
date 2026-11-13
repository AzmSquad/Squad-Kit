import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { Hono } from 'hono';
import type { Release, Ticket } from '../src/board/types.js';
import { codeAt } from './support/code-at.js';

/**
 * "Write new tests" on a new story: on by default, on any track. Off, the plan and the Builder add no tests and the
 * Reviewer asks for none, while squad-kit still runs the project's own checks, the review and the proof. The story says
 * "Built without new tests" on its card, its proof and the release notes. An engineer can keep it on for every story,
 * in the project's settings. Real git and real commands; no agent runs.
 */

const { boardPaths, listTickets, readMeta, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const actions = await import('../src/board/actions.js');
const P = await import('../src/engine/prompts.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { prDescription } = await import('../src/engine/review-record/pr-description.js');
const { harnessView } = await import('../src/engine/harness.js');
const { mountBoardApi } = await import('../src/console/api/board.js');
const { chooseProject } = await import('../src/core/paths.js');
const { runNew, runNewTests, runShow } = await import('../src/commands/board.js');
const { addWorktree } = await import('./support/copy.js');

const TEST = 'echo test >> runs.txt; echo "Tests  3 passed"';
const LINT = 'echo lint >> runs.txt; echo tidy';

let tmp: string;
let project: string;
let bp: ReturnType<typeof boardPaths>;
const get = (id: string) => readTicket(bp, id)!;
const lines = (id: string) => get(id).activity.map((a) => a.text);

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-new-tests-')));
  project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'rooms.txt'), 'two rooms\n');
  fs.writeFileSync(path.join(project, '.gitignore'), 'runs.txt\n');
  execSync('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm start', { cwd: project });
  bp = boardPaths(path.join(project, '.squad'));
  writeMeta(bp, {
    project: 'App',
    key: 'NT',
    nextNumber: 1,
    engine: 'live',
    runner: 'direct',
    user: { name: 'Momen', role: 'Project manager' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
    commands: { test: TEST, lint: LINT },
    git: { base: 'main', remote: '' },
    scan: { status: 'done', empty: false },
  });
});

afterEach(() => {
  chooseProject(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A story with its plan written, as the squad would have it before the build. */
function planned(noNewTests: boolean): Ticket {
  const t = actions.createTicket(bp, { title: 'Room colours', ask: 'Show free rooms in green.', track: 'express', ...(noNewTests ? { noNewTests: true } : {}) });
  return updateTicket(bp, t.id, (x) => {
    x.story = 'As a clerk, I want free rooms in green, so I see them at once.';
    x.criteria = [{ given: 'a free room', when: 'I open the rooms', then: 'it is green' }];
    x.steps = [{ title: 'Colour the free rooms', status: 'todo' }];
    x.baseCommit = 'abc123';
  });
}

describe('the switch off', () => {
  it('the plan, the design and the Builder add no tests, and the Reviewer asks for none; on, the words are as before', () => {
    const meta = readMeta(bp);
    const off = planned(true);
    const on = planned(false);
    expect(off.noNewTests).toBe(true);
    expect(on.noNewTests).toBeUndefined();
    expect(lines(off.id)).toContain("Chose to build it without new tests: the project's own checks, the review and the proof still run");

    for (const said of [P.planPrompt(off, undefined, meta), P.designPrompt(off, undefined, meta)]) {
      expect(said).toContain('The person chose to build this story without new tests, so no step writes tests.');
      expect(said).toContain('- tests: 0, as this story adds no tests.');
      expect(said).not.toContain('The last step writes the tests.');
    }
    for (const said of [P.planPrompt(on, undefined, meta), P.designPrompt(on, undefined, meta)]) {
      expect(said).toContain('The last step writes the tests.');
      expect(said).toContain('- tests: how many tests you expect to add.');
    }

    const build = P.buildPrompt(meta, [], off);
    expect(build).toContain('The person chose to build this story without new tests: write no new tests.');
    expect(build).toContain('Run the tests the project already has before you finish');
    expect(build).not.toContain('Write tests that check every "done when"');
    expect(P.buildPrompt(meta, [], on)).toContain('Write tests that check every "done when", and run the tests before you finish.');

    const review = P.reviewPrompt(meta, [], off, 1);
    expect(review).toContain('The person chose to build this story without new tests, so do not ask for new tests.');
    expect(review).not.toContain('missing tests');
    expect(review).not.toContain('a test that covers it');
    // Weakening the tests the project already has is still a real problem.
    expect(review).toContain('Were tests deleted, switched off or made weaker?');
    expect(P.reviewPrompt(meta, [], on, 1)).toContain('Real bugs, security holes, missing tests?');
    // No tests ran at all: the Reviewer is not asked to say tests are missing either.
    expect(P.reviewPrompt(meta, [], { ...off, gates: { checks: 'unchecked', review: 'pending', proof: 'pending' } }, 1)).not.toContain('tests are missing');

    expect(P.proofFixPrompt(['the room is grey'], false)).not.toContain('add or update a test');
    expect(P.proofFixPrompt(['the room is grey'])).toContain('add or update a test');
  });

  it("squad-kit still runs the project's own checks, and the label is on the pull request and the release notes", async () => {
    const t = planned(true);
    const wt = addWorktree(project, t.id, 'main');
    updateTicket(bp, t.id, (x) => {
      x.worktree = wt.dir;
      x.branch = wt.branch;
      x.baseCommit = wt.baseCommit;
      x.stage = 'implement';
      x.live = true;
      x.squad = null;
      x.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
    });
    fs.writeFileSync(path.join(wt.dir, 'rooms.txt'), 'two rooms, one free\n');
    await (new LiveSquad(bp) as unknown as { checks(id: string): Promise<void> }).checks(t.id);
    expect(fs.readFileSync(path.join(wt.dir, 'runs.txt'), 'utf8').trim().split('\n')).toEqual(['test', 'lint']);
    expect(get(t.id).gates).toMatchObject({ checks: 'pass', checksText: '3 tests pass, test, lint OK' });
    expect(get(t.id).squad?.phase).toBe('review');

    expect(prDescription(get(t.id), null, [])).toContain("- Built without new tests: the project's own checks ran, and this story added no tests");
    expect(prDescription(planned(false), null, [])).not.toContain('Built without new tests');
    const release = { version: 'v1.4.0', status: 'draft', from: 'v1.3.0', tickets: [t.id], notes: '' } as unknown as Release;
    expect(actions.composeNotes(bp, release)).toContain('- **Room colours.** _Built without new tests._');
  });
});

describe('the API, the terminal and the project setting', () => {
  const api = () => {
    const app = new Hono();
    mountBoardApi(app, { paths: { squadDir: bp.squadDir } as never });
    const call = (method: string, url: string, body: unknown) => app.request(url, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    return { post: (url: string, body: unknown) => call('POST', url, body), put: (url: string, body: unknown) => call('PUT', url, body) };
  };

  it('a story is made without new tests with one field, until an engineer keeps them on for every story', async () => {
    const { post, put } = api();
    let res = await post('/api/v1/tickets', { title: 'Room colours', noNewTests: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Ticket).noNewTests).toBe(true);
    res = await post('/api/v1/tickets', { title: 'Room names', noNewTests: 'yes' });
    expect(((await res.json()) as Ticket).noNewTests).toBeUndefined();
    expect(harnessView(readMeta(bp), bp).stages.flatMap((s) => s.gates).find((g) => g.id === 'new-tests')?.d).toContainEqual(['Here', 'Your choice on each new story, on by default']);

    // Kept in the project's own settings file, so the whole team gets it through git.
    res = await put('/api/v1/settings', { alwaysNewTests: true });
    expect(res.status).toBe(200);
    expect(fs.readFileSync(bp.configFile, 'utf8')).toMatch(/alwaysNewTests: true/);
    res = await post('/api/v1/tickets', { title: 'Room sizes', noNewTests: true });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(actions.NEW_TESTS_ALWAYS);
    expect((await post('/api/v1/tickets', { title: 'Room sizes' })).status).toBe(200);
    expect(harnessView(readMeta(bp), bp).stages.flatMap((s) => s.gates).find((g) => g.id === 'new-tests')?.d).toContainEqual(['Here', 'Always on: every story writes new tests']);

    res = await put('/api/v1/settings', { alwaysNewTests: false });
    expect(readMeta(bp).alwaysNewTests).toBeUndefined();
    expect(fs.readFileSync(bp.configFile, 'utf8')).not.toMatch(/alwaysNewTests/);
    expect((await post('/api/v1/tickets', { title: 'Room sizes', noNewTests: true })).status).toBe(200);
  });

  it('squad new --no-new-tests, squad show says so, and squad config set new-tests always or switch', async () => {
    chooseProject(project);
    let said = '';
    const quiet = [vi.spyOn(process.stdout, 'write').mockImplementation((x) => ((said += String(x)), true)), vi.spyOn(process.stderr, 'write').mockImplementation(() => true), vi.spyOn(console, 'log').mockImplementation((x) => void (said += `${String(x)}\n`))];
    try {
      await runNew(['Room colours'], { newTests: false });
      await runNew(['Room names'], {});
      const [colours, names] = listTickets(bp).sort((a, b) => a.id.localeCompare(b.id));
      expect(colours!.noNewTests).toBe(true);
      expect(names!.noNewTests).toBeUndefined();
      said = '';
      await runShow(colours!.id);
      expect(said).toContain('Built without new tests');

      await runNewTests('always');
      expect(readMeta(bp).alwaysNewTests).toBe(true);
      await expect(runNew(['Room sizes'], { newTests: false })).rejects.toThrow(actions.NEW_TESTS_ALWAYS);
      await expect(runNewTests('never')).rejects.toThrow('Use always');
      await runNewTests('switch');
      expect(readMeta(bp).alwaysNewTests).toBeUndefined();
    } finally {
      for (const q of quiet) q.mockRestore();
    }
  });
});

describe('on the board', () => {
  const read = (f: string) => fs.readFileSync(new URL(`../console-ui/src/${f}`, import.meta.url), 'utf8');

  it('the label, short on a card, and the second line of a long wait on the tracker', async () => {
    vi.stubGlobal('sessionStorage', { getItem: () => 'tok' });
    vi.stubGlobal('window', { location: { pathname: '/' } });
    try {
      // React lives with the board's own packages, and the root type check does not read its JSX.
      const board = (file: string) => import(/* @vite-ignore */ new URL(`../console-ui/${file}`, import.meta.url).pathname);
      const { renderToStaticMarkup } = await board('node_modules/react-dom/server.node.js');
      const { createElement } = await board('node_modules/react/index.js');
      const { NoNewTestsLabel, NoNewTestsTag } = await board('src/components/Gates.tsx');
      expect(renderToStaticMarkup(createElement(NoNewTestsLabel, { t: { noNewTests: true } }))).toMatch(/>Built without new tests<\/span>$/);
      expect(renderToStaticMarkup(createElement(NoNewTestsTag, { t: { noNewTests: true } }))).toMatch(/title="Built without new tests\. [^"]+">No new tests<\/span>$/);
      expect(renderToStaticMarkup(createElement(NoNewTestsLabel, { t: {} }))).toBe('');
      const { Tracker } = await board('src/components/ui.tsx');
      const now = { stages: [{ stage: 'tickets', note: '1 min' }, { stage: 'specs', note: '3 min, you approved', wait: 'waited 41 min for you' }, { stage: 'implement', note: 'now · 2 min' }] };
      const html = renderToStaticMarkup(createElement(Tracker, { ticket: { id: 'NT-1', stage: 'implement', waiting: null, now } }));
      expect(html).toContain('<span class="tnote">3 min, you approved</span><span class="tnote twait">waited 41 min for you</span>');
      expect(html.match(/twait/g)).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('every place shows it: the card, the story, the proof page and the release; the form has the switch', () => {
    expect(read('pages/Board.tsx')).toContain('<NoNewTestsTag t={t} />');
    expect(codeAt('console-ui/src/pages/TicketDrawer.tsx', 'console-ui/src/pages/drawer')).toContain('<NoNewTestsLabel t={t} />');
    expect(read('pages/Proof.tsx')).toContain('<NoNewTestsLabel t={t} />');
    expect(read('pages/Releases.tsx')).toContain('<NoNewTestsLabel t={it} />');
    const form = read('components/dialogs.tsx');
    expect(form).toContain('<b>Write new tests.</b>');
    // On by default, for any track, gone where an engineer keeps it on, and the same as the terminal option.
    expect(form).toContain("useDraft(NEW_TICKET, 'new-tests', true)");
    expect(form).toContain('{!testsAlways && (');
    expect(form).toContain("noNewTests ? '--no-new-tests' : ''");
    expect(read('pages/Pages.tsx')).toContain('squad config set new-tests');
  });
});
