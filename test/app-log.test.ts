import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DAY_CAP, KEEP_DAYS, log, logFile, logFiles, logLine, logsDir, printErrors, pruneLogs, recentLines, tailLines, writeLog } from '../src/core/app-log.js';

/**
 * squad-kit's own log (phase 10): one file a day in ~/.squad-kit/logs/, engine events and errors with the time, the
 * project and the ticket, kept 14 days and capped in size. Never a token; errors also print in the app's terminal.
 */

const day = (iso: string) => new Date(iso);

beforeEach(() => {
  fs.rmSync(logsDir(), { recursive: true, force: true });
});

afterEach(() => {
  printErrors(false);
});

describe('the app log', () => {
  it('writes one line per event, with the time, the level, the project and the ticket, in a file for the day', () => {
    const at = day('2026-11-03T10:15:00Z');
    writeLog({ level: 'error', project: 'roomflow', ticket: 'RO-7', text: 'Stopped at build: Claude Code stopped\nwith two lines' }, at);
    writeLog({ text: 'squad-kit started' }, at);
    const text = fs.readFileSync(logFile(at), 'utf8');
    expect(path.basename(logFile(at))).toMatch(/^2026-11-0[34]\.log$/);
    expect(text).toBe(
      '2026-11-03T10:15:00.000Z error [roomflow] RO-7  Stopped at build: Claude Code stopped | with two lines\n' +
        '2026-11-03T10:15:00.000Z info  [app]  squad-kit started\n',
    );
  });

  it('never holds a token, a key or a password', () => {
    const line = logLine({ text: 'git push https://momen:hunter2pass@dev.azure.com/org/_git/app failed; Bearer abcdefghijklmnop1234; key sk-ant-api03-AAAABBBBCCCCDDDD; token=0123456789abcdef' });
    expect(line).not.toMatch(/hunter2pass|abcdefghijklmnop1234|sk-ant-api03|0123456789abcdef/);
    expect(line).toContain('momen:[password removed]@dev.azure.com');
  });

  it('keeps 14 days and lets older days go', () => {
    fs.mkdirSync(logsDir(), { recursive: true });
    const now = Date.parse('2026-11-20T12:00:00');
    for (const d of ['2026-11-01', '2026-11-05', '2026-11-06', '2026-11-19']) fs.writeFileSync(path.join(logsDir(), `${d}.log`), 'x\n');
    fs.writeFileSync(path.join(logsDir(), 'notes.txt'), 'not a log');
    pruneLogs(now);
    expect(fs.readdirSync(logsDir()).sort()).toEqual(['2026-11-06.log', '2026-11-19.log', 'notes.txt']);
    expect(KEEP_DAYS).toBe(14);
  });

  it('prunes by itself on the first event of a day', () => {
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.writeFileSync(path.join(logsDir(), '2020-01-01.log'), 'old\n');
    writeLog({ text: 'a new day' }, day('2026-12-01T12:00:00Z'));
    expect(fs.existsSync(path.join(logsDir(), '2020-01-01.log'))).toBe(false);
  });

  it('stops taking events when a day is full, says so once, and still keeps errors for a while', () => {
    const at = day('2026-11-04T09:00:00Z');
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.writeFileSync(logFile(at), 'x'.repeat(DAY_CAP));
    writeLog({ text: 'one more event' }, at);
    writeLog({ text: 'and another' }, at);
    writeLog({ level: 'error', text: 'an error still goes in' }, at);
    const tail = fs.readFileSync(logFile(at), 'utf8').slice(DAY_CAP);
    expect(tail.match(/The log for today is full/g)).toHaveLength(1);
    expect(tail).not.toContain('one more event');
    expect(tail).toContain('an error still goes in');
  });

  it('gives the lines of the last 24 hours across files, and the last lines for squad logs --tail', () => {
    const now = Date.parse('2026-11-05T12:00:00Z');
    writeLog({ text: 'two days ago' }, new Date(now - 2 * 86_400_000));
    writeLog({ text: 'yesterday morning' }, new Date(now - 26 * 3_600_000));
    writeLog({ text: 'yesterday evening' }, new Date(now - 20 * 3_600_000));
    writeLog({ level: 'warn', text: 'this morning' }, new Date(now - 2 * 3_600_000));
    const lines = recentLines(86_400_000, now);
    const said = (l: string) => l.slice(l.indexOf(']  ') + 3);
    expect(lines.map(said)).toEqual(['yesterday evening', 'this morning']);
    expect(logFiles().length).toBeGreaterThanOrEqual(2);
    expect(tailLines(2).map(said)).toEqual(['yesterday evening', 'this morning']);
  });

  it('prints errors in the terminal that runs the app, and only errors', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    log.error('quiet in tests');
    expect(write).not.toHaveBeenCalled();
    printErrors(true);
    log.info('an event');
    log.error('The Builder run did not finish', { project: 'roomflow', ticket: 'RO-7' });
    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]![0])).toMatch(/squad-kit error.*\[roomflow\] RO-7 {2}The Builder run did not finish/);
  });
});
