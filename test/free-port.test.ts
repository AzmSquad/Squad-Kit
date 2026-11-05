import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';

/**
 * "Stop it and try again" on the Looks stuck card. A step that needs the app waits while a program holds the app's
 * port and the app never answers. squad-kit stops that program only when it started it itself (it knows its process
 * groups), after a confirm; a program of the person's own is never stopped. The card has plain words: the port and the
 * process are in its details, for engineers. Real processes and ports; no agent runs.
 */

const { boardPaths, readTicket, writeMeta, writeTicket } = await import('../src/board/store.js');
const { liveNow } = await import('../src/board/now.js');
const { freePortAndRetry, lookAtPort, portOf } = await import('../src/engine/free-port.js');
const { portTaken } = await import('../src/engine/run-app.js');
type Ticket = import('../src/board/types.js').Ticket;
type BoardPaths = import('../src/board/store.js').BoardPaths;

const hasLsof = (() => {
  try {
    execFileSync('lsof', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return process.platform !== 'win32' && fs.existsSync('/usr/sbin/lsof');
  }
})();

let tmp: string;
let bp: BoardPaths;
let port: number;
const started: number[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

/** A program that holds the port and never answers: it takes the connection and says nothing. */
const HOLD = (p: number) => `require('net').createServer(() => {}).listen(${p}, '127.0.0.1')`;

async function listening(): Promise<void> {
  for (let i = 0; i < 100 && !(await portTaken(port)); i++) await sleep(50);
  expect(await portTaken(port)).toBe(true);
}

/** Started by this squad-kit process, in its own process group, as squad-kit starts an app for the Tester. */
async function oursHolds(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', HOLD(port)], { detached: true, stdio: 'ignore' });
  started.push(child.pid!);
  await listening();
  return child;
}

/** The person's own program: started from a shell that has gone, so nothing ties it to squad-kit. */
async function theirsHolds(): Promise<number> {
  const out = execFileSync('/bin/sh', ['-c', `"${process.execPath}" -e "${HOLD(port)}" >/dev/null 2>&1 & echo $!`], { encoding: 'utf8' });
  const pid = Number(out.trim());
  started.push(pid);
  await listening();
  return pid;
}

/** A ticket whose Tester step looks stuck, waiting for the app. */
function stuckTester(): Ticket {
  const t: Ticket = {
    id: 'AP-1',
    title: 'Opening hours',
    ask: '',
    kind: 'feature',
    source: { type: 'manual' },
    priority: 'normal',
    stage: 'test',
    status: 'Tester is taking after screenshots',
    waiting: null,
    live: true,
    squad: { phase: 'proof', nextAt: new Date().toISOString() },
    createdAt: new Date().toISOString(),
    createdBy: 'Momen',
    owner: 'Momen',
    activity: [],
    clock: { who: 'tester', step: 'proof', since: new Date(Date.now() - 5 * 60_000).toISOString(), doing: 'Waiting for the app to open' },
    quiet: { since: new Date(Date.now() - 4 * 60_000).toISOString(), kind: 'stuck', detail: 'Claude Code has not answered for 4 minutes.' },
  };
  writeTicket(bp, t);
  return readTicket(bp, t.id)!;
}

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-free-port-')));
  port = await freePort();
  bp = boardPaths(path.join(tmp, '.squad'));
  writeMeta(bp, {
    project: 'App',
    key: 'AP',
    nextNumber: 2,
    engine: 'live',
    runner: 'direct',
    user: { name: 'Momen', role: 'Project manager' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
    commands: { test: 'true', start: 'npm run dev', url: `http://127.0.0.1:${port}` },
    scan: { status: 'done' },
  });
});

afterEach(async () => {
  for (const pid of started.splice(0)) {
    for (const p of [-pid, pid]) {
      try {
        process.kill(p, 'SIGKILL');
      } catch {
        // Gone already.
      }
    }
  }
  await sleep(50);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the app port on the Looks stuck card', () => {
  it('reads the port from the app address', () => {
    expect(portOf('http://localhost:3000/app')).toBe(3000);
    expect(portOf('https://example.test')).toBeNull();
    expect(portOf('not a url')).toBeNull();
  });

  it.skipIf(!hasLsof)('a program squad-kit started: the card offers to stop it, and it stops only that program', async () => {
    const child = await oursHolds();
    const t = stuckTester();
    const p = await lookAtPort(bp, t);
    expect(p).toMatchObject({ port, ours: true, pid: child.pid });

    // The card: what holds the port, and the way out.
    const card = liveNow({ ...t, quiet: { ...t.quiet!, port: p! } }, {}).slow!;
    expect(card.title).toBe('Looks stuck');
    expect(card.freePort).toEqual({ port, what: 'a program squad-kit started earlier' });
    expect(card.facts.find((f) => f.label === 'What is in the way')?.value).toBe('A program squad-kit started earlier is in the way, so the app does not answer.');
    // The port and the process are for engineers.
    expect(JSON.stringify(card.facts)).not.toMatch(new RegExp(`${port}|${child.pid}`));
    expect(card.detail).toMatch(new RegExp(`\\(process ${child.pid}\\) listens on port ${port}`));

    writeTicket(bp, { ...t, quiet: { ...t.quiet!, port: p! } });
    const exited = new Promise((r) => child.once('exit', r));
    const after = await freePortAndRetry(bp, t.id);
    await exited;
    expect(await portTaken(port)).toBe(false);
    // The step starts again, with the work so far.
    expect(after).toMatchObject({ stopRequested: true, retryOnStop: true });
    expect(after.quiet).toBeUndefined();
    expect(after.activity.map((a) => a.text)).toContain('Stopped a program squad-kit started earlier, which was in the way');
  });

  it.skipIf(!hasLsof)("a program of the person's own: the card says what to do in plain words, and squad-kit never stops it", async () => {
    const pid = await theirsHolds();
    const t = stuckTester();
    const p = await lookAtPort(bp, t);
    expect(p).toMatchObject({ port, ours: false, pid });
    const card = liveNow({ ...t, quiet: { ...t.quiet!, port: p! } }, {}).slow!;
    expect(card.freePort).toBeUndefined();
    expect(card.facts.find((f) => f.label === 'What is in the way')?.value).toBe('Another program on this computer is in the way, so the app does not answer. squad-kit leaves it alone. Close that program, then press Stop and try again.');
    expect(card.detail).toContain(`(process ${pid}) listens on port ${port}`);

    // Even when asked (an old card, or the terminal), it is checked again and left alone.
    writeTicket(bp, { ...t, quiet: { ...t.quiet!, port: { ...p!, ours: true } } });
    await expect(freePortAndRetry(bp, t.id)).rejects.toThrow('squad-kit did not start the program in the way, so it leaves it alone');
    expect(await portTaken(port)).toBe(true);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(readTicket(bp, t.id)!.stopRequested).toBeUndefined();
  });

  it.skipIf(!hasLsof)('says nothing about the port when the app answers there, or when the step does not need the app', async () => {
    const srv = net
      .createServer((s) => {
        s.on('error', () => undefined);
        s.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
      })
      .listen(port, '127.0.0.1');
    await listening();
    try {
      expect(await lookAtPort(bp, stuckTester())).toBeNull();
    } finally {
      srv.close();
    }
    await oursHolds();
    const builder = { ...stuckTester(), clock: { who: 'builder' as const, step: 'build' as const, since: new Date().toISOString() }, status: 'Builder is building' };
    expect(await lookAtPort(bp, builder)).toBeNull();
  });
});
