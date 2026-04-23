import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPaths } from '../src/core/paths.js';
import {
  listStories,
  findStoryByIntake,
  findPlanFor,
  readTitleHint,
} from '../src/core/stories.js';

let tmp: string;
let paths: ReturnType<typeof buildPaths>;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-stories-'));
  paths = buildPaths(tmp);
  fs.mkdirSync(paths.storiesDir, { recursive: true });
  fs.mkdirSync(paths.plansDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeIntake(feature: string, id: string, body: string): string {
  const dir = path.join(paths.storiesDir, feature, id);
  fs.mkdirSync(dir, { recursive: true });
  const intakePath = path.join(dir, 'intake.md');
  fs.writeFileSync(intakePath, body, 'utf8');
  return intakePath;
}

describe('listStories', () => {
  it('returns intakes and sets planFile when a matching plan exists', () => {
    writeIntake('auth', 'sso', '# intake\n');
    const planDir = path.join(paths.plansDir, 'auth');
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, '01-story-sso.md'), '# plan\n', 'utf8');

    const rows = listStories(paths);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      feature: 'auth',
      id: 'sso',
      planFile: '01-story-sso.md',
    });
    expect(rows[0]!.intakePath).toBe(path.join(paths.storiesDir, 'auth', 'sso', 'intake.md'));
  });

  it('omits planFile when no matching plan file', () => {
    writeIntake('billing', 'inv-1', '# x\n');
    const rows = listStories(paths);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.planFile).toBeUndefined();
  });

  it('ignores non-story markdown files in plans dir', () => {
    writeIntake('auth', 'x', '# i\n');
    const planDir = path.join(paths.plansDir, 'auth');
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, 'notes.md'), '# n\n', 'utf8');
    const rows = listStories(paths);
    expect(rows[0]!.planFile).toBeUndefined();
  });

  it('filters by feature slug', () => {
    writeIntake('auth', 'a', '#\n');
    writeIntake('billing', 'b', '#\n');
    expect(listStories(paths, { feature: 'auth' })).toHaveLength(1);
    expect(listStories(paths, { feature: 'auth' })[0]!.id).toBe('a');
  });
});

describe('findPlanFor', () => {
  it('returns filename matching story id and story-file pattern', () => {
    const planDir = path.join(paths.plansDir, 'f');
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, '02-story-my-id.md'), '', 'utf8');
    expect(findPlanFor(paths.plansDir, 'f', 'my-id')).toBe('02-story-my-id.md');
  });
});

describe('findStoryByIntake', () => {
  it('matches absolute paths with relative, dot segments, and trailing whitespace', () => {
    const intakePath = writeIntake('auth', 'story-1', '#\n');
    const records = listStories(paths);

    expect(findStoryByIntake(records, intakePath)?.id).toBe('story-1');

    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      expect(findStoryByIntake(records, '.squad/stories/auth/story-1/intake.md')?.id).toBe('story-1');
      expect(
        findStoryByIntake(records, path.join('.squad/stories/auth/foo', '..', 'story-1', 'intake.md'))?.id,
      ).toBe('story-1');
    } finally {
      process.chdir(cwd);
    }

    expect(findStoryByIntake(records, `${intakePath}\n`)?.id).toBe('story-1');
  });
});

describe('readTitleHint', () => {
  it('extracts title hint from preamble in first lines', () => {
    const f = path.join(tmp, 'hint.md');
    fs.writeFileSync(
      f,
      '> **Title hint (from CLI):** My Feature Title\n\n# rest\n',
      'utf8',
    );
    expect(readTitleHint(f)).toBe('My Feature Title');
  });

  it('returns undefined when preamble is missing', () => {
    const f = path.join(tmp, 'no-hint.md');
    fs.writeFileSync(f, '# Title\n\nBody\n', 'utf8');
    expect(readTitleHint(f)).toBeUndefined();
  });
});
