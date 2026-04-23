import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { select, confirm } from '@inquirer/prompts';
import { buildPaths, SQUAD_DIR } from '../src/core/paths.js';
import { saveConfig, DEFAULT_CONFIG } from '../src/core/config.js';
import { runRmStory } from '../src/commands/rm/story.js';
import { removeOverviewRow } from '../src/commands/rm/shared.js';

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
  confirm: vi.fn(),
}));

let tmp: string;
let prevCwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-rm-story-'));
  prevCwd = process.cwd();
  process.chdir(tmp);
  const squad = path.join(tmp, SQUAD_DIR);
  fs.mkdirSync(squad, { recursive: true });
  saveConfig(path.join(squad, 'config.yaml'), DEFAULT_CONFIG);
  vi.mocked(select).mockReset();
  vi.mocked(confirm).mockReset();
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

function seedStory(
  paths: ReturnType<typeof buildPaths>,
  feature: string,
  id: string,
  opts: { plan?: boolean; overviewOther?: string } = {},
): void {
  const sdir = path.join(paths.storiesDir, feature, id);
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, 'intake.md'), `# ${id}\n`, 'utf8');
  const pdir = path.join(paths.plansDir, feature);
  fs.mkdirSync(pdir, { recursive: true });
  if (opts.plan) {
    fs.writeFileSync(path.join(pdir, `01-story-${id}.md`), '# plan\n', 'utf8');
  }
  const header = `# ${feature} — plan overview\n\n## Stories\n\n| NN | File | Title | Tracker id | Depends on |\n|----|------|-------|------------|------------|\n`;
  const rowA = `| 01 | \`01-story-${id}.md\` | t | ${id} | — |\n`;
  const rowB = opts.overviewOther
    ? `| 02 | \`02-story-other.md\` | o | ${opts.overviewOther} | — |\n`
    : '';
  fs.writeFileSync(path.join(pdir, '00-overview.md'), header + rowA + rowB, 'utf8');
}

describe('runRmStory', () => {
  it('happy path with -y removes story dir, plan, and overview row', async () => {
    const paths = buildPaths(tmp);
    seedStory(paths, 'feat', 'story1', { plan: true, overviewOther: 'other' });
    await runRmStory('feat/story1', { yes: true });
    expect(fs.existsSync(path.join(paths.storiesDir, 'feat', 'story1'))).toBe(false);
    expect(fs.existsSync(path.join(paths.plansDir, 'feat', '01-story-story1.md'))).toBe(false);
    const ov = fs.readFileSync(path.join(paths.plansDir, 'feat', '00-overview.md'), 'utf8');
    expect(ov).toContain('other');
    expect(ov).not.toContain('story1');
  });

  it('dry-run leaves filesystem unchanged', async () => {
    const paths = buildPaths(tmp);
    seedStory(paths, 'feat', 'a', { plan: true });
    const before = fs.readFileSync(path.join(paths.plansDir, 'feat', '00-overview.md'), 'utf8');
    await runRmStory('feat/a', { dryRun: true, yes: true });
    expect(fs.existsSync(path.join(paths.storiesDir, 'feat', 'a', 'intake.md'))).toBe(true);
    expect(fs.readFileSync(path.join(paths.plansDir, 'feat', '00-overview.md'), 'utf8')).toBe(before);
  });

  it('interactive: picker + confirm deletes selected story only', async () => {
    const paths = buildPaths(tmp);
    seedStory(paths, 'feat', 'one', { plan: true, overviewOther: 'two' });
    const s1 = path.join(paths.storiesDir, 'feat', 'one', 'intake.md');
    const sdir2 = path.join(paths.storiesDir, 'feat', 'two');
    fs.mkdirSync(sdir2, { recursive: true });
    fs.writeFileSync(path.join(sdir2, 'intake.md'), '# two\n', 'utf8');
    fs.writeFileSync(path.join(paths.plansDir, 'feat', '02-story-two.md'), '# p2\n', 'utf8');
    const pdir = path.join(paths.plansDir, 'feat');
    const ov = fs.readFileSync(path.join(pdir, '00-overview.md'), 'utf8');
    const row2 = `| 02 | \`02-story-two.md\` | t | two | — |\n`;
    fs.writeFileSync(path.join(pdir, '00-overview.md'), ov.trimEnd() + '\n' + row2, 'utf8');
    const { listAllStories } = await import('../src/core/stories.js');
    const two = listAllStories(paths).find((s) => s.id === 'two')!;
    vi.mocked(select).mockResolvedValueOnce(two);
    vi.mocked(confirm).mockResolvedValueOnce(true);
    const restore = stubInteractiveTTY();
    try {
      await runRmStory(undefined, { yes: false });
    } finally {
      restore();
    }
    expect(fs.existsSync(s1)).toBe(true);
    expect(fs.existsSync(path.join(paths.storiesDir, 'feat', 'two', 'intake.md'))).toBe(false);
  });

  it('--trash moves targets into a timestamp bucket', async () => {
    const paths = buildPaths(tmp);
    seedStory(paths, 'feat', 't1', { plan: true });
    await runRmStory('feat/t1', { yes: true, trash: true });
    const trash = path.join(paths.squadDir, '.trash');
    const buckets = fs.readdirSync(trash);
    expect(buckets.length).toBe(1);
    const bucket = path.join(trash, buckets[0]!);
    const names = fs.readdirSync(bucket);
    expect(names.some((n) => n.includes('t1'))).toBe(true);
    expect(fs.existsSync(path.join(paths.storiesDir, 'feat', 't1'))).toBe(false);
  });

  it('no stories prints info and does not throw', async () => {
    const paths = buildPaths(tmp);
    fs.mkdirSync(paths.storiesDir, { recursive: true });
    const ui = await import('../src/ui/index.js');
    const spy = vi.spyOn(ui, 'info').mockImplementation(() => true);
    await runRmStory(undefined, { yes: true });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('No stories to delete'));
    spy.mockRestore();
  });

  it('unresolved arg throws with list hint', async () => {
    const paths = buildPaths(tmp);
    seedStory(paths, 'x', 'y', { plan: true });
    await expect(runRmStory('nope', { yes: true })).rejects.toThrow(/squad list/);
  });

  it('removeOverviewRow keeps header and other rows', () => {
    const p = path.join(tmp, 'plans', 'f');
    fs.mkdirSync(p, { recursive: true });
    const content = `# f

| NN | File | Title | Tracker id | Depends on |
|----|------|-------|------------|------------|
| 01 | \`a.md\` | t1 | id1 | — |
| 02 | \`b.md\` | t2 | id2 | — |
`;
    fs.writeFileSync(path.join(p, '00-overview.md'), content, 'utf8');
    removeOverviewRow(p, 'id1');
    const out = fs.readFileSync(path.join(p, '00-overview.md'), 'utf8');
    expect(out).toContain('NN');
    expect(out).toContain('id2');
    expect(out).not.toContain('id1');
  });
});
