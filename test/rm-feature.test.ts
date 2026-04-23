import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { confirm } from '@inquirer/prompts';
import { buildPaths, SQUAD_DIR } from '../src/core/paths.js';
import { saveConfig, DEFAULT_CONFIG } from '../src/core/config.js';
import { runRmFeature } from '../src/commands/rm/feature.js';

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
  select: vi.fn(),
}));

let tmp: string;
let prevCwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-rm-feat-'));
  prevCwd = process.cwd();
  process.chdir(tmp);
  const squad = path.join(tmp, SQUAD_DIR);
  fs.mkdirSync(squad, { recursive: true });
  saveConfig(path.join(squad, 'config.yaml'), DEFAULT_CONFIG);
  vi.mocked(confirm).mockReset();
  vi.mocked(confirm).mockResolvedValue(true);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function stubInteractiveTTY(): () => void {
  const saved = [process.stdin, process.stdout, process.stderr].map((s) => ({
    stream: s,
    desc: Object.getOwnPropertyDescriptor(s, 'isTTY'),
  }));
  for (const { stream } of saved) {
    Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
  }
  return () => {
    for (const { stream, desc } of saved) {
      if (desc) Object.defineProperty(stream, 'isTTY', desc);
      else Reflect.deleteProperty(stream as object, 'isTTY');
    }
  };
}

function seedFeature(paths: ReturnType<typeof buildPaths>, slug: string): void {
  for (const id of ['s1', 's2']) {
    const d = path.join(paths.storiesDir, slug, id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'intake.md'), '# i\n', 'utf8');
  }
  const pd = path.join(paths.plansDir, slug);
  fs.mkdirSync(pd, { recursive: true });
  fs.writeFileSync(path.join(pd, '01-story-s1.md'), '# a\n', 'utf8');
  fs.writeFileSync(
    path.join(pd, '00-overview.md'),
    '# ov\n| NN | File | Title | Tracker id | Depends on |\n|----|------|-------|------------|------------|\n| 01 | `01-story-s1.md` | t | s1 | — |\n',
    'utf8',
  );
}

describe('runRmFeature', () => {
  it('removes both story and plan tree with -y', async () => {
    const paths = buildPaths(tmp);
    seedFeature(paths, 'inspection-team');
    await runRmFeature('inspection-team', { yes: true });
    expect(fs.existsSync(path.join(paths.storiesDir, 'inspection-team'))).toBe(false);
    expect(fs.existsSync(path.join(paths.plansDir, 'inspection-team'))).toBe(false);
  });

  it('--trash: both directories land in the same timestamp bucket', async () => {
    const paths = buildPaths(tmp);
    seedFeature(paths, 'f');
    await runRmFeature('f', { yes: true, trash: true });
    const b = path.join(paths.squadDir, '.trash');
    const buckets = fs.readdirSync(b);
    expect(buckets.length).toBe(1);
    const names = fs.readdirSync(path.join(b, buckets[0]!));
    expect(names.length).toBe(2);
  });

  it('dry-run does not delete', async () => {
    const paths = buildPaths(tmp);
    seedFeature(paths, 'f');
    await runRmFeature('f', { dryRun: true, yes: true });
    expect(fs.existsSync(path.join(paths.storiesDir, 'f', 's1', 'intake.md'))).toBe(true);
  });

  it('non-interactive without -y throws', async () => {
    const paths = buildPaths(tmp);
    seedFeature(paths, 'f');
    const restore = stubInteractiveTTY();
    process.env.CI = '1';
    try {
      await expect(runRmFeature(undefined, { yes: false })).rejects.toThrow(/--yes/);
    } finally {
      delete process.env.CI;
      restore();
    }
  });
});
