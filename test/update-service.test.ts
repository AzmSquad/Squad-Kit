import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import yaml from 'js-yaml';
import type { InstalledPackage } from '../src/core/package-info.js';
import type { InstallResult } from '../src/core/update.js';
import { UpdateService, type UpdateDeps, type WorkItem } from '../src/console/updates.js';

/**
 * The Update button's engine, with a fake registry, a fake installer and a fake restart: it never reaches npm or
 * GitHub and never installs anything.
 */

const home = () => process.env.SQUAD_KIT_HOME!;
const updateFile = () => path.join(home(), 'update.json');

function installed(version: string, more: Partial<InstalledPackage> = {}): () => InstalledPackage {
  return () => ({ name: 'squad-kit', version, root: '/usr/local/lib/node_modules/squad-kit', repositoryUrl: 'https://github.com/AzmSquad/squad-kit', isDevInstall: false, ...more });
}

/** npm says `latest`; GitHub has notes for it. Every call is kept. */
function registry(latest: string, calls: string[] = []): typeof fetch {
  return (async (url: string) => {
    calls.push(url);
    if (url.startsWith('https://registry.npmjs.org/')) return Response.json({ 'dist-tags': { latest }, versions: { [latest]: {}, '1.0.1': {} } });
    if (url.includes('/releases/tags/')) {
      return Response.json({ body: '- Delete a ticket from the board\n- Start your app with one click', html_url: `https://github.com/AzmSquad/squad-kit/releases/tag/v${latest}` });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

const okInstall = async (): Promise<InstallResult> => ({ ok: true, code: 0, output: 'added 1 package', timedOut: false });

async function until(check: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

let ua: string | undefined;
let held: boolean[];
let restarts: number;

function service(more: UpdateDeps = {}): UpdateService {
  return new UpdateService({
    fetch: registry('1.0.2'),
    installed: installed('1.0.1'),
    install: okInstall,
    hold: (on) => void held.push(on),
    restart: () => void (restarts += 1),
    busy: () => [],
    carrying: () => [{ project: 'roomflow', ticket: 'RO-7', title: 'Booking page' }],
    ...more,
  });
}

beforeEach(() => {
  ua = process.env.npm_config_user_agent;
  delete process.env.npm_config_user_agent;
  fs.rmSync(updateFile(), { force: true });
  fs.writeFileSync(path.join(home(), 'settings.yaml'), 'checkForUpdates: false\n');
  held = [];
  restarts = 0;
});

afterEach(() => {
  if (ua !== undefined) process.env.npm_config_user_agent = ua;
});

describe('checking for updates', () => {
  it('finds a newer version on npm, with what is new from GitHub and the one command', async () => {
    const s = await service().check();
    expect(s).toMatchObject({
      current: '1.0.1',
      latest: '1.0.2',
      newer: true,
      major: false,
      notes: ['Delete a ticket from the board', 'Start your app with one click'],
      notesUrl: 'https://github.com/AzmSquad/squad-kit/releases/tag/v1.0.2',
      devInstall: false,
      command: 'npm install -g squad-kit@1.0.2',
      progress: { state: 'idle' },
    });
    expect(Date.parse(s.checkedAt!)).toBeGreaterThan(Date.now() - 5000);
    // Kept for the next start and the other pages.
    expect(new UpdateService({ installed: installed('1.0.1') }).status()).toMatchObject({ latest: '1.0.2', newer: true });
  });

  it('says it could not reach npm, and keeps what it knew', async () => {
    await service().check();
    const s = await service({ fetch: (async () => Promise.reject(new Error('offline'))) as unknown as typeof fetch }).check();
    expect(s.checkError).toBe('Could not reach the npm registry. Check the internet connection.');
    expect(s.latest).toBe('1.0.2');
  });

  it('looks on start and then once a day, only while the setting is on', async () => {
    const calls: string[] = [];
    const svc = service({ fetch: registry('1.0.1', calls) });
    svc.watch()();
    expect(calls).toEqual([]);

    svc.prefs({ daily: true });
    expect(yaml.load(fs.readFileSync(path.join(home(), 'settings.yaml'), 'utf8'))).toEqual({ checkForUpdates: true });
    const stop = svc.watch();
    await until(() => calls.length > 0);
    stop();
    expect(calls[0]).toBe('https://registry.npmjs.org/squad-kit');
    // On the latest version: no release notes are fetched.
    expect(calls).toHaveLength(1);
    expect(svc.status()).toMatchObject({ newer: false, daily: true });
  });

  it('keeps Later for one version', async () => {
    const svc = service();
    await svc.check();
    expect(svc.prefs({ later: '1.0.2' }).later).toBe('1.0.2');
    expect(service().status().later).toBe('1.0.2');
  });
});

describe('Update now', () => {
  it('installs with the right command, then restarts through the keeper, holding new runs', async () => {
    const asked: string[][] = [];
    // The install changes the files on disk; this app still runs the code it started with.
    let onDisk = '1.0.1';
    const svc = service({ installed: () => installed(onDisk)(), install: async (cmd, args) => (asked.push([cmd, ...args]), (onDisk = '1.0.2'), okInstall()) });
    await svc.check();
    await svc.start();
    await until(() => restarts === 1);
    expect(asked).toEqual([['npm', 'install', '-g', 'squad-kit@1.0.2']]);
    expect(held).toEqual([true]);
    expect(svc.status()).toMatchObject({ current: '1.0.1', progress: { state: 'restarting', from: '1.0.1', to: '1.0.2', carried: [{ ticket: 'RO-7' }] } });

    // The fresh app runs the new version: the update is done, and the note names what carried on.
    const after = new UpdateService({ installed: installed('1.0.2') }).status();
    expect(after.progress).toMatchObject({ state: 'done', from: '1.0.1', to: '1.0.2', carried: [{ project: 'roomflow', ticket: 'RO-7', title: 'Booking page' }] });
    expect(after.notes).toEqual(['Delete a ticket from the board', 'Start your app with one click']);
    expect(new UpdateService({ installed: installed('1.0.2') }).close().progress.state).toBe('idle');
  });

  it('says so when the fresh app still runs the old version', async () => {
    const svc = service();
    await svc.check();
    await svc.start();
    await until(() => restarts === 1);
    const after = new UpdateService({ installed: installed('1.0.1') }).status();
    expect(after.progress).toMatchObject({ state: 'failed', to: '1.0.2' });
    expect(after.progress.reason).toContain('still runs 1.0.1');
    expect(after.command).toBe('npm install -g squad-kit@1.0.2');
  });

  it('waits until no agent is in the middle of a step, unless the person says Now', async () => {
    let busy: WorkItem[] = [{ project: 'roomflow', ticket: 'RO-7', title: 'Booking page' }];
    const svc = service({ busy: () => busy });
    await svc.check();
    expect((await svc.start()).progress).toMatchObject({ state: 'waiting', busy, waitedFor: busy });
    expect(held).toEqual([true]);
    expect(restarts).toBe(0);
    busy = [];
    await until(() => restarts === 1);
    expect(svc.status().progress).toMatchObject({ state: 'restarting', waitedFor: [{ ticket: 'RO-7' }] });

    fs.rmSync(updateFile(), { force: true });
    busy = [{ project: 'roomflow', ticket: 'RO-9', title: 'Rooms list' }];
    const now = service({ busy: () => busy });
    await now.check();
    expect((await now.start()).progress.state).toBe('waiting');
    expect((await now.start({ now: true })).progress).toMatchObject({ now: true });
    await until(() => restarts === 2);
  });

  it('Not now stops waiting and lets new runs start again', async () => {
    const svc = service({ busy: () => [{ project: 'roomflow', ticket: 'RO-7', title: 'Booking page' }] });
    await svc.check();
    await svc.start();
    expect(svc.close().progress.state).toBe('idle');
    expect(held).toEqual([true, false]);
    await new Promise((r) => setTimeout(r, 1300));
    expect(restarts).toBe(0);
  });

  it('a failed install gives the one command to copy and a plain reason, and Restart after it', async () => {
    const svc = service({ install: async () => ({ ok: false, code: 243, output: 'npm ERR! code EACCES\nnpm ERR! permission denied', timedOut: false }) });
    await svc.check();
    await svc.start();
    await until(() => svc.status().progress.state === 'failed');
    const s = svc.status();
    expect(s.progress).toMatchObject({ state: 'failed', to: '1.0.2', permission: true, reason: 'This computer needs your permission to install.' });
    expect(s.progress.output).toContain('EACCES');
    expect(s.command).toBe('npm install -g squad-kit@1.0.2');
    expect(held).toEqual([true, false]);
    expect(restarts).toBe(0);

    // The person ran it in a terminal, then pressed Restart.
    expect(svc.restartNow().progress).toMatchObject({ state: 'restarting', to: '1.0.2' });
    expect(restarts).toBe(1);
  });

  it('a source checkout only gets the command; a major version never installs by itself', async () => {
    const dev = service({ installed: installed('1.0.1', { isDevInstall: true }) });
    await dev.check();
    expect(dev.status().devInstall).toBe(true);
    await expect(dev.start()).rejects.toThrow('Run: npm install -g squad-kit@1.0.2');

    fs.rmSync(updateFile(), { force: true });
    const major = service({ fetch: registry('2.0.0') });
    await major.check();
    expect(major.status().major).toBe(true);
    await expect(major.start()).rejects.toThrow('big change');

    fs.rmSync(updateFile(), { force: true });
    const latest = service({ fetch: registry('1.0.1') });
    await expect(latest.start()).rejects.toThrow('You are on the latest version (1.0.1).');
    expect(held).toEqual([]);
  });

  it('an update cut off by closing the app is not left installing', () => {
    fs.writeFileSync(updateFile(), JSON.stringify({ latest: '1.0.2', progress: { state: 'installing', from: '1.0.1', to: '1.0.2' } }));
    const s = new UpdateService({ installed: installed('1.0.1') }).status();
    expect(s.progress).toMatchObject({ state: 'failed', reason: 'squad-kit closed while it installed the update. Try again.' });
  });
});
