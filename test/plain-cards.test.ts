import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { STOP_IT, SKIP_BROWSER, LEAVE_IT, goAroundAnswer, ownWorkAnswer, portCard } from '../src/engine/port-ask.js';
import { startApp } from '../src/engine/checks.js';
import { portSettings } from '../src/engine/port-vars.js';
import { seedDemoBoard } from '../src/board/demo.js';
import { boardPaths, readTicket } from '../src/board/store.js';

/**
 * The person is a project manager: what they read names no command, port, process, file path or tool. Those are one
 * click away, for engineers. These are the last cards that showed them.
 */

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');
/** A component's source before its first "for engineers" part. */
const beforeDetails = (source: string) => source.split(/<details|<Modal/)[0]!;

describe('the card about a program in the way', () => {
  const asked = 'Can you stop the server on port 3100? I ran kill 17514';
  const cards = [
    portCard({ port: 3100, pid: 17514, program: 'node', asked }),
    portCard({ port: 3100, pid: 17514, program: 'node', app: 'shop', asked }),
    portCard({ port: 3100, pid: 0, asked }),
    portCard({ pid: 17514, asked }),
  ];

  it('never says a port or a process number', () => {
    for (const c of cards) {
      const words = `${c.text} ${c.why} ${c.options.join(' ')}`;
      expect(words).not.toMatch(/\d/);
      expect(words).not.toMatch(/\bport\b|\bprocess\b|\bPID\b/i);
    }
  });

  it('says it in the agreed words, and only offers to stop what squad-kit can stop', () => {
    expect(cards[0]).toMatchObject({ text: 'Another program on this computer is using what the browser tests need.', options: [STOP_IT, SKIP_BROWSER] });
    expect(cards[1]).toMatchObject({ text: 'Your app shop, which runs from Your apps, is using what the browser tests need.', options: [STOP_IT, SKIP_BROWSER] });
    expect(cards[2]).toMatchObject({ text: 'Another program on this computer is using what the browser tests need, and squad-kit cannot stop it.', options: [SKIP_BROWSER] });
    expect(cards[3]).toMatchObject({ text: "Another program on this computer is in the Builder's way.", options: [STOP_IT, LEAVE_IT] });
  });

  it('the panel keeps the port and the process under the details', () => {
    const top = beforeDetails(read('console-ui/src/components/PortAsk.tsx'));
    expect(top).not.toMatch(/p\.port\}|p\.pid\}|Port \$\{/);
    expect(read('console-ui/src/components/PortAsk.tsx')).toContain('Details for engineers');
  });

  it('tells the agent the way around it, with the port the person never reads', () => {
    const told = goAroundAnswer({ port: 3100, free: 3101, vars: ['ROOMFLOW_PORT'] });
    expect(told).toContain('holds port 3100. Leave it alone: do not stop it.');
    expect(told).toContain('Port 3101 is free right now: run your server there, with PORT=3101 and ROOMFLOW_PORT=3101');
    expect(goAroundAnswer({ port: 3100 })).toContain('Use another free port');
    expect(goAroundAnswer({})).toContain('Leave it alone: do not stop it. Work around it.');
    expect(ownWorkAnswer({ port: 3100, free: 3101 })).toContain("Port 3100 is used by squad-kit's own work right now");
  });
});

describe('a port held by another program', () => {
  let tmp = '';
  let server: net.Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = '';
  });

  it('a program that holds the port and says nothing: the copy of the app moves to a free port too', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-silent-port-'));
    const silent = net.createServer(() => undefined);
    server = silent;
    const port = await new Promise<number>((resolve) => silent.listen(0, '127.0.0.1', () => resolve((silent.address() as net.AddressInfo).port)));
    const app = await startApp(tmp, `node -e "require('http').createServer((q, r) => r.end('ok')).listen(process.env.PORT, '127.0.0.1')"`, `http://127.0.0.1:${port}`, 15_000);
    try {
      expect(app.url).not.toBe(`http://127.0.0.1:${port}`);
      expect(await fetch(app.url).then((r) => r.text())).toBe('ok');
    } finally {
      app.stop();
    }
  }, 30_000);

  it("reads whether an app can move: PORT, or a setting of its own", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-port-settings-'));
    expect(portSettings(tmp, 3000)).toEqual({ vars: [], reads: false });
    fs.writeFileSync(path.join(tmp, 'server.js'), 'app.listen(process.env.PORT || 3000);\n');
    expect(portSettings(tmp, 3000)).toEqual({ vars: [], reads: true });
    fs.writeFileSync(path.join(tmp, 'server.js'), 'app.listen(process.env.SHOP_PORT || 3000);\n');
    expect(portSettings(tmp, 3000)).toEqual({ vars: ['SHOP_PORT'], reads: true });
    // The port of another server does not move the app.
    fs.writeFileSync(path.join(tmp, 'server.js'), 'db.connect(process.env.DB_PORT || 5432);\n');
    expect(portSettings(tmp, 3000)).toEqual({ vars: [], reads: false });
  });
});

describe('what the person reads on the other cards', () => {
  it('Your apps: no port, process or command in the words, and See what failed has the rest', () => {
    const apps = read('console-ui/src/components/Apps.tsx');
    expect(apps).not.toMatch(/busy\.pid|busy\.program|busy\.port|Use port|\(process /);
    expect(apps).not.toMatch(/Setting it up first: |Starting: \$\{/);
    expect(apps).toContain('See what failed');
    expect(apps).toContain('{a.detail}');
  });

  it('the test command card: one sentence, and the commands only under the details', () => {
    const card = read('console-ui/src/components/TestCommand.tsx');
    expect(beforeDetails(card)).not.toMatch(/\{c\.from\}|\{c\.to\}/);
    expect(card).toContain('Details for engineers');
  });

  it('the Looks stuck card: its way out and its toast name no port', () => {
    const now = read('console-ui/src/components/LiveNow.tsx');
    expect(now).not.toMatch(/Freed port|Free port|Free the port|freePort\.port|freePort\?\.port/);
    expect(now).toContain('Details for engineers');
  });

  it("your own copy's setup: the command only under See what failed, and in the Developer tab", () => {
    const drawer = read('console-ui/src/pages/TicketDrawer.tsx');
    const line = drawer.slice(drawer.indexOf('function LocalSetupLine'), drawer.indexOf('function WorkingPanel'));
    expect(line.indexOf('{ls.command}')).toBeGreaterThan(line.indexOf('See what failed'));
    const dev = drawer.slice(drawer.indexOf('function DeveloperTab'));
    expect(dev).toContain('{t.localSetup.command}');
    expect(dev).toContain('How the tests run');
  });

  it('a step says where it is, not which tool runs it', () => {
    expect(read('src/engine/live.ts')).not.toMatch(/\.status = .*toolLabel/);
  });

  it('the sample board shows the same words', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-plain-demo-'));
    try {
      const bp = boardPaths(path.join(tmp, '.squad'));
      seedDemoBoard(bp, { speed: 50 });
      const t = readTicket(bp, 'SK-150')!;
      expect(t.stuck!.question).not.toMatch(/\.ts\b/);
      expect(t.stuck!.detail).toContain('autosave.spec.ts');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
