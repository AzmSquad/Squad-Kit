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
    // Plain words on the card; the command itself is kept beside them, for engineers.
    expect(q?.detail).toMatch(/^A command has run for 11 minutes and has done nothing for 2 minutes/);
    expect(q?.detail).not.toContain('npm');
    // A new sign of life clears it.
    dog.beat('MA-1');
    expect(dog.check('MA-1', Date.now(), rows(5.2))).toBeNull();
  });

  it('calls a long busy step "taking long", not stuck', () => {
    const dog = new Watchdog(3 * MIN, 2 * MIN, 12 * MIN, () => []);
    const t0 = Date.now();
    dog.track('MA-1', 10);
    let cpu = 0;
    const rows = () => [row(10, 1, 'claude -p'), row(11, 10, '/bin/zsh -c npx playwright test'), row(12, 11, 'npx playwright test', (cpu += 30), 800)];
    for (const m of [4, 6, 8, 10]) expect(dog.check('MA-1', t0 + m * MIN, rows())).toBeNull();
    expect(dog.check('MA-1', t0 + 13 * MIN, rows())).toMatchObject({ kind: 'long', command: 'npx playwright test' });
  });

  it('in ACP mode looks past the adapter, Claude Code and its servers to the youngest command a shell started', () => {
    // The tracked process is the adapter; Claude Code runs under it, with a server of its own and a Bash command.
    const adapter = row(100, 1, 'node /x/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js', 4, 900);
    const claude = row(101, 100, '/Users/me/.local/bin/claude --output-format stream-json --verbose', 30, 890);
    const server = row(102, 101, 'node /Users/me/mcp/server.js', 0, 880);
    const shell = row(103, 101, '/bin/zsh -c -l source /Users/me/.claude/shell-snapshots/s.sh && eval npm test', 0, 200);
    const npm = row(104, 103, 'node /usr/local/bin/npm test', 1, 199);
    const vitest = row(105, 104, '/usr/local/bin/node /app/node_modules/.bin/vitest run', 2, 198);
    expect(waitingOn([adapter, claude, server, shell, npm, vitest], 100)?.pid).toBe(105);
    // No command running: the agent's own processes are never "the stuck command".
    expect(waitingOn([adapter, claude, server], 100)).toBeNull();

    const dog = new Watchdog(3 * MIN, 2 * MIN, 12 * MIN, () => []);
    const t0 = Date.now();
    dog.track('MA-1', 100);
    const rows = [adapter, claude, server, shell, npm, vitest];
    expect(dog.check('MA-1', t0 + 4 * MIN, rows)).toBeNull();
    expect(dog.check('MA-1', t0 + 7 * MIN, rows)).toMatchObject({ kind: 'stuck', pid: 105, command: 'vitest run' });
    // Claude Code thinking with an idle server beside it: nothing to end, only a plain line.
    const quiet = new Watchdog(3 * MIN, 2 * MIN, 12 * MIN, () => []);
    quiet.track('MA-2', 100);
    expect(quiet.check('MA-2', t0 + 4 * MIN, [adapter, claude, server])).toBeNull();
    const q = quiet.check('MA-2', t0 + 7 * MIN, [adapter, claude, server]);
    expect(q?.pid).toBeUndefined();
    expect(q?.detail).toMatch(/The AI tool has not answered/);
  });

  it('after the computer sleeps, counts the sleep out instead of calling the step long', () => {
    const dog = new Watchdog(3 * MIN, 2 * MIN, 12 * MIN, () => []);
    const wall = Date.now();
    const ran = performance.now();
    dog.beat('MA-1');
    // Fifteen seconds later, nothing to say.
    expect(dog.resumed(wall + 15_000, ran + 15_000)).toBe(0);
    // The lid closed for an hour: the wall clock moved on, the app did not run.
    const slept = dog.resumed(wall + 60 * MIN + 30_000, ran + 30_000);
    expect(Math.round(slept / MIN)).toBe(60);
    expect(dog.check('MA-1', wall + 60 * MIN + 30_000)).toBeNull();
    // Awake from then on (both clocks move), so the quiet counts again from where it stood.
    expect(dog.resumed(wall + 69 * MIN, ran + 9 * MIN)).toBe(0);
    expect(dog.check('MA-1', wall + 69 * MIN)).toBeNull();
    expect(dog.resumed(wall + 77 * MIN, ran + 17 * MIN)).toBe(0);
    expect(dog.check('MA-1', wall + 77 * MIN)).toMatchObject({ kind: 'long', detail: 'No progress for 17 minutes.' });
  });

  it('notices Claude Code itself going silent', () => {
    const dog = new Watchdog(3 * MIN, 2 * MIN, 12 * MIN, () => []);
    const t0 = Date.now();
    dog.track('MA-1', 10);
    const rows = [row(10, 1, '/Users/me/.local/bin/claude -p ...', 3)];
    expect(dog.check('MA-1', t0 + 4 * MIN, rows)).toBeNull();
    expect(dog.check('MA-1', t0 + 7 * MIN, rows)).toMatchObject({ kind: 'stuck', detail: expect.stringMatching(/The AI tool has not answered/) });
  });
});
