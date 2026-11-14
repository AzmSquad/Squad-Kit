import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { privateFolder } from '../src/core/home.js';
import { useAtlassianApp } from '../src/modules/jira/atlassian-app.js';
import { holdRefreshLock } from '../src/modules/jira/atlassian-lock.js';
import { signOutOfAtlassian } from '../src/modules/jira/atlassian-sign-in.js';
import { freshDates, readAtlassianSignIn, writeAtlassianSignIn } from '../src/modules/jira/atlassian-store.js';
import { atlassianToken, forgetAtlassianFailure, forgetAtlassianTokens, keepAccess } from '../src/modules/jira/atlassian-token.js';
import { jiraConnection } from '../src/modules/jira/connection.js';
import { SITE } from './fakes/jira.js';
import { CLOUD, OTHER, fakeAtlassian, type FakeAtlassian } from './support/fake-atlassian.js';

/**
 * Refreshing squad-kit's Atlassian sign-in when two want it at once (ADR-012). Atlassian rotates the refresh token, so
 * a second refresh with the same one is refused: one refresh at a time, shared in one squad-kit and held by a lock
 * file across squad-kits on this computer (the board and a terminal). A late answer never writes over a newer sign-in.
 */

let fake: FakeAtlassian;
const PACE = { settleMs: 20, lockWaitMs: 5000 };

function use(f: FakeAtlassian) {
  fake = f;
  useAtlassianApp({ clientId: 'squad-kit-test-app', fetch: f.fetch, ...PACE });
}

const acme = { id: CLOUD, url: `https://${SITE}`, name: 'Acme' };

function signedIn(id = 'sign-in-a', name = 'Sara Ali') {
  writeAtlassianSignIn({ signIn: id, refreshToken: fake.now.refresh, sites: [acme], site: CLOUD, account: { id, name }, ...freshDates() });
}

/** Holds every refresh until let go. */
function hold(): () => void {
  let go = () => undefined as void;
  fake.gate = new Promise<void>((r) => (go = r));
  return () => {
    fake.gate = undefined;
    go();
  };
}

const refreshes = () => fake.calls.filter((c) => c.url.endsWith('/atlassian/refresh')).map((c) => c.body?.refresh_token);
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  fake.gate = undefined;
  await signOutOfAtlassian();
  forgetAtlassianTokens();
  useAtlassianApp(null);
  vi.resetModules();
});

describe('one refresh at a time', () => {
  it('Check again while a refresh is on its way starts no second one: both get the same new token', async () => {
    use(fakeAtlassian());
    signedIn();
    const go = hold();
    const first = atlassianToken();
    await tick();
    // Check again on the Connections page, then another call.
    jiraConnection.forget?.();
    forgetAtlassianFailure();
    const second = atlassianToken();
    go();
    expect(await first).toEqual({ ok: true, token: 'at-2' });
    expect(await second).toEqual({ ok: true, token: 'at-2' });
    expect(refreshes()).toEqual(['rt-1']);
    expect(readAtlassianSignIn()?.refreshToken).toBe('rt-2');
  });

  it.each([
    ['the board first', 0],
    ['the terminal first', 1],
  ])('two squad-kits on this computer (%s): one waits for the other and sends the newer token; nobody is signed out', async (_who, firstOne) => {
    use(fakeAtlassian());
    signedIn();
    // The second squad-kit: the same modules loaded afresh, as another process has them, over the same folder.
    vi.resetModules();
    const other = {
      app: await import('../src/modules/jira/atlassian-app.js'),
      token: await import('../src/modules/jira/atlassian-token.js'),
    };
    other.app.useAtlassianApp({ clientId: 'squad-kit-test-app', fetch: fake.fetch, ...PACE });
    const both = [atlassianToken, other.token.atlassianToken];
    const go = hold();
    const a = both[firstOne]!();
    await tick();
    const b = both[1 - firstOne]!();
    await tick();
    go();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual({ ok: true, token: 'at-2' });
    expect(rb).toEqual({ ok: true, token: 'at-3' });
    // rt-1 was sent once: the second took the lock after the first wrote rt-2, read the file again, and sent rt-2.
    expect(refreshes()).toEqual(['rt-1', 'rt-2']);
    expect(readAtlassianSignIn()).toMatchObject({ refreshToken: 'rt-3', signIn: 'sign-in-a' });
    expect(fs.existsSync(path.join(privateFolder('atlassian'), 'refresh.lock'))).toBe(false);
  });

  it('a lock left by a squad-kit that has stopped is taken over at once', async () => {
    use(fakeAtlassian());
    signedIn();
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    const lock = path.join(privateFolder('atlassian'), 'refresh.lock');
    fs.writeFileSync(lock, `${gone} left-behind`);
    expect(await atlassianToken()).toEqual({ ok: true, token: 'at-2' });
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('a lock of a squad-kit that still runs is taken over only when it is minutes old', async () => {
    use(fakeAtlassian());
    signedIn();
    const lock = path.join(privateFolder('atlassian'), 'refresh.lock');
    fs.writeFileSync(lock, `${process.pid} stuck`);
    const old = (Date.now() - 6 * 60_000) / 1000;
    fs.utimesSync(lock, old, old);
    expect(await atlassianToken()).toEqual({ ok: true, token: 'at-2' });
  });

  it('a folder standing where the lock goes is taken away, never a lock that stays forever', async () => {
    use(fakeAtlassian());
    signedIn();
    const lock = path.join(privateFolder('atlassian'), 'refresh.lock');
    fs.mkdirSync(path.join(lock, 'inside'), { recursive: true });
    expect(await atlassianToken()).toEqual({ ok: true, token: 'at-2' });
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('a site picked, or a Disconnect, waits for the refresh holding the lock: neither lands in its middle', async () => {
    use(fakeAtlassian());
    writeAtlassianSignIn({ signIn: 'sign-in-a', refreshToken: 'rt-1', sites: [acme, { id: OTHER.id, url: OTHER.url, name: OTHER.name }], account: { id: 'a1', name: 'Sara Ali' }, ...freshDates() });
    const release = (await holdRefreshLock(1000))!;
    let picked = false;
    const pick = jiraConnection.pickSite!('/nowhere', OTHER.host).then(() => (picked = true));
    await tick(250);
    expect(picked).toBe(false);
    release();
    await pick;
    expect(readAtlassianSignIn()?.site).toBe(OTHER.id);
    const again = (await holdRefreshLock(1000))!;
    let out = false;
    const disconnected = signOutOfAtlassian().then(() => (out = true));
    await tick(250);
    expect(out).toBe(false);
    expect(readAtlassianSignIn()).not.toBeNull();
    again();
    await disconnected;
    expect(readAtlassianSignIn()).toBeNull();
  });

  it("a lock still held by another squad-kit past the wait is no answer, never a sign-out", async () => {
    use(fakeAtlassian());
    useAtlassianApp({ clientId: 'squad-kit-test-app', fetch: fake.fetch, settleMs: 20, lockWaitMs: 200 });
    signedIn();
    // Held by a squad-kit that still runs: this test's own process stands for it.
    fs.writeFileSync(path.join(privateFolder('atlassian'), 'refresh.lock'), `${process.pid} busy`);
    expect(await atlassianToken()).toEqual({ ok: false, why: 'no-answer' });
    expect(refreshes()).toEqual([]);
    expect(readAtlassianSignIn()?.refreshToken).toBe('rt-1');
  });

  it("Atlassian's no to a token another squad-kit has just replaced: the newer one is sent, nobody is signed out", async () => {
    use(fakeAtlassian());
    signedIn();
    // A lock taken over: the other squad-kit wrote rt-9 while this one sent rt-1.
    fake.now = { access: 'at-9', refresh: 'rt-9' };
    fake.onRefused = () => {
      fake.onRefused = undefined;
      setTimeout(() => writeAtlassianSignIn({ ...readAtlassianSignIn()!, refreshToken: 'rt-9' }), 5);
    };
    expect(await atlassianToken()).toEqual({ ok: true, token: 'at-2' });
    expect(refreshes()).toEqual(['rt-1', 'rt-9']);
    expect(readAtlassianSignIn()?.refreshToken).toBe('rt-2');
  });
});

describe('a late answer', () => {
  it('a Disconnect waits for a refresh on its way, then nothing of the sign-in is left', async () => {
    use(fakeAtlassian());
    signedIn('sign-in-a', 'Sara Ali');
    const go = hold();
    const forA = atlassianToken();
    await vi.waitFor(() => expect(refreshes()).toEqual(['rt-1']));
    let out = false;
    const disconnected = signOutOfAtlassian().then(() => (out = true));
    await tick(200);
    expect(out).toBe(false);
    go();
    await disconnected;
    expect(await forA).toEqual({ ok: true, token: 'at-2' });
    expect(readAtlassianSignIn()).toBeNull();
    expect(fs.existsSync(privateFolder('atlassian'))).toBe(false);
    expect(await atlassianToken()).toEqual({ ok: false, why: 'signed-out' });
  });

  it('the board keeps no token of an old sign-in after a terminal signs in as someone else', async () => {
    use(fakeAtlassian());
    signedIn('sign-in-a', 'Sara Ali');
    keepAccess('at-1', 3600, 'sign-in-a');
    expect(await atlassianToken()).toEqual({ ok: true, token: 'at-1' });
    // Another squad-kit on this computer signs in as Omar: a new sign-in in the file, its own pair.
    fake.now = { access: 'at-omar', refresh: 'rt-omar' };
    writeAtlassianSignIn({ signIn: 'sign-in-b', refreshToken: 'rt-omar', sites: [acme], site: CLOUD, account: { id: 'b1', name: 'Omar' }, ...freshDates() });
    const got = await atlassianToken();
    expect(got).toEqual({ ok: true, token: 'at-2' });
    expect(refreshes()).toEqual(['rt-omar']);
  });
});
