import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../src/core/config.js';
import { buildPaths } from '../src/core/paths.js';
import { loadSecrets } from '../src/core/secrets.js';
import { boardPaths, writeMeta } from '../src/board/store.js';
import { pullTicket } from '../src/board/actions/new-ticket.js';
import { clientFor, overlayTrackerEnv } from '../src/tracker/index.js';
import { trackerModule, trackerFor } from '../src/modules/registry.js';
import { jiraConnection } from '../src/modules/jira/connection.js';
import { moduleTokenTracker, tokenSignInCheck, trackerReachCheck } from '../src/commands/doctor-tracker.js';
import { mountSecretsApi } from '../src/console/api/secrets.js';
import { mountTrackerApi } from '../src/console/api/tracker.js';

/**
 * A Jira token goes only to the host saved with it, on every path: the board, Settings and Connections, `squad doctor`,
 * the 0.x routes and `squad new-story --id`. Here a teammate's commit moved the team's site, and a token sits in
 * JIRA_API_TOKEN with no JIRA_HOST: nothing calls anywhere with any token.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  jiraConnection.forget?.();
});

function movedProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-jira-host-'));
  fs.mkdirSync(path.join(root, '.squad'), { recursive: true });
  saveConfig(buildPaths(root).configFile, { ...DEFAULT_CONFIG, tracker: { type: 'jira', workspace: 'new.atlassian.net', project: 'PAY', options: { updates: 'on' } } });
  fs.writeFileSync(buildPaths(root).secretsFile, 'tracker:\n  jira:\n    host: acme.atlassian.net\n    email: sara@acme.test\n    token: file-token\n');
  writeMeta(boardPaths(path.join(root, '.squad')), {
    project: 'Payments',
    key: 'PAY',
    nextNumber: 1,
    engine: 'live',
    user: { name: 'Sara', role: 'Project manager' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
  });
  return root;
}

describe("a Jira token never goes to the team's site when it was not saved for it", () => {
  it('with JIRA_EMAIL and JIRA_API_TOKEN and no JIRA_HOST, after the site changed: no call anywhere', async () => {
    const calls = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', calls);
    process.env.JIRA_EMAIL = 'sara@acme.test';
    process.env.JIRA_API_TOKEN = 'env-token';
    const root = movedProject();
    const paths = buildPaths(root);
    const bp = boardPaths(paths.squadDir);

    // The board and Settings.
    const mod = trackerModule('jira')!;
    expect(mod.open(root)).toBeNull();
    expect(trackerFor(bp)).toBeNull();
    expect(mod.read(root).note).toBe("The team's Jira site is now new.atlassian.net. Paste your token for it.");
    expect(await mod.choices!({ site: 'new.atlassian.net', email: 'sara@acme.test' }, root)).toEqual({});
    await expect(pullTicket(bp, 'PAY-40')).rejects.toThrow("The team's Jira site is now new.atlassian.net. Paste your token for it.");
    // Connections.
    expect((await jiraConnection.status(root)).state).toBe('not-connected');
    // squad doctor, as the board says.
    const doctor = moduleTokenTracker(loadConfig(paths.configFile))!;
    expect(tokenSignInCheck(root, doctor)).toMatchObject({ status: 'fail', detail: "The team's Jira site is now new.atlassian.net. Paste your token for it." });
    expect(await trackerReachCheck(root, doctor)).toMatchObject({ status: 'skip' });
    // The 0.x client behind `squad new-story --id` and the old tracker routes.
    const old = clientFor(loadConfig(paths.configFile), overlayTrackerEnv(loadSecrets(paths.secretsFile)));
    expect(old.client).toBeUndefined();
    expect(old.error?.message).toBe("The team's Jira site is now new.atlassian.net.");
    const app = new Hono();
    mountSecretsApi(app, { paths });
    mountTrackerApi(app, { paths });
    expect(await (await app.request('/api/secrets/test/jira', { method: 'POST' })).json()).toEqual({ ok: false, detail: "The team's Jira site is now new.atlassian.net. Paste your token for it." });
    expect((await app.request('/api/tracker/search?q=pay')).status).toBe(400);
    const imported = await app.request('/api/tracker/import', { method: 'POST', body: JSON.stringify({ issueId: 'PAY-40', feature: 'hold' }), headers: { 'content-type': 'application/json' } });
    expect(imported.status).toBe(400);

    expect(calls).not.toHaveBeenCalled();
  });
});
