import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApp } from '../src/engine/checks.js';

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
});
