import { describe, it, expect } from 'vitest';
import type { ChildProcess } from 'node:child_process';

/**
 * On Windows a command runs under cmd.exe with no process group, so ending cmd.exe alone left the app it started
 * running after stop_app, Try it yourself, Delete and the board closing. squad-kit ends the whole tree with taskkill.
 */

const { endGroup, signalGroup, endTree } = await import('../src/engine/process-group.js');
const { guardNote } = await import('../src/engine/sandbox.js');

function fakeSpawn() {
  const runs: { command: string; args: string[] }[] = [];
  const spawn = (command: string, args: string[]) => {
    runs.push({ command, args });
    return { on: () => undefined, unref: () => undefined } as unknown as ChildProcess;
  };
  return { runs, spawn };
}

describe('stopping on Windows', () => {
  it('ends the whole tree under cmd.exe with taskkill /T /F, once, and never only cmd.exe', () => {
    const { runs, spawn } = fakeSpawn();
    let killedAlone = 0;
    const child = { pid: 4242, kill: () => void (killedAlone += 1) } as unknown as ChildProcess;
    endGroup(child, 10, { platform: 'win32', spawn });
    expect(runs).toEqual([{ command: 'taskkill', args: ['/pid', '4242', '/T', '/F'] }]);
    expect(killedAlone).toBe(0);
    signalGroup(child, 'SIGKILL', { platform: 'win32', spawn });
    expect(runs).toHaveLength(2);
    endTree(77, { spawn });
    expect(runs.at(-1)).toEqual({ command: 'taskkill', args: ['/pid', '77', '/T', '/F'] });
  });

  it('elsewhere it still signals the whole process group, and runs no taskkill', () => {
    const { runs, spawn } = fakeSpawn();
    // A pid that is not running: the signal fails quietly.
    endGroup({ pid: 2 ** 22 + 12345, kill: () => undefined } as unknown as ChildProcess, 10, { platform: 'darwin', spawn });
    expect(runs).toEqual([]);
  });

  it('Settings says honestly what is less protected on Windows', () => {
    const note = guardNote('win32', [{ available: false, why: 'no guard on Windows' }]);
    expect(note?.text).toBe("On Windows, squad-kit does not guard the agents' own commands, or the project's own tests and app, so they can reach other files on this computer. Use it on projects you trust.");
    expect(note?.text).not.toMatch(/protect/);
  });
});
