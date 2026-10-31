import { describe, it, expect } from 'vitest';
import { Watchdog, descendants, parseClock, waitingOn, type ProcRow } from '../src/engine/watchdog.js';

const MIN = 60_000;
const row = (pid: number, ppid: number, command: string, cpuSec = 0, elapsedSec = 600): ProcRow => ({ pid, ppid, command, cpuSec, elapsedSec });

describe('watchdog', () => {
  it('reads ps clock formats', () => {
    expect(parseClock('03:04')).toBe(184);
    expect(parseClock('02:03:04')).toBe(7384);
    expect(parseClock('1-00:00:10')).toBe(86_410);
    expect(parseClock('0:01.50')).toBe(1.5);
  });

  it('finds the real command under shells and pipes', () => {
    const rows = [row(10, 1, 'claude -p'), row(11, 10, '/bin/zsh -c npm install | tail -15'), row(12, 11, 'node /usr/bin/npm install --no-audit', 2, 640), row(13, 11, 'tail -15')];
    expect(descendants(rows, 10).map((r) => r.pid)).toEqual([11, 12, 13]);
    expect(waitingOn(rows, 10)?.pid).toBe(12);
  });

  it('says nothing while the step shows progress', () => {
    const dog = new Watchdog(3 * MIN, 2 * MIN, 12 * MIN, () => []);
    dog.beat('MA-1', 10);
    expect(dog.check('MA-1')).toBeNull();
  });

  it('flags a command that stopped using the CPU as stuck, and offers to end it', () => {
    const dog = new Watchdog(3 * MIN, 2 * MIN, 12 * MIN, () => []);
    const t0 = Date.now();
    dog.track('MA-1', 10);
    const rows = (cpu: number) => [row(10, 1, 'claude -p'), row(11, 10, '/bin/zsh -c npm install'), row(12, 11, '/usr/local/bin/node /usr/local/bin/npm install --no-audit', cpu, 660)];
    // Quiet for 4 minutes, the install still using the CPU: not stuck yet.
    expect(dog.check('MA-1', t0 + 4 * MIN, rows(5))).toBeNull();
    // Two more minutes and no more CPU used: stuck.
    const q = dog.check('MA-1', t0 + 6 * MIN + 1000, rows(5.2));
    expect(q).toMatchObject({ kind: 'stuck', pid: 12, command: 'npm install --no-audit' });
    expect(q?.detail).toMatch(/npm install --no-audit has run for 11 minutes and has done nothing for 2 minutes/);
    // A new sign of life clears it.
    dog.beat('MA-1');
    expect(dog.check('MA-1', Date.now(), rows(5.2))).toBeNull();
  });

  it('calls a long busy step "taking long", not stuck', () => {
    const dog = new Watchdog(3 * MIN, 2 * MIN, 12 * MIN, () => []);
    const t0 = Date.now();
    dog.track('MA-1', 10);
    let cpu = 0;
    const rows = () => [row(10, 1, 'claude -p'), row(12, 10, 'npx playwright test', (cpu += 30), 800)];
    for (const m of [4, 6, 8, 10]) expect(dog.check('MA-1', t0 + m * MIN, rows())).toBeNull();
    expect(dog.check('MA-1', t0 + 13 * MIN, rows())).toMatchObject({ kind: 'long', command: 'npx playwright test' });
  });

  it('notices Claude Code itself going silent', () => {
    const dog = new Watchdog(3 * MIN, 2 * MIN, 12 * MIN, () => []);
    const t0 = Date.now();
    dog.track('MA-1', 10);
    const rows = [row(10, 1, '/Users/me/.local/bin/claude -p ...', 3)];
    expect(dog.check('MA-1', t0 + 4 * MIN, rows)).toBeNull();
    expect(dog.check('MA-1', t0 + 7 * MIN, rows)).toMatchObject({ kind: 'stuck', detail: expect.stringMatching(/Claude Code has not answered/) });
  });
});
