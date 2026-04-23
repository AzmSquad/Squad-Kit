import { beforeEach, afterEach } from 'vitest';

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
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'SQUAD_PLANNER_API_KEY',
  'JIRA_API_TOKEN',
  'AZURE_DEVOPS_PAT',
  'SQUAD_TRACKER_API_KEY',
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
