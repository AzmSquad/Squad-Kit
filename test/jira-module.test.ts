import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { EMAIL, SITE, fakeJira, type FakeJiraOptions } from './fakes/jira.js';
import { jiraTrackerModule } from '../src/modules/jira/module.js';
import { jiraConnection } from '../src/modules/jira/connection.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig, type SquadConfig } from '../src/core/config.js';
import { buildPaths } from '../src/core/paths.js';
import { loadSecrets } from '../src/core/secrets.js';
import { mountTrackerChoices } from '../src/console/api/tracker-form.js';

/** Jira in Settings: the save that checks with Jira first, the lists, a setup from squad-kit 0.x, and the Connections row. */

function project(tracker: SquadConfig['tracker'] = { type: 'none' }, secrets?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-jira-mod-'));
  fs.mkdirSync(path.join(root, '.squad'), { recursive: true });
  saveConfig(buildPaths(root).configFile, { ...DEFAULT_CONFIG, tracker });
  if (secrets) fs.writeFileSync(buildPaths(root).secretsFile, secrets);
  return root;
}

const OLD_SECRETS = `tracker:\n  jira:\n    host: ${SITE}\n    email: ${EMAIL}\n    token: secret\n`;
const tracker = (root: string) => loadConfig(buildPaths(root).configFile).tracker;
const secrets = (root: string) => loadSecrets(buildPaths(root).secretsFile).tracker?.jira;

function mod(opts: FakeJiraOptions = {}) {
  const fake = fakeJira('secret', opts);
  return { fake, m: jiraTrackerModule(fake.fetch) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  jiraConnection.forget?.();
});

describe('Jira settings', () => {
  it('a pasted issue link fills the site and the project, and the Scrum board is picked for sprints', async () => {
    const { m } = mod();
    const root = project();
    await m.save(root, { site: `https://${SITE}/browse/PAY-40`, email: EMAIL, token: 'secret' });
    expect(tracker(root)).toEqual({ type: 'jira', workspace: SITE, project: 'PAY', options: { updates: 'on', board: '1', boardName: 'PAY board' } });
    expect(secrets(root)).toEqual({ host: SITE, email: EMAIL, token: 'secret' });
    // The team's settings never hold the person's sign-in.
    expect(fs.readFileSync(buildPaths(root).configFile, 'utf8')).not.toMatch(/secret|sara@/);
    expect(m.read(root)).toEqual({ values: { site: SITE, email: EMAIL, project: 'PAY', board: '1' }, hasSecret: true });
    const t = m.open(root)!;
    expect(t.abilities).toEqual({ sprints: true, wiki: false, bugs: true, tags: true, create: true });
    expect(await t.whoAmI()).toBe('Sara Ali');
  });

  it('checks with Jira first: a token it refuses saves nothing', async () => {
    const { m } = mod();
    const root = project();
    await expect(m.save(root, { site: 'acme', email: EMAIL, token: 'wrong' })).rejects.toMatchObject({ kind: 'sign-in' });
    expect(tracker(root)).toEqual({ type: 'none' });
    expect(secrets(root)).toBeUndefined();
    await expect(m.save(root, { site: '', email: EMAIL, token: 'secret' })).rejects.toThrow('Enter your Jira site');
    await expect(m.save(root, { site: SITE, email: 'sara', token: 'secret' })).rejects.toThrow('Enter the email');
    await expect(m.save(root, { site: SITE, email: EMAIL, token: '' })).rejects.toThrow('Paste your Jira API token');
  });

  it('a site with several projects: the sign-in is saved first, then the project is picked from the list', async () => {
    const { m } = mod({ projects: [{ key: 'OPS', name: 'Operations' }] });
    const root = project();
    expect(await m.choices!({ site: SITE, email: EMAIL }, root)).toEqual({});
    await m.save(root, { site: 'acme', email: EMAIL, token: 'secret' });
    expect(tracker(root)).toEqual({ type: 'jira', workspace: SITE, options: { updates: 'on' } });
    expect(m.read(root).note).toBe('Pick the project the stories come from, then press Save and check.');
    await expect(m.open(root)!.list()).rejects.toThrow('Pick the Jira project');
    // The lists come from the saved token: no token is ever in the address.
    const lists = await m.choices!({ site: SITE, email: EMAIL, project: 'PAY' }, root);
    expect(lists.project).toEqual([
      { value: 'PAY', label: 'PAY: Payments' },
      { value: 'OPS', label: 'OPS: Operations' },
    ]);
    expect(lists.board).toEqual([
      { value: '', label: 'PAY board (best fit)' },
      { value: 'none', label: 'None: no sprints' },
      { value: '1', label: 'PAY board' },
    ]);
    expect((await m.choices!({ site: SITE, email: EMAIL, project: 'OPS' }, root)).board).toEqual([{ value: '', label: 'None: the project has no board with sprints' }]);
    // Saved again without a token: the saved one stays.
    await m.save(root, { site: SITE, email: EMAIL, token: '', project: 'pay', board: 'none' });
    expect(tracker(root)).toEqual({ type: 'jira', workspace: SITE, project: 'PAY', options: { updates: 'on', board: 'none' } });
    expect(secrets(root)!.token).toBe('secret');
    expect(m.open(root)!.abilities.sprints).toBe(false);
    expect(m.read(root).values.board).toBe('none');
  });

  it('refuses a project or a board Jira does not have, and a board without sprints', async () => {
    const { m } = mod();
    const root = project();
    await expect(m.save(root, { site: SITE, email: EMAIL, token: 'secret', project: 'NOPE' })).rejects.toThrow(`Jira at ${SITE} has no project NOPE that ${EMAIL} can see.`);
    await expect(m.save(root, { site: SITE, email: EMAIL, token: 'secret', project: 'two words' })).rejects.toThrow('is not a Jira project key');
    await expect(m.save(root, { site: SITE, email: EMAIL, token: 'secret', project: 'PAY', board: '2' })).rejects.toThrow('Board PAY flow has no sprints. Pick a board with sprints, or None.');
    await expect(m.save(root, { site: SITE, email: EMAIL, token: 'secret', project: 'PAY', board: '99' })).rejects.toThrow('Jira has no board 99');
    expect(tracker(root)).toEqual({ type: 'none' });
  });

  it('the terminal may give the token to the lists, as it asks for it before the project', async () => {
    const { m } = mod();
    expect((await m.choices!({ site: SITE, email: EMAIL, token: 'secret' }, project())).project).toEqual([{ value: 'PAY', label: 'PAY: Payments' }]);
    expect(m.guess(`https://${SITE}/browse/PAY-1`)).toBeNull();
  });
});

describe('the saved token goes only to the host it was saved for', () => {
  const saved = async (m: ReturnType<typeof mod>['m']) => {
    const root = project();
    await m.save(root, { site: SITE, email: EMAIL, token: 'secret' });
    return root;
  };
  const calls = (fake: ReturnType<typeof fakeJira>) => fake.requests.length;

  it('the lists while the site is typed: no call with it to a half-typed, misspelled or other host', async () => {
    const { m, fake } = mod();
    const root = await saved(m);
    const before = calls(fake);
    for (const site of ['acme.atlas', 'acme.atlassian.ne', 'acmee.atlassian.net', 'jira.mycorp.com', 'evil.example']) {
      expect(await m.choices!({ site, email: EMAIL, project: 'PAY' }, root)).toEqual({});
    }
    expect(calls(fake)).toBe(before);
    expect((await m.choices!({ site: 'acme', email: EMAIL }, root)).project).toHaveLength(1);
  });

  it("a commit that changes the team's site: nobody's token goes there, and Settings and Connections say what to do", async () => {
    vi.stubGlobal('fetch', fakeJira().fetch);
    const { m, fake } = mod();
    const root = await saved(m);
    saveConfig(buildPaths(root).configFile, { ...loadConfig(buildPaths(root).configFile), tracker: { ...tracker(root), workspace: 'other.atlassian.net' } });
    const before = calls(fake);
    expect(m.open(root)).toBeNull();
    expect(m.read(root)).toMatchObject({ values: { site: 'other.atlassian.net' }, hasSecret: false, note: "The team's Jira site is now other.atlassian.net. Paste your token for it." });
    expect(await m.choices!({ site: 'other.atlassian.net', email: EMAIL }, root)).toEqual({});
    jiraConnection.forget?.();
    const row = await jiraConnection.status(root);
    expect(row.state).toBe('not-connected');
    expect(row.steps[0]!.text).toEqual({ en: "The team's Jira site is now other.atlassian.net. Paste your token for it.", ar: 'موقع Jira للفريق صار other.atlassian.net. الصق رمزك له.' });
    expect(calls(fake)).toBe(before);
  });

  it('saving a new site with the token left empty never carries the old token there', async () => {
    const { m, fake } = mod();
    const root = await saved(m);
    const before = calls(fake);
    await expect(m.save(root, { site: 'other.atlassian.net', email: EMAIL, token: '' })).rejects.toThrow('Paste your Jira API token for other.atlassian.net.');
    expect(fake.requests.slice(before)).toEqual([]);
    expect(tracker(root).workspace).toBe(SITE);
  });
});

describe('a Jira setup from squad-kit 0.x', () => {
  it('reads with the saved site, email and token, asks nothing again, and writes once saved', async () => {
    const { m, fake } = mod();
    const root = project({ type: 'jira', workspace: SITE }, OLD_SECRETS);
    const old = m.open(root)!;
    expect(old.abilities.create).toBe(false);
    expect(await old.whoAmI()).toBe('Sara Ali');
    expect((await old.get('PAY-40')).title).toBe('Hold a slot');
    await expect(old.comment('PAY-40', 'x')).rejects.toMatchObject({ kind: 'sign-in' });
    expect(m.read(root)).toEqual({
      values: { site: SITE, email: EMAIL, project: '', board: '' },
      hasSecret: true,
      note: 'Set up before this version: squad-kit only reads Jira for now. Pick the project the stories come from, then press Save and check to let it update Jira.',
    });
    // Save and check with the form as it stands: the token is not typed again.
    await m.save(root, { ...m.read(root).values, project: 'PAY' });
    const now = m.open(root)!;
    expect(now.abilities.create).toBe(true);
    await now.comment('PAY-40', 'Connected again');
    expect(fake.comments('PAY-40')).toHaveLength(1);
    expect(m.read(root).note).toBeUndefined();
  });

  it('a 0.x project key is kept, and JIRA_* variables still work, a token in JIRA_API_TOKEN going only to JIRA_HOST', async () => {
    const { m } = mod();
    const root = project({ type: 'jira', workspace: SITE, project: 'pay' });
    expect(m.open(root)).toBeNull();
    expect(m.read(root).hasSecret).toBe(false);
    process.env.JIRA_EMAIL = EMAIL;
    process.env.JIRA_API_TOKEN = 'secret';
    // A token without the host it is for goes nowhere.
    expect(m.open(root)).toBeNull();
    process.env.JIRA_HOST = SITE;
    const t = m.open(root)!;
    expect(t.refOf('40')).toBe('PAY-40');
    expect((await t.list()).length).toBeGreaterThan(0);
    expect(m.read(root).note).toBe('Set up before this version: squad-kit only reads Jira for now. Press Save and check to let it update Jira.');
  });
});

describe('Jira on the Connections page and the lists route', () => {
  it('a token connection: not connected, then connected as the token owner, with a link to make the token', async () => {
    const fake = fakeJira();
    vi.stubGlobal('fetch', fake.fetch);
    const root = project();
    const before = await jiraConnection.status(root);
    expect(before.state).toBe('not-connected');
    expect(before.steps[0]!.link).toBe('https://id.atlassian.com/manage-profile/security/api-tokens');
    expect(before.steps.at(-1)!.command).toBe('squad config set tracker');
    expect(jiraConnection).toMatchObject({ how: 'token', tracker: 'jira', next: { en: 'Sign in with Atlassian' } });
    for (const line of [...jiraConnection.can, jiraConnection.what, ...before.steps.map((s) => s.text)]) expect(line.ar.trim()).toBeTruthy();
    await jiraTrackerModule(fake.fetch).save(root, { site: SITE, email: EMAIL, token: 'secret' });
    jiraConnection.forget?.();
    expect(await jiraConnection.status(root)).toMatchObject({ state: 'connected', account: 'Sara Ali' });
  });

  it('GET /api/v1/tracker/choices lists with the token saved for the project', async () => {
    const fake = fakeJira();
    vi.stubGlobal('fetch', fake.fetch);
    const root = project();
    await jiraTrackerModule(fake.fetch).save(root, { site: SITE, email: EMAIL, token: 'secret' });
    const app = new Hono();
    mountTrackerChoices(app, { paths: buildPaths(root) });
    const res = (await (await app.request(`/api/v1/tracker/choices?module=jira&site=${SITE}&email=${encodeURIComponent(EMAIL)}&project=PAY`)).json()) as { lists: Record<string, unknown[]> };
    expect(res.lists.project).toHaveLength(1);
    expect(res.lists.board).toHaveLength(3);
  });
});
