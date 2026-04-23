import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runNewStory } from '../src/commands/new-story.js';
import { runTrackerLink } from '../src/commands/tracker-link.js';
import { runRmStory } from '../src/commands/rm/story.js';
import { runConfigSetPlanner } from '../src/commands/config/set-planner.js';
import { runConfigRemoveCredential } from '../src/commands/config/remove-credential.js';
import { loadConfig } from '../src/core/config.js';
import { saveConfig, DEFAULT_CONFIG, type SquadConfig } from '../src/core/config.js';
import { SQUAD_DIR } from '../src/core/paths.js';
import * as tty from '../src/ui/tty.js';

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
  confirm: vi.fn(),
  input: vi.fn(),
  password: vi.fn(),
}));

/** At least one backticked token that looks like a command (e.g. `squad new-story`). */
const backtickCommand =
  /`[a-z]+( [a-z-]+)*(-[a-z]+)*[^`]*`/;

function assertCanonicalHintMessage(msg: string) {
  expect(msg).toMatch(backtickCommand);
  const okLead =
    msg.includes('Run `') ||
    msg.includes('Usage:') ||
    /`[a-z]+/.test(msg); // e.g. pnpm, npm in upgrade failures
  expect(okLead).toBe(true);
}

let tmp: string;
let previousCwd: string;
const prevOpen = process.env.OPENAI_API_KEY;
const prevCi = process.env.CI;
const prevStdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

beforeEach(() => {
  process.env.CI = '1';
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-err-hints-'));
  previousCwd = process.cwd();
  process.chdir(tmp);
  fs.mkdirSync(path.join(tmp, SQUAD_DIR, 'stories'), { recursive: true });
  fs.mkdirSync(path.join(tmp, SQUAD_DIR, 'plans'), { recursive: true });
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  vi.spyOn(tty, 'isInteractive').mockReturnValue(false);
});

afterEach(() => {
  process.chdir(previousCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (prevOpen === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = prevOpen;
  }
  if (prevCi === undefined) {
    delete process.env.CI;
  } else {
    process.env.CI = prevCi;
  }
  if (prevStdinTty) Object.defineProperty(process.stdin, 'isTTY', prevStdinTty);
  else Reflect.deleteProperty(process.stdin, 'isTTY');
  vi.restoreAllMocks();
});

function writeBaseConfig(overrides: Partial<SquadConfig> = {}): void {
  const cfg: SquadConfig = { ...DEFAULT_CONFIG, ...overrides };
  saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), cfg);
}

describe('error hints (curated command failures)', () => {
  it('runNewStory(undefined, { yes: true }) — feature slug required', async () => {
    writeBaseConfig();
    let msg = '';
    try {
      await runNewStory(undefined, { yes: true });
    } catch (e) {
      msg = (e as Error).message;
    }
    assertCanonicalHintMessage(msg);
    expect(msg).toMatch(/`squad new-story`/);
  });

  it('runNewStory with slug when jira + includeTrackerId and yes — id or no-tracker', async () => {
    const cfg: SquadConfig = {
      ...DEFAULT_CONFIG,
      tracker: { type: 'jira', workspace: 'x.atlassian.net' },
      naming: { includeTrackerId: true, globalSequence: true },
    };
    writeBaseConfig(cfg);
    let msg = '';
    try {
      await runNewStory('feat', { yes: true });
    } catch (e) {
      msg = (e as Error).message;
    }
    assertCanonicalHintMessage(msg);
    expect(msg).toContain('--id');
    expect(msg).toContain('--no-tracker');
  });

  it('runTrackerLink(undefined, undefined, { yes: true })', async () => {
    writeBaseConfig();
    let msg = '';
    try {
      await runTrackerLink(undefined, undefined, { yes: true });
    } catch (e) {
      msg = (e as Error).message;
    }
    assertCanonicalHintMessage(msg);
    expect(msg).toMatch(/`squad tracker link`/);
  });

  it("runRmStory('nonexistent', { yes: true })", async () => {
    writeBaseConfig();
    const sdir = path.join(tmp, SQUAD_DIR, 'stories', 'f', 'id1');
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, 'intake.md'), '# x\n', 'utf8');
    const err = await runRmStory('nonexistent', { yes: true }).then(
      () => {
        throw new Error('expected throw');
      },
      (e: unknown) => e as Error,
    );
    assertCanonicalHintMessage(err.message);
    expect(err.message).toContain('squad rm story');
    expect(err.message).toContain('squad list');
  });

  it('runConfigSetPlanner with yes + openai and no API key / secrets', async () => {
    if (process.env.OPENAI_API_KEY) {
      delete process.env.OPENAI_API_KEY;
    }
    writeBaseConfig();
    const err = await runConfigSetPlanner({ yes: true, provider: 'openai' }).then(
      () => {
        throw new Error('expected throw');
      },
      (e: unknown) => e as Error,
    );
    assertCanonicalHintMessage(err.message);
    expect(err.message).toContain('squad config set planner');
  });

  it("runConfigRemoveCredential('garbage', {})", async () => {
    writeBaseConfig();
    const err = await runConfigRemoveCredential('garbage', {}).then(
      () => {
        throw new Error('expected throw');
      },
      (e: unknown) => e as Error,
    );
    assertCanonicalHintMessage(err.message);
    expect(err.message).toContain('squad config remove-credential');
  });

  it('loadConfig on invalid YAML', () => {
    const bad = path.join(tmp, 'garbage.yaml');
    fs.writeFileSync(bad, 'foo: [unclosed', 'utf8');
    let msg = '';
    try {
      loadConfig(bad);
    } catch (e) {
      msg = (e as Error).message;
    }
    assertCanonicalHintMessage(msg);
    expect(msg).toMatch(/squad (doctor|init)/);
  });
});
