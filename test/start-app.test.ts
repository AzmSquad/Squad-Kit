import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { freePort } from './support/tiny-app.js';
import { held, startApp } from '../src/engine/checks.js';

describe('startApp', () => {
  it('starts the app, waits until it answers, and stops the whole process group', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-app-'));
    fs.writeFileSync(path.join(dir, 'server.js'), "setTimeout(() => require('http').createServer((q, r) => r.end('ok')).listen(4799, '127.0.0.1'), 800);");
    const app = await startApp(dir, 'node server.js', 'http://localhost:4799', 20_000);
    expect(await fetch('http://127.0.0.1:4799').then((r) => r.text())).toBe('ok');
    app.stop();
    await new Promise((r) => setTimeout(r, 500));
    await expect(fetch('http://127.0.0.1:4799', { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it('says why when the app crashes while starting', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-app-'));
    await expect(startApp(dir, 'node -e "console.error(\'port in use\'); process.exit(1)"', 'http://localhost:4798', 10_000)).rejects.toThrow(/stopped while starting.*port in use/s);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 20_000);

  it('runs the ticket copy on a free port when your own app already uses the address', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-app-'));
    const yours = http.createServer((q, r) => r.end('yours')).listen(4797, '127.0.0.1');
    fs.writeFileSync(path.join(dir, 'server.js'), "require('http').createServer((q, r) => r.end('ticket')).listen(Number(process.env.PORT || 4797), '127.0.0.1');");
    const app = await startApp(dir, 'node server.js', 'http://localhost:4797', 20_000);
    expect(app.url).not.toBe('http://localhost:4797');
    expect(await fetch(app.url.replace('localhost', '127.0.0.1')).then((r) => r.text())).toBe('ticket');
    expect(await fetch('http://127.0.0.1:4797').then((r) => r.text())).toBe('yours');
    app.stop();
    yours.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it('says the address is taken when the app cannot move to a free port', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-app-'));
    const yours = http.createServer((q, r) => r.end('yours')).listen(4796, '127.0.0.1');
    fs.writeFileSync(path.join(dir, 'server.js'), "require('http').createServer((q, r) => r.end('ticket')).listen(4796, '127.0.0.1');");
    await expect(startApp(dir, 'node server.js', 'http://localhost:4796', 10_000)).rejects.toThrow(/localhost:4796 is used by another program \(maybe your own "npm run dev"\)/);
    yours.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 20_000);

  it('an app it just stopped is no other program: the next round waits for its port, and does not go around it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-app-'));
    const port = await freePort();
    // An app that cannot move to another port, and that takes a moment to go, as on a busy computer.
    fs.writeFileSync(path.join(dir, 'server.js'), `const s = require('http').createServer((q, r) => r.end('up')).listen(${port}, '127.0.0.1'); process.on('SIGTERM', () => setTimeout(() => { s.close(); process.exit(0); }, 700));`);
    const url = `http://127.0.0.1:${port}`;
    const first = await startApp(dir, 'node server.js', url, 20_000);
    first.stop();
    const second = await startApp(dir, 'node server.js', url, 20_000);
    expect(second.url).toBe(url);
    expect(await (await fetch(url)).text()).toBe('up');
    second.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('a moment when this process was busy does not make a port in use read as free', async () => {
    const silent = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => silent.once('listening', r));
    const asked = held((silent.address() as net.AddressInfo).port);
    // What a git call that waits does to the process, on a busy computer.
    const until = Date.now() + 1200;
    while (Date.now() < until);
    expect(await asked).toBe(true);
    silent.close();
  });
});
