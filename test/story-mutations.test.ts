import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { buildPaths } from '../src/core/paths.js';
import { createStoryRecord, deleteStoryRecord, writeNewStoryToDisk } from '../src/core/story-mutations.js';
import { listStories } from '../src/core/stories.js';
import { loadConfig } from '../src/core/config.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';

let tmp: string;
let prev: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-mut-'));
  prev = process.cwd();
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(prev);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(tracker: 'none' | 'jira' = 'none'): void {
  const paths = buildPaths(tmp);
  fs.mkdirSync(paths.squadDir, { recursive: true });
  fs.writeFileSync(
    paths.configFile,
    yaml.dump({
      ...DEFAULT_CONFIG,
      tracker: tracker === 'jira' ? { type: 'jira', workspace: 'x.atlassian.net' } : { type: 'none' },
      naming: { includeTrackerId: true, globalSequence: true },
    }),
    'utf8',
  );
}

describe('createStoryRecord + deleteStoryRecord', () => {
  it('creates and deletes a title-based story (tracker skipped)', () => {
    writeConfig('jira');
    const paths = buildPaths(tmp);
    const cfg = loadConfig(paths.configFile);
    const created = createStoryRecord({
      paths,
      config: cfg,
      feature: 'f1',
      title: 'hello world',
    });
    expect(fs.existsSync(created.intakePath)).toBe(true);
    expect(created.id).toBe('hello-world');
    const story = listStories(paths, { feature: 'f1' })[0]!;
    const del = deleteStoryRecord({ paths, story, trash: false });
    expect(del.removed.length).toBeGreaterThan(0);
    expect(listStories(paths).find((s) => s.id === 'hello-world')).toBeUndefined();
  });

  it('creates a tracker-id story when id provided', () => {
    writeConfig('jira');
    const paths = buildPaths(tmp);
    const cfg = loadConfig(paths.configFile);
    const created = createStoryRecord({
      paths,
      config: cfg,
      feature: 'f2',
      title: 'ignored',
      trackerId: 'PROJ-1',
    });
    expect(created.id).toBe('PROJ-1');
  });

  it('writeNewStoryToDisk is idempotent with existing check', () => {
    writeConfig('none');
    const paths = buildPaths(tmp);
    const cfg = loadConfig(paths.configFile);
    writeNewStoryToDisk({
      paths,
      config: cfg,
      featureSlug: 'x',
      storyFolderName: 'only',
      id: undefined,
      title: 't',
      noTracker: true,
      sourceBlock: '',
      fetchedIssue: undefined,
    });
    expect(() =>
      writeNewStoryToDisk({
        paths,
        config: cfg,
        featureSlug: 'x',
        storyFolderName: 'only',
        id: undefined,
        title: 't',
        noTracker: true,
        sourceBlock: '',
        fetchedIssue: undefined,
      }),
    ).toThrow(/already exists/);
  });
});
