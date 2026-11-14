import { afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// squad-kit keeps each project's local files in ~/.squad-kit (ADR-001). Tests use a temp folder instead, never the
// developer's own.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-home-'));
process.env.SQUAD_KIT_HOME = home;
// squad-kit never gets its own tools (Maestro, Java) from the internet by itself in a test: a test that wants it gives a
// made-up source (engine/phone/plan.ts useGetSource).
process.env.SQUAD_KIT_NO_AUTO_GET = '1';
// squad-kit's own switches for a squad-kit started inside a project's command (engine/own-home.ts): a run inside the guard
// gets them, and a test starts clean of them.
for (const v of ['SQUAD_KIT_UPDATES', 'SQUAD_KIT_BROWSER']) delete process.env[v];
// An app a test starts never asks npm for a new squad-kit; the update tests pass their own registry.
fs.writeFileSync(path.join(process.env.SQUAD_KIT_HOME, 'settings.yaml'), 'checkForUpdates: false\n');

// The same git settings on every machine: a laptop's own name or branch default never leaks into a test, and a CI
// runner with none set behaves like a laptop.
// Beside squad-kit's folder, not in it: a commit runs in the project's guard, which hides that folder from git too.
const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-gitconfig-'));
const gitConfig = path.join(gitDir, 'gitconfig');
fs.writeFileSync(gitConfig, '[user]\n\tname = Momen\n\temail = momen@example.com\n[init]\n\tdefaultBranch = main\n');
process.env.GIT_CONFIG_GLOBAL = gitConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';

// Both go when the file's tests end: a full run makes one of each per test file, and a home can grow past a gigabyte.
afterAll(() => {
  for (const dir of [home, gitDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A program a test left running may still hold a file: the system clears its temp folder later.
    }
  }
});

// A test never touches the person's clipboard: these stand-ins come first on the PATH, and only say what they were given.
const standIns = path.join(process.env.SQUAD_KIT_HOME, 'stand-in-bin');
fs.mkdirSync(standIns, { recursive: true });
for (const tool of ['pbcopy', 'xclip', 'xsel', 'wl-copy', 'termux-clipboard-set']) {
  fs.writeFileSync(path.join(standIns, tool), '#!/bin/sh\ncat > "$SQUAD_KIT_HOME/clipboard.txt"\n', { mode: 0o755 });
}
// A test never reaches GitHub with the developer's own sign-in: this gh is not signed in, and its settings folder is
// empty. A test that wants gh puts its own made-up one first on the PATH.
fs.writeFileSync(path.join(standIns, 'gh'), '#!/bin/sh\necho "not signed in (test)" >&2\nexit 1\n', { mode: 0o755 });
process.env.GH_CONFIG_DIR = path.join(standIns, 'gh-config');
fs.mkdirSync(process.env.GH_CONFIG_DIR, { recursive: true });
// Nor with Microsoft's: this az answers nothing, and squad-kit's own az folder is inside the test's home (ADR-011). A
// test that wants az puts its own made-up one first on the PATH.
fs.writeFileSync(path.join(standIns, 'az'), "#!/bin/sh\necho \"ERROR: Please run 'az login' to setup account. (test)\" >&2\nexit 1\n", { mode: 0o755 });
process.env.PATH = `${standIns}${path.delimiter}${process.env.PATH ?? ''}`;

// A locale for git, as a person's terminal has. Started with none (an app opened from the Dock, an editor's test
// runner), git on a Mac asks the system for the person's languages on every start, through one shared system service:
// about 8 ms more per git call when quiet, and far more when other work keeps that service busy. The release and
// handover tests run hundreds of git calls each, so that wait alone could push them past their time limits.
if (!process.env.LC_ALL && !process.env.LANG) process.env.LANG = 'en_US.UTF-8';

/**
 * Every env var that squad-kit reads to resolve planner or tracker credentials.
 * These leak in two realistic ways:
 *   1. A developer `export`s one locally to try the CLI.
 *   2. `prepublishOnly` runs `verify:models` (which requires them) and then `test`
 *      in the same shell, so tests that assume "no key present" break.
 *
 * Global isolation: before every test, snapshot and clear these vars; after every
 * test, restore. Tests that want to set them (e.g. "status reads from env") can still
 * do so inside the test body — restore runs after.
 */
const ISOLATED_VARS = [
  'ANTHROPIC_API_KEY',
  // Anthropic subscription auth: both outrank the Claude login in the SDK's precedence order,
  // so a developer's exported value would silently change which credential tests resolve.
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'SQUAD_PLANNER_API_KEY',
  'JIRA_API_TOKEN',
  // The rest of a Jira sign-in from the environment: a developer's own site would reach a real Jira from a test.
  'JIRA_HOST',
  'JIRA_EMAIL',
  'AZURE_DEVOPS_PAT',
  // GitHub's tool reads these before its own sign-in: a developer's own would reach GitHub from a test.
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'SQUAD_TRACKER_API_KEY',
  // Also isolate the interactivity-gating vars. Tests that want CI=1 (fail-fast
  // path) set it explicitly inside their own beforeEach, which runs after this
  // global one and is restored from the pre-test snapshot after the test ends.
  // Without this, GitHub Actions' CI=true breaks every test that mocks isTTY
  // but expects `isInteractive()` to return true.
  'CI',
  // `skipExternalProbesInAutomation()` also short-circuits on GITHUB_ACTIONS. Isolating CI but not
  // this one made the suite behave differently on a runner than on a laptop: probe-driven doctor
  // checks silently took the "skipped" path in CI only, and tests asserting probe behaviour failed
  // there while passing locally. Reproduce a runner with `GITHUB_ACTIONS=true pnpm test`.
  'GITHUB_ACTIONS',
  'SQUAD_QUIET',
] as const;

const snapshot: Partial<Record<(typeof ISOLATED_VARS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const name of ISOLATED_VARS) {
    snapshot[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of ISOLATED_VARS) {
    const prev = snapshot[name];
    if (prev === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = prev;
    }
  }
});
