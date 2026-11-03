import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { buildPaths } from '../src/core/paths.js';
import { readMeta, writeMeta } from '../src/board/store.js';
import { prepareProject } from '../src/engine/setup.js';
import { writeOverview } from '../src/board/overview.js';
import { finish } from '../src/board/setup-state.js';
import { mountOverviewApi } from '../src/console/api/overview.js';
import { mountAppApi } from '../src/console/api/app.js';
import type { OpenProjects } from '../src/console/open-projects.js';

/** Every button of the setup page and the Overview is one REST call; Add project's folder listing says what it found. */

let tmp: string;
let api: Hono;
let root: string;

const call = async (method: string, url: string, body?: unknown) => {
  const res = await api.request(url, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
  return { status: res.status, data: (await res.json()) as Record<string, any> };
};

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-overview-api-')));
  root = path.join(tmp, 'roomflow');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'app.py'), 'print("hi")\n');
  prepareProject(root);
  api = new Hono();
  mountOverviewApi(api, { paths: buildPaths(root) });
  mountAppApi(api, { projects: {} as OpenProjects });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the setup and the Overview over REST', () => {
  it('shows the setup, stops it, starts it again and asks Quality once', async () => {
    const setup = await call('GET', '/api/v1/setup');
    expect(setup.data.setup).toMatchObject({ project: 'roomflow', kind: 'files', ready: false, total: 7, quality: 'best' });
    expect((await call('POST', '/api/v1/setup/stop')).data.steps.find((s: { state: string }) => s.state === 'stopped').id).toBe('tool');
    expect((await call('POST', '/api/v1/setup/again', { step: 'files' })).status).toBe(400);
    expect((await call('POST', '/api/v1/setup/again', {})).data.steps.some((s: { state: string }) => s.state === 'stopped')).toBe(false);
    expect((await call('POST', '/api/v1/setup/quality', { quality: 'balanced' })).data.setup).toMatchObject({ quality: 'balanced', qualityAsked: true });
  });

  it('approves only once the overview is ready, then makes a ticket from an idea', async () => {
    expect((await call('POST', '/api/v1/overview/approve')).status).toBe(400);
    const bp = prepareProject(root).bp;
    const meta = readMeta(bp);
    for (const st of meta.setup!.steps) if (st.state === 'todo') finish(meta.setup!, st.id, 'done');
    writeMeta(bp, meta);
    writeOverview(bp, { can: [], worth: [], parts: [], links: [], ideas: [{ title: 'Add tests', why: 'There are none.' }] });
    expect((await call('GET', '/api/v1/overview')).data).toMatchObject({ handover: 'ready', command: 'squad overview' });
    expect((await call('POST', '/api/v1/overview/approve')).data.handover).toBe('approved');
    const t = await call('POST', '/api/v1/overview/ideas/1');
    expect(t.data).toMatchObject({ title: 'Add tests', stage: 'tickets' });
    expect((await call('POST', '/api/v1/overview/ideas/4')).data.error).toBe('There is no idea 4. The overview has 1.');
  });

  it('opens the talk, sends a message, and closes it', async () => {
    expect((await call('POST', '/api/v1/overview/talk', {})).data.talk).toMatchObject({ open: true, thinking: true });
    expect((await call('POST', '/api/v1/overview/talk/close')).data.talk.open).toBe(false);
    const sent = await call('POST', '/api/v1/overview/talk', { text: 'The users have accounts' });
    expect(sent.data.talk.messages).toEqual([expect.objectContaining({ who: 'you', text: 'The users have accounts' })]);
    expect((await call('GET', '/api/v1/overview/talk')).data.talk.open).toBe(true);
  });

  it("Add project's folder listing says what squad-kit found and what happens next", async () => {
    const dir = path.join(tmp, 'site');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hi</h1>\n');
    const l = (await call('GET', `/api/v1/app/folders?path=${encodeURIComponent(dir)}`)).data;
    expect(l).toMatchObject({ kind: 'files', canAdd: true, look: { kind: 'files', title: 'Code without git', found: 'A web site with 1 file, not in git yet.' } });
    expect((await call('GET', `/api/v1/app/folders?path=${encodeURIComponent(os.homedir())}`)).data.look).toBeUndefined();
  });
});
