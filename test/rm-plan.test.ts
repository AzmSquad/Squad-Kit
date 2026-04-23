import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { select, confirm } from '@inquirer/prompts';
import { buildPaths, SQUAD_DIR } from '../src/core/paths.js';
import { saveConfig, DEFAULT_CONFIG } from '../src/core/config.js';
import { runRmPlan } from '../src/commands/rm/plan.js';

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
  confirm: vi.fn(),
}));

let tmp: string;
let prevCwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-rm-plan-'));
  prevCwd = process.cwd();
  process.chdir(tmp);
  const squad = path.join(tmp, SQUAD_DIR);
  fs.mkdirSync(squad, { recursive: true });
  saveConfig(path.join(squad, 'config.yaml'), DEFAULT_CONFIG);
  vi.mocked(select).mockReset();
  vi.mocked(confirm).mockReset();
  vi.mocked(confirm).mockResolvedValue(true);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function seedPlanWorkspace(paths: ReturnType<typeof buildPaths>, feature: string, id: string): void {
  const sdir = path.join(paths.storiesDir, feature, id);
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, 'intake.md'), '# x\n', 'utf8');
  const pdir = path.join(paths.plansDir, feature);
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, `03-story-${id}.md`), '# plan\n', 'utf8');
  const table = `# ${feature} — plan overview

## Stories

| NN | File | Title | Tracker id | Depends on |
|----|------|-------|------------|------------|
| 03 | \`03-story-${id}.md\` | t | ${id} | — |
`;
  fs.writeFileSync(path.join(pdir, '00-overview.md'), table, 'utf8');
}

describe('runRmPlan', () => {
  it('resolves by absolute path; intake and overview row updated', async () => {
    const paths = buildPaths(tmp);
    seedPlanWorkspace(paths, 'auth', 'x');
    const planAbs = path.join(paths.plansDir, 'auth', '03-story-x.md');
    await runRmPlan(planAbs, { yes: true });
    expect(fs.existsSync(path.join(paths.storiesDir, 'auth', 'x', 'intake.md'))).toBe(true);
    expect(fs.existsSync(planAbs)).toBe(false);
    const ov = fs.readFileSync(path.join(paths.plansDir, 'auth', '00-overview.md'), 'utf8');
    expect(ov).toContain('NN');
    expect(ov).not.toContain('03-story-x');
  });

  it('resolves by sequence 03 with --feature', async () => {
    const paths = buildPaths(tmp);
    seedPlanWorkspace(paths, 'auth', 'x');
    await runRmPlan('03', { yes: true, feature: 'auth' });
    expect(fs.existsSync(path.join(paths.plansDir, 'auth', '03-story-x.md'))).toBe(false);
  });

  it('throws when sequence matches multiple features without --feature', async () => {
    const paths = buildPaths(tmp);
    seedPlanWorkspace(paths, 'a', '1');
    seedPlanWorkspace(paths, 'b', '2');
    await expect(runRmPlan('03', { yes: true })).rejects.toThrow(/--feature/);
  });

  it('--dry-run with --trash shows preview only', async () => {
    const paths = buildPaths(tmp);
    seedPlanWorkspace(paths, 'f', 'p');
    const p = path.join(paths.plansDir, 'f', '03-story-p.md');
    const before = fs.readFileSync(p, 'utf8');
    await runRmPlan('03', { dryRun: true, trash: true, yes: true, feature: 'f' });
    expect(fs.readFileSync(p, 'utf8')).toBe(before);
  });
});
