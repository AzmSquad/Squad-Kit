import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { input, select } from '@inquirer/prompts';
import { runTrackerLink } from '../src/commands/tracker-link.js';
import { saveConfig, DEFAULT_CONFIG } from '../src/core/config.js';
import { SQUAD_DIR, buildPaths } from '../src/core/paths.js';

vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
  select: vi.fn(),
}));

let tmp: string;
let previousCwd: string;
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

function writeStory(feature: string, id: string, intake: string): string {
  const p = buildPaths(path.join(tmp));
  const storyDir = path.join(p.storiesDir, feature, id);
  fs.mkdirSync(storyDir, { recursive: true });
  const intakePath = path.join(storyDir, 'intake.md');
  fs.writeFileSync(intakePath, intake, 'utf8');
  return intakePath;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-tracker-link-'));
  previousCwd = process.cwd();
  process.chdir(tmp);
  prevCI = process.env.CI;
  delete process.env.CI;
  vi.mocked(input).mockReset();
  vi.mocked(select).mockReset();
  const p = buildPaths(path.join(tmp));
  fs.mkdirSync(p.squadDir, { recursive: true });
  fs.mkdirSync(p.storiesDir, { recursive: true });
  fs.mkdirSync(p.plansDir, { recursive: true });
  saveConfig(p.configFile, {
    ...DEFAULT_CONFIG,
    tracker: { type: 'jira' },
    naming: { includeTrackerId: true, globalSequence: true },
  });
});

afterEach(() => {
  if (restoreTTY) {
    restoreTTY();
    restoreTTY = undefined;
  }
  if (prevCI === undefined) delete process.env.CI;
  else process.env.CI = prevCI;
  process.chdir(previousCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('tracker link', () => {
  it('with both args: updates intake without prompts', async () => {
    const intake = writeStory('fx', 's1', '# x\n- **Work item id:**\n');
    await runTrackerLink(intake, 'ENG-1', { yes: false });
    const body = fs.readFileSync(intake, 'utf8');
    expect(body).toMatch(/- \*\*Work item id:\*\* ENG-1/);
    expect(vi.mocked(select)).not.toHaveBeenCalled();
    expect(vi.mocked(input)).not.toHaveBeenCalled();
  });

  it('when story path missing and interactive, uses select to pick intake', async () => {
    const intake = writeStory('fx', 's2', '# x\n- **Work item id:**\n');
    restoreTTY = stubStdinTTY(true);
    vi.mocked(select).mockResolvedValueOnce(intake);

    await runTrackerLink(undefined, 'ENG-2', { yes: false });
    const body = fs.readFileSync(intake, 'utf8');
    expect(body).toMatch(/- \*\*Work item id:\*\* ENG-2/);
    expect(vi.mocked(input)).not.toHaveBeenCalled();
  });

  it('when both args missing, prompts select then input', async () => {
    const intake = writeStory('fx', 's3', '# x\n- **Work item id:**\n');
    restoreTTY = stubStdinTTY(true);
    vi.mocked(select).mockResolvedValueOnce(intake);
    vi.mocked(input).mockResolvedValueOnce('ENG-3');

    await runTrackerLink(undefined, undefined, { yes: false });
    const body = fs.readFileSync(intake, 'utf8');
    expect(body).toMatch(/- \*\*Work item id:\*\* ENG-3/);
  });

  it('when non-interactive and path missing, throws usage without select', () => {
    writeStory('fx', 's4', '# x\n');
    restoreTTY = stubStdinTTY(false);

    return expect(runTrackerLink(undefined, 'ENG-1', { yes: false })).rejects.toThrow(
      /Usage: squad tracker link/,
    );
  });

  it('when no stories exist, error before any prompt', () => {
    restoreTTY = stubStdinTTY(true);

    return expect(runTrackerLink(undefined, 'ENG-1', { yes: false })).rejects.toThrow(
      /No stories found under/,
    );
  });

  it('exposes id validation on input (jira)', async () => {
    const intake = writeStory('fx', 's5', '# x\n');
    restoreTTY = stubStdinTTY(true);
    vi.mocked(select).mockResolvedValueOnce(intake);
    vi.mocked(input).mockResolvedValueOnce('ENG-9');

    await runTrackerLink(undefined, undefined, { yes: false });
    const first = vi.mocked(input).mock.calls[0]?.[0] as { validate?: (v: string) => true | string };
    expect(first?.validate?.('nope-nope')).toBe('Invalid jira id format.');
  });
});
