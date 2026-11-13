import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { Hono } from 'hono';
import { githubPullPage } from '../src/modules/github/pull-page.js';
import { pullRequestPageFor } from '../src/modules/registry.js';
import { sendAsOf } from '../src/engine/send-as-pr.js';
import { prepareProject } from '../src/engine/setup.js';
import { writeTicket } from '../src/board/store.js';
import { createTicket } from '../src/board/actions.js';
import { mountBoardApi } from '../src/console/api/board.js';
import type { Ticket } from '../src/board/types.js';

/**
 * A story merged on this computer, on squad-kit's own code, goes on by pull request: the story says how to push its
 * branch with the person's own sign-in, and opens the host's page for the request, into the repo it came from. Any other
 * project, a fork too, gets none of it: its work goes out with its own release. With GitHub's tool signed in, squad-kit
 * sends the pull request itself (github-pull-requests.test.ts), so this box is the way when it is not.
 */

let tmp: string;
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, stdio: 'ignore' });

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-send-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("GitHub's page for a pull request", () => {
  it('from a fork goes to the repo it came from, as owner:branch; from the same repo, the branch', () => {
    const fork = 'https://github.com/someone/squad-kit.git';
    const main = 'https://github.com/AzmSquad/squad-kit';
    expect(githubPullPage.pageFor({ from: fork, into: main, base: 'main', branch: 'sk-1-show-version', title: 'Show the version' })).toBe(
      'https://github.com/AzmSquad/squad-kit/compare/main...someone:sk-1-show-version?expand=1&title=Show+the+version',
    );
    expect(githubPullPage.pageFor({ from: 'git@github.com:AzmSquad/squad-kit.git', into: main, base: 'main', branch: 'sk-2', title: 'x' })).toBe('https://github.com/AzmSquad/squad-kit/compare/main...sk-2?expand=1&title=x');
    expect(githubPullPage.repoName('ssh://git@github.com/someone/squad-kit')).toBe('someone/squad-kit');
    expect(pullRequestPageFor(fork)?.label).toBe('GitHub');
    expect(pullRequestPageFor('/Users/x/origin.git')).toBeNull();
    expect(pullRequestPageFor('https://dev.azure.com/org/p/_git/r')).toBeNull();
  });
});

describe('a merged story says how to send it', () => {
  /** squad-kit's own code, cloned from a fork, with a story merged into main and its branch kept. */
  function mergedStory(origin: string, more: object = {}) {
    const dir = path.join(tmp, 'fork');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'squad-kit', bin: { squad: './dist/cli.js' }, repository: { type: 'git', url: 'https://github.com/AzmSquad/squad-kit' }, ...more }));
    sh(`git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -q -m first && git branch sk-1-show-version && git remote add origin ${origin}`, dir);
    const { bp } = prepareProject(dir);
    const t = { id: 'SK-1', title: 'Show the version', kind: 'feature', stage: 'release', status: 'Merged', branch: 'sk-1-show-version', mergedAt: '2026-11-13T10:00:00.000Z', activity: [], createdAt: '2026-11-13T09:00:00.000Z' } as unknown as Ticket;
    return { bp, t, dir };
  }

  it('on GitHub: push the branch to your fork, then the page into the repo squad-kit comes from', async () => {
    const { bp, t, dir } = mergedStory('https://github.com/someone/squad-kit.git');
    const s = sendAsOf(bp, t)!;
    expect(s).toEqual({
      branch: 'sk-1-show-version',
      remote: 'origin',
      push: 'git push origin sk-1-show-version',
      dir,
      page: 'https://github.com/AzmSquad/squad-kit/compare/main...someone:sk-1-show-version?expand=1&title=Show+the+version',
      host: 'GitHub',
      into: 'AzmSquad/squad-kit',
      // GitHub's tool is not signed in here (the test's gh is not): the steps that let squad-kit send the next ones.
      letSquadKit: ["Install GitHub's tool, gh, from cli.github.com.", 'Sign in: open a terminal and run gh auth login.', 'squad-kit then sends your next stories as pull requests by itself.'],
    });
    // The ticket's own record carries it, for the drawer.
    const made = createTicket(bp, { title: 'Show the version' });
    writeTicket(bp, { ...made, branch: t.branch, mergedAt: t.mergedAt });
    const app = new Hono();
    mountBoardApi(app, { paths: { squadDir: bp.squadDir } as never });
    const view = (await (await app.request(`/api/v1/tickets/${made.id}`)).json()) as { sendAs?: { push: string } };
    expect(view.sendAs?.push).toBe('git push origin sk-1-show-version');
  });

  it('an upstream remote wins; a plain folder remote gets the push and no page', () => {
    const { bp, t, dir } = mergedStory('/somewhere/origin.git');
    expect(sendAsOf(bp, t)).toMatchObject({ push: 'git push origin sk-1-show-version' });
    expect(sendAsOf(bp, t)?.page).toBeUndefined();
    sh('git remote set-url origin https://github.com/someone/squad-kit && git remote add upstream https://github.com/team/squad-kit-mirror', dir);
    expect(sendAsOf(bp, t)?.page).toContain('https://github.com/team/squad-kit-mirror/compare/main...someone:sk-1-show-version');
  });

  it('nothing for a story not merged, one with a pull request, a branch gone, or one released', () => {
    const { bp, t } = mergedStory('https://github.com/someone/squad-kit.git');
    expect(sendAsOf(bp, { ...t, mergedAt: undefined } as Ticket)).toBeNull();
    expect(sendAsOf(bp, { ...t, pr: { id: 4, url: 'u' } } as Ticket)).toBeNull();
    expect(sendAsOf(bp, { ...t, branch: 'gone' } as Ticket)).toBeNull();
    expect(sendAsOf(bp, { ...t, stage: 'done' } as Ticket)).toBeNull();
  });

  it('nothing on any other project, a fork with an upstream remote too: its work goes out with its own release', async () => {
    const dir = path.join(tmp, 'shop');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'shop' }));
    sh('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -q -m first && git branch sk-1-private', dir);
    sh('git remote add origin https://github.com/someone/shop.git && git remote add upstream https://github.com/team/shop.git', dir);
    const { bp } = prepareProject(dir);
    const made = createTicket(bp, { title: 'A private plan' });
    writeTicket(bp, { ...made, stage: 'release', branch: 'sk-1-private', mergedAt: '2026-11-13T10:00:00.000Z' });
    const t = { id: made.id, title: 'A private plan', stage: 'release', branch: 'sk-1-private', mergedAt: '2026-11-13T10:00:00.000Z' } as unknown as Ticket;
    expect(sendAsOf(bp, t)).toBeNull();
    const app = new Hono();
    mountBoardApi(app, { paths: { squadDir: bp.squadDir } as never });
    const view = (await (await app.request(`/api/v1/tickets/${made.id}`)).json()) as { sendAs?: unknown; title: string };
    expect(view.title).toBe('A private plan');
    expect(view.sendAs).toBeUndefined();
  });
});
