import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { privateFolder } from '../src/core/home.js';
import { useAtlassianApp } from '../src/modules/jira/atlassian-app.js';
import { refreshAtlassian } from '../src/modules/jira/atlassian-refresh.js';
import { signOutOfAtlassian } from '../src/modules/jira/atlassian-sign-in.js';
import { freshDates, readAtlassianSignIn, writeAtlassianSignIn } from '../src/modules/jira/atlassian-store.js';
import { atlassianEnded, atlassianToken, forgetAtlassianFailure, forgetAtlassianTokens, keepAccess } from '../src/modules/jira/atlassian-token.js';
import { jiraConnection } from '../src/modules/jira/connection.js';
import { SITE } from './fakes/jira.js';
import { CLOUD, fakeAtlassian, type FakeAtlassian } from './support/fake-atlassian.js';

/**
 * Keeping every pair Atlassian gives (ADR-012): Atlassian stops the old refresh token as soon as it gives a new one, so
 * a pair that cannot be written, or an answer that never arrives, must not quietly sign the person out. And what one
 * squad-kit on this computer learns (a new sign-in, a sign-in Atlassian ended) the others see from the folder.
 */

let fake: FakeAtlassian;
const PACE = { clientId: 'squad-kit-test-app', settleMs: 20, lockWaitMs: 5000 };
const acme = { id: CLOUD, url: `https://${SITE}`, name: 'Acme' };
const file = () => path.join(privateFolder('atlassian'), 'sign-in.json');
const refreshes = () => fake.calls.filter((c) => c.url.endsWith('/atlassian/refresh')).map((c) => c.body?.refresh_token);
let tmp = '';

function use(f: FakeAtlassian, fetch: typeof globalThis.fetch = f.fetch) {
  fake = f;
  useAtlassianApp({ ...PACE, fetch });
}

function signedIn(id = 'sign-in-a', name = 'Sara Ali') {
  writeAtlassianSignIn({ signIn: id, refreshToken: fake.now.refresh, sites: [acme], site: CLOUD, account: { id, name }, ...freshDates() });
}

/** A folder with no project in it: the Jira row says only what the sign-in says. */
function folder(): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-atl-keep-'));
  return tmp;
}

afterEach(async () => {
  vi.useRealTimers();
  fake.gate = undefined;
  await signOutOfAtlassian();
  forgetAtlassianTokens();
  jiraConnection.forget?.();
  useAtlassianApp(null);
  vi.resetModules();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = '';
});

describe('a pair that cannot be written', () => {
  it('Windows holding the file, or a full disk: the pair is kept in memory, used, and written at the next call; no temp file stays', async () => {
    use(fakeAtlassian());
    signedIn();
    const rename = fs.renameSync;
    let broken = true;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (broken && String(to).endsWith('sign-in.json')) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      return rename(from, to);
    });
    expect(await atlassianToken()).toEqual({ ok: true, token: 'at-2' });
    expect(readAtlassianSignIn()?.refreshToken).toBe('rt-1');
    expect(fs.readdirSync(privateFolder('atlassian')).filter((f) => f.startsWith('.'))).toEqual([]);
    // Still not writable when the token ends: the kept pair is the one sent, never the stopped one.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * 3600_000);
    expect(await atlassianToken()).toEqual({ ok: true, token: 'at-3' });
    expect(refreshes()).toEqual(['rt-1', 'rt-2']);
    expect(readAtlassianSignIn()?.refreshToken).toBe('rt-1');
    // Writable again: the next call writes it, behind the caller.
    broken = false;
    expect(await atlassianToken()).toEqual({ ok: true, token: 'at-3' });
    await vi.waitFor(() => expect(readAtlassianSignIn()?.refreshToken).toBe('rt-3'));
    expect(readAtlassianSignIn()?.renewing).toBeUndefined();
    expect(fs.readdirSync(privateFolder('atlassian')).filter((f) => f.startsWith('.'))).toEqual([]);
  });

  it('Windows refusing the rename for a moment: tried again, and written', async () => {
    use(fakeAtlassian());
    signedIn();
    const rename = fs.renameSync;
    let refusals = 2;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('sign-in.json') && refusals-- > 0) throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
      return rename(from, to);
    });
    expect(await atlassianToken()).toEqual({ ok: true, token: 'at-2' });
    expect(readAtlassianSignIn()?.refreshToken).toBe('rt-2');
  });
});

describe('an answer that never came', () => {
  it("Atlassian renewed it but its answer was lost: the next refresh says so plainly, not the 90-days line", async () => {
    const f = fakeAtlassian();
    let lose = true;
    use(f, (async (url: string, init?: RequestInit) => {
      const res = await f.fetch(url, init);
      if (lose && String(url).endsWith('/atlassian/refresh')) {
        lose = false;
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }
      return res;
    }) as typeof fetch);
    signedIn();
    expect(await atlassianToken()).toEqual({ ok: false, why: 'no-answer' });
    expect(readAtlassianSignIn()).toMatchObject({ refreshToken: 'rt-1', renewing: expect.any(String) });
    forgetAtlassianFailure();
    expect(await atlassianToken()).toEqual({ ok: false, why: 'ended' });
    expect(atlassianEnded()).toBe('lost');
    expect((await jiraConnection.status(folder())).line?.en).toBe(
      "squad-kit lost Atlassian's answer while renewing your sign-in, so Atlassian no longer takes it. Sign in with Atlassian again.",
    );
  });

  it('a request that never left this computer leaves no mark: a later refusal is the plain one', async () => {
    use(fakeAtlassian());
    signedIn();
    fake.offline = true;
    expect(await atlassianToken()).toEqual({ ok: false, why: 'no-answer' });
    expect(readAtlassianSignIn()?.renewing).toBeUndefined();
    fake.offline = false;
    fake.revoked = true;
    forgetAtlassianFailure();
    expect(await atlassianToken()).toEqual({ ok: false, why: 'ended' });
    expect(atlassianEnded()).toBe('refused');
  });
});

describe('another squad-kit on this computer', () => {
  it('its new sign-in, written while this one’s refresh was on its way: the late answer leaves it as it is', async () => {
    use(fakeAtlassian());
    signedIn('sign-in-a', 'Sara Ali');
    // The other squad-kit: the same modules loaded afresh, as another process has them, over the same folder.
    vi.resetModules();
    const other = await import('../src/modules/jira/atlassian-store.js');
    let go = () => undefined as void;
    fake.gate = new Promise<void>((r) => (go = r));
    // This squad-kit did not sign in anew or out: only the file can tell it the sign-in changed.
    const late = refreshAtlassian(() => true);
    await vi.waitFor(() => expect(refreshes()).toEqual(['rt-1']));
    // Its wait for the lock ran out (a refresh hanging): it signs out, and in as Omar.
    other.clearAtlassianFolder();
    other.writeAtlassianSignIn({ signIn: 'sign-in-b', refreshToken: 'rt-omar', sites: [acme], site: CLOUD, account: { id: 'b1', name: 'Omar' }, ...other.freshDates() });
    const b = fs.readFileSync(file(), 'utf8');
    fake.gate = undefined;
    go();
    expect(await late).toEqual({ ok: false, why: 'stale' });
    expect(fs.readFileSync(file(), 'utf8')).toBe(b);
    expect(refreshes()).toEqual(['rt-1']);
  });

  it('Atlassian ended the sign-in there: this one says why too, and Disconnect takes everything away', async () => {
    use(fakeAtlassian());
    signedIn();
    keepAccess('at-1', 3600, 'sign-in-a');
    fake.revoked = true;
    vi.resetModules();
    const other = { app: await import('../src/modules/jira/atlassian-app.js'), token: await import('../src/modules/jira/atlassian-token.js') };
    other.app.useAtlassianApp({ ...PACE, fetch: fake.fetch });
    expect(await other.token.atlassianToken()).toEqual({ ok: false, why: 'ended' });
    // This squad-kit never asked Atlassian: the marker in the folder tells it.
    expect(atlassianEnded()).toBe('refused');
    expect(await atlassianToken()).toEqual({ ok: false, why: 'ended' });
    expect((await jiraConnection.status(folder())).line?.en).toBe(
      "Atlassian ended squad-kit's sign-in: it was not used for 90 days, or it was removed under Connected apps. Sign in with Atlassian again.",
    );
    await signOutOfAtlassian();
    expect(atlassianEnded()).toBeNull();
    expect(fs.existsSync(privateFolder('atlassian'))).toBe(false);
  });
});
