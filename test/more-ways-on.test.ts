import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardPaths, writeMeta } from '../src/board/store.js';
import { spawnInherit } from '../src/commands/upgrade.js';
import { runProjects } from '../src/commands/projects.js';
import { forgetProject, readProjects, rememberProject } from '../src/core/projects.js';
import { writeReport } from '../src/engine/report.js';
import { AppRunner } from '../src/engine/run-app.js';
import { ticketTrouble, withPermission } from '../console-ui/src/lib/ticket-trouble.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-more-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a ticket that does not load', () => {
  it('says "no ticket" only when there is none', () => {
    expect(ticketTrouble(new Error('404 Not Found: {}'), 'SK-1')).toMatch(/no ticket SK-1/);
    const down = 'squad-kit did not answer, so nothing changed. Check that it still runs in its terminal, then try again.';
    expect(ticketTrouble(new Error(down), 'SK-1')).toBe(down);
    expect(ticketTrouble(new Error('500 Internal Server Error: x'), 'SK-1')).not.toMatch(/no ticket/);
  });
});

describe('squad upgrade', () => {
  it('a killed install is not a success', async () => {
    if (process.platform === 'win32') return;
    expect(await spawnInherit('/bin/sh', ['-c', 'kill -9 $$'])).not.toBe(0);
    expect(await spawnInherit('/bin/sh', ['-c', 'exit 0'])).toBe(0);
  });

  it('the permission way out asks for permission, not the command that just failed', () => {
    expect(withPermission('npm install -g squad-kit@2.0.0', false)).toBe('sudo npm install -g squad-kit@2.0.0');
    expect(withPermission('sudo npm install -g squad-kit', false)).toBe('sudo npm install -g squad-kit');
    expect(withPermission('npm install -g squad-kit', true)).toBe('npm install -g squad-kit');
  });
});

describe('Report a problem', () => {
  const bp = () => {
    const b = boardPaths(path.join(tmp, '.squad'));
    writeMeta(b, { project: 'App', key: 'AP', nextNumber: 1, engine: 'demo', user: { name: 'M', role: 'x' }, roles: {}, tools: [], speed: 1, map: [], lessons: [], commands: {} } as never);
    return b;
  };

  it('a folder that refuses is no raw EPERM: it says what to do', () => {
    const refuse = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    const b = bp();
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file) => {
      if (String(file).endsWith('.zip')) throw refuse;
    });
    expect(() => writeReport({ bp: b })).toThrow(/could not save the report\. Check that the disk has room/);
  });

  it('when only the first folder refuses, it lands in the second and says where', () => {
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, 'Downloads'), { recursive: true });
    vi.stubEnv('SQUAD_KIT_HOME', '');
    vi.stubEnv('HOME', home);
    const real = fs.writeFileSync;
    const b = bp();
    let first = true;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: string, ...rest: unknown[]) => {
      if (String(file).endsWith('.zip') && first) {
        first = false;
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }
      return (real as (...a: unknown[]) => unknown)(file, ...rest);
    }) as never);
    const r = writeReport({ bp: b });
    vi.unstubAllEnvs();
    expect(fs.existsSync(r.file)).toBe(true);
    expect(r.file.startsWith(path.join(home, '.squad-kit', 'reports'))).toBe(true);
    expect(r.folder).toBe(path.join(home, '.squad-kit', 'reports'));
  });
});

describe('taking a project out', () => {
  it('works from the terminal when its folder is gone', async () => {
    const root = path.join(tmp, 'gone-project');
    rememberProject('gone-1', root);
    await runProjects({ remove: 'gone-project' });
    expect(readProjects().find((p) => p.id === 'gone-1')).toBeUndefined();
    forgetProject('gone-1');
  });
});

describe('Your apps after a reboot', () => {
  it('an old process number with a later start is not called running, and is never signalled', async () => {
    const b = boardPaths(path.join(tmp, '.squad'));
    writeMeta(b, { project: 'App', key: 'AP', nextNumber: 1, engine: 'live', user: { name: 'M', role: 'x' }, roles: {}, tools: [], speed: 1, map: [], lessons: [], commands: {} } as never);
    const runner = new AppRunner(b);
    const write = runner as unknown as { record(repo: string, fn: (r: Record<string, unknown>) => void): void; elsewhere(repo: string): unknown };
    // A group that really exists here: this test process's own. Its start is far after the record, as after a reboot.
    let group: number;
    try {
      group = Number((await import('node:child_process')).execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());
    } catch {
      return;
    }
    write.record('.', (r) => Object.assign(r, { pid: group, startedAt: '2001-01-01T00:00:00.000Z' }));
    expect(write.elsewhere('.')).toBeNull();
  });
});
