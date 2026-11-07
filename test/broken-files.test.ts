import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import {
  boardExists,
  boardPaths,
  brokenDecisions,
  brokenReleases,
  brokenTickets,
  listDecisions,
  listReleases,
  listTickets,
  nextDecisionId,
  readMeta,
  readRelease,
  readTicket,
  recordProblemWords,
  ticketProblem,
  updateTicket,
  writeDecision,
  writeMeta,
  writeRelease,
  writeTicket,
  type BoardPaths,
} from '../src/board/store.js';
import { createTicket, ensureDraftRelease } from '../src/board/actions.js';
import { seedDemoBoard } from '../src/board/demo.js';
import { architecture } from '../src/board/architecture.js';
import { breakdownRows, breakdownView, brokenBreakdowns, listBreakdowns, readBreakdown, readBreakdownState, requireBreakdown, updateBreakdown, writeBreakdownState } from '../src/board/requirements.js';
import { addBreakdown, retryBreakdown } from '../src/board/requirements-actions.js';
import { breakdownFile, breakdownStateFile } from '../src/board/requirements-paths.js';
import { runBreakdownJob } from '../src/engine/breakdown-job.js';
import { readHarness, harnessFile } from '../src/board/additions.js';
import { mountRequirementsApi } from '../src/console/api/requirements.js';
import type { Decision, Release, Ticket } from '../src/board/types.js';
import { depsReady } from '../src/board/depends.js';
import { LiveSquad } from '../src/engine/live.js';
import { pickUpPushed } from '../src/engine/handover.js';
import { loadConfig, saveConfig } from '../src/core/config.js';
import { mountBoardApi } from '../src/console/api/board.js';
import { buildPaths, chooseProject } from '../src/core/paths.js';
import { prepareProject } from '../src/engine/setup.js';
import { runBoard, runInbox } from '../src/commands/board.js';
import { OpenProjects } from '../src/console/open-projects.js';
import { ticketTrouble } from '../console-ui/src/lib/ticket-trouble.js';

/**
 * The files under `.squad` are the truth, and people, teammates' merges and outside tools write them. A ticket file that
 * cannot be read is a plain problem the person can see, never a ticket that silently left the board. Settings that
 * cannot be read say so, and are never written in place, so a full disk cannot empty them.
 */

let tmp: string;
let project: string;
let bp: BoardPaths;

const sh = (cmd: string, cwd = project) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commitAll = (msg: string) => sh(`git add -A && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m "${msg}"`);

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-broken-')));
  project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  sh('git init -q -b main');
  bp = boardPaths(path.join(project, '.squad'));
  writeMeta(bp, {
    project: 'App',
    key: 'AP',
    nextNumber: 1,
    engine: 'live',
    user: { name: 'Momen', role: 'Project manager' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
    commands: {},
    git: { base: 'main', remote: '' },
    scan: { status: 'done', empty: false },
  });
  commitAll('start');
});

afterEach(() => {
  chooseProject(null);
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Two people changed the same file: git leaves the marks in it, as in a real merge. */
function conflict(file: string, ours: (text: string) => string, theirs: (text: string) => string): void {
  const before = fs.readFileSync(file, 'utf8');
  commitAll('both start here');
  sh('git switch -q -c teammate');
  fs.writeFileSync(file, theirs(before));
  commitAll('theirs');
  sh('git switch -q main');
  fs.writeFileSync(file, ours(before));
  commitAll('ours');
  expect(() => sh('git merge -q teammate')).toThrow();
  expect(fs.readFileSync(file, 'utf8')).toContain('<<<<<<<');
}

const ticketFile = (id: string) => path.join(bp.ticketsDir, id, 'ticket.md');
const api = () => {
  const app = new Hono();
  mountBoardApi(app, { paths: buildPaths(project) });
  return app;
};
const board = async () => (await (await api().request('/api/v1/board')).json()) as { ready: boolean; settings?: string; tickets?: { id: string }[]; broken?: { id: string; problem: string; file: string; detail: string }[]; brokenRecords?: { kind: string; id: string; problem: string; file: string; detail: string }[] };

describe('a ticket file that cannot be read', () => {
  const WORDS = (id: string) => `${id} could not be read: its file is damaged, so it is not on the board. Nothing is lost. An engineer can look at it.`;

  it('with merge marks: the board names it and says what happened, and the other tickets stay', async () => {
    const bad = createTicket(bp, { title: 'Two people changed this' });
    const good = createTicket(bp, { title: 'This one is fine' });
    conflict(
      ticketFile(bad.id),
      (t) => t.replace(/^priority: .*$/m, 'priority: high'),
      (t) => t.replace(/^priority: .*$/m, 'priority: low'),
    );
    expect(listTickets(bp).map((t) => t.id)).toEqual([good.id]);
    const b = await board();
    expect(b.ready).toBe(true);
    expect(b.tickets!.map((t) => t.id)).toEqual([good.id]);
    expect(b.broken).toEqual([{ id: bad.id, problem: WORDS(bad.id), file: path.join('.squad', 'tickets', bad.id, 'ticket.md'), detail: expect.any(String) }]);
    expect(b.broken![0]!.problem).not.toMatch(/yaml|git|merge|header/i);
  });

  it('with the marks around the whole file, bad YAML, or not the shape of a ticket', async () => {
    const wrong: [string, (t: string) => string][] = [
      ['marks around it all', (t) => `<<<<<<< HEAD\n${t}=======\n${t}>>>>>>> teammate\n`],
      ['bad YAML', (t) => t.replace(/^title: .*$/m, 'title: [not closed')],
      ['no title', (t) => t.replace(/^title: .*$/m, '')],
      ['a stage that does not exist', (t) => t.replace(/^stage: .*$/m, 'stage: banana')],
      ['no id', (t) => t.replace(/^id: .*$/m, '')],
      ["another ticket's id", (t) => t.replace(/^id: .*$/m, 'id: AP-99')],
      ['no source', (t) => t.replace(/^source:\n(?:\s+.*\n)+/m, '')],
      ['an empty file', () => ''],
    ];
    for (const [what, change] of wrong) {
      const t = createTicket(bp, { title: `Broken by ${what}` });
      fs.writeFileSync(ticketFile(t.id), change(fs.readFileSync(ticketFile(t.id), 'utf8')));
      expect(listTickets(bp).map((x) => x.id), what).not.toContain(t.id);
      expect(brokenTickets(bp).map((x) => x.id), what).toContain(t.id);
      expect(ticketProblem(bp, t.id), what).toBe(WORDS(t.id));
    }
    expect(brokenTickets(bp)).toHaveLength(wrong.length);
  });

  it("this computer's own part being damaged counts too", () => {
    const a = createTicket(bp, { title: 'State' });
    fs.writeFileSync(path.join(bp.stateDir, `${a.id}.yaml`), 'status: [not closed');
    expect(brokenTickets(bp).map((x) => x.id)).toEqual([a.id]);
  });

  it('a folder that holds no ticket file stays ignored, and so do files', async () => {
    const t = createTicket(bp, { title: 'Real' });
    fs.mkdirSync(path.join(bp.ticketsDir, 'our-notes'), { recursive: true });
    fs.writeFileSync(path.join(bp.ticketsDir, 'our-notes', 'notes.md'), '# Notes\n');
    fs.mkdirSync(path.join(bp.ticketsDir, 'AP-77'), { recursive: true });
    fs.writeFileSync(path.join(bp.ticketsDir, 'readme.txt'), 'hello');
    expect(brokenTickets(bp)).toEqual([]);
    expect(listTickets(bp).map((x) => x.id)).toEqual([t.id]);
    const b = await board();
    expect(b.broken).toBeUndefined();
    expect(readTicket(bp, 'AP-77')).toBeNull();
  });

  it('is never written over, and the ticket comes back once the file is fixed', () => {
    const t = createTicket(bp, { title: 'Keep me' });
    const good = fs.readFileSync(ticketFile(t.id), 'utf8');
    const bad = `<<<<<<< HEAD\n${good}=======\n${good}>>>>>>> teammate\n`;
    fs.writeFileSync(ticketFile(t.id), bad);
    expect(() => updateTicket(bp, t.id, (x) => (x.status = 'Changed'))).toThrow(WORDS(t.id));
    expect(fs.readFileSync(ticketFile(t.id), 'utf8')).toBe(bad);
    fs.writeFileSync(ticketFile(t.id), good);
    expect(listTickets(bp).map((x) => x.id)).toEqual([t.id]);
    expect(brokenTickets(bp)).toEqual([]);
  });

  it("opening it says what happened, and its number is not given to a new ticket", async () => {
    const t = createTicket(bp, { title: 'Open me' });
    fs.writeFileSync(ticketFile(t.id), 'title: [not closed');
    const res = await api().request(`/api/v1/tickets/${t.id}`);
    expect(res.status).toBe(409);
    const answer = await res.text();
    expect(JSON.parse(answer)).toEqual({ error: WORDS(t.id) });
    // The drawer shows the plain words, not the answer they came in.
    expect(ticketTrouble(new Error(`409 Conflict: ${answer}`), t.id)).toBe(WORDS(t.id));
    expect(createTicket(bp, { title: 'Next' }).id).not.toBe(t.id);
  });

  it('a ticket that depends on it keeps waiting, and the squad goes on with the others', () => {
    const dep = createTicket(bp, { title: 'Built first' });
    const t = createTicket(bp, { title: 'Waits for it' });
    const other = createTicket(bp, { title: 'Nothing to do with it' });
    updateTicket(bp, t.id, (x) => {
      x.dependsOn = [dep.id];
      x.dependency = { way: 'wait', on: [dep.id], by: 'Momen', at: new Date().toISOString() };
      x.squad = null;
    });
    fs.writeFileSync(ticketFile(dep.id), 'title: [not closed');
    expect(depsReady(bp, [dep.id])).toBe(false);
    const squad = new LiveSquad(bp) as unknown as { safeTick(): void; turnsFailed: number; launch: unknown };
    const started: string[] = [];
    squad.launch = (key: string) => started.push(key);
    squad.safeTick();
    expect(squad.turnsFailed).toBe(0);
    expect(readTicket(bp, t.id)!.dependency?.started).toBeUndefined();
    expect(readTicket(bp, other.id)!.title).toBe('Nothing to do with it');
  });

  it('a pushed copy of it is not brought in over it, and the project still opens', () => {
    const remote = path.join(tmp, 'remote.git');
    sh(`git init -q --bare -b main ${remote}`, tmp);
    writeMeta(bp, { ...readMeta(bp), documentsInGit: true });
    const t = createTicket(bp, { title: 'Pushed by me' });
    commitAll('the ticket');
    sh(`git remote add origin ${remote} && git push -q origin main`);
    sh(`git switch -q -c squad/${t.id.toLowerCase()}`);
    fs.appendFileSync(ticketFile(t.id), 'More words.\n');
    commitAll('more');
    sh(`git push -q origin squad/${t.id.toLowerCase()}`);
    sh('git switch -q main');
    const bad = 'title: [not closed';
    fs.writeFileSync(ticketFile(t.id), bad);
    expect(pickUpPushed(bp)).toEqual([]);
    expect(fs.readFileSync(ticketFile(t.id), 'utf8')).toBe(bad);
    expect(brokenTickets(bp).map((x) => x.id)).toEqual([t.id]);
  });

  it('the terminal says the same on the board and in the inbox', async () => {
    const t = createTicket(bp, { title: 'Broken here' });
    fs.writeFileSync(ticketFile(t.id), 'title: [not closed');
    chooseProject(project);
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
      written.push(String(s));
      return true;
    });
    await runBoard();
    await runInbox();
    const text = written.join('');
    expect(text.split(WORDS(t.id)).length - 1).toBe(2);
  });
});

describe('settings that cannot be read', () => {
  const WORDS = "This project's settings file could not be read, so its board cannot open. Nothing is lost. An engineer can look at it.";

  it('a merge conflict shows what happened, not "no board yet" and the sample board', async () => {
    conflict(
      bp.configFile,
      (t) => t.replace('nextNumber: 1', 'nextNumber: 5'),
      (t) => t.replace('nextNumber: 1', 'nextNumber: 9'),
    );
    expect(boardExists(bp)).toBe(false);
    const b = await board();
    expect(b).toEqual({ ready: false, settings: WORDS });
    // Opening the project says the same, in plain words, and leaves the file as it is.
    const before = fs.readFileSync(bp.configFile, 'utf8');
    expect(() => prepareProject(project)).toThrow(WORDS);
    expect(fs.readFileSync(bp.configFile, 'utf8')).toBe(before);
    // The terminal.
    chooseProject(project);
    await expect(runBoard()).rejects.toThrow(WORDS);
    // Home, with the project open in the app.
    const projects = new OpenProjects({ token: 't', info: () => ({ pid: null, port: 0, token: 't', startedAt: '', version: '', build: 0 }), remember: false });
    (projects as unknown as { open: Map<string, unknown> }).open.set('app', { id: 'app', root: project, bp });
    expect(projects.summaries()[0]).toMatchObject({ open: true, why: WORDS });
  });

  it('a folder with no settings yet still has no board, with no word about a problem', async () => {
    fs.rmSync(bp.configFile);
    expect(await board()).toEqual({ ready: false });
  });

  it('are written whole or not at all: a full disk leaves them as they were, with nothing left behind', () => {
    const before = fs.readFileSync(bp.configFile, 'utf8');
    const config = loadConfig(bp.configFile);
    const real = fs.writeFileSync;
    // What a full disk does: the file it writes is emptied, then the write fails.
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, opts) => {
      if (String(file).startsWith(bp.configFile)) {
        real(file, '');
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      }
      real(file, data, opts);
    });
    expect(() => saveConfig(bp.configFile, { ...config, project: { ...config.project, name: 'Changed' } })).toThrow(/ENOSPC/);
    vi.restoreAllMocks();
    expect(fs.readFileSync(bp.configFile, 'utf8')).toBe(before);
    expect(fs.readdirSync(path.dirname(bp.configFile)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(readMeta(bp).project).toBe('App');
  });

  it('a save still lands, with the new settings', () => {
    const config = loadConfig(bp.configFile);
    saveConfig(bp.configFile, { ...config, project: { ...config.project, name: 'Changed' } });
    expect(loadConfig(bp.configFile).project.name).toBe('Changed');
    expect(fs.readdirSync(path.dirname(bp.configFile)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

/** What a person's tool, or a merge, can leave in a record's file. Each row: what, and how it changes the good text. */
const marks = (t: string) => `<<<<<<< HEAD\n${t}=======\n${t}>>>>>>> teammate\n`;

describe('a decision file that cannot be read', () => {
  const decision = (id: string): Decision => ({ id, title: `Decision ${id}`, why: 'Because', options: ['A', 'B'], chosen: 'A', from: 'AP-1', approvedBy: 'Momen', date: '2026-11-01', checkedBy: null, tickets: ['AP-1'] });
  const file = (id: string) => path.join(bp.decisionsDir, `${id}.md`);
  const wrong: [string, (t: string) => string][] = [
    ['merge marks', marks],
    ['bad YAML', (t) => t.replace(/^title: .*$/m, 'title: [not closed')],
    ['no id', (t) => t.replace(/^id: .*$/m, '')],
    ['no title', (t) => t.replace(/^title: .*$/m, '')],
    ['a number for its title', (t) => t.replace(/^title: .*$/m, 'title: 5')],
    ['a word for its tickets', (t) => t.replace(/^tickets:\n(?:\s*- .*\n)+/m, 'tickets: AP-1\n')],
    ['a number for its follows list', (t) => t.replace(/^tickets:/m, 'buildsOn: 7\ntickets:')],
    ['another id', (t) => t.replace(/^id: .*$/m, 'id: AP-1.99')],
    ['no header at all', () => 'We chose the blue one.\n'],
  ];

  it('each way: it is named in plain words, and the page and the others keep working', async () => {
    writeDecision(bp, decision('AP-1.1'));
    for (const [what, change] of wrong) {
      const id = `AP-2.${wrong.findIndex(([w]) => w === what) + 1}`;
      writeDecision(bp, decision(id));
      fs.writeFileSync(file(id), change(fs.readFileSync(file(id), 'utf8')));
      expect(listDecisions(bp).map((d) => d.id), what).not.toContain(id);
      expect(brokenDecisions(bp).map((d) => d.id), what).toContain(id);
    }
    expect(listDecisions(bp).map((d) => d.id)).toEqual(['AP-1.1']);
    const b = await board();
    const shown = b.brokenRecords!.filter((r) => r.kind === 'decision');
    expect(shown).toHaveLength(wrong.length);
    expect(shown[0]).toEqual({ kind: 'decision', id: 'AP-2.1', problem: recordProblemWords('decision', 'AP-2.1'), file: path.join('.squad', 'decisions', 'AP-2.1.md'), detail: expect.any(String) });
    expect(shown[0]!.problem).toBe('Decision AP-2.1 could not be read: its file is damaged, so it is not shown here. Nothing is lost. An engineer can look at it.');
    expect(shown[0]!.problem).not.toMatch(/yaml|git|merge|header/i);
    // The Architecture page's own call, and the terminal's words, still work.
    const res = await api().request('/api/v1/architecture');
    expect(res.status).toBe(200);
    const page = (await res.json()) as { decisions: { id: string }[]; broken: { id: string }[] };
    expect(page.decisions.map((d) => d.id)).toEqual(['AP-1.1']);
    expect(page.broken).toHaveLength(wrong.length);
    const list = (await (await api().request('/api/v1/decisions')).json()) as { decisions: unknown[]; broken: unknown[] };
    expect(list.decisions).toHaveLength(1);
    expect(list.broken).toHaveLength(wrong.length);
  });

  it('before this, a list that is missing crashed the whole page: now it is simply empty', () => {
    writeDecision(bp, decision('AP-3.1'));
    fs.writeFileSync(file('AP-3.1'), fs.readFileSync(file('AP-3.1'), 'utf8').replace(/^tickets:\n(?:\s*- .*\n)+/m, ''));
    createTicket(bp, { title: 'Reads the decisions' });
    expect(architecture(bp).decisions[0]!.tickets).toEqual([]);
    expect(brokenDecisions(bp)).toEqual([]);
  });

  it('a date a tool wrote with no quotes still reads', () => {
    writeDecision(bp, decision('AP-3.1'));
    fs.writeFileSync(file('AP-3.1'), fs.readFileSync(file('AP-3.1'), 'utf8').replace(/^date: .*$/m, 'date: 2026-11-05'));
    expect(listDecisions(bp)[0]!.date).toBe('2026-11-05');
  });

  it('its name is not given to a new decision, so it is never written over', () => {
    writeDecision(bp, decision('AP-4.1'));
    const bad = 'title: [not closed';
    fs.writeFileSync(file('AP-4.1'), bad);
    expect(nextDecisionId(bp, 'AP-4')).toBe('AP-4.2');
    expect(fs.readFileSync(file('AP-4.1'), 'utf8')).toBe(bad);
  });

  it("the project's own notes stay left alone, and a hand-named file that says it is a decision counts", () => {
    fs.mkdirSync(bp.decisionsDir, { recursive: true });
    fs.writeFileSync(file('why-we-chose-postgres'), '# Our own notes\n\nWe like it.\n');
    expect(brokenDecisions(bp)).toEqual([]);
    expect(listDecisions(bp)).toEqual([]);
    fs.writeFileSync(file('auth-choice'), '---\nid: 5\ntitle: Sign in\n---\n## Chosen\n\nCookies\n');
    expect(brokenDecisions(bp).map((d) => d.id)).toEqual(['auth-choice']);
  });
});

describe('a release file that cannot be read', () => {
  const release = (version: string, status: Release['status'] = 'released'): Release => ({ version, status, from: 'v0.0.1', date: '2026-11-01T10:00:00.000Z', tickets: ['AP-1'], notes: 'Notes', addons: { changelog: true, tag: true, pipeline: false, whatsapp: false } });
  const file = (v: string) => path.join(bp.releasesDir, `${v}.md`);
  const wrong: [string, (t: string) => string][] = [
    ['merge marks', marks],
    ['bad YAML', (t) => t.replace(/^status: .*$/m, 'status: [not closed')],
    ['no version', (t) => t.replace(/^version: .*$/m, '')],
    ['a state that does not exist', (t) => t.replace(/^status: .*$/m, 'status: banana')],
    ['a word for its tickets', (t) => t.replace(/^tickets:\n(?:\s*- .*\n)+/m, 'tickets: AP-1\n')],
    ['a number for its add-ons', (t) => t.replace(/^addons:\n(?:\s+.*\n)+/m, 'addons: 5\n')],
    ['another version', (t) => t.replace(/^version: .*$/m, 'version: v9.9.9')],
    ['plain words only', () => 'Some notes about this version.\n'],
  ];

  it('each way: it is named in plain words, and the Releases page keeps working', async () => {
    writeRelease(bp, release('v0.1.0'));
    wrong.forEach(([what, change], i) => {
      const v = `v0.2.${i}`;
      writeRelease(bp, release(v));
      fs.writeFileSync(file(v), change(fs.readFileSync(file(v), 'utf8')));
      expect(listReleases(bp).map((r) => r.version), what).not.toContain(v);
      expect(brokenReleases(bp).map((r) => r.id), what).toContain(v);
    });
    const res = await api().request('/api/v1/releases');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { version: string }[]).map((r) => r.version)).toEqual(['v0.1.0']);
    const shown = (await board()).brokenRecords!.filter((r) => r.kind === 'release');
    expect(shown).toHaveLength(wrong.length);
    expect(shown[0]).toEqual({ kind: 'release', id: 'v0.2.0', problem: 'Release v0.2.0 could not be read: its file is damaged, so it is not shown here. Nothing is lost. An engineer can look at it.', file: path.join('.squad', 'releases', 'v0.2.0.md'), detail: expect.any(String) });
  });

  it('asking for it by name says the same words, with no raw error', async () => {
    writeRelease(bp, release('v0.3.0', 'draft'));
    fs.writeFileSync(file('v0.3.0'), 'status: [not closed');
    expect(() => readRelease(bp, 'v0.3.0')).toThrow(recordProblemWords('release', 'v0.3.0'));
    const res = await api().request('/api/v1/releases/v0.3.0/release', { method: 'POST' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: recordProblemWords('release', 'v0.3.0') });
  });

  it('a new draft goes around its version and never writes over it', () => {
    writeRelease(bp, release('v0.1.0'));
    const bad = marks('---\nversion: v0.2.0\n---\n');
    fs.writeFileSync(file('v0.2.0'), bad);
    expect(ensureDraftRelease(bp, 'minor').version).toBe('v0.3.0');
    expect(fs.readFileSync(file('v0.2.0'), 'utf8')).toBe(bad);
  });

  it("this computer's own part being damaged only loses its log", () => {
    writeRelease(bp, { ...release('v0.4.0'), log: [{ ok: true, text: 'Sent' }] });
    fs.writeFileSync(path.join(bp.stateDir, 'releases', 'v0.4.0.yaml'), 'log: [not closed');
    expect(listReleases(bp).map((r) => r.version)).toEqual(['v0.4.0']);
    expect(readRelease(bp, 'v0.4.0')!.log).toBeUndefined();
  });

  it("an older squad-kit's notes stay left alone", () => {
    fs.mkdirSync(bp.releasesDir, { recursive: true });
    fs.writeFileSync(file('2026-10-19-1234'), '# Story 1234\n\nShipped.\n');
    expect(brokenReleases(bp)).toEqual([]);
    expect(listReleases(bp)).toEqual([]);
  });
});

describe('a breakdown file that cannot be read', () => {
  const add = () => addBreakdown(bp, { text: '# Booking\n\nPeople book rooms.\n' }).id;
  const reqApi = () => {
    const app = new Hono();
    mountRequirementsApi(app, { paths: buildPaths(project) });
    return app;
  };
  const wrong: [string, (t: string) => string][] = [
    ['merge marks', marks],
    ['bad YAML', (t) => t.replace(/^title: .*$/m, 'title: [not closed')],
    ['no status', (t) => t.replace(/^status: .*$/m, '')],
    ['a status that does not exist', (t) => t.replace(/^status: .*$/m, 'status: banana')],
    ['no title', (t) => t.replace(/^title: .*$/m, '')],
    ['a word for its epics', (t) => t.replace(/^epics: .*$/m, 'epics: none')],
    ['a story with a number for a title', (t) => t.replace(/^epics: .*$/m, 'epics:\n  - key: E-1\n    title: One\n    features: []\n    stories:\n      - key: S-1\n        title: 5\n        story: x\n        criteria: []\n        size: M\n        dependsOn: []')],
    ['an epic with a word for its features', (t) => t.replace(/^epics: .*$/m, 'epics:\n  - key: E-1\n    title: One\n    features: lots\n    stories: []')],
    ['a story with a word for its needs', (t) => t.replace(/^epics: .*$/m, 'epics:\n  - key: E-1\n    title: One\n    features: []\n    stories:\n      - key: S-1\n        title: A\n        story: x\n        criteria: []\n        size: M\n        dependsOn: S-2')],
    ['a document outside its folder', (t) => t.replace(/^(\s+)file: .*$/m, '$1file: ../../secret.md')],
  ];

  it('each way: it is named in plain words, and the list and the others keep working', async () => {
    const good = add();
    for (const [what, change] of wrong) {
      const id = add();
      fs.writeFileSync(breakdownFile(bp, id), change(fs.readFileSync(breakdownFile(bp, id), 'utf8')));
      expect(readBreakdown(bp, id), what).toBeNull();
      expect(brokenBreakdowns(bp).map((b) => b.id), what).toContain(id);
    }
    expect(listBreakdowns(bp).map((b) => b.id)).toEqual([good]);
    expect(breakdownRows(bp).map((r) => r.id)).toEqual([good]);
    const res = await reqApi().request('/api/v1/requirements');
    expect(res.status).toBe(200);
    const list = (await res.json()) as { breakdowns: { id: string }[]; broken: { id: string; problem: string; file: string }[] };
    expect(list.breakdowns.map((b) => b.id)).toEqual([good]);
    expect(list.broken).toHaveLength(wrong.length);
    expect(list.broken[0]!.problem).toBe(`Breakdown ${list.broken[0]!.id} could not be read: its file is damaged, so it is not shown here. Nothing is lost. An engineer can look at it.`);
    expect(list.broken[0]!.file).toBe(path.join('.squad', 'requirements', list.broken[0]!.id, 'breakdown.yaml'));
    expect((await board()).brokenRecords!.filter((r) => r.kind === 'breakdown')).toHaveLength(wrong.length);
  });

  it('opening it says what happened, and it is never written over', async () => {
    const id = add();
    const bad = 'title: [not closed';
    fs.writeFileSync(breakdownFile(bp, id), bad);
    const res = await reqApi().request(`/api/v1/requirements/${id}`);
    expect(res.status).toBe(409);
    const words = recordProblemWords('breakdown', id);
    expect(await res.json()).toEqual({ error: words });
    expect(() => requireBreakdown(bp, id)).toThrow(words);
    expect(() => updateBreakdown(bp, id, (b) => (b.title = 'New'))).toThrow(words);
    expect(fs.readFileSync(breakdownFile(bp, id), 'utf8')).toBe(bad);
    // A folder with no breakdown file is still simply not there.
    expect((await reqApi().request('/api/v1/requirements/BR-99')).status).toBe(404);
  });

  it("this computer's part damaged or in the wrong type: no crash, and a breakdown left waiting has Try again", () => {
    const id = add();
    const state = breakdownStateFile(bp, id);
    for (const bad of ['job: [not closed', 'activity: 5\njob: 5', '- a list', 'build: on']) {
      fs.writeFileSync(state, bad);
      expect(readBreakdownState(bp, id).job).toBeUndefined();
      expect(Array.isArray(readBreakdownState(bp, id).activity)).toBe(true);
      const v = breakdownView(bp, id, 'subscription');
      expect(v.status).toBe('failed');
      expect(v.error).toBe("squad-kit lost track of the Analyst's work on this computer, so it stopped. Your document is safe. Press Try again.");
      expect(breakdownRows(bp)[0]!.status).toBe('failed');
    }
    retryBreakdown(bp, id);
    expect(readBreakdownState(bp, id).job).toMatchObject({ step: 'read', status: 'pending' });
    expect(fs.readFileSync(state, 'utf8')).not.toContain('lost');
    expect(breakdownView(bp, id, 'subscription').status).toBe('reading');
  });

  it("a teammate's breakdown with no job here is not called stopped", () => {
    const id = add();
    updateBreakdown(bp, id, (b) => (b.owner = 'Someone else'));
    fs.rmSync(breakdownStateFile(bp, id));
    expect(breakdownView(bp, id, 'subscription').status).toBe('reading');
  });

  it('a job whose document is gone stops with plain words, and pays for no run', async () => {
    const id = add();
    fs.rmSync(path.join(bp.squadDir, 'requirements', id, 'text'), { recursive: true });
    const run = vi.fn(async () => ({ text: '', structured: {} }));
    await runBreakdownJob(bp, id, { run });
    expect(run).not.toHaveBeenCalled();
    expect(readBreakdown(bp, id)).toMatchObject({ status: 'failed', error: `The document of ${id} is no longer in its folder. Add the BRD again.` });
  });
});

describe("a ticket's other files", () => {
  const doc = (id: string, f: string) => path.join(bp.ticketsDir, id, f);
  const planned = (title: string) => {
    const t = createTicket(bp, { title });
    return updateTicket(bp, t.id, (x) => {
      x.story = 'As a person, I want it.';
      x.criteria = [{ given: 'a', when: 'b', then: 'c' }];
      x.steps = [{ title: 'Do it', status: 'todo' }];
      x.decision = { title: 'Use it', options: [{ name: 'It', note: '', chosen: true }], why: 'Good' };
      x.questions = [{ id: 'q1', from: 'analyst', text: 'Which?', options: ['A'] }];
      x.proof = [{ criterion: 'c', before: 'b.png', after: 'a.png', beforeLabel: 'B', afterLabel: 'A' }];
      x.notes = [{ at: new Date().toISOString(), by: 'Momen', kind: 'note', text: 'Note' }];
    });
  };

  it.each(['spec.md', 'design.md', 'questions.md', 'proof.md', 'notes.md'])('%s with merge marks or in no shape squad-kit reads: the ticket is named, and that file is said to engineers', (f) => {
    for (const change of [marks, () => 'Just some free text from a tool.\n']) {
      const t = planned(`Damaged ${f}`);
      const before = fs.readFileSync(doc(t.id, f), 'utf8');
      const bad = change(before);
      fs.writeFileSync(doc(t.id, f), bad);
      expect(listTickets(bp).map((x) => x.id)).not.toContain(t.id);
      const b = brokenTickets(bp).find((x) => x.id === t.id)!;
      expect(b.file).toBe(path.join('.squad', 'tickets', t.id, f));
      expect(ticketProblem(bp, t.id)).toContain(`${t.id} could not be read`);
      // The next save would have lost what the tool wrote: it is refused instead.
      expect(() => updateTicket(bp, t.id, (x) => (x.status = 'Changed'))).toThrow(/could not be read/);
      expect(fs.readFileSync(doc(t.id, f), 'utf8')).toBe(bad);
    }
  });

  it('a spec with a row of equals as a heading is not a merge', () => {
    const t = planned('Equals');
    updateTicket(bp, t.id, (x) => (x.story = 'Heading\n=======\nWords.'));
    expect(listTickets(bp).map((x) => x.id)).toContain(t.id);
  });

  it('a proof saved with no rows yet still reads', () => {
    const t = createTicket(bp, { title: 'Empty proof' });
    const saved = readTicket(bp, t.id)!;
    writeTicket(bp, { ...saved, proof: [] });
    expect(listTickets(bp).map((x) => x.id)).toContain(t.id);
  });

  it('a wrong type in one field of the ticket file: the ticket is named, and the board does not crash', async () => {
    const rows: [string, (s: string) => string][] = [
      ['needs', (s) => s.replace(/^stage: /m, 'dependsOn: 5\nstage: ')],
      ['gates', (s) => s.replace(/^stage: /m, 'gates: 7\nstage: ')],
      ['follows', (s) => s.replace(/^stage: /m, 'follows: AP-1.1\nstage: ')],
      ['decided', (s) => s.replace(/^stage: /m, 'decided: lots\nstage: ')],
      ['priority', (s) => s.replace(/^priority: .*$/m, 'priority: 12')],
      ['work', (s) => s.replace(/^stage: /m, 'work: 3\nstage: ')],
    ];
    const ok = createTicket(bp, { title: 'Fine' });
    for (const [what, change] of rows) {
      const t = createTicket(bp, { title: `Wrong ${what}` });
      fs.writeFileSync(ticketFile(t.id), change(fs.readFileSync(ticketFile(t.id), 'utf8')));
      expect(ticketProblem(bp, t.id), what).toContain('could not be read');
    }
    const b = await board();
    expect(b.tickets!.map((t) => t.id)).toEqual([ok.id]);
    expect(b.broken).toHaveLength(rows.length);
  });
});

describe('a board as squad-kit writes it', () => {
  it('a ticket with only one of its parts is never called damaged', () => {
    const row = { criterion: 'c', before: 'b.png', after: 'a.png', beforeLabel: 'B', afterLabel: 'A' };
    const parts: Partial<Ticket>[] = [
      { story: 'As a person, I want it.' },
      { story: '' },
      { criteria: [] },
      { criteria: [{ given: 'a', when: 'b', then: 'c' }] },
      { releaseNote: 'Now it works.' },
      { steps: [] },
      { steps: [{ title: 'Do it', status: 'todo' }] },
      { decision: { title: 'Use it', options: [], why: '' } },
      { questions: [{ id: 'q1', from: 'architect', text: 'أي واحد؟', options: [] }] },
      { notes: [{ at: new Date().toISOString(), by: 'سارة', kind: 'rule', text: 'Note' }] },
      { proof: [] },
      { proof: [row] },
    ];
    for (const part of parts) {
      const t = createTicket(bp, { title: 'طلب: جديد' });
      updateTicket(bp, t.id, (x) => Object.assign(x, part));
      expect(ticketProblem(bp, t.id), JSON.stringify(part)).toBeNull();
    }
    expect(brokenTickets(bp)).toEqual([]);
  });

  it('a file a tool saved with other line endings reads the same', () => {
    const t = createTicket(bp, { title: 'From a tool' });
    updateTicket(bp, t.id, (x) => {
      x.story = 'As a person, I want it.';
      x.steps = [{ title: 'Do it', status: 'todo' }];
    });
    for (const f of ['ticket.md', 'spec.md', 'design.md']) {
      const file = path.join(bp.ticketsDir, t.id, f);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
    }
    expect(ticketProblem(bp, t.id)).toBeNull();
    expect(readTicket(bp, t.id)).toMatchObject({ title: 'From a tool', story: 'As a person, I want it.', steps: [{ title: 'Do it' }] });
  });

  it('the sample board has no broken file of any kind', () => {
    seedDemoBoard(bp, { speed: 50 });
    expect(listTickets(bp).length).toBeGreaterThan(0);
    expect(brokenTickets(bp)).toEqual([]);
    expect(listDecisions(bp).length).toBeGreaterThan(0);
    expect(brokenDecisions(bp)).toEqual([]);
    expect(listReleases(bp).length).toBeGreaterThan(0);
    expect(brokenReleases(bp)).toEqual([]);
    expect(brokenBreakdowns(bp)).toEqual([]);
  });
});

describe('the other files a tool may write', () => {
  it('settings with a wrong type say so, and the board does not open on them', async () => {
    const WORDS = "This project's settings file could not be read, so its board cannot open. Nothing is lost. An engineer can look at it.";
    for (const line of ['git: 5', 'repos: all', 'commands: 7', 'nextNumber: lots']) {
      const before = fs.readFileSync(bp.configFile, 'utf8');
      const key = line.split(':')[0]!;
      const cleared = before.replace(new RegExp(`^  ${key}:.*(\\n {4}.*)*$`, 'm'), '').replace(/^board:$/m, `board:\n  ${line}`);
      fs.writeFileSync(bp.configFile, cleared);
      expect(await board(), line).toEqual({ ready: false, settings: WORDS });
      fs.writeFileSync(bp.configFile, before);
    }
    expect((await board()).ready).toBe(true);
  });

  it('harness.yaml in the wrong shape: every way says so in plain words, with no crash', () => {
    const rows = [
      '<<<<<<< HEAD\nadditions: []\n=======\nadditions: []\n>>>>>>> t\n',
      'additions: [not closed',
      'additions: 5\n',
      'log: nothing\n',
      'log:\n  - 5\n',
      'additions:\n  - kind: rule\n    id: r1\n    name: 5\n    state: on\n    agents: all\n    text: Be kind\n',
      'additions:\n  - kind: gate\n    id: g1\n    name: G\n    state: maybe\n    when: checks\n    command: x\n    on_fail: stop\n',
    ];
    for (const raw of rows) {
      fs.writeFileSync(harnessFile(bp), raw);
      const h = readHarness(bp);
      expect(h.broken, raw).toMatch(/can't be read/);
      expect(h.additions).toEqual([]);
    }
  });
});
