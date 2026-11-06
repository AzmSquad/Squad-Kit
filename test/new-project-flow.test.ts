import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readMeta, writeMeta } from '../src/board/store.js';
import { approveOverview, overviewView, setupLine, setupView, tellIdea } from '../src/board/first-run.js';
import { nextProofStep } from '../src/board/setup-state.js';
import { breakdownJobs, listBreakdowns } from '../src/board/requirements.js';
import { saveScan } from '../src/engine/onboard.js';
import { readAgainDone, readIdea } from '../src/engine/onboard-live.js';
import { isRepo } from '../src/engine/git.js';
import { defaultPlace, folderNameFor, makeNewProject, newProjectFolder, whyNotHere } from '../src/engine/new-project.js';
import { squadHome } from '../src/core/home.js';

/**
 * New project: a person with only a BRD or an idea gets a folder, git and a board in one step. An idea goes into the
 * first read, so nothing is asked twice and an empty folder is read once. A BRD goes to the Analyst with no read at all.
 * Anything that fails leaves nothing behind, so pressing Create again just works.
 */

let tmp: string;
const IDEA = 'A visitor log for a small office';
const brd = (name = 'visitors.md', text = '# Visitor log\n\nPeople sign in at the door.\n') => ({ name, data: Buffer.from(text).toString('base64') });
const noFolders = () => fs.readdirSync(tmp);

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-new-flow-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the name and the place', () => {
  it('turns any name into a folder name a disk and the guard can take', () => {
    expect(folderNameFor('Visitor log')).toBe('Visitor log');
    expect(folderNameFor('سجل الزوار')).toBe('سجل الزوار');
    expect(folderNameFor('  a/b\\c:d*e?f"g<h>i|j  ')).toBe('a b c d e f g h i j');
    expect(folderNameFor('..hidden')).toBe('hidden');
    expect(folderNameFor('ends with dots...')).toBe('ends with dots');
    expect(folderNameFor('line\nbreak')).toBe('line break');
    expect(folderNameFor('../../etc')).toBe('etc');
    expect(folderNameFor('...')).toBe('');
    expect([...folderNameFor('ن'.repeat(200))]).toHaveLength(80);
  });

  it('asks for what is missing, in plain words, before anything is made', () => {
    const where = tmp;
    expect(() => newProjectFolder({ where, idea: IDEA })).toThrow('Give the project a name.');
    expect(() => newProjectFolder({ name: '///', where, idea: IDEA })).toThrow('Give the project a name.');
    expect(() => newProjectFolder({ name: 'A', where })).toThrow('Add your BRD, or say what you want to build.');
    expect(() => newProjectFolder({ name: 'A', where, idea: '   ' })).toThrow('Add your BRD, or say what you want to build.');
    expect(() => newProjectFolder({ name: 'A', where, idea: IDEA, text: 'a BRD' })).toThrow('not both');
    expect(() => newProjectFolder({ name: 'A', where: path.join(tmp, 'nowhere'), idea: IDEA })).toThrow('There is no folder at');
    expect(noFolders()).toEqual([]);
  });

  it('never takes a folder that is there already', () => {
    fs.mkdirSync(path.join(tmp, 'Taken'));
    fs.writeFileSync(path.join(tmp, 'Taken', 'mine.txt'), 'keep me');
    expect(() => makeNewProject({ name: 'Taken', where: tmp, idea: IDEA })).toThrow('Taken is there already');
    expect(fs.readdirSync(path.join(tmp, 'Taken'))).toEqual(['mine.txt']);
  });

  it('never goes inside another project, which would open that project instead', () => {
    const made = makeNewProject({ name: 'Outer', where: tmp, idea: IDEA });
    const inner = path.join(made.bp.root, 'src');
    fs.mkdirSync(inner);
    expect(whyNotHere(made.bp.root)).toContain('inside the project Outer');
    expect(() => makeNewProject({ name: 'Inner', where: inner, idea: IDEA })).toThrow('inside the project Outer');
    expect(fs.readdirSync(inner)).toEqual([]);
  });

  it("never goes inside someone's code, which would land it in that repo's history", () => {
    const repo = path.join(tmp, 'code');
    fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
    execSync('git init -q', { cwd: repo });
    expect(whyNotHere(path.join(repo, 'sub'))).toContain("inside another project's code");
    expect(() => makeNewProject({ name: 'Inner', where: path.join(repo, 'sub'), idea: IDEA })).toThrow("inside another project's code");
    expect(fs.readdirSync(path.join(repo, 'sub'))).toEqual([]);
  });

  it('goes in Documents unless the person picks another place, and in the home folder with no Documents', () => {
    const home = process.env.HOME;
    try {
      process.env.HOME = tmp;
      expect(defaultPlace()).toBe(tmp);
      fs.mkdirSync(path.join(tmp, 'Documents'));
      expect(defaultPlace()).toBe(path.join(tmp, 'Documents'));
      const made = makeNewProject({ name: 'Here', idea: IDEA });
      expect(made.bp.root).toBe(path.join(tmp, 'Documents', 'Here'));
    } finally {
      process.env.HOME = home;
    }
  });
});

describe('from an idea', () => {
  it('makes the folder, git and the board, and the first read takes the idea in', () => {
    const made = makeNewProject({ name: 'Visitor log', where: tmp, idea: `  ${IDEA}\n` });
    expect(made.opens).toBe('/setup');
    expect(made.bp.root).toBe(path.join(tmp, 'Visitor log'));
    expect(isRepo(made.bp.root)).toBe(true);
    expect(execSync('git log --oneline', { cwd: made.bp.root, encoding: 'utf8' }).trim().split('\n')).toHaveLength(1);
    const meta = readMeta(made.bp);
    expect(meta.project).toBe('Visitor log');
    expect(meta.scan?.status).toBe('pending');
    expect(meta.setup?.kind).toBe('empty');
    expect(readIdea(made.bp)).toBe(IDEA);
  });

  it('does not ask again what the person just said, on the setup page, on Home or on the Overview', () => {
    const made = makeNewProject({ name: 'Visitor log', where: tmp, idea: IDEA });
    expect(setupView(made.bp)!.steps.find((s) => s.id === 'read')!.label).toBe('The Architect reads what you want to build');
    expect(overviewView(made.bp).handover).toBe('reading');

    const idea = readIdea(made.bp);
    saveScan(made.bp, { empty: true, summary: 'A visitor log.', ideas: [{ title: 'Sign in at the door', why: 'The first thing people do.' }] } as never, [], undefined, idea);
    readAgainDone(made.bp);
    const m = readMeta(made.bp);
    for (const st of m.setup!.steps) if (st.state === 'todo') st.state = 'done';
    writeMeta(made.bp, m);

    const v = setupView(made.bp)!;
    expect(v).toMatchObject({ ready: true, empty: true, idea: true });
    expect(setupLine(v)).toBe('Your first stories are ready to check');
    const o = overviewView(made.bp);
    expect(o.idea).toBe(IDEA);
    expect(o.ideas.map((i) => i.title)).toEqual(['Sign in at the door']);
    expect(o.brd).toBeUndefined();
    // Nothing else changes: approving it works as on any new project.
    expect(approveOverview(made.bp).handover).toBe('approved');
  });

  it('still asks on an empty folder added by hand, where nobody said anything yet', () => {
    const made = makeNewProject({ name: 'Visitor log', where: tmp, idea: IDEA });
    fs.rmSync(path.join(made.bp.localDir, 'overview-talk.json'));
    saveScan(made.bp, { empty: true, summary: 'Nothing yet.' } as never, []);
    const m = readMeta(made.bp);
    for (const st of m.setup!.steps) if (st.state === 'todo') st.state = 'done';
    writeMeta(made.bp, m);
    expect(setupLine(setupView(made.bp)!)).toBe('One question for you: what do you want to build?');
    // The answer there goes to a read as before.
    expect(tellIdea(made.bp, IDEA).idea).toBe(true);
  });
});

describe('from a BRD', () => {
  it('goes to the Analyst, with no read of an empty folder and nothing to approve', () => {
    const made = makeNewProject({ name: 'Visitor log', where: tmp, file: brd() });
    const [b] = listBreakdowns(made.bp);
    expect(made.opens).toBe(`/requirements/${b!.id}`);
    const meta = readMeta(made.bp);
    // Nothing starts an AI run for the setup, and the Analyst's first step waits for the squad.
    expect(meta.scan).toMatchObject({ status: 'done', empty: true });
    expect(nextProofStep(meta.setup)).toBeFalsy();
    expect(breakdownJobs(made.bp, meta).map((j) => j.id)).toEqual([b!.id]);
    expect(setupView(made.bp)).toMatchObject({ approved: true, ready: true, brd: { id: b!.id, title: 'visitors' } });
    expect(fs.existsSync(path.join(made.bp.root, '.git'))).toBe(true);
  });

  it('takes pasted text too', () => {
    const made = makeNewProject({ name: 'Pasted', where: tmp, text: '# The visitor log\n\nPeople sign in.\n' });
    expect(listBreakdowns(made.bp)[0]).toMatchObject({ title: 'The visitor log' });
  });

  it('the Overview points at the BRD and says nobody approved anything, until the first release', () => {
    const made = makeNewProject({ name: 'Visitor log', where: tmp, file: brd() });
    const o = overviewView(made.bp);
    expect(o).toMatchObject({ handover: 'approved', empty: true, old: false, brd: { title: 'visitors' } });
    expect(o.approved).toBeUndefined();

    const m = readMeta(made.bp);
    m.scan = { ...m.scan!, empty: false };
    writeMeta(made.bp, m);
    expect(overviewView(made.bp).brd).toBeUndefined();
    expect(setupView(made.bp)!.brd).toBeUndefined();
  });

  it.each([
    ['a kind squad-kit cannot read', { name: 'visitors.exe', data: 'AAAA' }],
    ['a Word file that is not one', { name: 'visitors.docx', data: Buffer.from('not a word file').toString('base64') }],
    ['an empty text file', { name: 'visitors.md', data: Buffer.from('  \n').toString('base64') }],
  ])('leaves nothing behind for %s, so Create works again', (_what, file) => {
    const projects = path.join(squadHome(), 'projects');
    const before = new Set(fs.existsSync(projects) ? fs.readdirSync(projects) : []);
    expect(() => makeNewProject({ name: 'Visitor log', where: tmp, file })).toThrow();
    expect(noFolders()).toEqual([]);
    const after = fs.existsSync(projects) ? fs.readdirSync(projects) : [];
    expect(after.filter((x) => !before.has(x))).toEqual([]);
    expect(makeNewProject({ name: 'Visitor log', where: tmp, file: brd() }).opens).toContain('/requirements/');
  });
});
