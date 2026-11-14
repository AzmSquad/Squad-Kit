import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { Hono } from 'hono';
import { boardPaths, writeMeta, type BoardPaths } from '../src/board/store.js';
import { DEFAULT_CONFIG, saveConfig } from '../src/core/config.js';
import { buildPaths } from '../src/core/paths.js';
import { ownAzureFolder, squadHome } from '../src/core/home.js';
import { cancelSignIn, connectionsOf, disconnect, signInNow, startSignIn } from '../src/engine/connections.js';
import { mountConnectionsApi } from '../src/console/api/connections.js';
import { azureConnection } from '../src/modules/azure/connection.js';
import { useAzurePace } from '../src/modules/azure/device-sign-in.js';
import { orgTenant } from '../src/modules/azure/tenant.js';
import { forgetMicrosoftTokens, microsoftToken } from '../src/modules/azure/token.js';
import { azureTracker } from '../src/modules/azure/tracker.js';
import { azureCodeHost } from '../src/modules/azure/code-host.js';
import { ModuleError } from '../src/modules/errors.js';
import { pathWithoutGh } from './support/fake-github.js';
import { MS_TOKEN, OTHER_TENANT, TENANT, ZEROS, fakeAz, fakeDevOps, signedIn, type FakeAz } from './support/fake-azure.js';

/**
 * Sign in with Microsoft for Azure DevOps (ADR-011): squad-kit runs Microsoft's own tool, az, always with its own
 * settings folder, reads the one-time code and page from what az prints, finds the organization's directory without
 * signing in, and keeps the token in memory only. A saved token wins. az here is made up and Azure DevOps is answered
 * by the test: nothing reaches Microsoft.
 */

const REMOTE = 'https://dev.azure.com/contoso/Shop/_git/shop';
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let tmp = '';
let az: FakeAz | undefined;
let devops: ReturnType<typeof fakeDevOps> | undefined;

/** A project whose stories come from Azure Boards in `org`, with its code on Azure Repos. */
function project(org = 'contoso'): BoardPaths {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-azure-ms-')));
  const dir = path.join(tmp, 'app');
  fs.mkdirSync(dir);
  sh('git init -q -b main', dir);
  sh(`git remote add origin https://dev.azure.com/${org}/Shop/_git/shop`, dir);
  fs.mkdirSync(path.join(dir, '.squad'));
  const file = buildPaths(dir).configFile;
  saveConfig(file, { ...DEFAULT_CONFIG, tracker: { ...DEFAULT_CONFIG.tracker, type: 'azure', workspace: org, project: 'Shop' } });
  const bp = boardPaths(path.join(dir, '.squad'));
  writeMeta(bp, {
    project: 'Shop',
    key: 'SH',
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

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(ok()).toBe(true);
};
const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const azureRow = async (bp: BoardPaths) => (await connectionsOf(bp, { again: true })).rows.find((r) => r.name === 'azure')!;
/** Every file under squad-kit's own folder, read: none may hold the Microsoft token. */
const filesHolding = (dir: string, text: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return filesHolding(p, text);
    return fs.readFileSync(p, 'utf8').includes(text) ? [p] : [];
  });

beforeEach(() => {
  az = fakeAz();
});

afterEach(() => {
  if (signInNow('azure')?.state === 'waiting') cancelSignIn('azure');
  useAzurePace(null);
  vi.unstubAllEnvs();
  devops?.done();
  devops = undefined;
  az?.done();
  az = undefined;
  forgetMicrosoftTokens();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the organization’s directory, found without signing in', () => {
  const answer = (status: number, headers: Record<string, string> = {}) => vi.fn(async () => new Response('', { status, headers })) as unknown as typeof fetch;

  it('reads X-VSS-ResourceTenant from the answer to a call with no sign-in, and asks once an hour', async () => {
    const http = answer(401, { 'x-vss-resourcetenant': TENANT.toUpperCase() });
    expect(await orgTenant('Contoso', http)).toEqual({ kind: 'entra', tenant: TENANT });
    expect(await orgTenant('contoso', http)).toEqual({ kind: 'entra', tenant: TENANT });
    expect(http).toHaveBeenCalledTimes(1);
    const [url, init] = (http as unknown as ReturnType<typeof vi.fn>).mock.calls[0]! as [string, RequestInit];
    // A HEAD of the organization's own address, as Git Credential Manager asks: an API page of an organization with
    // public projects answers anonymously, with no header.
    expect(url).toBe('https://dev.azure.com/Contoso');
    expect(init.method).toBe('HEAD');
    expect(init.headers).toEqual({ 'X-TFS-FedAuthRedirect': 'Suppress' });
    expect(init.redirect).toBe('manual');
  });

  it('all zeros: not on Microsoft Entra; a 404: no such organization; only WWW-Authenticate: its directory', async () => {
    expect(await orgTenant('personal-org', answer(401, { 'x-vss-resourcetenant': ZEROS }))).toEqual({ kind: 'personal' });
    expect(await orgTenant('nobody-here', answer(404))).toEqual({ kind: 'not-found' });
    expect(await orgTenant('old-style', answer(302, { 'www-authenticate': `Bearer authorization_uri=https://login.microsoftonline.com/${OTHER_TENANT}, Basic realm="x"` }))).toEqual({ kind: 'entra', tenant: OTHER_TENANT });
  });

  it('not reachable is never kept: the next look asks again', async () => {
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await orgTenant('far-away', offline)).toEqual({ kind: 'no-answer' });
    expect(await orgTenant('far-away', answer(401, { 'x-vss-resourcetenant': TENANT }))).toEqual({ kind: 'entra', tenant: TENANT });
  });
});

describe('Connections: Sign in with Microsoft through its own tool, in squad-kit’s own folder', () => {
  it("gives az's one-time code and Microsoft's page, signs in to the organization's directory, and is connected", async () => {
    const bp = project();
    devops = fakeDevOps();
    const f = await startSignIn(bp, 'azure');
    expect(f).toMatchObject({ state: 'waiting', code: 'GZ3SDVTBE', url: 'https://login.microsoft.com/device' });
    expect(az!.calls()).toContain(`login --use-device-code --allow-no-subscriptions --tenant ${TENANT} --output none | dir=${ownAzureFolder()} | telemetry=false`);
    // Asked again while it waits: the same sign-in, not a second az.
    expect((await startSignIn(bp, 'azure')).pid).toBe(f.pid);
    const waiting = await azureRow(bp);
    expect(waiting).toMatchObject({ how: 'sign-in', tracker: 'azure', state: 'not-connected', codePage: { name: 'Microsoft' }, ownSignIn: true, flow: { state: 'waiting', code: 'GZ3SDVTBE' } });
    expect(waiting.actions.map((a) => [a.id, a.name, a.command])).toEqual([
      ['sign-in', 'Sign in with Microsoft', 'squad connect azure'],
      ['check', 'Check again', 'squad connect --status'],
    ]);
    az!.touch('approve');
    await until(() => signInNow('azure')?.state === 'done');
    expect(signInNow('azure')?.account).toBe('sara@contoso.com');
    const row = await azureRow(bp);
    expect(row).toMatchObject({ state: 'connected', account: 'Sara Ahmed', for: { repo: 'Shop/shop', self: false } });
    expect(row.by).toBeUndefined();
    expect(row.actions.map((a) => a.id)).toEqual(['disconnect', 'check']);
    expect(row.steps[1]!.done).toEqual({ en: 'Signed in as sara@contoso.com', ar: 'مسجّل باسم sara@contoso.com' });
    // Every az run used squad-kit's own folder, never the person's ~/.azure, and sent no usage report.
    expect(az!.calls().every((c) => c.endsWith(`| dir=${ownAzureFolder()} | telemetry=false`))).toBe(true);
    expect(ownAzureFolder()).toBe(path.join(squadHome(), 'azure-cli'));
    // The token went in memory only: on no command line and in no file of squad-kit's.
    expect(az!.calls().some((c) => c.includes(MS_TOKEN))).toBe(false);
    expect(filesHolding(squadHome(), MS_TOKEN)).toEqual([]);
    expect(devops.calls.filter((c) => c.auth === `Bearer ${MS_TOKEN}`).length).toBeGreaterThan(0);
  });

  it('Cancel stops that az and the Python it started, by their own group, and nothing is signed in', async () => {
    const bp = project();
    devops = fakeDevOps();
    const f = await startSignIn(bp, 'azure');
    const inner = path.join(az!.bin, 'inner.pid');
    await until(() => fs.existsSync(inner) && fs.readFileSync(inner, 'utf8').trim() !== '');
    const python = Number(fs.readFileSync(inner, 'utf8').trim());
    expect(running(f.pid!) && running(python)).toBe(true);
    expect(cancelSignIn('azure')).toMatchObject({ state: 'cancelled', pid: f.pid });
    await until(() => !running(f.pid!) && !running(python));
    expect(fs.existsSync(path.join(ownAzureFolder(), 'azureProfile.json'))).toBe(false);
    expect((await azureRow(bp)).state).toBe('not-connected');
  });

  it('az gives no code in time, or Microsoft says no: the sign-in failed in plain words', async () => {
    const bp = project();
    devops = fakeDevOps();
    az!.touch('silent');
    useAzurePace({ codeWaitMs: 300 });
    const f = await startSignIn(bp, 'azure');
    expect(f).toMatchObject({ state: 'failed', line: "Microsoft's tool gave no sign-in code. Try again, or use a token instead." });
    await until(() => !running(f.pid!));
    fs.rmSync(path.join(az!.bin, 'silent'));
    az!.touch('decline');
    az!.touch('approve');
    await startSignIn(bp, 'azure');
    await until(() => signInNow('azure')?.state === 'failed');
    expect(signInNow('azure')?.line).toBe('Microsoft did not finish the sign-in: AADSTS70016: The person declined the sign-in. Try again.');
  });

  it('a code nobody approves stops after its time (15 minutes for real), and az with it', async () => {
    const bp = project();
    devops = fakeDevOps();
    useAzurePace({ lifeMs: 300 });
    const f = await startSignIn(bp, 'azure');
    expect(f.state).toBe('waiting');
    await until(() => signInNow('azure')?.state === 'failed');
    expect(signInNow('azure')?.line).toBe('The code expired after 15 minutes. Try again.');
    await until(() => !running(f.pid!));
  });

  it('az is not on this computer: the guide with the Tools page, the token as the other way, and no Sign in', async () => {
    const bp = project();
    devops = fakeDevOps();
    const bare = fs.mkdtempSync(path.join(tmp, 'bin-'));
    process.env.PATH = pathWithoutGh(bare, 'az');
    const row = await azureRow(bp);
    expect(row.state).toBe('missing');
    expect(row.steps[0]).toMatchObject({ page: '/tools#az', text: { en: "Install Microsoft's Azure tool" } });
    expect(row.steps[0]!.done).toBeUndefined();
    expect(row.steps[0]!.command).toBe(process.platform === 'darwin' ? 'brew install azure-cli' : undefined);
    expect(row.steps[1]!.command).toBe('squad connect azure');
    expect(row.tracker).toBe('azure');
    expect(row.actions.map((a) => a.id)).toEqual(['check']);
    expect(await startSignIn(bp, 'azure')).toMatchObject({ state: 'failed', line: "Microsoft's Azure tool, az, is not on this computer. Install it from the Tools page first, or use a token instead." });
  });

  it('an organization not on Microsoft Entra says it needs a token, with the token steps, and cannot sign in', async () => {
    const bp = project('personal-org');
    devops = fakeDevOps({ orgs: { 'personal-org': ZEROS } });
    const row = await azureRow(bp);
    expect(row).toMatchObject({ state: 'not-connected', by: 'token' });
    expect(row.line?.en).toBe('personal-org is not on Microsoft Entra, so it needs a token. Make one on Azure DevOps and paste it in Settings.');
    expect(row.line?.ar).toContain('Microsoft Entra');
    expect(row.steps.map((s) => s.command)).toEqual([undefined, undefined, 'squad config set tracker']);
    expect(row.actions.map((a) => a.id)).toEqual(['check']);
    const f = await startSignIn(bp, 'azure');
    expect(f).toMatchObject({ state: 'failed' });
    expect(f.line).toContain('Use a token instead');
    expect(az!.calls().some((c) => c.startsWith('login'))).toBe(false);
  });

  it('signed in with an account that cannot reach the organization: plain words, and Sign in again', async () => {
    const bp = project();
    // The account is in the directory, but not a member of the organization: Azure DevOps refuses its token.
    devops = fakeDevOps({ access: false });
    signedIn(TENANT, 'sam@fabrikam.com');
    let row = await azureRow(bp);
    expect(row).toMatchObject({ state: 'not-connected' });
    expect(row.line?.en).toBe('Signed in as sam@fabrikam.com, which has no access to contoso. Sign in with the Microsoft account that owns contoso.');
    expect(row.actions.map((a) => a.id)).toEqual(['sign-in', 'check']);
    // An account from another directory: Microsoft gives no token for the organization's.
    devops.done();
    devops = fakeDevOps();
    signedIn(OTHER_TENANT, 'sam@fabrikam.com');
    az!.touch('refuse');
    row = await azureRow(bp);
    expect(row.line?.en).toBe('Signed in as sam@fabrikam.com, which has no access to contoso. Sign in with the Microsoft account that owns contoso.');
    // In its own directory, the sign-in has only ended: sign in again.
    signedIn(TENANT, 'sara@contoso.com');
    row = await azureRow(bp);
    expect(row.line?.en).toBe('The Microsoft sign-in has ended. Sign in with Microsoft again.');
  });

  it('a saved token wins: connected by the token, no sign-in and no Disconnect, and Settings says which is used', async () => {
    const bp = project();
    devops = fakeDevOps();
    signedIn();
    vi.stubEnv('AZURE_DEVOPS_PAT', 'pat-secret');
    const row = await azureRow(bp);
    expect(row).toMatchObject({ state: 'connected', account: 'Sara (token)', by: 'token' });
    expect(row.actions.map((a) => a.id)).toEqual(['check']);
    await expect(disconnect(bp, 'azure')).rejects.toThrow('Azure DevOps is connected with the token saved in Settings. Change it there.');
    expect(azureTracker.read(bp.root).note).toBe('The token saved here is used, not your Microsoft sign-in.');
    await azureTracker.open(bp.root)!.whoAmI();
    expect(devops.calls.at(-1)!.auth).toBe(`Basic ${Buffer.from(':pat-secret').toString('base64')}`);
    expect(az!.calls().some((c) => c.startsWith('account get-access-token'))).toBe(false);
  });

  it('Disconnect signs squad-kit out of its own folder only, and says the person’s other sign-ins stay', async () => {
    const bp = project();
    devops = fakeDevOps();
    signedIn();
    expect((await azureRow(bp)).state).toBe('connected');
    expect((await disconnect(bp, 'azure')).line).toBe('squad-kit is signed out of Azure DevOps on this computer, as Sara Ahmed. Your other sign-ins on this computer stay as they are.');
    expect(az!.calls()).toContain(`account clear | dir=${ownAzureFolder()} | telemetry=false`);
    expect((await azureRow(bp)).state).toBe('not-connected');
  });

  it('each button is one REST call, and the board never gets the process id or the token', async () => {
    const bp = project();
    devops = fakeDevOps();
    const app = new Hono();
    mountConnectionsApi(app, { paths: buildPaths(bp.root) });
    const started = (await (await app.request('/api/v1/connections/azure/sign-in', { method: 'POST' })).json()) as Record<string, unknown>;
    expect(started).toMatchObject({ state: 'waiting', code: 'GZ3SDVTBE', url: 'https://login.microsoft.com/device' });
    expect(started).not.toHaveProperty('pid');
    az!.touch('approve');
    await until(() => signInNow('azure')?.state === 'done');
    const listed = await (await app.request('/api/v1/connections?again=1')).text();
    expect(listed).toContain('"account":"Sara Ahmed"');
    expect(listed).not.toContain(MS_TOKEN);
    expect(listed).not.toContain('"pid"');
  });
});

describe('Azure DevOps calls and git with the Microsoft token', () => {
  it('the tracker calls with a bearer token, asked of az once and kept in memory until shortly before it ends', async () => {
    const bp = project();
    devops = fakeDevOps();
    signedIn();
    const tracker = azureTracker.open(bp.root)!;
    expect(tracker.identity).toBe('contoso/Shop/microsoft');
    expect(await tracker.whoAmI()).toBe('Sara Ahmed');
    expect(await tracker.whoAmI()).toBe('Sara Ahmed');
    const asked = () => az!.calls().filter((c) => c.startsWith('account get-access-token'));
    expect(asked()).toEqual([`account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --tenant ${TENANT} --output json | dir=${ownAzureFolder()} | telemetry=false`]);
    expect(devops.calls.filter((c) => c.auth).every((c) => c.auth === `Bearer ${MS_TOKEN}`)).toBe(true);
    // A token with less than five minutes left is asked for again.
    forgetMicrosoftTokens();
    az!.touch('life', '200');
    await microsoftToken(TENANT);
    await microsoftToken(TENANT);
    expect(asked().length).toBe(3);
  });

  it('no sign-in and no token: no tracker and no code host, as before', () => {
    const bp = project();
    expect(azureTracker.open(bp.root)).toBeNull();
    expect(azureCodeHost.repoFor(bp.root, REMOTE)).toBeNull();
  });

  it('git pushes with the bearer token through its environment, with the person’s own git helpers set aside', async () => {
    const bp = project();
    devops = fakeDevOps();
    signedIn();
    const host = azureCodeHost.repoFor(bp.root, REMOTE)!;
    expect(await host.gitEnv()).toEqual({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.https://dev.azure.com.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'http.https://dev.azure.com/.extraheader',
      GIT_CONFIG_VALUE_1: `AUTHORIZATION: bearer ${MS_TOKEN}`,
      GIT_TERMINAL_PROMPT: '0',
    });
    // With a saved token, as before: its Basic header.
    vi.stubEnv('AZURE_DEVOPS_PAT', 'pat-secret');
    expect((await azureCodeHost.repoFor(bp.root, REMOTE)!.gitEnv()).GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: Basic ${Buffer.from(':pat-secret').toString('base64')}`);
  });

  it('a sign-in that ended: calls stop with the way out, and git gets no header and none of the person’s helpers', async () => {
    const bp = project();
    devops = fakeDevOps();
    signedIn(OTHER_TENANT);
    az!.touch('refuse');
    const err = await azureTracker.open(bp.root)!.whoAmI().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModuleError);
    expect(err).toMatchObject({ kind: 'sign-in', message: 'squad-kit has no Microsoft sign-in for contoso. Sign in with Microsoft again on the Connections page (squad connect azure), or paste a token in Settings.' });
    expect(await azureCodeHost.repoFor(bp.root, REMOTE)!.gitEnv()).toEqual({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.https://dev.azure.com.helper', GIT_CONFIG_VALUE_0: '', GIT_TERMINAL_PROMPT: '0' });
  });

  it('an organization not on Microsoft Entra: a call says it needs a token', async () => {
    const bp = project('personal-org');
    devops = fakeDevOps({ orgs: { 'personal-org': ZEROS } });
    signedIn();
    await expect(azureTracker.open(bp.root)!.whoAmI()).rejects.toMatchObject({ kind: 'sign-in', message: 'personal-org is not on Microsoft Entra, so it needs a token. Paste one in Settings.' });
  });

  it('the Connections row before any project settings: connected as the Microsoft account', async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-azure-ms-')));
    signedIn();
    const s = await azureConnection.status(tmp);
    expect(s).toMatchObject({ state: 'connected', account: 'sara@contoso.com' });
  });
});
