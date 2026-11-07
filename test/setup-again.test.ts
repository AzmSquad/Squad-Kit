import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REFUSED = 'A check tried to use Docker, which is not open to the project\'s own commands. An engineer can allow it in Settings.';

// The guard's refusal looks different on each computer: here a command that prints this word was refused.
vi.mock('../src/engine/project-guard.js', async (orig) => ({
  ...(await orig<typeof import('../src/engine/project-guard.js')>()),
  dockerBlockedWords: (output: string) => (output.includes('docker refused') ? REFUSED : null),
}));

const { boardPaths, readTicket, writeMeta } = await import('../src/board/store.js');
const { createTicket } = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');

/** Only Docker's refusal stops a story at its setup. After an engineer allows Docker, Try again must run the setup again. */

let tmp: string;
let project: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-setup-again-')));
  project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  const sh = (cmd: string) => execSync(cmd, { cwd: project, stdio: 'pipe' });
  sh('git init -q -b main');
  fs.writeFileSync(path.join(project, 'readme.md'), 'x\n');
  sh('git add readme.md && git -c user.name=t -c user.email=t@t commit -q -m first');
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('Try again after a setup Docker refused', () => {
  it('runs the setup again until it gets through, then not again', async () => {
    const allowed = path.join(tmp, 'allowed');
    const ran = path.join(tmp, 'ran.txt');
    const bp = boardPaths(path.join(project, '.squad'));
    writeMeta(bp, {
      project: 'App',
      key: 'AP',
      nextNumber: 1,
      engine: 'live',
      user: { name: 'Momen', role: 'Project manager' },
      roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
      tools: [],
      speed: 1,
      map: [],
      lessons: [],
      commands: { setup: `test -f ${allowed} && echo ran >> ${ran} || { echo docker refused; exit 1; }` },
      git: { base: 'main', remote: '' },
      scan: { status: 'done', empty: false },
    });
    const t = createTicket(bp, { title: 'Needs Docker' });
    const squad = new LiveSquad(bp) as unknown as { workspace(id: string): Promise<unknown>; guardFor(): undefined };
    squad.guardFor = () => undefined;

    await expect(squad.workspace(t.id)).rejects.toThrow(REFUSED);
    const copy = readTicket(bp, t.id)!.worktree!;
    expect(fs.existsSync(copy)).toBe(true);
    expect(readTicket(bp, t.id)!.setupOwed).toEqual(['.']);

    // Not allowed yet: the same stop, not a story that goes on with no setup.
    await expect(squad.workspace(t.id)).rejects.toThrow(REFUSED);

    fs.writeFileSync(allowed, '');
    await squad.workspace(t.id);
    expect(fs.readFileSync(ran, 'utf8')).toBe('ran\n');
    expect(readTicket(bp, t.id)!.setupOwed).toEqual([]);

    await squad.workspace(t.id);
    expect(fs.readFileSync(ran, 'utf8')).toBe('ran\n');
  });
});
