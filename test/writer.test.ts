import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPaths, SQUAD_DIR } from '../src/core/paths.js';
import type { SquadConfig } from '../src/core/config.js';
import type { StoryRecord } from '../src/core/stories.js';
import { buildMetadataHeader, writePlanFile } from '../src/planner/writer.js';

let tmp: string;
let prevCwd: string;

const baseConfig: SquadConfig = {
  version: 1,
  project: { name: 't' },
  tracker: { type: 'none' },
  naming: { includeTrackerId: false, globalSequence: true },
  agents: [],
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-writer-'));
  prevCwd = process.cwd();
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function story(over: Partial<StoryRecord> = {}): StoryRecord {
  return {
    feature: 'auth',
    id: 'story-1',
    intakePath: path.join(tmp, '.squad/stories/auth/story-1/intake.md'),
    storyDir: path.join(tmp, '.squad/stories/auth/story-1'),
    ...over,
  };
}

describe('writePlanFile', () => {
  it('creates feature dir, plan file, and 00-overview with nextGlobal NN', () => {
    const paths = buildPaths(tmp);
    fs.mkdirSync(paths.squadDir, { recursive: true });
    const s = story({ titleHint: 'Login flow' });
    const { planFile, sequenceNumber, overwrote } = writePlanFile({
      paths,
      config: baseConfig,
      story: s,
      planBodyMarkdown: '# Plan body\n',
      metadataHeader: '<!-- meta -->',
    });
    expect(overwrote).toBe(false);
    expect(sequenceNumber).toBe(1);
    expect(planFile).toMatch(/01-story-story-1\.md$/);
    expect(fs.readFileSync(planFile, 'utf8').startsWith('<!-- meta -->')).toBe(true);
    expect(fs.readFileSync(planFile, 'utf8')).toContain('# Plan body');
    const overview = path.join(paths.plansDir, 'auth', '00-overview.md');
    expect(fs.existsSync(overview)).toBe(true);
    expect(fs.readFileSync(overview, 'utf8')).toContain('01-story-story-1.md');
    expect(fs.readFileSync(overview, 'utf8')).toContain('story-1');
  });

  it('overwrites same story plan in place and updates overview row', () => {
    const paths = buildPaths(tmp);
    fs.mkdirSync(paths.squadDir, { recursive: true });
    const s = story();
    const first = writePlanFile({
      paths,
      config: baseConfig,
      story: s,
      planBodyMarkdown: 'v1',
      metadataHeader: '<!-- a -->',
    });
    const second = writePlanFile({
      paths,
      config: baseConfig,
      story: s,
      planBodyMarkdown: 'v2',
      metadataHeader: '<!-- b -->',
    });
    expect(second.overwrote).toBe(true);
    expect(second.sequenceNumber).toBe(first.sequenceNumber);
    expect(second.planFile).toBe(first.planFile);
    expect(fs.readFileSync(first.planFile, 'utf8')).toContain('v2');
    expect(fs.readFileSync(first.planFile, 'utf8')).toContain('<!-- b -->');
  });

  it('uses slugified story folder id for linear tracker plans', () => {
    const paths = buildPaths(tmp);
    fs.mkdirSync(paths.squadDir, { recursive: true });
    const config: SquadConfig = {
      ...baseConfig,
      tracker: { type: 'linear' },
      naming: { includeTrackerId: true, globalSequence: true },
    };
    const s = story({ id: 'ENG-42' });
    const { planFile } = writePlanFile({
      paths,
      config,
      story: s,
      planBodyMarkdown: 'x',
      metadataHeader: '<!-- h -->',
    });
    expect(path.basename(planFile)).toBe('01-story-eng-42.md');
  });

  it('writes a partial plan with .partial.md and YAML status front matter', () => {
    const paths = buildPaths(tmp);
    fs.mkdirSync(paths.squadDir, { recursive: true });
    const s = story({ titleHint: 'Draft plan' });
    const { planFile } = writePlanFile({
      paths,
      config: baseConfig,
      story: s,
      planBodyMarkdown: '# WIP\n',
      metadataHeader: buildMetadataHeader({
        provider: 'anthropic',
        model: 'm',
        reads: 0,
        bytes: 0,
        inputTokens: 1,
        outputTokens: 2,
        durationMs: 1,
        planStatus: 'partial',
      }),
      partial: true,
    });
    expect(planFile).toMatch(/\.partial\.md$/);
    const raw = fs.readFileSync(planFile, 'utf8');
    expect(raw).toContain('squad-kit-plan-status: partial');
    expect(raw).toContain('# WIP');
  });

  it('does not put title hint in the filename when it differs from the story id', () => {
    const paths = buildPaths(tmp);
    fs.mkdirSync(paths.squadDir, { recursive: true });
    const config: SquadConfig = {
      ...baseConfig,
      tracker: { type: 'azure' },
      naming: { includeTrackerId: true, globalSequence: true },
    };
    const s = story({ feature: 'inspection-team', id: '852655', titleHint: 'Inspection form updates' });
    const { planFile } = writePlanFile({
      paths,
      config,
      story: s,
      planBodyMarkdown: 'x',
      metadataHeader: '<!-- h -->',
    });
    expect(path.basename(planFile)).toBe('01-story-852655.md');
  });
});

describe('buildMetadataHeader', () => {
  it('includes provider, model, ISO timestamp, reads, KB, tokens, and optional cost', () => {
    const h = buildMetadataHeader({
      provider: 'anthropic',
      model: 'claude-x',
      reads: 3,
      bytes: 4096,
      inputTokens: 10,
      outputTokens: 20,
      durationMs: 1000,
      costUsd: 0.42,
    });
    expect(h.startsWith('<!-- squad-kit:')).toBe(true);
    expect(h).toContain('anthropic/claude-x');
    expect(h).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(h).toContain('3 reads');
    expect(h).toContain('4.0 KB context');
    expect(h).toContain('10 in / 20 out');
    expect(h).toContain('~$0.42');
  });
});
