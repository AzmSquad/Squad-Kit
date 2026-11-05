import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execSync } from 'node:child_process';
import { Hono } from 'hono';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import { freePort } from './support/tiny-app.js';

/**
 * Your check at review: Ask a question is a questions-only chat that leaves the ticket waiting for Looks right, and
 * its agent is told where to look; Try it yourself runs the ticket's own copy of the app, one per project, and stops
 * when the ticket moves on. The AI tool is a fake; the app is a real little server.
 */

const calls: RunOptions[] = [];
const answers: unknown[] = [];
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    return { ok: true, structured: answers.shift() ?? { reply: 'ok', ready: false }, text: '', sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

const { boardPaths, readMeta, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { waitsAtReview, proofPages } = await import('../src/board/at-review.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { TryRunner, tryRunner, stopTries, stopTry } = await import('../src/engine/try-app.js');
const { mountTryApi } = await import('../src/console/api/try.js');
const { mountBoardApi } = await import('../src/console/api/board.js');
const { buildPaths } = await import('../src/core/paths.js');
const { tryWith } = await import('../src/commands/try.js');

type TryStatus = import('../src/engine/try-app.js').TryStatus;
type Squad = { chatReply(id: string): Promise<void> };

let tmp: string;
let bp: ReturnType<typeof boardPaths>;
let port: number;
const runners: InstanceType<typeof TryRunner>[] = [];

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function answersAt(url: string): Promise<string | null> {
  for (const u of [url, url.replace('://localhost', '://127.0.0.1')]) {
    const text = await fetch(u, { signal: AbortSignal.timeout(1000) }).then((r) => r.text(), () => null);
    if (text !== null) return text;
  }
  return null;
}

/** A ticket's own copy of the code: a git repo whose app says which copy it is, and one new page since its base. */
function ticketCopy(name: string): { dir: string; base: string } {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'server.js'),
    `require('http').createServer((q, r) => r.end('${name} ' + q.url)).listen(Number(process.env.PORT || require('./port.json')), '127.0.0.1');\n`,
  );
  fs.writeFileSync(path.join(dir, 'port.json'), String(port));
  sh('git init -q -b main && git add -A && git commit -qm start', dir);
  const base = sh('git rev-parse HEAD', dir);
  fs.mkdirSync(path.join(dir, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'pages', 'cases.tsx'), 'export const route = "/cases";\n');
  return { dir, base };
}

function runner(): InstanceType<typeof TryRunner> {
  const r = new TryRunner(bp, { waitMs: 15_000, watchMs: 60_000 });
  runners.push(r);
  return r;
}

beforeEach(async () => {
  calls.length = 0;
  answers.length = 0;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-your-check-')));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  port = await freePort();
  writeMeta(bp, { ...readMeta(bp), commands: { start: 'node server.js', url: `http://localhost:${port}` } });
});

afterEach(async () => {
  for (const r of runners.splice(0)) r.stopAll();
  stopTries(bp);
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Ask a question while the ticket waits for your check', () => {
  it('is a questions-only chat: the proof keeps waiting for Looks right, Done leaves it where it was', async () => {
    writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct' });
    const copy = ticketCopy('sk139');
    updateTicket(bp, 'SK-139', (x) => {
      x.worktree = copy.dir;
      x.baseCommit = copy.base;
      x.sessions = { build: 'b-1', tester: 't-1' };
    });
    const before = readTicket(bp, 'SK-139')!;
    expect(waitsAtReview(before)).toBe(true);
    expect(proofPages(before)).toEqual(['/cases', '/cases?q=1446', '/hearings?q=1446']);

    let t = actions.startChat(bp, 'SK-139', 'tester');
    expect(t.chat).toMatchObject({ with: 'tester', open: true, beside: true });
    expect(t.waiting).toEqual(before.waiting);
    expect(t.stage).toBe('review');
    expect(t.live).toBeFalsy();
    expect(t.squad ?? null).toBeNull();
    expect(t.activity[0]!.text).toContain('Questions only: it still waits for your check');

    // The Tester answers in a side conversation in the ticket's copy, never its own session, read only.
    const squad = new LiveSquad(bp) as unknown as Squad;
    answers.push({ reply: 'Open http://localhost/cases and type a case number.', ready: true });
    await squad.chatReply('SK-139');
    const call = calls.at(-1)!;
    expect(call.resume).toBeUndefined();
    expect(call.sessionId).not.toBe('t-1');
    expect(call.cwd).toBe(copy.dir);
    expect(call.prompt).toContain('waits for the person to check it');
    expect(call.prompt).toContain("This ticket's own copy of the app is NOT running now");
    expect(call.prompt).toContain('press **Try it yourself**, then open the page');
    expect(call.prompt).not.toContain(`http://localhost:${port}`);
    expect(call.prompt).toContain('"Typing a full case number opens the case": page /cases');
    expect(call.prompt).toContain('src/pages/cases.tsx');
    expect(call.prompt).toContain('press "Something\'s wrong"');
    expect(call.prompt).toContain('"Try it yourself"');
    expect(call.prompt).not.toContain('The squad is working on this ticket right now');
    t = readTicket(bp, 'SK-139')!;
    expect(t.chat!.ready).toBe(false);

    // Asking changes nothing: no spec or design from this talk, and Done leaves the proof waiting.
    actions.sendChat(bp, 'SK-139', 'Which page do I open?');
    answers.push({ reply: 'The case list, /cases.', ready: false });
    await squad.chatReply('SK-139');
    expect(calls.at(-1)!.resume).toBe(readTicket(bp, 'SK-139')!.chat!.side);
    expect(() => actions.chatWrite(bp, 'SK-139')).toThrow(/waits for your check.*Something's wrong/);
    t = actions.chatDone(bp, 'SK-139');
    expect(t.chat!.open).toBe(false);
    expect(t.waiting).toEqual(before.waiting);
    expect(t.stage).toBe('review');
    expect(t.live).toBeFalsy();
    expect(t.squad ?? null).toBeNull();
    expect(t.gates).toEqual(before.gates);
  });

  it('while the person tries the copy, the agent gives addresses there; with no page saved it reads the code', async () => {
    const P = await import('../src/engine/prompts.js');
    const t = readTicket(bp, 'SK-139')!;
    const trying = P.whereToLook(t, { tryUrl: 'http://localhost:5174', changed: ['src/app/cases/page.tsx'] });
    expect(trying).toContain("This ticket's own copy of the app is running now, at http://localhost:5174");
    expect(trying).toContain('like http://localhost:5174/cases');
    const none = P.whereToLook({ ...t, proof: [] }, { canTry: true, changed: [] });
    expect(none).toContain('No screenshots were taken, so no page is saved: find the pages in the code.');
    expect(none).toContain('is NOT running now');
  });

  it('the chat says plainly whether the copy runs now, with its real address, or not: both states, fresh on every answer', async () => {
    const { reviewLook } = await import('../src/engine/review-look.js');
    const P = await import('../src/engine/prompts.js');
    writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct' });
    const copy = ticketCopy('sk139');
    updateTicket(bp, 'SK-139', (x) => {
      x.worktree = copy.dir;
      x.baseCommit = copy.base;
      x.sessions = { build: 'b-1', tester: 't-1' };
    });

    // Nothing runs: no address at all, though the settings have one, and Try it yourself is what the person presses.
    const off = reviewLook(bp, readTicket(bp, 'SK-139')!);
    expect(off).toMatchObject({ canTry: true, accepted: false });
    expect(off).not.toHaveProperty('tryUrl');
    const notRunning = P.whereToLook(readTicket(bp, 'SK-139')!, off);
    expect(notRunning).toContain("This ticket's own copy of the app is NOT running now, so no address works.");
    expect(notRunning).toContain('Never say the app is running, and never give a local address');
    expect(notRunning).toContain('press **Try it yourself**, then open the page');
    expect(notRunning).not.toContain(`localhost:${port}`);

    actions.startChat(bp, 'SK-139', 'tester');
    const squad = new LiveSquad(bp) as unknown as Squad;
    await squad.chatReply('SK-139');
    expect(calls.at(-1)!.prompt).toContain('press **Try it yourself**');
    expect(calls.at(-1)!.prompt).not.toContain(`localhost:${port}`);

    // The person presses Try it yourself while the chat is open: the next answer hears the real address.
    const r = tryRunner(bp);
    r.start('SK-139');
    const s = await r.settled('SK-139');
    expect(s.state).toBe('running');
    const on = reviewLook(bp, readTicket(bp, 'SK-139')!);
    expect(on.tryUrl).toBe(s.url);
    const running = P.whereToLook(readTicket(bp, 'SK-139')!, on);
    expect(running).toContain(`This ticket's own copy of the app is running now, at ${s.url}. That is the one address that works`);
    expect(running).toContain(`like ${s.url}/cases`);
    expect(running).not.toContain('NOT running');
    actions.sendChat(bp, 'SK-139', 'Which page do I open?');
    await squad.chatReply('SK-139');
    expect(calls.at(-1)!.resume).toBeTruthy();
    expect(calls.at(-1)!.prompt).toContain(`is running now, at ${s.url}`);

    await r.stop('SK-139');
    expect(reviewLook(bp, readTicket(bp, 'SK-139')!)).not.toHaveProperty('tryUrl');
  }, 60_000);

  it('an accepted ticket points to Your apps, never to an address', async () => {
    const P = await import('../src/engine/prompts.js');
    const said = P.copyNow({ accepted: true, changed: [] });
    expect(said).toContain('press Start under Your apps in the sidebar');
    expect(said).not.toContain('Try it yourself');
  });

  it('a ticket stopped at a gate stays stopped while you ask, with its ways out', async () => {
    const before = readTicket(bp, 'SK-150')!;
    expect(before.stuck?.gate).toBe('checks');
    expect(waitsAtReview(before)).toBe(true);
    let t = actions.startChat(bp, 'SK-150', 'builder');
    expect(t.chat!.beside).toBe(true);
    expect(t.waiting).toEqual(before.waiting);
    updateTicket(bp, 'SK-150', (x) => (x.chat!.thinking = false));
    expect(() => actions.chatWrite(bp, 'SK-150')).toThrow(/pick one of the ways out/);
    t = actions.chatDone(bp, 'SK-150');
    expect(t.waiting).toEqual(before.waiting);
    expect(t.stuck).toEqual(before.stuck);
    expect(t.squad ?? null).toBeNull();
  });
});

describe('Try it yourself: the ticket’s own copy of the app', () => {
  it('starts, runs with its pages, and stops; another ticket’s copy stops the first', async () => {
    const a = ticketCopy('sk139');
    const b = ticketCopy('sk142');
    updateTicket(bp, 'SK-139', (x) => (x.worktree = a.dir));
    updateTicket(bp, 'SK-142', (x) => (x.worktree = b.dir));
    const r = runner();

    expect(r.status('SK-139')).toMatchObject({ ticket: 'SK-139', state: 'off', can: true });
    expect(r.start('SK-139').state).toBe('starting');
    let s = await r.settled('SK-139');
    expect(s).toMatchObject({ state: 'running', url: `http://localhost:${port}`, can: true });
    expect(s.pages).toEqual(['/cases', '/cases?q=1446', '/hearings?q=1446'].map((page) => ({ page, url: `http://localhost:${port}${page}` })));
    expect(await answersAt(`http://localhost:${port}/cases`)).toBe('sk139 /cases');
    expect(readTicket(bp, 'SK-139')!.activity[0]!.text).toBe("Started this story's own copy of the app for you to try. Nothing is merged.");
    // Pressing it again while it runs changes nothing.
    expect(r.start('SK-139').state).toBe('running');

    // One copy at a time: SK-142's starts once SK-139's is gone, on the same address.
    expect(r.status('SK-142')).toMatchObject({ state: 'off', other: 'SK-139' });
    r.start('SK-142');
    s = await r.settled('SK-142');
    expect(s.state).toBe('running');
    expect(r.status('SK-139')).toMatchObject({ state: 'off', other: 'SK-142' });
    expect(await answersAt(`http://localhost:${port}/`)).toBe('sk142 /');
    expect(readTicket(bp, 'SK-139')!.activity[0]!.text).toContain("you started SK-142's");

    s = (await r.stop('SK-142'))!;
    expect(s.state).toBe('off');
    expect(await answersAt(`http://localhost:${port}/`)).toBeNull();
  }, 60_000);

  it('stops by itself on Looks right and on Something’s wrong', async () => {
    const a = ticketCopy('sk139');
    const b = ticketCopy('sk142');
    updateTicket(bp, 'SK-139', (x) => (x.worktree = a.dir));
    updateTicket(bp, 'SK-142', (x) => (x.worktree = b.dir));
    const r = runner();

    r.start('SK-139');
    expect((await r.settled('SK-139')).state).toBe('running');
    await r.look();
    expect(r.status('SK-139').state).toBe('running');
    actions.approve(bp, 'SK-139');
    await r.look();
    expect(r.status('SK-139').state).toBe('off');
    expect(await answersAt(`http://localhost:${port}/`)).toBeNull();
    expect(readTicket(bp, 'SK-139')!.activity[0]!.text).toContain('the ticket is accepted');

    r.start('SK-142');
    expect((await r.settled('SK-142')).state).toBe('running');
    actions.requestChange(bp, 'SK-142', 'The highlight is too pale');
    await r.look();
    expect(r.status('SK-142').state).toBe('off');
    expect(await answersAt(`http://localhost:${port}/`)).toBeNull();
    expect(readTicket(bp, 'SK-142')!.activity[0]!.text).toContain('the ticket moved on');
  }, 60_000);

  it('says plainly when it cannot start, with what it printed for engineers, and Try again works', async () => {
    const a = ticketCopy('sk139');
    updateTicket(bp, 'SK-139', (x) => (x.worktree = a.dir));
    const meta = readMeta(bp);
    writeMeta(bp, { ...meta, commands: { ...meta.commands, start: 'node -e "console.error(\'Cannot find module express\'); process.exit(3)"' } });
    const r = runner();
    r.start('SK-139');
    const s = await r.settled('SK-139');
    expect(s).toMatchObject({ state: 'failed', error: 'The app did not start.', can: true });
    expect(s.detail).toContain('Cannot find module express');
    expect(readTicket(bp, 'SK-139')!.activity[0]!.text).toBe('Try it yourself: the app did not start.');

    writeMeta(bp, { ...meta, commands: { ...meta.commands, start: 'node server.js' } });
    r.start('SK-139');
    expect((await r.settled('SK-139')).state).toBe('running');
  }, 60_000);

  it('only while the ticket waits for your check, from a copy of the code on this computer', () => {
    const r = runner();
    expect(r.status('SK-142')).toMatchObject({ state: 'off', can: false, why: 'SK-142 has no copy of the code on this computer to run.' });
    expect(() => r.start('SK-142')).toThrow('SK-142 has no copy of the code on this computer to run.');
    expect(() => r.start('SK-153')).toThrow('SK-153 does not wait for your check now, so there is nothing to try.');
    const meta = readMeta(bp);
    writeMeta(bp, { ...meta, commands: {} });
    updateTicket(bp, 'SK-139', (x) => (x.worktree = tmp));
    expect(r.status('SK-139').why).toMatch(/does not know how to start the app yet/);
  });

  it('stops before Delete removes its copy, and when the board closes', async () => {
    const a = ticketCopy('sk139');
    updateTicket(bp, 'SK-139', (x) => (x.worktree = a.dir));
    const r = tryRunner(bp);
    r.start('SK-139');
    expect((await r.settled('SK-139')).state).toBe('running');
    await stopTry(bp, 'SK-139');
    expect(r.status('SK-139').state).toBe('off');
    expect(await answersAt(`http://localhost:${port}/`)).toBeNull();

    r.start('SK-139');
    expect((await r.settled('SK-139')).state).toBe('running');
    stopTries(bp);
    await new Promise((done) => setTimeout(done, 1500));
    expect(await answersAt(`http://localhost:${port}/`)).toBeNull();
  }, 60_000);
});

describe('Try it yourself is one call each, and so is Looks right', () => {
  it('starts, reads and stops over REST; Looks right through the API stops the copy at once', async () => {
    const a = ticketCopy('sk139');
    updateTicket(bp, 'SK-139', (x) => (x.worktree = a.dir));
    const app = new Hono();
    const paths = buildPaths(tmp);
    mountTryApi(app, { paths });
    mountBoardApi(app, { paths });
    const call = async (method: 'GET' | 'POST', url: string) => {
      const res = await app.request(url, { method, headers: { 'content-type': 'application/json' } });
      return { status: res.status, body: (await res.json()) as TryStatus & { error?: string } };
    };

    expect((await call('GET', '/api/v1/tickets/SK-139/try')).body).toMatchObject({ state: 'off', can: true });
    expect((await call('POST', '/api/v1/tickets/SK-139/try')).body.state).toBe('starting');
    await tryRunner(bp).settled('SK-139');
    expect((await call('GET', '/api/v1/tickets/SK-139/try')).body).toMatchObject({ state: 'running', url: `http://localhost:${port}` });
    expect((await call('POST', '/api/v1/tickets/SK-139/try/stop')).body.state).toBe('off');
    expect((await call('POST', '/api/v1/tickets/SK-142/try')).body.error).toBe('SK-142 has no copy of the code on this computer to run.');

    await call('POST', '/api/v1/tickets/SK-139/try');
    await tryRunner(bp).settled('SK-139');
    expect((await call('POST', '/api/v1/tickets/SK-139/approve')).status).toBe(200);
    const until = Date.now() + 10_000;
    while (Date.now() < until && (await call('GET', '/api/v1/tickets/SK-139/try')).body.state !== 'off') await new Promise((r) => setTimeout(r, 100));
    expect((await call('GET', '/api/v1/tickets/SK-139/try')).body.state).toBe('off');
  }, 60_000);
});

describe('squad try in the terminal', () => {
  let printed = '';
  beforeEach(() => {
    printed = '';
    const keep = (chunk: string | Uint8Array) => {
      printed += String(chunk).replace(/\x1b\[[0-9;]*m/g, '');
      return true;
    };
    vi.spyOn(process.stdout, 'write').mockImplementation(keep);
    vi.spyOn(process.stderr, 'write').mockImplementation(keep);
  });

  it('with the board open, each command is its REST call: start follows it until it runs, --stop and --status', async () => {
    const sent: string[] = [];
    const running: TryStatus = { ticket: 'SK-139', state: 'running', url: 'http://localhost:5174', pages: [{ page: '/cases', url: 'http://localhost:5174/cases' }], can: true };
    let reads = 0;
    const api = {
      async call<T>(method: string, at: string): Promise<T> {
        sent.push(`${method} ${at}`);
        if (method === 'GET') return (reads++ < 1 ? { ticket: 'SK-139', state: 'starting', can: true } : running) as T;
        if (at.endsWith('/stop')) return { ticket: 'SK-139', state: 'off', can: true } as T;
        return { ticket: 'SK-139', state: 'starting', can: true } as T;
      },
    };
    expect(await tryWith(bp, api, 'sk-139')).toBe(true);
    expect(sent).toEqual(['POST /tickets/SK-139/try', 'GET /tickets/SK-139/try', 'GET /tickets/SK-139/try']);
    expect(printed).toContain("SK-139's own copy of the app runs at http://localhost:5174. Nothing is merged.");
    expect(printed).toContain('http://localhost:5174/cases');
    expect(printed).toContain('squad try SK-139 --stop');

    sent.length = 0;
    expect(await tryWith(bp, api, 'SK-139', { stop: true })).toBe(true);
    expect(sent).toEqual(['POST /tickets/SK-139/try/stop']);
    expect(await tryWith(bp, api, 'SK-139', { status: true })).toBe(true);
    expect(sent.at(-1)).toBe('GET /tickets/SK-139/try');
  });

  it('without the board, the copy runs here until you stop it', async () => {
    const a = ticketCopy('sk139');
    updateTicket(bp, 'SK-139', (x) => (x.worktree = a.dir));
    const r = runner();
    let stop!: () => void;
    const stopAsked = new Promise<void>((done) => (stop = done));
    const run = tryWith(bp, null, 'SK-139', {}, { runner: r, stopAsked });
    const until = Date.now() + 15_000;
    while (Date.now() < until && r.status('SK-139').state !== 'running') await new Promise((done) => setTimeout(done, 100));
    expect(await answersAt(`http://localhost:${port}/`)).toBe('sk139 /');
    stop();
    expect(await run).toBe(true);
    expect(r.status('SK-139').state).toBe('off');
    expect(printed).toContain('Press Ctrl-C to stop it.');
    expect(printed).toContain("Stopped SK-139's copy of the app.");

    printed = '';
    expect(await tryWith(bp, null, 'SK-139', { stop: true })).toBe(true);
    expect(printed).toContain('squad-kit is not open');
  }, 60_000);
});
