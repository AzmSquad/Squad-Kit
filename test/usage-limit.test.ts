import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeLimit, isClaudeLimit, resetTime } from '../src/modules/claude/limit.js';
import { plainError } from '../src/modules/claude/direct.js';
import { withLimit } from '../src/modules/claude/index.js';
import { runAcp, type AcpLaunch } from '../src/engine/acp-runner.js';
import { RETRY_MS, activePause, endPause, isLimitText, limitText, readPause, resetWords, startPause } from '../src/engine/usage-limit.js';

/**
 * Claude's usage limit (E5): Claude Code says it in several ways, over ACP and in `claude -p`, with and without the
 * time it resets. The Claude module reads them; the engine gets a tool-neutral limit and pauses the whole queue.
 */

// 12:00 UTC on a Tuesday in November: London is on GMT, New York on EST (UTC-5), Cairo on EET (UTC+2).
const NOW = Date.parse('2026-11-03T12:00:00Z');
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const local = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m, d, h, min).getTime();

describe('reading Claude’s usage-limit message', () => {
  it('reads the reset time in the forms Claude Code uses today, in the zone it names', () => {
    expect(iso(resetTime("You've hit your session limit · resets 3:40pm (Europe/London)", NOW))).toBe('2026-11-03T15:40:00.000Z');
    expect(iso(resetTime("You've hit your limit · resets 5pm (America/New_York) · progress saved", NOW))).toBe('2026-11-03T22:00:00.000Z');
    // A time already gone today is tomorrow's.
    expect(iso(resetTime("You've hit your session limit · resets 9am (Europe/London)", NOW))).toBe('2026-11-04T09:00:00.000Z');
    // More than a day away: the date comes first.
    expect(iso(resetTime("You've hit your weekly limit · resets Nov 5, 9am (Africa/Cairo)", NOW))).toBe('2026-11-05T07:00:00.000Z');
    expect(iso(resetTime("You've reached your Opus limit · resets Jan 2, 2027, 9:30am (Europe/London)", NOW))).toBe('2027-01-02T09:30:00.000Z');
    expect(iso(resetTime("You're out of extra usage · resets 4pm (Asia/Dubai)", Date.parse('2026-11-03T09:00:00Z')))).toBe('2026-11-03T12:00:00.000Z');
  });

  it('reads the older forms: a Unix time after a bar, "will reset at", "resets in", a full date', () => {
    expect(iso(resetTime('Claude AI usage limit reached|1793725200', NOW))).toBe('2026-11-03T17:00:00.000Z');
    expect(iso(resetTime('Claude usage limit reached. Your limit will reset at 3pm (America/New_York).', NOW))).toBe('2026-11-03T20:00:00.000Z');
    expect(iso(resetTime('Usage limit reached. Resets in 2h 15m.', NOW))).toBe('2026-11-03T14:15:00.000Z');
    expect(iso(resetTime('spend limit reached (daily; resets 2026-11-04 00:00 UTC)', NOW))).toBe('2026-11-04T00:00:00.000Z');
    expect(iso(resetTime('5-hour limit reached ∙ resets Nov 3 at 6pm (Europe/London)', NOW))).toBe('2026-11-03T18:00:00.000Z');
  });

  it('takes a time with no zone as this computer’s time', () => {
    const d = new Date(NOW);
    const at = resetTime('5-hour limit reached ∙ resets 11:50pm', NOW)!;
    const want = local(d.getFullYear(), d.getMonth(), d.getDate(), 23, 50);
    expect(at).toBe(want > NOW - 60_000 ? want : local(d.getFullYear(), d.getMonth(), d.getDate() + 1, 23, 50));
  });

  it('knows a limit without a reset time, over ACP and directly, and leaves other failures alone', () => {
    expect(claudeLimit("Internal error: You've hit your session limit · resets 3:40pm (Europe/London)", NOW)).toEqual({ resetsAt: '2026-11-03T15:40:00.000Z' });
    expect(claudeLimit('Claude AI usage limit reached', NOW)).toEqual({});
    expect(claudeLimit('API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your rate limit"}}', NOW)).toEqual({});
    expect(claudeLimit('Your org is out of usage · contact your admin', NOW)).toEqual({});
    for (const other of [
      'Claude Code is not logged in. Please run /login',
      'Claude Code stopped (exit 1).',
      'The answer was cut off: max tokens reached',
      '429 tests passed, 0 failed',
      'resets the form after 3pm',
    ]) {
      expect(isClaudeLimit(other), other).toBe(false);
      expect(claudeLimit(other, NOW)).toBeNull();
    }
  });

  it('says it in plain words, with the reset time when Claude said it', () => {
    const at = resetWords('2026-11-03T15:40:00.000Z', NOW);
    expect(plainError("You've hit your session limit · resets 3:40pm (Europe/London)", NOW)).toBe(`Claude's usage limit is reached. It resets ${at}; press Try again after that.`);
    expect(plainError('Claude AI usage limit reached', NOW)).toBe("Claude's usage limit is reached. Press Try again once the limit resets.");
    expect(plainError('API Error: 529 {"type":"overloaded_error"}')).toBe('Claude is busy right now. Wait a few minutes, then press Try again.');
    expect(plainError('TypeError: fetch failed')).toBe('Claude Code could not reach the internet. Check the connection, then press Try again.');
    expect(plainError('Credit balance is too low')).toMatch(/no credit left/);
  });

  it('reports the limit to the engine as a tool-neutral signal, from the exact words or the plain ones', () => {
    const direct = withLimit({ ok: false, sessionId: 's', text: '', error: "Claude's usage limit is reached.", detail: "You've hit your session limit · resets 3:40pm (Europe/London)" });
    expect(direct.limit?.name).toBe('Claude');
    expect(direct.limit?.resetsAt).toMatch(/T\d\d:40:00\.000Z$/);
    expect(withLimit({ ok: false, sessionId: 's', text: '', error: 'Claude AI usage limit reached' }).limit).toEqual({ name: 'Claude' });
    expect(withLimit({ ok: false, sessionId: 's', text: '', error: 'Claude Code stopped (exit 1).' }).limit).toBeUndefined();
    expect(withLimit({ ok: true, sessionId: 's', text: 'usage limit reached in the answer text' }).limit).toBeUndefined();
    // A turn that ends with the limit message as its only answer is a stop on the limit too.
    const said = withLimit({ ok: true, sessionId: 's', text: "You've hit your session limit · resets 3:40pm (Europe/London)" });
    expect(said.ok).toBe(false);
    expect(said.limit?.resetsAt).toMatch(/:40:00\.000Z$/);
    expect(withLimit({ ok: true, sessionId: 's', text: "You've hit your stride, here is the plan", structured: { done: true } }).ok).toBe(true);
    expect(withLimit({ ok: true, sessionId: 's', text: "You've hit your target: the page loads in 1 second." }).ok).toBe(true);
  });
});

describe('the usage limit over ACP', () => {
  const ADAPTER = `
import readline from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return send({ id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === 'session/new') return send({ id: msg.id, result: { sessionId: 'limit-1' } });
  if (msg.method === 'session/prompt') {
    return send({ id: msg.id, error: { code: -32603, message: "Internal error: You've hit your session limit · resets 3:40pm (Europe/London)", data: { errorKind: 'rate_limit' } } });
  }
});
`;
  let script: string;
  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-acp-limit-'));
    script = path.join(dir, 'adapter.mjs');
    fs.writeFileSync(script, ADAPTER);
  });

  it('keeps the exact error, says it plainly, and the module turns it into a limit with its reset time', async () => {
    const launch: AcpLaunch = { command: process.execPath, args: [script], env: process.env, meta: {}, canResume: () => false, explain: (raw) => plainError(raw), toolName: () => undefined };
    const r = withLimit(await runAcp(launch, { cwd: os.tmpdir(), prompt: 'hello' }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^Claude's usage limit is reached\. It resets /);
    expect(r.detail).toContain("You've hit your session limit · resets 3:40pm (Europe/London)");
    expect(r.limit?.name).toBe('Claude');
    expect(new Date(r.limit!.resetsAt!).getUTCMinutes()).toBe(40);
  });
});

describe('the pause every project shares', () => {
  beforeEach(() => endPause());

  it('waits until just after the reset, and says when the squad carries on', () => {
    const p = startPause({ name: 'Claude', resetsAt: '2026-11-03T15:40:00.000Z' }, { project: 'roomflow', ticket: 'RO-7' }, NOW);
    expect(p.until).toBe('2026-11-03T15:40:30.000Z');
    expect(readPause()).toEqual(p);
    expect(activePause(NOW + 60_000)).toEqual(p);
    expect(activePause(Date.parse('2026-11-03T15:41:00Z'))).toBeNull();
    const text = limitText(p, NOW);
    expect(text).toBe(`Claude's usage limit is reached. The squad carries on ${resetWords(p.resetsAt!, NOW)} by itself`);
    expect(isLimitText(text)).toBe(true);
    expect(resetWords('2026-11-03T15:40:00.000Z', NOW)).toMatch(/^(at|tomorrow at) \d{1,2}:40 [AP]M$/);
  });

  it('without a reset time, looks again every 10 minutes', () => {
    const p = startPause({ name: 'Claude' }, {}, NOW);
    expect(Date.parse(p.until)).toBe(NOW + RETRY_MS);
    expect(limitText(p, NOW)).toBe("Claude's usage limit is reached. The squad carries on by itself when the limit resets");
    // The next look finds it again: one more wait, from then.
    const again = startPause({ name: 'Claude' }, {}, NOW + RETRY_MS + 1000);
    expect(Date.parse(again.until)).toBe(NOW + 2 * RETRY_MS + 1000);
  });

  it('keeps the later time when a second step hits the limit, and does not believe a reset weeks away', () => {
    const first = startPause({ name: 'Claude', resetsAt: '2026-11-03T15:40:00.000Z' }, {}, NOW);
    expect(startPause({ name: 'Claude' }, {}, NOW + 1000)).toEqual(first);
    const far = startPause({ name: 'Claude', resetsAt: '2027-02-01T00:00:00.000Z' }, {}, NOW + 2000);
    expect(far).toEqual(first);
  });

  it('ends at once on Try now', () => {
    startPause({ name: 'Claude' }, {}, Date.now());
    expect(activePause()).not.toBeNull();
    expect(endPause()).toBe(true);
    expect(activePause()).toBeNull();
    expect(endPause()).toBe(false);
  });
});
