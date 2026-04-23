import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { input, select } from '@inquirer/prompts';
import { runNewStory } from '../src/commands/new-story.js';
import * as ui from '../src/ui/index.js';
import { buildPaths } from '../src/core/paths.js';
import { DEFAULT_CONFIG, saveConfig, type SquadConfig } from '../src/core/config.js';

vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
}));

let tmp: string;
let prevCwd: string;
let prevCI: string | undefined;
let restoreTTY: (() => void) | undefined;

function stubStdinTTY(value: boolean): () => void {
  const desc = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
  return () => {
    if (desc) Object.defineProperty(process.stdin, 'isTTY', desc);
    else Reflect.deleteProperty(process.stdin as object, 'isTTY');
  };
}

function writeJiraWorkspaceRequireId(configOverrides: Partial<SquadConfig> = {}): void {
  const paths = buildPaths(tmp);
  fs.mkdirSync(paths.squadDir, { recursive: true });
  const config: SquadConfig = {
    ...DEFAULT_CONFIG,
    tracker: { type: 'jira', workspace: 'mycompany.atlassian.net' },
    naming: { includeTrackerId: true, globalSequence: true },
    ...configOverrides,
  };
  saveConfig(paths.configFile, config);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-new-story-no-tracker-'));
  prevCwd = process.cwd();
  process.chdir(tmp);
  prevCI = process.env.CI;
  delete process.env.CI;
  vi.mocked(input).mockReset();
  vi.mocked(select).mockReset();
});

afterEach(() => {
  restoreTTY?.();
  restoreTTY = undefined;
  if (prevCI === undefined) delete process.env.CI;
  else process.env.CI = prevCI;
  process.chdir(prevCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('new-story --no-tracker', () => {
  it('creates title-derived folder when Jira requires id and includeTrackerId is true', async () => {
    writeJiraWorkspaceRequireId();

    await runNewStory('experiments', {
      title: 'quick one',
      yes: true,
      tracker: false,
    });

    const intakePath = path.join(tmp, '.squad/stories/experiments/quick-one/intake.md');
    expect(fs.existsSync(intakePath)).toBe(true);
    const body = fs.readFileSync(intakePath, 'utf8');
    expect(body).toMatch(/manual entry \(tracker skipped via `--no-tracker`\)/);
    expect(body).not.toMatch(/PROJ-|ENG-/);
  });

  it('without title non-interactive: throws folder name error', async () => {
    writeJiraWorkspaceRequireId();

    await expect(
      runNewStory('experiments', { yes: true, tracker: false }),
    ).rejects.toThrow(
      /Could not derive a story folder name\. Pass `--title "<hint>"` when using `--no-tracker`, or `--id <tracker-id>`/,
    );
  });

  it('without title interactive: prompts for title and uses slugified folder', async () => {
    writeJiraWorkspaceRequireId();
    restoreTTY = stubStdinTTY(true);
    vi.mocked(input).mockResolvedValueOnce('my manual title');

    await runNewStory('experiments', { tracker: false });

    const intakePath = path.join(tmp, '.squad/stories/experiments/my-manual-title/intake.md');
    expect(fs.existsSync(intakePath)).toBe(true);
  });

  it('with --id: id ignored for folder name and preamble', async () => {
    writeJiraWorkspaceRequireId();

    await runNewStory('experiments', {
      id: 'PROJ-999',
      title: 'title wins',
      yes: true,
      tracker: false,
    });

    expect(fs.existsSync(path.join(tmp, '.squad/stories/experiments/title-wins/intake.md'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(tmp, '.squad/stories/experiments/PROJ-999'))).toBe(false);
    const body = fs.readFileSync(
      path.join(tmp, '.squad/stories/experiments/title-wins/intake.md'),
      'utf8',
    );
    expect(body).not.toContain('PROJ-999');
    expect(body).toMatch(/manual entry \(tracker skipped/);
  });

  it('interactive skip: same as --no-tracker', async () => {
    writeJiraWorkspaceRequireId();
    restoreTTY = stubStdinTTY(true);
    vi.mocked(select).mockResolvedValueOnce('skip');

    const warn = vi.spyOn(ui, 'warning').mockImplementation(() => true);

    await runNewStory('experiments', { title: 'via skip', yes: false });

    const intakePath = path.join(tmp, '.squad/stories/experiments/via-skip/intake.md');
    expect(fs.existsSync(intakePath)).toBe(true);
    const body = fs.readFileSync(intakePath, 'utf8');
    expect(body).toMatch(/manual entry \(tracker skipped/);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Created without a tracker link'),
    );
    warn.mockRestore();
  });

  it('interactive enter id: id-derived folder', async () => {
    writeJiraWorkspaceRequireId();
    restoreTTY = stubStdinTTY(true);
    vi.mocked(select).mockResolvedValueOnce('enter');
    vi.mocked(input).mockResolvedValueOnce('PROJ-55');

    await runNewStory('experiments', { title: 'ignored when id set', yes: false });

    expect(
      fs.existsSync(path.join(tmp, '.squad/stories/experiments/PROJ-55/intake.md')),
    ).toBe(true);
  });

  it('non-interactive missing id without --no-tracker: error mentions --no-tracker', async () => {
    writeJiraWorkspaceRequireId();

    await expect(runNewStory('experiments', { title: 'x', yes: true })).rejects.toThrow(
      /--no-tracker/,
    );
  });

  it('regression: tracker none — --no-tracker does not change id-only story', async () => {
    const paths = buildPaths(tmp);
    fs.mkdirSync(paths.squadDir, { recursive: true });
    saveConfig(paths.configFile, {
      ...DEFAULT_CONFIG,
      tracker: { type: 'none' },
      naming: { includeTrackerId: false, globalSequence: true },
    });

    await runNewStory('feat', { id: 'ignored-123', yes: true, tracker: false });

    const intakePath = path.join(tmp, '.squad/stories/feat/ignored-123/intake.md');
    expect(fs.existsSync(intakePath)).toBe(true);
    const body = fs.readFileSync(intakePath, 'utf8');
    expect(body).not.toMatch(/manual entry \(tracker skipped/);
  });
});
