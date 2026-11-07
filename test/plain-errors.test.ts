import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { Hono } from 'hono';
import { act } from '../src/console/api/act.js';
import { RawError, SOMETHING_TECHNICAL, wordsForPeople } from '../src/core/for-people.js';
import { recentLines } from '../src/core/app-log.js';
import { boardPaths, writeMeta, type BoardPaths } from '../src/board/store.js';
import { BoardActionError } from '../src/board/actions.js';
import { StepError } from '../src/board/problem.js';
import { git } from '../src/engine/git.js';
import { mountBoardApi } from '../src/console/api/board.js';
import { mountRequirementsApi } from '../src/console/api/requirements.js';
import { addBreakdown } from '../src/board/requirements-actions.js';
import { buildPaths } from '../src/core/paths.js';
import { Azure, AzureError } from '../src/modules/azure/client.js';

/** Any error used to reach a toast as it was. Only words meant for a person pass now, and the raw ones go to the app log. */

let tmp: string;
let project: string;
let bp: BoardPaths;

const raised = async (err: unknown) => {
  const app = new Hono();
  app.post('/try', (c) =>
    act(c, () => {
      throw err;
    }),
  );
  const res = await app.request('/try', { method: 'POST' });
  return { status: res.status, error: ((await res.json()) as { error: string }).error };
};

const rawGit = () => {
  try {
    git(tmp, ['not-a-git-command']);
  } catch (err) {
    return err;
  }
  throw new Error('git should have failed');
};
const rawCommand = () => {
  try {
    execFileSync('/bin/sh', ['-c', 'echo boom >&2; exit 3'], { stdio: 'pipe' });
  } catch (err) {
    return err;
  }
  throw new Error('the command should have failed');
};
const rawYaml = () => {
  try {
    yaml.load('a: [not closed');
  } catch (err) {
    return err;
  }
  throw new Error('yaml should have failed');
};
const rawFile = () => {
  try {
    fs.readFileSync(path.join(tmp, 'not-there'));
  } catch (err) {
    return err;
  }
  throw new Error('the read should have failed');
};

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-plain-')));
  project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  execSync('git init -q -b main', { cwd: project });
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
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('what reaches a toast', () => {
  it.each([
    ["git's own words", rawGit, /not-a-git-command/],
    ['a command that failed', rawCommand, /boom|Command failed/],
    ['a broken YAML file', rawYaml, /not closed|unexpected end/],
    ['a file error with its code', rawFile, /ENOENT/],
    ['a language error', () => new TypeError("Cannot read properties of undefined (reading 'steps')"), /Cannot read properties/],
    ['a raw line squad-kit wrapped', () => new RawError('git push failed: fatal: bad ref'), /bad ref/],
  ])('%s: one plain sentence, a 500 for Try again, and the exact words in the log', async (_what, make, words) => {
    const r = await raised((make as () => unknown)());
    expect(r).toEqual({ status: 500, error: SOMETHING_TECHNICAL });
    expect(r.error).not.toMatch(/git|ENOENT|YAML|undefined|Command/);
    expect(recentLines(60_000).join('\n')).toMatch(words as RegExp);
  });

  it.each([
    ['a board action', new BoardActionError('A ticket needs a title.')],
    ["squad-kit's own sentence", new Error('Give the project a name.')],
    ['a stop', new StepError('It took longer than 30 minutes, so squad-kit stopped it.', 'detail')],
    ['a service, in its module', new AzureError('Azure DevOps did not accept the sign-in. Check it in Settings.', 401)],
  ])('%s passes as it is, as a 400', async (_what, err) => {
    expect(await raised(err)).toEqual({ status: 400, error: (err as Error).message });
  });

  it('a full disk has its own words, whichever route it came through', async () => {
    const full = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    expect((await raised(full)).error).toBe('The disk is full, so squad-kit cannot save its work. Free up some space. Nothing is lost, and squad-kit carries on by itself.');
  });

  it('what is not meant for a person is told apart from what is', () => {
    expect(wordsForPeople(new Error('Give it a name.'))).toBe('Give it a name.');
    expect(wordsForPeople(new Error(''))).toBeNull();
    expect(wordsForPeople('a string')).toBeNull();
    expect(wordsForPeople(Object.assign(new Error('EBUSY: busy'), { code: 'EBUSY' }))).toBeNull();
    expect(wordsForPeople(rawGit())).toBeNull();
    expect(wordsForPeople(new DOMException('stopped', 'AbortError'))).toBeNull();
  });
});

describe('through real routes', () => {
  const app = () => {
    const a = new Hono();
    mountBoardApi(a, { paths: buildPaths(project) });
    mountRequirementsApi(a, { paths: buildPaths(project) });
    return a;
  };
  const post = (url: string, body: unknown = {}) => app().request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('a raw error while making a ticket reads as one plain sentence', async () => {
    const real = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, opts) => {
      if (String(file).includes('.squad') || String(file).includes('config')) throw Object.assign(new Error('EBUSY: resource busy or locked, open'), { code: 'EBUSY' });
      real(file, data, opts);
    });
    const res = await post('/api/v1/tickets', { title: 'A ticket' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: SOMETHING_TECHNICAL });
  });

  it('this computer\'s own part damaged: a plain sentence, not a YAML error', async () => {
    fs.writeFileSync(bp.localMetaFile, 'user: [not closed');
    const res = await post('/api/v1/tickets', { title: 'A ticket' });
    const said = ((await res.json()) as { error: string }).error;
    expect(said).toBe(SOMETHING_TECHNICAL);
  });

  it('the same on a breakdown route', async () => {
    const b = addBreakdown(bp, { text: '# BRD\n\nWords.\n' });
    const real = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).includes('requirements')) throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
      real(from, to);
    });
    const res = await post(`/api/v1/requirements/${b.id}/stop`);
    expect(await res.json()).toEqual({ error: SOMETHING_TECHNICAL });
  });
});

describe('words in stops', () => {
  it('a tracker that refuses says so with no status or scopes, and the exact answer is in the log', async () => {
    const fake = (async () => new Response(JSON.stringify({ message: 'TF400813: needs vso.work_write scope' }), { status: 401 })) as unknown as typeof fetch;
    const azure = new Azure({ organization: 'org', project: 'proj', pat: 'pat' }, fake);
    const said = await azure.whoAmI().catch((e: Error) => e.message);
    expect(said).toBe('Azure DevOps did not accept the sign-in. Check it in Settings. An engineer can see why in the log.');
    expect(said).not.toMatch(/HTTP|scope|token|TF\d+/i);
    expect(recentLines(60_000).join('\n')).toContain('TF400813');
  });
});
