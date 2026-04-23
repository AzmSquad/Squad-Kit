import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { select } from '@inquirer/prompts';
import { buildPaths, SQUAD_DIR } from '../src/core/paths.js';
import { DEFAULT_CONFIG, saveConfig } from '../src/core/config.js';
import { listStories } from '../src/core/stories.js';
import { runNewPlan } from '../src/commands/new-plan.js';

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
  confirm: vi.fn(),
}));

let tmp: string;
let prevCwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-new-plan-'));
  prevCwd = process.cwd();
  process.chdir(tmp);
  const squad = path.join(tmp, SQUAD_DIR);
  fs.mkdirSync(squad, { recursive: true });
  saveConfig(path.join(squad, 'config.yaml'), DEFAULT_CONFIG);
  vi.mocked(select).mockReset();
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeIntake(paths: ReturnType<typeof buildPaths>, feature: string, id: string): void {
  const dir = path.join(paths.storiesDir, feature, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'intake.md'), `# ${id}\n`, 'utf8');
}

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

describe('new-plan picker branches', () => {
  it('returns undefined and reports when there are no stories', async () => {
    const paths = buildPaths(tmp);
    fs.mkdirSync(paths.storiesDir, { recursive: true });
    const ui = await import('../src/ui/index.js');
    const info = vi.spyOn(ui, 'info').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runNewPlan(undefined, { clipboard: false });
    expect(info).toHaveBeenCalledWith(expect.stringContaining('No intakes to plan'));
    expect(stdout).not.toHaveBeenCalled();
    stdout.mockRestore();
  });

  it('returns undefined when all intakes already have plans and all=false', async () => {
    const paths = buildPaths(tmp);
    fs.mkdirSync(paths.storiesDir, { recursive: true });
    writeIntake(paths, 'auth', 'a');
    const planDir = path.join(paths.plansDir, 'auth');
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, '01-story-a.md'), '# p\n', 'utf8');

    const ui = await import('../src/ui/index.js');
    const info = vi.spyOn(ui, 'info').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runNewPlan(undefined, { clipboard: false, all: false });
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/All 1 intakes already have plans/));
    expect(stdout).not.toHaveBeenCalled();
    stdout.mockRestore();
  });

  it('calls select with expected choices when interactive', async () => {
    const paths = buildPaths(tmp);
    writeIntake(paths, 'auth', 's1');
    // @ts-expect-error Inquirer types Promise with `cancel`; mock returns plain Promise<string>.
    vi.mocked(select).mockImplementation(async (opts) => {
      const o = opts as unknown as { choices: { name?: string; value: string }[] };
      return o.choices[0]!.value;
    });

    const restoreTTY = stubInteractiveTTY();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const prevCI = process.env.CI;
    process.env.CI = 'true';
    try {
      await runNewPlan(undefined, { clipboard: false });
      expect(select).toHaveBeenCalled();
      const arg = vi.mocked(select).mock.calls[0]![0] as {
        message: string;
        choices: { name: string; value: string }[];
        pageSize: number;
      };
      expect(arg.message).toBe('Pick a story to plan:');
      expect(arg.pageSize).toBe(1);
      expect(arg.choices[0]).toMatchObject({
        name: expect.stringContaining('auth / s1'),
        value: expect.stringMatching(/intake\.md$/),
      });
      expect(stdout).toHaveBeenCalled();
    } finally {
      if (prevCI === undefined) delete process.env.CI;
      else process.env.CI = prevCI;
      restoreTTY();
      stdout.mockRestore();
    }
  });
});

describe('runNewPlan', () => {
  it('throws when non-interactive, no path, and an unplanned intake exists', async () => {
    const paths = buildPaths(tmp);
    writeIntake(paths, 'f', 'id1');
    const desc = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      await expect(runNewPlan(undefined, { clipboard: false })).rejects.toThrow(/not running interactively/);
    } finally {
      if (desc) Object.defineProperty(process.stdin, 'isTTY', desc);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
    }
  });
});
