import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { boardPaths, readMeta, writeMeta, type BoardPaths } from '../src/board/store.js';
import { createTicket } from '../src/board/actions.js';
import { mountBoardApi } from '../src/console/api/board.js';
import { buildPaths } from '../src/core/paths.js';
import { allowPath, sharedPath } from '../src/engine/project-guard.js';
import { loadSecrets } from '../src/core/secrets.js';
import { MUNSIT_URL } from '../src/modules/munsit/speech.js';

/** Settings are checked when they are saved, not much later when a story or a note fails on them. Real git and real files. */

let tmp: string;
let project: string;
let bp: BoardPaths;
const sh = (cmd: string, cwd = project) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const api = () => {
  const app = new Hono();
  mountBoardApi(app, { paths: buildPaths(project) });
  return app;
};
const put = (url: string, body: unknown) => api().request(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const words = async (r: Response) => ((await r.json()) as { error?: string }).error;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-settings-')));
  project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  sh('git init -q -b main');
  fs.writeFileSync(path.join(project, 'a.txt'), 'x');
  sh('git add a.txt && git -c user.name=t -c user.email=t@t commit -q -m first && git branch develop');
  sh(`git init -q --bare -b main ${path.join(tmp, 'remote.git')}`, tmp);
  sh(`git remote add origin ${path.join(tmp, 'remote.git')} && git push -q origin main && git fetch -q origin`);
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
    git: { base: 'main', remote: 'origin' },
    scan: { status: 'done', empty: false },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('where the code goes', () => {
  it('a branch that does not exist is refused, naming the ones that do, and nothing is saved', async () => {
    const res = await put('/api/v1/settings', { git: { base: 'mian', remote: 'origin' } });
    expect(res.status).toBe(400);
    expect(await words(res)).toBe('There is no branch called "mian" here. It has: develop, main. Nothing was saved.');
    expect(readMeta(bp).git?.base).toBe('main');
  });

  it('a remote that does not exist is refused the same way', async () => {
    const res = await put('/api/v1/settings', { git: { base: 'main', remote: 'upstream' } });
    expect(res.status).toBe(400);
    expect(await words(res)).toBe('There is no remote called "upstream" here. It has: origin. Nothing was saved.');
    expect(readMeta(bp).git?.remote).toBe('origin');
  });

  it('real ones save; so does no remote at all; and a branch only on the remote counts', async () => {
    expect((await put('/api/v1/settings', { git: { base: 'develop', remote: '' } })).status).toBe(200);
    expect(readMeta(bp).git).toEqual({ base: 'develop', remote: '' });
    sh('git push -q origin develop:only-there && git fetch -q origin');
    expect((await put('/api/v1/settings', { git: { base: 'only-there', remote: 'origin' } })).status).toBe(200);
  });

  it('a folder with no commits yet has nothing to check', async () => {
    const meta = readMeta(bp);
    const fresh = path.join(tmp, 'fresh');
    fs.mkdirSync(fresh);
    sh('git init -q -b main', fresh);
    project = fresh;
    bp = boardPaths(path.join(fresh, '.squad'));
    writeMeta(bp, { ...meta, git: { base: 'main', remote: '' } });
    expect((await put('/api/v1/settings', { git: { base: 'trunk', remote: '' } })).status).toBe(200);
  });

  it('each repo of a project with several is checked in its own folder', async () => {
    const part = path.join(project, 'api');
    fs.mkdirSync(part);
    sh('git init -q -b trunk && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m first', part);
    writeMeta(bp, { ...readMeta(bp), repos: [{ path: 'api', base: 'trunk', remote: '', commands: {} } as never] });
    const res = await put('/api/v1/settings', { repos: [{ path: 'api', base: 'main' }] });
    expect(res.status).toBe(400);
    expect(await words(res)).toContain('There is no branch called "main" here. It has: trunk.');
    expect((await put('/api/v1/settings', { repos: [{ path: 'api', base: 'trunk' }] })).status).toBe(200);
  });
});

describe('the speech key', () => {
  const answering = (status: number) => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      asked.push(`${url} ${new Headers(init.headers).get('authorization')}`);
      return new Response('{}', { status });
    });
    return asked;
  };

  it('a wrong key is not saved, and says so; it never shows "is set up"', async () => {
    const asked = answering(401);
    const res = await put('/api/v1/speech', { munsit: 'not-a-real-key' });
    expect(res.status).toBe(400);
    expect(await words(res)).toBe('Munsit did not accept this key, so it was not saved. Copy it again from your Munsit account.');
    expect(asked).toEqual([`${MUNSIT_URL} Bearer not-a-real-key`]);
    expect(((await (await api().request('/api/v1/speech')).json()) as { hasKey: boolean }).hasKey).toBe(false);
    expect(loadSecrets(bp.secretsFile).speech).toBeUndefined();
  });

  it('a good key is saved: a call with no sound in it is turned down for the sound, not the key', async () => {
    answering(422);
    const res = await put('/api/v1/speech', { munsit: 'good-key' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, hasKey: true });
    expect(loadSecrets(bp.secretsFile).speech?.munsit).toBe('good-key');
  });

  it('with no answer from Munsit it is saved, and says it could not be checked', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    const res = await put('/api/v1/speech', { munsit: 'good-key' });
    expect(await res.json()).toEqual({ ok: true, hasKey: true, unchecked: true });
  });

  it('says what is true for this computer about video', async () => {
    const said = (await (await api().request('/api/v1/speech')).json()) as { video: boolean };
    expect(said.video).toBe(process.platform === 'darwin');
  });
});

describe('what the project commands may reach', () => {
  it("a place in this person's home goes in the team's file as ~, so it works on any computer", async () => {
    const res = await put('/api/v1/settings', { guard: { allowRead: [path.join(os.homedir(), 'shared', 'data')], allowWrite: ['~/out', '/opt/tools'] } });
    expect(res.status).toBe(200);
    expect(readMeta(bp).guard).toEqual({ allowRead: ['~/shared/data'], allowWrite: ['~/out', '/opt/tools'] });
    expect(fs.readFileSync(bp.configFile, 'utf8')).not.toContain(os.homedir());
  });

  it('each computer reads it as its own home', () => {
    expect(allowPath('~/shared/data', '/home/sara')).toBe('/home/sara/shared/data');
    expect(allowPath('~/shared/data', '/home/omar')).toBe('/home/omar/shared/data');
    expect(sharedPath('/home/sara/x', '/home/sara')).toBe('~/x');
    expect(sharedPath('/home/sara', '/home/sara')).toBe('~');
    expect(sharedPath('/home/sarah/x', '/home/sara')).toBe('/home/sarah/x');
  });
});

describe('Create sent twice', () => {
  const create = (body: object) => api().request('/api/v1/tickets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('the same one-time key gets the ticket it made, and only one ticket exists', async () => {
    const first = (await (await create({ title: 'Add a coupon', key: 'k-1' })).json()) as { id: string };
    const again = (await (await create({ title: 'Add a coupon', key: 'k-1' })).json()) as { id: string };
    expect(again.id).toBe(first.id);
    expect(fs.readdirSync(bp.ticketsDir)).toEqual([first.id]);
  });

  it('a new key, or no key, makes a new one; and the same key with other words is another ticket', async () => {
    const a = (await (await create({ title: 'One', key: 'k-1' })).json()) as { id: string };
    const b = (await (await create({ title: 'One', key: 'k-2' })).json()) as { id: string };
    const c = (await (await create({ title: 'One' })).json()) as { id: string };
    const d = (await (await create({ title: 'Something else', key: 'k-1' })).json()) as { id: string };
    expect(new Set([a.id, b.id, c.id, d.id]).size).toBe(4);
  });

  it('after a restart too: the key lives with the ticket', () => {
    const t = createTicket(bp, { title: 'Kept', key: 'k-9' });
    expect(createTicket(boardPaths(path.join(project, '.squad')), { title: 'Kept', key: 'k-9' }).id).toBe(t.id);
  });
});
