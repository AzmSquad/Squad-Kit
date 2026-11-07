import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { boardExists, boardPaths, brokenTickets, listTickets, readMeta, readTicket, ticketProblem, updateTicket, writeMeta, type BoardPaths } from '../src/board/store.js';
import { createTicket } from '../src/board/actions.js';
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
const board = async () => (await (await api().request('/api/v1/board')).json()) as { ready: boolean; settings?: string; tickets?: { id: string }[]; broken?: { id: string; problem: string; file: string; detail: string }[] };

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
