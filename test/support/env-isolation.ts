import { beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// squad-kit keeps each project's local files in ~/.squad-kit (ADR-001). Tests use a temp folder instead, never the
// developer's own.
process.env.SQUAD_KIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-home-'));
// An app a test starts never asks npm for a new squad-kit; the update tests pass their own registry.
fs.writeFileSync(path.join(process.env.SQUAD_KIT_HOME, 'settings.yaml'), 'checkForUpdates: false\n');

// The same git settings on every machine: a laptop's own name or branch default never leaks into a test, and a CI
// runner with none set behaves like a laptop.
const gitConfig = path.join(process.env.SQUAD_KIT_HOME, 'gitconfig');
fs.writeFileSync(gitConfig, '[user]\n\tname = Momen\n\temail = momen@example.com\n[init]\n\tdefaultBranch = main\n');
process.env.GIT_CONFIG_GLOBAL = gitConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';

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
  'AZURE_DEVOPS_PAT',
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
