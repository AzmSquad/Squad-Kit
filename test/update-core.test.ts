import { describe, expect, it } from 'vitest';
import process from 'node:process';
import { fetchReleaseNotes, githubRepo, isMajorBump, notesFromMarkdown, runInstall, upgradePlan, whyInstallFailed } from '../src/core/update.js';

/** The parts `squad upgrade` and the Update button share. Nothing here reaches npm or GitHub: fetch is a fake. */

const RELEASE = `## What's new

- **Delete a ticket** from the board ([#41](https://github.com/AzmSquad/squad-kit/pull/41))
- Start your app with one click
  - a sub-point that stays out
* Faster \`first scan\`
- A fourth
- A fifth
- A sixth

## Fixes
`;

describe('release notes', () => {
  it('keeps the first top-level bullets as plain lines', () => {
    expect(notesFromMarkdown(RELEASE)).toEqual(['Delete a ticket from the board (#41)', 'Start your app with one click', 'Faster first scan', 'A fourth', 'A fifth']);
    expect(notesFromMarkdown('# 1.0.2\n\nSmall fixes after the first week.\n\n| a | b |')).toEqual(['Small fixes after the first week.']);
  });

  it('reads the GitHub repository from the ways package.json writes it', () => {
    expect(githubRepo('https://github.com/AzmSquad/squad-kit')).toEqual({ owner: 'AzmSquad', repo: 'squad-kit' });
    expect(githubRepo('git+https://github.com/AzmSquad/squad-kit.git')).toEqual({ owner: 'AzmSquad', repo: 'squad-kit' });
    expect(githubRepo('git@github.com:AzmSquad/squad-kit.git')).toEqual({ owner: 'AzmSquad', repo: 'squad-kit' });
    expect(githubRepo('https://gitlab.com/a/b')).toBeNull();
  });

  it('asks the release by its tag, and falls back to the changelog link when there is none', async () => {
    const asked: string[] = [];
    const fake = (async (url: string) => {
      asked.push(url);
      return url.endsWith('/v1.0.2')
        ? Response.json({ body: RELEASE, html_url: 'https://github.com/AzmSquad/squad-kit/releases/tag/v1.0.2' })
        : new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
    const found = await fetchReleaseNotes('https://github.com/AzmSquad/squad-kit', '1.0.2', { fetch: fake });
    expect(asked[0]).toBe('https://api.github.com/repos/AzmSquad/squad-kit/releases/tags/v1.0.2');
    expect(found.lines[0]).toBe('Delete a ticket from the board (#41)');
    expect(found.url).toBe('https://github.com/AzmSquad/squad-kit/releases/tag/v1.0.2');

    const none = await fetchReleaseNotes('https://github.com/AzmSquad/squad-kit', '1.0.3', { fetch: fake });
    expect(none).toEqual({ version: '1.0.3', lines: [], url: 'https://github.com/AzmSquad/squad-kit/blob/v1.0.3/CHANGELOG.md' });
    const offline = await fetchReleaseNotes(undefined, '1.0.3', { fetch: (async () => Promise.reject(new Error('offline'))) as unknown as typeof fetch });
    expect(offline.lines).toEqual([]);
  });

  it('gives up on a slow GitHub inside its limit', async () => {
    const slow = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    const started = Date.now();
    const notes = await fetchReleaseNotes('https://github.com/AzmSquad/squad-kit', '1.0.2', { fetch: slow, timeoutMs: 100 });
    expect(notes.lines).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('the install command', () => {
  it('uses the package manager that installed squad-kit', () => {
    const before = process.env.npm_config_user_agent;
    delete process.env.npm_config_user_agent;
    try {
      expect(upgradePlan({ name: 'squad-kit', root: '/usr/local/lib/node_modules/squad-kit' }, '1.0.2').text).toBe('npm install -g squad-kit@1.0.2');
      expect(upgradePlan({ name: 'squad-kit', root: '/Users/me/Library/pnpm/global/5/node_modules/squad-kit' }).text).toBe('pnpm add -g squad-kit@latest');
    } finally {
      if (before !== undefined) process.env.npm_config_user_agent = before;
    }
  });

  it('knows a major version from a minor one', () => {
    expect(isMajorBump('2.0.0', '1.9.9')).toBe(true);
    expect(isMajorBump('1.1.0', '1.0.9')).toBe(false);
  });
});

describe('running the install', () => {
  const node = process.execPath;

  it('keeps what it printed and its exit code', async () => {
    const ok = await runInstall(node, ['-e', 'console.log("added 1 package"); console.error("a warning")']);
    expect(ok).toMatchObject({ ok: true, code: 0, timedOut: false });
    expect(ok.output).toContain('added 1 package');
    expect(ok.output).toContain('a warning');

    const denied = await runInstall(node, ['-e', 'console.error("npm ERR! code EACCES\\nnpm ERR! permission denied, mkdir /usr/local/lib"); process.exit(243)']);
    expect(denied).toMatchObject({ ok: false, code: 243 });
    expect(whyInstallFailed(denied, 'npm')).toEqual({ reason: 'This computer needs your permission to install.', permission: true });
  });

  it('stops an install past its limit, children too', async () => {
    const started = Date.now();
    const slow = await runInstall(node, ['-e', 'require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "inherit" }); setTimeout(() => {}, 60000)'], { timeoutMs: 300 });
    expect(slow).toMatchObject({ ok: false, timedOut: true });
    expect(Date.now() - started).toBeLessThan(8000);
    expect(whyInstallFailed(slow, 'npm').reason).toContain('longer than 5 minutes');
  });

  it('says so when the package manager is not on this computer', async () => {
    const missing = await runInstall('squad-kit-no-such-package-manager', ['install']);
    expect(missing.ok).toBe(false);
    expect(whyInstallFailed(missing, 'squad-kit-no-such-package-manager').reason).toBe('squad-kit could not find squad-kit-no-such-package-manager on this computer.');
  });

  it('names a network failure and any other one in plain words', () => {
    const base = { ok: false, code: 1, timedOut: false };
    expect(whyInstallFailed({ ...base, output: 'npm ERR! code ENOTFOUND' }, 'npm').reason).toContain('could not reach the npm registry');
    expect(whyInstallFailed({ ...base, output: 'something else' }, 'npm')).toEqual({ reason: 'The install stopped with an error (exit code 1).', permission: false });
  });
});
