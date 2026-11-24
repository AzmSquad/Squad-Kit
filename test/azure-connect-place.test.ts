import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { Hono } from 'hono';
import { boardPaths, writeMeta, type BoardPaths } from '../src/board/store.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig, type TrackerType } from '../src/core/config.js';
import { buildPaths } from '../src/core/paths.js';
import { loadSecrets } from '../src/core/secrets.js';
import { cancelSignIn, connectionsOf, pickSite, saveToken, signInNow, startSignIn } from '../src/engine/connections.js';
import { mountConnectionsApi } from '../src/console/api/connections.js';
import { connectionLines } from '../src/commands/connect.js';
import { parseBoardAddress } from '../src/modules/azure/hosts.js';
import { azureTracker } from '../src/modules/azure/tracker.js';
import { forgetMicrosoftTokens } from '../src/modules/azure/token.js';
import { MS_TOKEN, ZEROS, TENANT, fakeAz, fakeDevOps, signedIn, type FakeAz } from './support/fake-azure.js';

/**
 * Connecting Azure DevOps in one place: a project whose stories come from Azure Boards is Connected only once squad-kit
 * reaches its project. Right after Sign in with Microsoft the row lists the projects the account reaches to pick from,
 * takes the board's address pasted from the browser, and takes a token with real steps, all on the same row. Nothing
 * reaches Microsoft: az is made up and Azure DevOps is answered by the test.
 */

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let tmp = '';
let az: FakeAz | undefined;
let devops: ReturnType<typeof fakeDevOps> | undefined;

/** A phone app whose code is on GitHub and whose stories come from Azure Boards, with no place saved yet (a phone app's usual case). */
function project(o: { type?: TrackerType; place?: { org: string; project: string } } = {}): BoardPaths {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-azure-place-')));
  const dir = path.join(tmp, 'app');
  fs.mkdirSync(dir);
  sh('git init -q -b main', dir);
  sh('git remote add origin git@github.com:acme/app-mobile.git', dir);
  fs.mkdirSync(path.join(dir, '.squad'));
  const tracker = o.place ? { type: 'azure' as const, workspace: o.place.org, project: o.place.project } : { type: o.type ?? 'azure' };
  saveConfig(buildPaths(dir).configFile, { ...DEFAULT_CONFIG, tracker: { ...DEFAULT_CONFIG.tracker, ...tracker } });
  const bp = boardPaths(path.join(dir, '.squad'));
  writeMeta(bp, {
    project: 'App',
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
    commands: {},
    git: { base: 'main', remote: 'origin' },
    scan: { status: 'done', empty: false },
  });
  return bp;
}

const azureRow = async (bp: BoardPaths) => (await connectionsOf(bp, { again: true })).rows.find((r) => r.name === 'azure')!;
const placeSaved = (bp: BoardPaths) => {
  const t = loadConfig(buildPaths(bp.root).configFile).tracker;
  return { type: t.type, workspace: t.workspace, project: t.project };
};

beforeEach(() => {
  az = fakeAz();
});

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(ok()).toBe(true);
};

afterEach(() => {
  if (signInNow('azure')?.state === 'waiting') cancelSignIn('azure');
  vi.unstubAllEnvs();
  devops?.done();
  devops = undefined;
  az?.done();
  az = undefined;
  forgetMicrosoftTokens();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the address of an Azure Boards page, pasted from the browser', () => {
  it('reads the organization and project from any page of the project, or from organization/project', () => {
    expect(parseBoardAddress('https://dev.azure.com/fabrikam/Mobile%20App/_boards/board/t/Mobile%20App%20Team/Stories')).toEqual({ organization: 'fabrikam', project: 'Mobile App' });
    expect(parseBoardAddress('dev.azure.com/contoso/Shop')).toEqual({ organization: 'contoso', project: 'Shop' });
    expect(parseBoardAddress('https://contoso.visualstudio.com/DefaultCollection/Shop/_workitems/edit/12?x=1')).toEqual({ organization: 'contoso', project: 'Shop' });
    expect(parseBoardAddress('https://contoso.visualstudio.com/Shop/_git/shop')).toEqual({ organization: 'contoso', project: 'Shop' });
    expect(parseBoardAddress('  contoso/Shop  ')).toEqual({ organization: 'contoso', project: 'Shop' });
  });

  it('names no project: Azure DevOps pages of the organization, another site, or nothing', () => {
    expect(parseBoardAddress('https://dev.azure.com/contoso/_usersSettings/tokens')).toBeNull();
    expect(parseBoardAddress('https://dev.azure.com/contoso')).toBeNull();
    expect(parseBoardAddress('https://github.com/acme/app')).toBeNull();
    expect(parseBoardAddress('contoso')).toBeNull();
    expect(parseBoardAddress('')).toBeNull();
  });
});

describe('Connections: Azure DevOps is Connected only once squad-kit reaches the project', () => {
  it('signed in with no place yet: never Connected; the projects the account reaches, to pick from, one click', async () => {
    const bp = project();
    devops = fakeDevOps({ projects: { contoso: ['Shop', 'Admin'] } });
    signedIn();
    const row = await azureRow(bp);
    expect(row).toMatchObject({ state: 'not-connected', line: { en: 'Signed in as sara@contoso.com. Pick the project your stories come from.' } });
    expect(row.pick).toEqual([
      { site: 'contoso/Admin', name: 'Admin', where: 'contoso' },
      { site: 'contoso/Shop', name: 'Shop', where: 'contoso' },
    ]);
    expect(row.address).toMatchObject({ example: 'dev.azure.com/your-organization/your-project' });
    expect(row.address?.now).toBeUndefined();
    // The token way is on the same row, closed: no Settings first.
    expect(row.token).toMatchObject({ command: 'squad config set tracker' });
    expect(row.token?.open).toBeUndefined();
    // Signed in already: no second Sign in button, and the sign-in can still be ended.
    expect(row.actions.map((a) => a.id)).toEqual(['disconnect', 'check']);

    expect((await pickSite(bp, 'azure', 'contoso/Shop')).line).toBe('Stories for this project come from contoso / Shop on Azure DevOps.');
    expect(placeSaved(bp)).toEqual({ type: 'azure', workspace: 'contoso', project: 'Shop' });
    // No token was saved: the Microsoft sign-in is used.
    expect(loadSecrets(buildPaths(bp.root).secretsFile).tracker?.azure?.pat).toBeUndefined();
    const after = await azureRow(bp);
    expect(after).toMatchObject({ state: 'connected', account: 'Sara Ahmed', address: { now: 'contoso / Shop' } });
    expect(after.pick).toBeUndefined();
    expect(devops.calls.some((c) => c.url.includes('/contoso/_apis/projects/Shop'))).toBe(true);
  });

  it('a pasted address is used as Azure DevOps names the project, and a project that is not there is never saved', async () => {
    const bp = project();
    devops = fakeDevOps({ projects: { contoso: ['Mobile App'] } });
    signedIn();
    await expect(pickSite(bp, 'azure', 'https://dev.azure.com/contoso/Web/_boards')).rejects.toThrow('squad-kit could not find the project Web in contoso. Check the address, or pick it from the list.');
    expect(placeSaved(bp).workspace).toBeUndefined();
    await expect(pickSite(bp, 'azure', 'https://dev.azure.com/nowhere/Web')).rejects.toThrow('squad-kit could not find the organization nowhere on Azure DevOps. Check the address.');
    await expect(pickSite(bp, 'azure', 'https://github.com/acme/app')).rejects.toThrow('Paste the address of your Azure Boards, like dev.azure.com/your-organization/your-project.');
    expect((await pickSite(bp, 'azure', 'dev.azure.com/contoso/mobile%20app/_backlogs')).line).toBe('Stories for this project come from contoso / Mobile App on Azure DevOps.');
    expect(placeSaved(bp)).toMatchObject({ workspace: 'contoso', project: 'Mobile App' });
  });

  it('a saved project that is not there (a typo, renamed): not Connected, with the right ones to pick', async () => {
    const bp = project({ place: { org: 'contoso', project: 'Shopp' } });
    devops = fakeDevOps({ projects: { contoso: ['Shop'] } });
    signedIn();
    const row = await azureRow(bp);
    expect(row).toMatchObject({ state: 'not-connected', line: { en: 'squad-kit could not find the project Shopp in contoso. Pick the right one, or paste its address.' } });
    expect(row.pick).toEqual([{ site: 'contoso/Shop', name: 'Shop', where: 'contoso' }]);
  });

  it('an account that reaches no project says so, with the address to paste and the token way', async () => {
    const bp = project();
    devops = fakeDevOps({ member: [] });
    signedIn();
    const row = await azureRow(bp);
    expect(row).toMatchObject({ state: 'not-connected' });
    expect(row.line?.en).toBe("Signed in as sara@contoso.com, but this account reaches no Azure DevOps project. Paste your board's address, or sign in with the account your team uses.");
    expect(row.pick).toBeUndefined();
    expect(row.address).toBeDefined();
    expect(row.token).toBeDefined();
  });

  it('not reaching Azure DevOps while listing is never "no project": the row waits and asks again', async () => {
    const bp = project();
    devops = fakeDevOps({ offline: true });
    signedIn();
    const row = await azureRow(bp);
    expect(row.state).toBe('unknown');
    expect(row.line?.en).toContain('could not be reached just now');
  });

  it('a project on another tracker keeps the row about the sign-in alone: nothing to pick, and picking is refused', async () => {
    const bp = project({ type: 'jira' });
    devops = fakeDevOps();
    signedIn();
    const row = await azureRow(bp);
    expect(row).toMatchObject({ state: 'connected', account: 'sara@contoso.com' });
    expect(row.pick).toBeUndefined();
    expect(row.address).toBeUndefined();
    expect(row.token).toBeUndefined();
    await expect(pickSite(bp, 'azure', 'contoso/Shop')).rejects.toThrow("This project's stories come from another tracker.");
    expect(placeSaved(bp).type).toBe('jira');
  });

  it('a new sign-in asks afresh what the account reaches: no list kept from the account before', async () => {
    const bp = project();
    devops = fakeDevOps({ member: [] });
    signedIn();
    expect((await azureRow(bp)).line?.en).toContain('reaches no Azure DevOps project');
    // The person signs in with the account their team uses, within the minute the list is kept.
    devops.done();
    devops = fakeDevOps({ projects: { contoso: ['Shop'] } });
    await startSignIn(bp, 'azure');
    az!.touch('approve');
    await until(() => signInNow('azure')?.state === 'done');
    const row = (await connectionsOf(bp)).rows.find((r) => r.name === 'azure')!;
    expect(row.pick).toEqual([{ site: 'contoso/Shop', name: 'Shop', where: 'contoso' }]);
  });

  it('a pick is refused, in plain words, when the saved token cannot reach the new organization', async () => {
    const bp = project({ place: { org: 'contoso', project: 'Shop' } });
    vi.stubEnv('AZURE_DEVOPS_PAT', 'contoso-only');
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const u = new URL(url);
      const auth = (init.headers as Record<string, string> | undefined)?.authorization;
      const org = u.pathname.split('/')[1];
      if (!auth) return new Response(null, { status: 401, headers: { 'x-vss-resourcetenant': TENANT } });
      if (org === 'fabrikam') return new Response('', { status: 401 });
      return new Response(JSON.stringify({ authenticatedUser: { providerDisplayName: 'Sara (token)' }, name: 'Shop' }), { status: 200 });
    });
    await expect(pickSite(bp, 'azure', 'dev.azure.com/fabrikam/Web')).rejects.toThrow('The token saved for this project does not work in fabrikam');
    expect(placeSaved(bp)).toMatchObject({ workspace: 'contoso', project: 'Shop' });
  });

  it('a project with no tracker yet takes Azure Boards when its project is picked', async () => {
    const bp = project({ type: 'none' });
    devops = fakeDevOps();
    signedIn();
    expect((await azureRow(bp)).pick).toEqual([{ site: 'contoso/Shop', name: 'Shop', where: 'contoso' }]);
    await pickSite(bp, 'azure', 'contoso/Shop');
    expect(placeSaved(bp)).toEqual({ type: 'azure', workspace: 'contoso', project: 'Shop' });
  });
});

describe('a token pasted on the same row', () => {
  it('is checked before it is saved: a refused token saves nothing, a good one connects with the place', async () => {
    const bp = project();
    devops = fakeDevOps({ orgs: { 'home-org': ZEROS }, projects: { 'home-org': ['Shop'] } });
    // A personal-account organization: the token form is open at once, with its tokens page.
    await pickSite(bp, 'azure', 'dev.azure.com/home-org/Shop');
    const row = await azureRow(bp);
    expect(row).toMatchObject({ state: 'not-connected', by: 'token', token: { open: true, address: 'dev.azure.com/home-org/Shop' } });
    expect(row.token?.steps[0]?.link).toBe('https://dev.azure.com/home-org/_usersSettings/tokens');
    vi.stubGlobal('fetch', async (url: string) => (new URL(url).pathname === '/home-org' ? new Response(null, { status: 401, headers: { 'x-vss-resourcetenant': ZEROS } }) : new Response('', { status: 401 })));
    await expect(saveToken(bp, 'azure', { token: 'bad-token' })).rejects.toThrow('Azure DevOps did not accept this token for home-org. Make a new one with the steps here, and paste it again. Nothing was saved.');
    expect(loadSecrets(buildPaths(bp.root).secretsFile).tracker?.azure?.pat).toBeUndefined();
    devops = fakeDevOps({ orgs: { 'home-org': ZEROS }, projects: { 'home-org': ['Shop'] } });
    await expect(saveToken(bp, 'azure', { token: '  ' })).rejects.toThrow('Paste the token first.');
    expect((await saveToken(bp, 'azure', { token: 'good-token' })).line).toBe('Azure DevOps is connected with your token, as Sara (token). Stories come from home-org / Shop.');
    expect(loadSecrets(buildPaths(bp.root).secretsFile).tracker?.azure).toMatchObject({ organization: 'home-org', project: 'Shop', pat: 'good-token' });
    expect(await azureRow(bp)).toMatchObject({ state: 'connected', by: 'token', address: { now: 'home-org / Shop' } });
  });

  it('a token without the right to read projects still connects: work items and code are what it is for', async () => {
    const bp = project();
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const u = new URL(url);
      const auth = (init.headers as Record<string, string> | undefined)?.authorization;
      if (!auth) return new Response(null, { status: 401, headers: { 'x-vss-resourcetenant': ZEROS } });
      if (u.pathname.endsWith('/_apis/connectionData')) return new Response(JSON.stringify({ authenticatedUser: { providerDisplayName: 'Sara (token)' } }), { status: 200 });
      return new Response('', { status: 401 });
    });
    await saveToken(bp, 'azure', { address: 'dev.azure.com/home-org/Shop', token: 'work-items-only' });
    expect(loadSecrets(buildPaths(bp.root).secretsFile).tracker?.azure).toMatchObject({ organization: 'home-org', project: 'Shop', pat: 'work-items-only' });
    expect(await azureRow(bp)).toMatchObject({ state: 'connected', by: 'token', address: { now: 'home-org / Shop' } });
  });

  it('a token that may not read projects still finds a typo: the project\'s work item types say it is not there', async () => {
    const bp = project();
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const u = new URL(url);
      const auth = (init.headers as Record<string, string> | undefined)?.authorization;
      if (!auth) return new Response(null, { status: 401, headers: { 'x-vss-resourcetenant': ZEROS } });
      if (u.pathname.endsWith('/_apis/connectionData')) return new Response(JSON.stringify({ authenticatedUser: { providerDisplayName: 'Sara (token)' } }), { status: 200 });
      if (u.pathname === '/home-org/Shopp/_apis/wit/workitemtypes') return new Response(JSON.stringify({ message: 'TF200016' }), { status: 404 });
      return new Response('', { status: 401 });
    });
    await expect(saveToken(bp, 'azure', { address: 'dev.azure.com/home-org/Shopp', token: 'work-items-only' })).rejects.toThrow('squad-kit could not find the project Shopp in home-org.');
    expect(loadSecrets(buildPaths(bp.root).secretsFile).tracker?.azure?.pat).toBeUndefined();
  });

  it('takes the address with the token when the project has no place yet', async () => {
    const bp = project();
    devops = fakeDevOps({ projects: { contoso: ['Shop'] } });
    await expect(saveToken(bp, 'azure', { token: 'good-token' })).rejects.toThrow('Paste the address of your Azure Boards too');
    await saveToken(bp, 'azure', { address: 'https://dev.azure.com/contoso/shop/_boards', token: 'good-token' });
    expect(placeSaved(bp)).toMatchObject({ workspace: 'contoso', project: 'Shop' });
  });

  it('over REST: one call, and the token never comes back', async () => {
    const bp = project();
    devops = fakeDevOps({ projects: { contoso: ['Shop'] } });
    const app = new Hono();
    mountConnectionsApi(app, { paths: buildPaths(bp.root) });
    const res = await app.request('/api/v1/connections/azure/token', { method: 'POST', body: JSON.stringify({ address: 'contoso/Shop', token: 'good-token-77' }), headers: { 'content-type': 'application/json' } });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain('connected with your token');
    expect(text).not.toContain('good-token-77');
    const listed = await (await app.request('/api/v1/connections?again=1')).text();
    expect(listed).not.toContain('good-token-77');
    expect(listed).not.toContain(MS_TOKEN);
    const site = await app.request('/api/v1/connections/azure/site', { method: 'POST', body: JSON.stringify({ site: 'contoso/Shop' }), headers: { 'content-type': 'application/json' } });
    expect(site.status).toBe(200);
  });
});

describe('Settings and the terminal say the same', () => {
  it('Settings never says a token is needed while squad-kit is signed in with Microsoft', () => {
    const bp = project();
    expect(azureTracker.read(bp.root)).toEqual({ values: { organization: '', project: '' }, hasSecret: false });
    signedIn(TENANT);
    expect(azureTracker.read(bp.root)).toMatchObject({ hasSecret: false, signedIn: true, note: 'You are signed in with Microsoft, so no token is needed. Pick your project on the Connections page.' });
    azureTracker.save(bp.root, { organization: 'contoso', project: 'Shop' });
    expect(azureTracker.read(bp.root).note).toBe('You are signed in with Microsoft, so no token is needed.');
  });

  it('squad connect --status lists the projects to pick and the address to paste', async () => {
    const bp = project();
    devops = fakeDevOps({ projects: { contoso: ['Shop'] } });
    signedIn();
    const lines = connectionLines([await azureRow(bp)]).join('\n');
    expect(lines).toContain('Signed in as sara@contoso.com. Pick the project your stories come from.');
    expect(lines).toContain('1. Shop (contoso/Shop)');
    expect(lines).toContain('Not in the list? Paste its address: squad connect azure --site dev.azure.com/your-organization/your-project');
  });
});
