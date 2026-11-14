import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { boardPaths, writeMeta, type BoardPaths } from '../src/board/store.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig, type SquadConfig } from '../src/core/config.js';
import { privateFolder } from '../src/core/home.js';
import { buildPaths } from '../src/core/paths.js';
import { loadSecrets } from '../src/core/secrets.js';
import { connectionsOf, disconnect, type ConnectionRow } from '../src/engine/connections.js';
import { mountConnectionsApi } from '../src/console/api/connections.js';
import { connectionLines } from '../src/commands/connect.js';
import { useAtlassianApp } from '../src/modules/jira/atlassian-app.js';
import { forgetAtlassianFlow, signOutOfAtlassian } from '../src/modules/jira/atlassian-sign-in.js';
import { freshDates, writeAtlassianSignIn } from '../src/modules/jira/atlassian-store.js';
import { forgetAtlassianTokens, keepAccess } from '../src/modules/jira/atlassian-token.js';
import { jiraConnection } from '../src/modules/jira/connection.js';
import { jiraTrackerModule } from '../src/modules/jira/module.js';
import { EMAIL, SITE } from './fakes/jira.js';
import { CLOUD, OTHER, fakeAtlassian, type FakeAtlassian } from './support/fake-atlassian.js';

/**
 * Jira's row on the Connections page with Sign in with Atlassian (ADR-012), and Settings with it: a pasted token for the
 * project's site wins, the project's own site is used, a project with none picks one, and Disconnect works offline.
 */

let fake: FakeAtlassian;
let tmp = '';
const made: string[] = [];

function use(f: FakeAtlassian) {
  fake = f;
  useAtlassianApp({ clientId: 'squad-kit-test-app', fetch: f.fetch });
  vi.stubGlobal('fetch', f.fetch);
}

function signedIn(sites: 'one' | 'two' = 'one', chosen?: string) {
  const acme = { id: CLOUD, url: `https://${SITE}`, name: 'Acme' };
  const globex = { id: OTHER.id, url: OTHER.url, name: OTHER.name };
  writeAtlassianSignIn({
    signIn: 'sign-in-a',
    refreshToken: fake.now.refresh,
    sites: sites === 'two' ? [acme, globex] : [acme],
    ...(chosen ? { site: chosen } : sites === 'one' ? { site: CLOUD } : {}),
    account: { id: 'a1', name: 'Sara Ali' },
    ...freshDates(),
  });
  keepAccess(fake.now.access, 3600, 'sign-in-a');
}

function project(tracker: SquadConfig['tracker'] = { type: 'jira', workspace: SITE, project: 'PAY', options: { updates: 'on' } }, token = false): BoardPaths {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-atl-row-'));
  made.push(tmp);
  fs.mkdirSync(path.join(tmp, '.squad'));
  saveConfig(buildPaths(tmp).configFile, { ...DEFAULT_CONFIG, tracker });
  if (token) fs.writeFileSync(buildPaths(tmp).secretsFile, `tracker:\n  jira:\n    host: ${SITE}\n    email: ${EMAIL}\n    token: secret\n`);
  const bp = boardPaths(path.join(tmp, '.squad'));
  writeMeta(bp, {
    project: 'app',
    key: 'AP',
    nextNumber: 1,
    engine: 'live',
    runner: 'direct',
    user: { name: 'Sara', role: 'Project manager' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
  } as never);
  return bp;
}

const row = async (bp: BoardPaths): Promise<ConnectionRow> => {
  jiraConnection.forget?.();
  return (await connectionsOf(bp)).rows.find((r) => r.name === 'jira')!;
};
const ids = (r: ConnectionRow) => r.actions.map((a) => a.id);

afterEach(async () => {
  vi.unstubAllGlobals();
  await signOutOfAtlassian();
  forgetAtlassianFlow();
  forgetAtlassianTokens();
  jiraConnection.forget?.();
  useAtlassianApp(null);
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Jira's row", () => {
  it('not signed in: Sign in with Atlassian and its terminal command, with the token as the other way', async () => {
    use(fakeAtlassian());
    const r = await row(project());
    expect(r).toMatchObject({ how: 'sign-in', tracker: 'jira', state: 'not-connected', ownSignIn: true, codePage: { name: 'Atlassian' } });
    expect(r.next).toBeUndefined();
    expect(r.actions.find((a) => a.id === 'sign-in')).toEqual({ id: 'sign-in', name: 'Sign in with Atlassian', command: 'squad connect jira' });
    expect(ids(r)).toEqual(['sign-in', 'check']);
    expect(r.steps[0]!.command).toBe('squad connect jira');
    expect(r.revokeAt?.link).toBe('https://id.atlassian.com/manage-profile/apps');
  });

  it('signed in: the account on the site; Disconnect works offline, empties the folder and names Connected apps', async () => {
    use(fakeAtlassian());
    signedIn();
    const bp = project();
    const r = await row(bp);
    expect(r).toMatchObject({ state: 'connected', account: `Sara Ali (${SITE})`, signedIn: { as: 'Sara Ali' } });
    expect(ids(r)).toEqual(['disconnect', 'check']);
    expect(r.steps[0]!.done?.en).toBe('Signed in as Sara Ali');
    fake.offline = true;
    jiraConnection.forget?.();
    expect((await disconnect(bp, 'jira')).line).toBe(
      'squad-kit is signed out of Jira on this computer, as Sara Ali. Your other sign-ins on this computer stay as they are. You can also remove squad-kit from your Atlassian account, under Connected apps: https://id.atlassian.com/manage-profile/apps',
    );
    expect(fs.existsSync(privateFolder('atlassian'))).toBe(false);
    fake.offline = false;
    expect(await row(bp)).toMatchObject({ state: 'not-connected' });
  });

  it('Disconnect decides from this computer’s files alone: online, it calls neither the helper nor Jira', async () => {
    use(fakeAtlassian());
    signedIn();
    const bp = project();
    expect(await row(bp)).toMatchObject({ state: 'connected' });
    fake.calls.length = 0;
    fake.jira.requests.length = 0;
    // Check again first, as the board's Disconnect dialog may follow it: still nothing goes out.
    jiraConnection.forget?.();
    expect((await disconnect(bp, 'jira')).line).toContain('squad-kit is signed out of Jira on this computer, as Sara Ali.');
    expect(fake.calls).toEqual([]);
    expect(fake.jira.requests).toEqual([]);
    await expect(disconnect(bp, 'jira')).rejects.toThrow('Jira is not signed in on this computer.');
    const token = project(undefined, true);
    await expect(disconnect(token, 'jira')).rejects.toThrow('Jira is connected with the token saved in Settings. Change it there.');
    expect(fake.calls).toEqual([]);
  });

  it("Jira refusing a call for a missing permission (or an admin removing squad-kit): the row is not connected, and says why", async () => {
    use(fakeAtlassian());
    signedIn();
    const bp = project();
    expect(await row(bp)).toMatchObject({ state: 'connected' });
    fake.scopeMissing = true;
    const r = await row(bp);
    expect(r).toMatchObject({ state: 'not-connected', signedIn: { as: 'Sara Ali' } });
    expect(r.line?.en).toBe(
      "Jira refused this call: squad-kit's Atlassian app is missing a permission it needs (read:jira-user), or the site's admin removed squad-kit's access. Ask the admin, or tell the squad-kit maintainers: https://github.com/AzmSquad/Squad-Kit/issues",
    );
    expect(r.line?.ar).toContain('read:jira-user');
  });

  it("a token saved for the project's site wins; the sign-in left here can still be ended", async () => {
    use(fakeAtlassian());
    signedIn();
    const r = await row(project(undefined, true));
    expect(r).toMatchObject({ state: 'connected', account: 'Sara Ali', by: 'token', signedIn: { as: 'Sara Ali' } });
    expect(ids(r)).toEqual(['disconnect', 'check']);
    expect(fake.calls.some((c) => c.auth?.startsWith('Bearer'))).toBe(false);
  });

  it('several sites and a project with no Jira site: a short list to pick from, on the board or in a terminal', async () => {
    use(fakeAtlassian());
    signedIn('two');
    const bp = project({ type: 'none' });
    const r = await row(bp);
    expect(r).toMatchObject({ state: 'not-connected', line: { en: 'Atlassian gave squad-kit 2 Jira sites. Pick the one for this project.' } });
    expect(r.pick).toEqual([
      { site: SITE, name: 'Acme' },
      { site: OTHER.host, name: 'Globex' },
    ]);
    // Signed in already: no second sign-in button while the site is left to pick.
    expect(ids(r)).toEqual(['disconnect', 'check']);
    expect(connectionLines([r]).join('\n')).toContain(`2. Globex (${OTHER.host})`);
    const app = new Hono();
    mountConnectionsApi(app, { paths: buildPaths(tmp) });
    const pick = (site: string) => app.request('/api/v1/connections/jira/site', { method: 'POST', body: JSON.stringify({ site }), headers: { 'content-type': 'application/json' } });
    const no = await pick('initech.atlassian.net');
    expect(no.status).toBe(400);
    expect(await no.json()).toEqual({ error: `Atlassian did not give squad-kit access to initech.atlassian.net. Pick one of: ${SITE}, ${OTHER.host}.` });
    // A body that is no object, or a site that is no text: said plainly, never a crash.
    for (const body of ['null', '{"site":5}', 'not json']) {
      const bad = await app.request('/api/v1/connections/jira/site', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: 'Say which one to use.' });
    }
    expect(await (await pick('globex')).json()).toEqual({ line: `squad-kit uses ${OTHER.host} for Jira on this computer.` });
    expect(await row(bp)).toMatchObject({ state: 'connected', account: `Sara Ali (${OTHER.host})` });
  });

  it("the project's site not among those Atlassian gave: said plainly, with Sign in again and Disconnect", async () => {
    use(fakeAtlassian());
    writeAtlassianSignIn({ signIn: 'sign-in-a', refreshToken: 'rt-1', sites: [{ id: OTHER.id, url: OTHER.url, name: OTHER.name }], site: OTHER.id, account: { id: 'a1', name: 'Sara Ali' }, ...freshDates() });
    const r = await row(project());
    expect(r.line?.en).toBe(`Atlassian did not give squad-kit access to ${SITE}, this project's Jira site (it gave ${OTHER.host}). Sign in with Atlassian again and pick ${SITE} on Atlassian's page.`);
    expect(r.line?.ar).toContain(SITE);
    expect(ids(r)).toEqual(['sign-in', 'disconnect', 'check']);
  });

  it('Atlassian ended the sign-in: said plainly; not reaching it is never a sign-out', async () => {
    use(fakeAtlassian());
    signedIn();
    const bp = project();
    forgetAtlassianTokens();
    fake.offline = true;
    const off = await row(bp);
    expect(off).toMatchObject({ state: 'unknown', line: { en: 'Jira or Atlassian could not be reached just now. Check the network; squad-kit asks again in a minute.' }, signedIn: { as: 'Sara Ali' } });
    expect(ids(off)).toEqual(['disconnect', 'check']);
    fake.offline = false;
    fake.revoked = true;
    const out = await row(bp);
    expect(out).toMatchObject({ state: 'not-connected', line: { en: expect.stringContaining("Atlassian ended squad-kit's sign-in") } });
    expect(ids(out)).toEqual(['sign-in', 'check']);
  });

  it('each button is one REST call: Sign in gives the link and never a process id; Cancel stops it', async () => {
    use(fakeAtlassian());
    const app = new Hono();
    mountConnectionsApi(app, { paths: buildPaths(project().root) });
    const started = (await (await app.request('/api/v1/connections/jira/sign-in', { method: 'POST' })).json()) as Record<string, unknown>;
    expect(started).toMatchObject({ state: 'waiting', url: expect.stringMatching(/^https:\/\/auth\.atlassian\.com\/authorize\?/) });
    expect(started).not.toHaveProperty('code');
    expect(started).not.toHaveProperty('pid');
    expect(await (await app.request('/api/v1/connections/jira/sign-in/cancel', { method: 'POST' })).json()).toMatchObject({ state: 'cancelled' });
  });
});

describe('Settings with the sign-in', () => {
  it('Save and check works with the sign-in alone, keeps nothing of the person’s, and the lists come through the gateway', async () => {
    use(fakeAtlassian());
    signedIn();
    const bp = project({ type: 'none' });
    const m = jiraTrackerModule(fake.fetch);
    const lists = await m.choices!({ site: SITE, project: 'PAY' }, bp.root);
    expect(lists.project?.[0]).toEqual({ value: 'PAY', label: 'PAY: Payments' });
    // No site typed: the sign-in's own site.
    await m.save(bp.root, { site: '', project: 'PAY' });
    expect(loadConfig(buildPaths(bp.root).configFile).tracker).toEqual({ type: 'jira', workspace: SITE, project: 'PAY', options: { updates: 'on', board: '1', boardName: 'PAY board' } });
    expect(loadSecrets(buildPaths(bp.root).secretsFile).tracker?.jira).toBeUndefined();
    expect(m.read(bp.root)).toMatchObject({ hasSecret: false, note: 'Signed in with Atlassian as Sara Ali: no token needed.' });
    expect(m.about).toContain('Sign in with Atlassian on the Connections page, or paste an API token here');
    expect(fake.jira.requests.every((r) => new URL(r.url).host === 'api.atlassian.com')).toBe(true);
  });

  it('a site the sign-in does not cover asks for a token for it, or a new sign-in; a saved token is said to be used', async () => {
    use(fakeAtlassian());
    signedIn();
    const bp = project({ type: 'none' });
    const m = jiraTrackerModule(fake.fetch);
    await expect(m.save(bp.root, { site: 'initech', email: EMAIL })).rejects.toThrow(
      "Paste your Jira API token for initech.atlassian.net. Make one at id.atlassian.com, under Security, API tokens. squad-kit's Atlassian sign-in does not cover initech.atlassian.net",
    );
    const own = project(undefined, true);
    expect(m.read(own.root).note).toBe('The API token saved here is used, not your Atlassian sign-in.');
  });
});
