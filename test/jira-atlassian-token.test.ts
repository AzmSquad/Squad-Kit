import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, saveConfig } from '../src/core/config.js';
import { buildPaths } from '../src/core/paths.js';
import { useAtlassianApp } from '../src/modules/jira/atlassian-app.js';
import { signOutOfAtlassian } from '../src/modules/jira/atlassian-sign-in.js';
import { freshDates, readAtlassianSignIn, writeAtlassianSignIn } from '../src/modules/jira/atlassian-store.js';
import { atlassianCloud, atlassianEnded, atlassianToken, forgetAtlassianFailure, forgetAtlassianTokens, keepAccess } from '../src/modules/jira/atlassian-token.js';
import { jiraTracker } from '../src/modules/jira/module.js';
import { EMAIL, SITE } from './fakes/jira.js';
import { CLOUD, fakeAtlassian, type FakeAtlassian } from './support/fake-atlassian.js';

/**
 * The Atlassian sign-in's token (ADR-012) and the Jira client with it: the access token in memory only, refreshed
 * through the sign-in helper with Atlassian's rotating refresh tokens, and the bearer only ever sent to Atlassian's
 * gateway for the site's cloud id. A pasted token for the site wins.
 */

let fake: FakeAtlassian;
let tmp = '';

function use(f: FakeAtlassian) {
  fake = f;
  useAtlassianApp({ clientId: 'squad-kit-test-app', fetch: f.fetch, settleMs: 20 });
  // The Jira client and the Connections row use the plain fetch.
  vi.stubGlobal('fetch', f.fetch);
}

/** Signed in as Sara Ali on acme, the way a finished sign-in leaves it. */
function signedIn(expiresIn = 3600) {
  writeAtlassianSignIn({ signIn: 'sign-in-a', refreshToken: fake.now.refresh, sites: [{ id: CLOUD, url: `https://${SITE}`, name: 'Acme' }], site: CLOUD, account: { id: 'a1', name: 'Sara Ali' }, ...freshDates() });
  keepAccess(fake.now.access, expiresIn, 'sign-in-a');
}

/** A project on Jira at acme, project PAY, with or without the person's API token. */
function project(token = false): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-atl-'));
  fs.mkdirSync(path.join(tmp, '.squad'));
  saveConfig(buildPaths(tmp).configFile, { ...DEFAULT_CONFIG, tracker: { type: 'jira', workspace: SITE, project: 'PAY', options: { updates: 'on', board: '1', boardName: 'PAY board' } } });
  if (token) fs.writeFileSync(buildPaths(tmp).secretsFile, `tracker:\n  jira:\n    host: ${SITE}\n    email: ${EMAIL}\n    token: secret\n`);
  return tmp;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await signOutOfAtlassian();
  forgetAtlassianTokens();
  useAtlassianApp(null);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = '';
});

const refreshes = () => fake.calls.filter((c) => c.url.endsWith('/atlassian/refresh'));

describe('the access token', () => {
  it('a token at its end is asked anew through the helper, and the new refresh token is on disk first', async () => {
    use(fakeAtlassian());
    signedIn(1);
    expect(await atlassianToken()).toEqual({ ok: true, token: 'at-2' });
    expect(refreshes().map((c) => c.body)).toEqual([{ refresh_token: 'rt-1' }]);
    expect(readAtlassianSignIn()).toMatchObject({ refreshToken: 'rt-2', account: { name: 'Sara Ali' }, site: CLOUD });
    expect(readAtlassianSignIn()?.renewing).toBeUndefined();
    // Then from memory for the hour.
    expect(await atlassianToken()).toEqual({ ok: true, token: 'at-2' });
    expect(refreshes()).toHaveLength(1);
  });

  it('in its last minutes the token is still handed out at once, and the new one comes behind the caller', async () => {
    use(fakeAtlassian());
    signedIn(200);
    let go = () => undefined as void;
    fake.gate = new Promise<void>((r) => (go = r));
    expect(await atlassianToken()).toEqual({ ok: true, token: 'at-1' });
    expect(await atlassianToken()).toEqual({ ok: true, token: 'at-1' });
    await vi.waitFor(() => expect(refreshes()).toHaveLength(1));
    fake.gate = undefined;
    go();
    await vi.waitFor(() => expect(readAtlassianSignIn()?.refreshToken).toBe('rt-2'));
    expect(await atlassianToken()).toEqual({ ok: true, token: 'at-2' });
    expect(refreshes()).toHaveLength(1);
  });

  it('not reaching the helper never signs out, and is remembered a minute; Atlassian’s no does, in plain words', async () => {
    use(fakeAtlassian());
    signedIn(1);
    fake.offline = true;
    expect(await atlassianToken()).toEqual({ ok: false, why: 'no-answer' });
    expect(await atlassianToken()).toEqual({ ok: false, why: 'no-answer' });
    expect(refreshes()).toHaveLength(1);
    expect(readAtlassianSignIn()?.refreshToken).toBe('rt-1');
    await expect(atlassianCloud(SITE)!.cloud.bearer()).rejects.toMatchObject({ kind: 'offline' });
    // Check again: asked afresh.
    forgetAtlassianFailure();
    fake.offline = false;
    fake.revoked = true;
    expect(await atlassianToken()).toEqual({ ok: false, why: 'ended' });
    expect(readAtlassianSignIn()).toBeNull();
    expect(atlassianEnded()).toBe('refused');
    expect(await atlassianToken()).toEqual({ ok: false, why: 'ended' });
  });

  it('another squad-kit on this computer refreshed first: its new refresh token is used, never a sign-out', async () => {
    use(fakeAtlassian());
    signedIn(1);
    // The other squad-kit got rt-9 from Atlassian and wrote it, while this one was sending rt-1.
    fake.now = { access: 'at-9', refresh: 'rt-9' };
    fake.onRefused = () => {
      fake.onRefused = undefined;
      writeAtlassianSignIn({ ...readAtlassianSignIn()!, refreshToken: 'rt-9' });
    };
    expect(await atlassianToken()).toEqual({ ok: true, token: 'at-2' });
    expect(refreshes().map((c) => c.body?.refresh_token)).toEqual(['rt-1', 'rt-9']);
    expect(readAtlassianSignIn()?.refreshToken).toBe('rt-2');
  });

  it("the helper's own trouble never signs out; a Disconnect while a refresh is on its way is never undone", async () => {
    use(fakeAtlassian());
    signedIn(1);
    const helper = (answer: () => Response) =>
      useAtlassianApp({ clientId: 'squad-kit-test-app', fetch: (async (url: string, init?: RequestInit) => (String(url).endsWith('/atlassian/refresh') ? answer() : fake.fetch(url, init))) as typeof fetch });
    helper(() => new Response(JSON.stringify({ error: 'invalid_client', error_description: 'Client credentials are invalid.' }), { status: 401 }));
    expect(await atlassianToken()).toEqual({ ok: false, why: 'no-answer' });
    expect(readAtlassianSignIn()?.refreshToken).toBe('rt-1');
    forgetAtlassianFailure();
    // A Disconnect while the helper is asked: it waits for the refresh to end, then nothing is left.
    let out: Promise<void> | undefined;
    helper(() => {
      helper(() => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 403 }));
      out = signOutOfAtlassian();
      return new Response(JSON.stringify({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }), { status: 200 });
    });
    await atlassianToken();
    await out;
    expect(readAtlassianSignIn()).toBeNull();
    expect(await atlassianToken()).toEqual({ ok: false, why: 'signed-out' });
  });
});

describe('Jira with the sign-in', () => {
  it("calls Atlassian's gateway for the site's cloud id with the bearer, never the site; the issue page stays on the site", async () => {
    use(fakeAtlassian());
    signedIn();
    const t = jiraTracker.open(project())!;
    expect(await t.whoAmI()).toBe('Sara Ali');
    const rows = await t.list();
    expect(rows.map((r) => r.ref)).toContain('PAY-40');
    expect((await t.get('PAY-40')).url).toBe(`https://${SITE}/browse/PAY-40`);
    const asked = fake.jira.requests.map((r) => new URL(r.url));
    expect(asked.length).toBeGreaterThan(3);
    expect(asked.every((u) => u.origin === 'https://api.atlassian.com' && u.pathname.startsWith(`/ex/jira/${CLOUD}/rest/`))).toBe(true);
    expect(fake.calls.filter((c) => c.auth?.startsWith('Bearer')).every((c) => new URL(c.url).host === 'api.atlassian.com')).toBe(true);
  });

  it('a token kept a while that Jira refuses is swapped for a new one once; a fresh one’s refusal is said plainly', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    use(fakeAtlassian());
    signedIn();
    const t = jiraTracker.open(project())!;
    // Atlassian ended the token early on its side.
    fake.now = { ...fake.now, access: 'at-ended' };
    await expect(t.whoAmI()).rejects.toThrow("Jira did not accept squad-kit's Atlassian sign-in for Sara Ali. Sign in with Atlassian again on the Connections page (squad connect jira), or paste an API token in Settings.");
    expect(refreshes()).toHaveLength(0);
    vi.setSystemTime(Date.now() + 2 * 60_000);
    expect(await t.whoAmI()).toBe('Sara Ali');
    expect(refreshes()).toHaveLength(1);
  });

  it("an attachment comes through the gateway's attachment path; the media host gets no sign-in; a file elsewhere is refused", async () => {
    use(fakeAtlassian());
    signedIn();
    const t = jiraTracker.open(project())!;
    const out = path.join(tmp, 'slot.png');
    const item = await t.get('PAY-40');
    await t.download(item.attachments[0]!.url, out);
    expect(fs.readFileSync(out, 'utf8')).toBe('PNG!');
    const got = fake.jira.requests.slice(-2);
    expect(got).toEqual([
      { method: 'GET', url: `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/attachment/content/10100`, signedIn: true },
      expect.objectContaining({ url: expect.stringMatching(/^https:\/\/api\.media\.atlassian\.com\//), signedIn: false }),
    ]);
    await t.download(`https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/attachment/content/10100`, out);
    for (const url of [
      'https://evil.test/rest/api/3/attachment/content/10100',
      'https://api.atlassian.com/ex/jira/another-cloud/rest/api/3/attachment/content/10100',
      `https://${SITE}/rest/api/3/myself`,
      `http://${SITE}/rest/api/3/attachment/content/10100`,
    ]) {
      await expect(t.download(url, out)).rejects.toThrow(`squad-kit only downloads files kept on ${SITE}.`);
    }
  });

  it("a call squad-kit's app has no scope for names the permission, asks for no new token, and is not sent again", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    use(fakeAtlassian({ scopeMissing: true }));
    signedIn();
    // A token kept more than a minute: a plain refusal would be answered with a new one.
    vi.setSystemTime(Date.now() + 2 * 60_000);
    const t = jiraTracker.open(project())!;
    const words = "Jira refused this call: squad-kit's Atlassian app is missing a permission it needs (read:jira-user), or the site's admin removed squad-kit's access. Ask the admin, or tell the squad-kit maintainers: https://github.com/AzmSquad/Squad-Kit/issues";
    await expect(t.whoAmI()).rejects.toThrow(words);
    expect(refreshes()).toHaveLength(0);
    const sent = fake.jira.requests.length;
    await expect(t.whoAmI()).rejects.toThrow(words);
    expect(fake.jira.requests).toHaveLength(sent);
    await expect(t.sprints()).rejects.toThrow('(read:sprint:jira-software)');
    // A new sign-in may bring the permission: the call is tried again.
    keepAccess(fake.now.access, 3600, 'sign-in-a');
    await expect(t.whoAmI()).rejects.toThrow(words);
    expect(fake.jira.requests.length).toBeGreaterThan(sent);
    expect(refreshes()).toHaveLength(0);
  });

  it('only "scope does not match" is a missing permission: another 401 that names a scope is answered with a new token once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    use(fakeAtlassian({ scopeMissing: 'Unauthorized; the scope of this token has ended' }));
    signedIn();
    vi.setSystemTime(Date.now() + 2 * 60_000);
    await expect(jiraTracker.open(project())!.whoAmI()).rejects.toThrow("Jira did not accept squad-kit's Atlassian sign-in for Sara Ali.");
    expect(refreshes()).toHaveLength(1);
  });

  it("a token saved for the project's site wins: it goes to the site, and the bearer goes nowhere", async () => {
    use(fakeAtlassian());
    signedIn();
    const t = jiraTracker.open(project(true))!;
    expect(await t.whoAmI()).toBe('Sara Ali');
    expect(fake.jira.requests.map((r) => new URL(r.url).host)).toEqual([SITE]);
    expect(fake.calls.some((c) => c.auth?.startsWith('Bearer'))).toBe(false);
  });

  it('without a registered app, the sign-in is never used, even when one is on this computer', async () => {
    use(fakeAtlassian());
    signedIn();
    useAtlassianApp({ clientId: 'ATLASSIAN_CLIENT_ID_NOT_SET', fetch: fake.fetch });
    expect(jiraTracker.open(project())).toBeNull();
  });
});
