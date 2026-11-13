import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Hono } from 'hono';
import type { FakeGithub } from './fakes/github.js';

/** Connecting GitHub through the board's REST calls, and its backlog, with gh and GitHub faked. */

const state = vi.hoisted(() => ({ fake: null as FakeGithub | null }));
vi.mock('../src/modules/github/auth.js', () => ({
  githubToken: async () => 'token',
  githubApi: (p: string, i?: { method?: string; body?: unknown }) => state.fake!.calls.rest(p, i),
  githubGraphql: (q: string, v?: Record<string, unknown>) => state.fake!.calls.graphql(q, v),
}));
vi.mock('../src/modules/github/sign-in.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/modules/github/sign-in.js')>()),
  signInSteps: async (forProject: boolean) => (forProject ? [{ say: 'Let it use Projects', command: 'gh auth refresh -s project' }] : []),
}));

const { fakeGithub } = await import('./fakes/github.js');
const { mountApi } = await import('../src/console/api/index.js');
const { buildPaths } = await import('../src/core/paths.js');
const { DEFAULT_CONFIG, saveConfig } = await import('../src/core/config.js');
const { boardPaths, readTicket, readMeta, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');

let tmp = '';
beforeEach(() => {
  state.fake = fakeGithub();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-gh-api-')));
  vi.stubEnv('SQUAD_KIT_HOME', path.join(tmp, 'home'));
  execFileSync('git', ['init', '-q', tmp]);
  execFileSync('git', ['-C', tmp, 'remote', 'add', 'origin', 'git@github.com:octo/shop.git']);
  fs.mkdirSync(path.join(tmp, '.squad'));
  saveConfig(buildPaths(tmp).configFile, DEFAULT_CONFIG);
  const bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  writeMeta(bp, { ...readMeta(bp), engine: 'live' });
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const app = () => {
  const a = new Hono();
  mountApi(a, { paths: buildPaths(tmp) });
  return a;
};
const json = async <T>(r: Response | Promise<Response>) => (await r).json() as Promise<T>;
const put = (a: Hono, body: unknown) => a.request('/api/v1/tracker', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

type Form = { type: string; module: string; label: string; values: Record<string, string>; modules: { name: string }[]; steps: { command?: string }[]; user?: string; example?: string };

describe('connecting GitHub on the board', () => {
  it("offers every tracker, and a GitHub remote opens GitHub's fields with its repo", async () => {
    const a = app();
    const form = await json<Form>(a.request('/api/v1/tracker'));
    expect(form).toMatchObject({ type: 'none', module: 'github', label: 'GitHub', values: { repo: 'octo/shop', from: 'issues' } });
    expect(form.modules.map((m) => m.name)).toEqual(['azure', 'github']);
    expect((await json<Form>(a.request('/api/v1/tracker?module=azure'))).module).toBe('azure');
  });

  it('lists the Projects, connects one, and says what gh still needs for it', async () => {
    const a = app();
    const lists = await json<{ lists: { board: { value: string }[] } }>(a.request('/api/v1/tracker/choices?module=github&repo=octo/shop&from=project'));
    expect(lists.lists.board.map((b) => b.value)).toEqual(['octo/2']);
    expect(await json(put(a, { module: 'github', repo: 'octo/shop', from: 'project', board: 'octo/2' }))).toEqual({ ok: true, user: 'momen' });
    const form = await json<Form>(a.request('/api/v1/tracker'));
    expect(form).toMatchObject({ type: 'github', user: 'momen', example: '#40', values: { board: 'octo/2', 'stage-closed': 'Done' } });
    expect(form.steps.map((s) => s.command)).toEqual(['gh auth refresh -s project']);
  });

  it("a save GitHub refuses keeps the old settings and says why", async () => {
    const a = app();
    const r = await put(a, { module: 'github', repo: 'octo/nope', from: 'issues' });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/no repository octo\/nope/);
    expect((await json<Form>(a.request('/api/v1/tracker'))).type).toBe('none');
  });

  it("shows the board's backlog and starts a story from another repo as its own ticket", async () => {
    const a = app();
    await put(a, { module: 'github', repo: 'octo/shop', from: 'project', board: '2' });
    const backlog = await json<{ connected: boolean; sprints: { current: boolean }[]; items: { ref: string; state: string }[] }>(a.request('/api/v1/backlog'));
    expect(backlog.connected).toBe(true);
    expect(backlog.items.map((i) => `${i.ref} ${i.state}`)).toEqual(['#40 Todo']);
    const all = await json<{ items: { ref: string }[] }>(a.request('/api/v1/backlog?sprint=all'));
    expect(all.items.map((i) => i.ref)).toEqual(['#40', 'octo/api#7']);
    const started = await json<{ id: string; source: { ref: string } }>(a.request(`/api/v1/backlog/${encodeURIComponent('octo/api#7')}/start`, { method: 'POST' }));
    expect(started).toMatchObject({ id: 'GH-OCTO-API-7', source: { ref: 'octo/api#7' } });
    expect(readTicket(boardPaths(path.join(tmp, '.squad')), 'GH-OCTO-API-7')?.trackerQueue).toEqual([{ kind: 'started' }]);
    // Its own repo's issue shows as #40 and is kept whole, so it stays the same issue.
    const own = await json<{ id: string; source: { ref: string; id: string } }>(a.request(`/api/v1/backlog/${encodeURIComponent('octo/shop#40')}/start`, { method: 'POST' }));
    expect(own).toMatchObject({ id: 'GH-40', source: { ref: '#40', id: 'octo/shop#40' } });
    const listed = await json<{ items: { ref: string; ticket: { id: string } | null }[] }>(a.request('/api/v1/backlog'));
    expect(listed.items).toMatchObject([{ ref: '#40', ticket: { id: 'GH-40' } }]);
  });

  it('says when only the first items are shown, and when a setup from before only reads', async () => {
    state.fake = fakeGithub({ endless: true });
    const a = app();
    saveConfig(buildPaths(tmp).configFile, { ...DEFAULT_CONFIG, tracker: { type: 'github', workspace: 'octo', project: 'shop', options: { from: 'project', board: 'octo/2', boardId: 'PVT_board2' } } });
    expect((await json<Form & { note?: string }>(a.request('/api/v1/tracker'))).note).toBe('Connect again to let squad-kit update GitHub.');
    expect(await json<{ capped?: boolean }>(a.request('/api/v1/backlog'))).toMatchObject({ capped: true });
    await put(a, { module: 'github', repo: 'octo/shop', from: 'project', board: '2' });
    expect((await json<Form & { note?: string }>(a.request('/api/v1/tracker'))).note).toBeUndefined();
  });
});
