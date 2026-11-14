import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { privateFolder } from '../src/core/home.js';
import { privateFolders } from '../src/modules/registry.js';
import { SCOPES, useAtlassianApp } from '../src/modules/jira/atlassian-app.js';
import { atlassianSignInNow, cancelAtlassianSignIn, forgetAtlassianFlow, signOutOfAtlassian, startAtlassianSignIn } from '../src/modules/jira/atlassian-sign-in.js';
import { readAtlassianSignIn } from '../src/modules/jira/atlassian-store.js';
import { forgetAtlassianTokens } from '../src/modules/jira/atlassian-token.js';
import { SITE } from './fakes/jira.js';
import { CLOUD, GOOD_CODE, OTHER, fakeAtlassian, type FakeAtlassian } from './support/fake-atlassian.js';

/**
 * Sign in with Atlassian (ADR-012): squad-kit opens a one-shot door on 127.0.0.1, gives the link to Atlassian's page,
 * and takes the answer the sign-in helper sends back there. The code goes to the helper, the sites come from Atlassian,
 * and the sign-in is kept in squad-kit's own folder. Atlassian and the helper are made up here; the door is real.
 */

const real = globalThis.fetch.bind(globalThis);
let fake: FakeAtlassian;

function use(f: FakeAtlassian, lifeMs?: number) {
  fake = f;
  useAtlassianApp({ clientId: 'squad-kit-test-app', fetch: f.fetch, ...(lifeMs ? { lifeMs } : {}) });
}

afterEach(async () => {
  await signOutOfAtlassian();
  forgetAtlassianFlow();
  forgetAtlassianTokens();
  useAtlassianApp(null);
});

const file = () => path.join(privateFolder('atlassian'), 'sign-in.json');

/** The person's browser, sent back by the helper: the door's own address, with the state from the link. */
function arrive(url: string, answer: Record<string, string>, state?: string): Promise<Response> {
  const own = new URL(url).searchParams.get('state')!;
  const s = state ?? own;
  const port = own.split('.')[0];
  return real(`http://127.0.0.1:${port}/atlassian?${new URLSearchParams({ ...answer, state: s }).toString()}`);
}

async function ended(): Promise<NonNullable<ReturnType<typeof atlassianSignInNow>>> {
  await vi.waitFor(() => expect(atlassianSignInNow()?.state).not.toBe('waiting'));
  return atlassianSignInNow()!;
}

describe('the link', () => {
  it("is Atlassian's page with squad-kit's app, every scope with offline_access, the helper's callback and the door's state", async () => {
    use(fakeAtlassian());
    const f = await startAtlassianSignIn(undefined, () => undefined);
    expect(f).toMatchObject({ state: 'waiting' });
    expect(f.code).toBeUndefined();
    const url = new URL(f.url!);
    expect(`${url.origin}${url.pathname}`).toBe('https://auth.atlassian.com/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      audience: 'api.atlassian.com',
      client_id: 'squad-kit-test-app',
      scope: SCOPES.join(' '),
      redirect_uri: 'https://auth.squad-kit.com/atlassian/callback',
      response_type: 'code',
      prompt: 'consent',
    });
    expect(f.url).toContain('scope=read%3Ajira-work%20write%3Ajira-work');
    expect(SCOPES).toContain('offline_access');
    expect(url.searchParams.get('state')).toMatch(/^\d{4,5}\.[A-Za-z0-9_-]{43}$/);
    // A second start shows the one waiting.
    expect((await startAtlassianSignIn(undefined, () => undefined)).url).toBe(f.url);
    // squad-kit's own folder for it is hidden from every agent.
    expect(privateFolders()).toContain('atlassian');
  });
});

describe('the answer at the door', () => {
  it('Accept: the code goes to the helper, the site comes from Atlassian, and the sign-in is kept in squad-kit’s own folder', async () => {
    use(fakeAtlassian());
    let told = 0;
    const f = await startAtlassianSignIn(undefined, () => (told += 1));
    const page = await arrive(f.url!, { code: GOOD_CODE });
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(await page.text()).toContain('You can close this tab');
    expect(await ended()).toMatchObject({ state: 'done', account: 'Sara Ali' });
    expect(told).toBe(1);
    expect(readAtlassianSignIn()).toMatchObject({
      refreshToken: 'rt-1',
      sites: [{ id: CLOUD, url: `https://${SITE}`, name: 'Acme' }],
      site: CLOUD,
      account: { id: '5b10a2844c20165700ede21g', name: 'Sara Ali' },
    });
    // Confluence's site is not a Jira site.
    expect(readAtlassianSignIn()!.sites).toHaveLength(1);
    // The access token lives in memory only; the file is the person's only.
    expect(fs.readFileSync(file(), 'utf8')).not.toContain('at-1');
    if (process.platform !== 'win32') {
      expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
      expect(fs.statSync(privateFolder('atlassian')).mode & 0o777).toBe(0o700);
    }
    // The helper got the code; the bearer went only to Atlassian's gateway.
    expect(fake.calls.find((c) => c.url.endsWith('/atlassian/token'))?.body).toEqual({ code: GOOD_CODE });
    expect(fake.calls.filter((c) => c.auth).every((c) => new URL(c.url).host === 'api.atlassian.com')).toBe(true);
    // The door is closed: the same answer again reaches nothing.
    await expect(arrive(f.url!, { code: GOOD_CODE })).rejects.toThrow();
  });

  it("Cancel on Atlassian's page is said plainly, and nothing is kept", async () => {
    use(fakeAtlassian());
    const f = await startAtlassianSignIn(undefined, () => undefined);
    const page = await arrive(f.url!, { error: 'access_denied' });
    expect(await page.text()).toContain('Cancelled');
    expect(await ended()).toMatchObject({ state: 'failed', line: "You pressed Cancel on Atlassian's page. Nothing changed." });
    expect(readAtlassianSignIn()).toBeNull();
    expect(fake.calls).toEqual([]);
  });

  it('a state the door did not give gets nothing, and the door keeps waiting for its own, once', async () => {
    use(fakeAtlassian());
    const f = await startAtlassianSignIn(undefined, () => undefined);
    const own = new URL(f.url!).searchParams.get('state')!;
    const port = own.split('.')[0]!;
    for (const state of [`${port}.${'x'.repeat(43)}`, `${port}.`, port, `1.${own.split('.')[1]}`]) {
      const res = await arrive(f.url!, { code: GOOD_CODE }, state);
      expect(res.status).toBe(400);
    }
    expect(atlassianSignInNow()?.state).toBe('waiting');
    expect(fake.calls).toEqual([]);
    await arrive(f.url!, { code: GOOD_CODE });
    expect((await ended()).state).toBe('done');
  });

  it('only a GET on its one path, at 127.0.0.1 and its port: another name for it (DNS rebinding) gets nothing', async () => {
    use(fakeAtlassian());
    const f = await startAtlassianSignIn(undefined, () => undefined);
    const state = new URL(f.url!).searchParams.get('state')!;
    const port = Number(state.split('.')[0]);
    const ask = (opts: http.RequestOptions) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, ...opts }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
    const q = `?code=${GOOD_CODE}&state=${encodeURIComponent(state)}`;
    expect(await ask({ method: 'POST', path: `/atlassian${q}` })).toBe(404);
    expect(await ask({ path: `/other${q}` })).toBe(404);
    expect(await ask({ path: `/atlassian${q}`, headers: { host: `evil.test:${port}` } })).toBe(404);
    expect(atlassianSignInNow()?.state).toBe('waiting');
  });

  it('two starts at once (a double click) open one door: both get the same link', async () => {
    use(fakeAtlassian());
    const [a, b] = await Promise.all([startAtlassianSignIn(undefined, () => undefined), startAtlassianSignIn(undefined, () => undefined)]);
    expect(b.url).toBe(a.url);
    expect(atlassianSignInNow()?.url).toBe(a.url);
    cancelAtlassianSignIn();
    // That one door is closed now: nothing is left listening.
    await expect(arrive(a.url!, { code: GOOD_CODE })).rejects.toThrow();
  });

  it('Cancel closes the door; a code that comes after is never kept', async () => {
    use(fakeAtlassian());
    const f = await startAtlassianSignIn(undefined, () => undefined);
    expect(cancelAtlassianSignIn()).toMatchObject({ state: 'cancelled' });
    await expect(arrive(f.url!, { code: GOOD_CODE })).rejects.toThrow();
    expect(readAtlassianSignIn()).toBeNull();
  });

  it('the door closes when the wait is over', async () => {
    use(fakeAtlassian(), 200);
    const f = await startAtlassianSignIn(undefined, () => undefined);
    expect(await ended()).toMatchObject({ state: 'failed', line: 'The sign-in waited 15 minutes. Try again.' });
    await expect(arrive(f.url!, { code: GOOD_CODE })).rejects.toThrow();
  });

  it('the helper or Atlassian out of reach, or a code Atlassian refuses: plain words, nothing kept', async () => {
    use(fakeAtlassian());
    fake.offline = true;
    let f = await startAtlassianSignIn(undefined, () => undefined);
    await arrive(f.url!, { code: GOOD_CODE });
    expect((await ended()).line).toBe("squad-kit's sign-in helper or Atlassian could not be reached just now. Check the network, then try again.");
    fake.offline = false;
    f = await startAtlassianSignIn(undefined, () => undefined);
    await arrive(f.url!, { code: 'used-before' });
    expect((await ended()).line).toBe('Atlassian did not accept the sign-in: Invalid authorization code. Try again.');
    expect(readAtlassianSignIn()).toBeNull();
  });
});

describe('which Jira site', () => {
  it('several sites and no site of the project’s own: signed in, with the site left to pick', async () => {
    use(fakeAtlassian({ sites: 'two' }));
    const f = await startAtlassianSignIn(undefined, () => undefined);
    await arrive(f.url!, { code: GOOD_CODE });
    expect(await ended()).toMatchObject({ state: 'done', line: "Signed in. Pick this project's Jira site on the Connections page." });
    const kept = readAtlassianSignIn()!;
    expect(kept.sites.map((s) => s.url)).toEqual([`https://${SITE}`, OTHER.url]);
    expect(kept.site).toBeUndefined();
  });

  it("the project's own site is used when Atlassian gave it, and said plainly when it did not", async () => {
    use(fakeAtlassian({ sites: 'two' }));
    let f = await startAtlassianSignIn(OTHER.host, () => undefined);
    await arrive(f.url!, { code: GOOD_CODE });
    expect(await ended()).toMatchObject({ state: 'done', account: 'Sara Ali' });
    expect(readAtlassianSignIn()!.site).toBe(OTHER.id);
    await signOutOfAtlassian();
    use(fakeAtlassian({ sites: 'other' }));
    f = await startAtlassianSignIn(SITE, () => undefined);
    await arrive(f.url!, { code: GOOD_CODE });
    expect(await ended()).toMatchObject({
      state: 'failed',
      line: `Atlassian did not give squad-kit access to ${SITE}, this project's Jira site (it gave ${OTHER.host}). Sign in with Atlassian again and pick ${SITE} on Atlassian's page.`,
    });
    // The sign-in still works for the site it was given.
    expect(readAtlassianSignIn()!.sites.map((s) => s.id)).toEqual([OTHER.id]);
  });

  it('no Jira site given at all: nothing kept, and the words say to pick one on Atlassian’s page', async () => {
    use(fakeAtlassian({ sites: 'none' }));
    const f = await startAtlassianSignIn(undefined, () => undefined);
    await arrive(f.url!, { code: GOOD_CODE });
    expect((await ended()).line).toContain("Atlassian gave squad-kit no Jira site. Sign in again, and pick your Jira site on Atlassian's page");
    expect(readAtlassianSignIn()).toBeNull();
  });
});

describe("squad-kit's folder", () => {
  it('a link standing where the file or the folder goes is never read or written through', async () => {
    if (process.platform === 'win32') return;
    use(fakeAtlassian());
    const outside = fs.mkdtempSync(path.join(path.dirname(privateFolder('atlassian')), 'elsewhere-'));
    fs.writeFileSync(path.join(outside, 'sign-in.json'), JSON.stringify({ refreshToken: 'planted', sites: [], refreshedAt: '', until: '' }));
    fs.symlinkSync(outside, privateFolder('atlassian'));
    expect(readAtlassianSignIn()).toBeNull();
    const f = await startAtlassianSignIn(undefined, () => undefined);
    await arrive(f.url!, { code: GOOD_CODE });
    expect((await ended()).state).toBe('done');
    expect(fs.lstatSync(privateFolder('atlassian')).isSymbolicLink()).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(outside, 'sign-in.json'), 'utf8')).refreshToken).toBe('planted');
    // Disconnect empties squad-kit's folder only.
    await signOutOfAtlassian();
    expect(fs.existsSync(privateFolder('atlassian'))).toBe(false);
    expect(fs.existsSync(path.join(outside, 'sign-in.json'))).toBe(true);
  });
});
