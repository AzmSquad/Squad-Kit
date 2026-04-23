import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { input, select } from '@inquirer/prompts';
import { runNewStory, validateFeatureSlugForPrompt } from '../src/commands/new-story.js';
import { saveConfig, DEFAULT_CONFIG } from '../src/core/config.js';
import { SQUAD_DIR, buildPaths } from '../src/core/paths.js';

vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
  select: vi.fn(),
}));

function installWorkspace(): void {
  const p = buildPaths(path.join(tmp));
  fs.mkdirSync(p.squadDir, { recursive: true });
  fs.mkdirSync(p.storiesDir, { recursive: true });
  fs.mkdirSync(p.plansDir, { recursive: true });
  saveConfig(p.configFile, { ...DEFAULT_CONFIG, tracker: { type: 'none' }, naming: { includeTrackerId: false, globalSequence: true } });
}

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

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-new-story-inter-'));
  previousCwd = process.cwd();
  process.chdir(tmp);
  prevCI = process.env.CI;
  delete process.env.CI;
  vi.mocked(input).mockReset();
  vi.mocked(select).mockReset();
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

describe('new-story interactive (feature slug)', () => {
  it('prompts for kebab feature slug in TTY when omitted and scaffolds under that feature', async () => {
    installWorkspace();
    restoreTTY = stubStdinTTY(true);
    vi.mocked(input).mockResolvedValueOnce('my-feature');

    await runNewStory(undefined, { title: 'a', yes: false });

    const intake = path.join(tmp, SQUAD_DIR, 'stories/my-feature/a/intake.md');
    expect(fs.existsSync(intake)).toBe(true);
  });

  it('offers a select for existing feature folders and can pick one', async () => {
    installWorkspace();
    const stories = path.join(tmp, SQUAD_DIR, 'stories');
    fs.mkdirSync(path.join(stories, 'auth'), { recursive: true });
    restoreTTY = stubStdinTTY(true);
    vi.mocked(select).mockResolvedValueOnce('auth');

    await runNewStory(undefined, { title: 'b', yes: false });

    expect(vi.mocked(input)).not.toHaveBeenCalled();
    const intake = path.join(stories, 'auth', 'b', 'intake.md');
    expect(fs.existsSync(intake)).toBe(true);
  });

  it('throws usage when not interactive and slug missing', () => {
    installWorkspace();
    restoreTTY = stubStdinTTY(false);

    return expect(runNewStory(undefined, { title: 't', yes: false })).rejects.toThrow(
      /feature-slug is required/,
    );
  });

  it('throws with --yes and no slug (fail fast)', () => {
    installWorkspace();
    restoreTTY = stubStdinTTY(true);

    return expect(runNewStory(undefined, { title: 't', yes: true })).rejects.toThrow(/feature-slug is required/);
  });

  it('treats CI=1 as non-interactive and throws without slug', () => {
    installWorkspace();
    restoreTTY = stubStdinTTY(true);
    process.env.CI = 'true';

    return expect(runNewStory(undefined, { title: 't' })).rejects.toThrow(/feature-slug is required/);
  });

  it('validateFeatureSlugForPrompt rejects non-kebab user input', () => {
    expect(validateFeatureSlugForPrompt('Not A Slug ')).toBe('Use lowercase kebab-case (letters, digits, hyphens).');
  });
});
