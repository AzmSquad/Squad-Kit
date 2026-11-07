import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { copyEnvFiles } from '../src/engine/run-app.js';

let tmp = '';
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const write = (root: string, f: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
  fs.writeFileSync(path.join(root, f), text);
};

describe("your app gets your .env files", () => {
  it('copies the .env files git does not carry, at the same places, readable by you only', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-appenv-'));
    const src = path.join(tmp, 'project');
    const dir = path.join(tmp, 'copy');
    fs.mkdirSync(src);
    const sh = (c: string) => execSync(c, { cwd: src, stdio: 'pipe' });
    sh('git init -q && git config user.email t@t && git config user.name T');
    write(src, '.gitignore', '.env\n.env.local\nnode_modules/\n');
    write(src, '.env.example', 'KEY=\n');
    sh('git add -A && git commit -qm init');
    write(src, '.env', 'KEY=secret\n');
    write(src, 'apps/web/.env.local', 'WEB=1\n');
    write(src, '.env.test', 'T=1\n');
    write(src, 'node_modules/pkg/.env', 'NOT=ours\n');
    write(src, '.env.sample', 'S=\n');
    fs.mkdirSync(dir);

    expect(await copyEnvFiles(src, dir)).toEqual(['.env', '.env.test', 'apps/web/.env.local']);
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe('KEY=secret\n');
    expect(fs.readFileSync(path.join(dir, 'apps/web/.env.local'), 'utf8')).toBe('WEB=1\n');
    expect(fs.existsSync(path.join(dir, 'node_modules/pkg/.env'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.env.sample'))).toBe(false);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, '.env')).mode & 0o777).toBe(0o600);
  });
});
