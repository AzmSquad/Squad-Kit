import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { boardPaths, readMeta, writeMeta, type BoardPaths } from '../src/board/store.js';
import { seedDemoBoard } from '../src/board/demo.js';
import { storyFile } from '../src/board/project-files.js';
import { logFile } from '../src/core/app-log.js';
import { runCommand, startApp } from '../src/engine/checks.js';
import { forgetWiring, wireCopy, wireCopyRedis } from '../src/engine/db-env.js';
import { placeStoryFiles } from '../src/engine/local-files.js';
import { partEnv } from '../src/engine/part-env.js';
import { confirmDatabase, setUpStoryDb } from '../src/engine/story-db.js';
import { addWorktree } from './support/copy.js';
import { freePort } from './support/tiny-app.js';

/**
 * What a part's env file gives the commands squad-kit runs in a copy: the story's values from the file in that copy,
 * then squad-kit's own on top (a Docker service's address through its port here, the story's own database and Redis
 * number, the port it picked). A made-up shop API whose daily stack runs in Docker Compose; nothing here runs Docker or a
 * database. Values never reach the log.
 */

const COMPOSE = `services:
  api:
    build: .
    container_name: shop-api
    env_file: .env.dev
    ports: ["8080:80"]
  app.db:
    image: mongo:7
    container_name: shop-mongo
    ports: ["27018:27017"]
  orders-db:
    image: postgres:16
    ports: ["5433:5432"]
  cache:
    image: redis:7
    ports: ["6380:6379"]
`;

/** The person's own values, and the ones kept for stories. */
const values = (who: 'REAL' | 'TEST') =>
  [
    `ConnectionStrings__Shop=mongodb://shop:${who}-SECRET-4471@app.db:27017/shop?authSource=admin`,
    `Shop__Mode="${who}-MODE"`,
    'ConnectionStrings__Orders=postgres://shop:pw@orders-db:5432/orders',
    'Redis__ConnectionString=cache:6379,abortConnect=false',
    'Remote__Mongo=mongodb://203.0.113.7:27017/shop',
    'PORT=80',
    '',
  ].join('\n');

let root: string;
let bp: BoardPaths;
const sh = (cmd: string, cwd = root) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (file: string, text: string, dir = root) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};
const local = { repo: '.', path: '.env.dev' };

/** What a command run in the folder sees, by name: null for one it does not have. */
async function seen(dir: string, names: string[], env?: Record<string, string>): Promise<Record<string, string | null>> {
  const r = await runCommand(dir, `node show-env.js ${names.join(' ')}`, 20_000, env ? { env } : {});
  expect(r.ok, r.output).toBe(true);
  return JSON.parse(r.output.trim().split('\n').at(-1)!) as Record<string, string | null>;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-partenv-')));
  sh('git init -q -b main');
  write('.gitignore', '.env.dev\n.squad/\n');
  write('docker-compose.yml', COMPOSE);
  write('appsettings.json', '{ "ConnectionStrings": { "Shop": "mongodb://admin:pw@203.0.113.7:27017/shop" } }\n');
  write('show-env.js', 'const names = process.argv.slice(2);\nconsole.log(JSON.stringify(Object.fromEntries(names.map((n) => [n, process.env[n] ?? null]))));\n');
  write('server.js', "require('http').createServer((q, r) => r.end(JSON.stringify({ mode: process.env.Shop__Mode ?? null, port: process.env.PORT ?? null }))).listen(Number(process.env.PORT), '127.0.0.1');\n");
  sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm start');
  write('.env.dev', values('REAL'));
  bp = boardPaths(path.join(root, '.squad'));
  seedDemoBoard(bp, { project: 'Shop', speed: 0.001 });
  writeMeta(bp, { ...readMeta(bp), commands: { test: 'dotnet test', envFile: '.env.dev' }, localFiles: [local] });
  write(storyFile(bp, local), values('TEST'), '/');
  forgetWiring();
});

afterEach(() => {
  forgetWiring();
  delete process.env.Shop__Mode;
  fs.rmSync(root, { recursive: true, force: true });
});

/** A story's copy with its local files placed, as squad-kit sets one up. */
function storyCopy(id = 'SH-1'): string {
  const dir = addWorktree(root, id, 'main').dir;
  placeStoryFiles(bp, '.', dir);
  return dir;
}

describe("the commands squad-kit runs in a story's copy", () => {
  it("get the story's values from the copy's env file, never the person's own file or environment", async () => {
    const copy = storyCopy();
    process.env.Shop__Mode = 'SHELL-MODE';
    const got = await seen(copy, ['Shop__Mode', 'ConnectionStrings__Shop']);
    expect(got.Shop__Mode).toBe('TEST-MODE');
    expect(got.ConnectionStrings__Shop).toContain('TEST-SECRET-4471');
    expect(JSON.stringify(got)).not.toContain('REAL');
  });

  it('get the env file first, then the service swap, the story database, its Redis number and the port on top', async () => {
    const copy = storyCopy();
    const names = ['Shop__Mode', 'ConnectionStrings__Shop', 'ConnectionStrings__Orders', 'Redis__ConnectionString', 'Remote__Mongo', 'PORT'];
    // The env file alone, with each Docker service reached through the port it publishes here.
    expect(await seen(copy, names)).toEqual({
      Shop__Mode: 'TEST-MODE',
      ConnectionStrings__Shop: 'mongodb://shop:TEST-SECRET-4471@localhost:27018/shop?authSource=admin',
      ConnectionStrings__Orders: 'postgres://shop:pw@localhost:5433/orders',
      Redis__ConnectionString: 'localhost:6380,abortConnect=false',
      Remote__Mongo: 'mongodb://203.0.113.7:27017/shop',
      PORT: '80',
    });
    // squad-kit's own on top: the story's database, its Redis number, and the port it picked.
    wireCopy(copy, { env: { ConnectionStrings__Shop: 'mongodb://shop:TEST-SECRET-4471@localhost:27018/shop_sh_1?authSource=admin' }, value: 'unused' });
    wireCopyRedis(copy, { env: { Redis__ConnectionString: 'localhost:6380,abortConnect=false,defaultDatabase=4' }, files: [] });
    expect(await seen(copy, names, { PORT: '5181' })).toEqual({
      Shop__Mode: 'TEST-MODE',
      ConnectionStrings__Shop: 'mongodb://shop:TEST-SECRET-4471@localhost:27018/shop_sh_1?authSource=admin',
      ConnectionStrings__Orders: 'postgres://shop:pw@localhost:5433/orders',
      Redis__ConnectionString: 'localhost:6380,abortConnect=false,defaultDatabase=4',
      Remote__Mongo: 'mongodb://203.0.113.7:27017/shop',
      PORT: '5181',
    });
  });

  it('the app squad-kit starts gets the port it picked over the one in the env file', async () => {
    const copy = storyCopy();
    // Its address is taken: squad-kit moves it to a free port.
    const busy = await freePort();
    const holder = net.createServer().listen(busy, '127.0.0.1');
    try {
      const moved = await startApp(copy, 'node server.js', `http://127.0.0.1:${busy}`, 20_000);
      try {
        const port = new URL(moved.url).port;
        expect(port).not.toBe(String(busy));
        expect(JSON.parse(await (await fetch(moved.url)).text())).toEqual({ mode: 'TEST-MODE', port });
      } finally {
        moved.stop();
      }
    } finally {
      holder.close();
    }
    // A start that reads PORT gets its own address's, not the container's 80.
    const own = await freePort();
    const app = await startApp(copy, `PORT=\${PORT:-${own}} node server.js`, `http://127.0.0.1:${own}`, 20_000);
    try {
      expect(JSON.parse(await (await fetch(app.url)).text())).toEqual({ mode: 'TEST-MODE', port: String(own) });
    } finally {
      app.stop();
    }
  }, 60_000);

  it("leave the person's own folder alone, and a command that runs in Compose reads its own env files", async () => {
    const copy = storyCopy();
    expect(await seen(root, ['Shop__Mode'])).toEqual({ Shop__Mode: null });
    expect(partEnv('docker compose up --build', copy)).toEqual({});
    expect(partEnv('docker-compose -f docker-compose.yml up', copy)).toEqual({});
    expect(partEnv('dotnet test', copy)).toMatchObject({ Shop__Mode: 'TEST-MODE' });
  });

  it('a copy with no values for the file runs without it, and says so in the log', async () => {
    writeMeta(bp, { ...readMeta(bp), localFiles: [] });
    const copy = addWorktree(root, 'SH-3', 'main').dir;
    expect(await seen(copy, ['Shop__Mode'])).toEqual({ Shop__Mode: null });
    expect(fs.readFileSync(logFile(), 'utf8')).toContain(`${path.basename(copy)} has no .env.dev, so its commands run without that env file.`);
  });

  it("fill in $NAME as Compose does: from the environment they start with, then the file's own lines, never squad-kit's own keys", async () => {
    write(storyFile(bp, local), ['MONGO_USER=shop', 'MONGO_PASSWORD=TEST-SECRET-4471', 'MONGO_HOST=app.db', 'MONGO_PORT=27017', 'ConnectionStrings__Shop=mongodb://${MONGO_USER}:${MONGO_PASSWORD}@${MONGO_HOST}:${MONGO_PORT}/shop?authMechanism=SCRAM-SHA-256', 'Shop__Region=${SHOP_REGION}', 'Shop__Key=${SQUAD_TEST_TOKEN}', "Shop__Note='${MONGO_HOST}'", ''].join('\n'), '/');
    process.env.SHOP_REGION = 'eu-north';
    process.env.SQUAD_TEST_TOKEN = 'SQUAD-OWN-9931';
    try {
      const copy = storyCopy('SH-6');
      expect(await seen(copy, ['ConnectionStrings__Shop', 'Shop__Region', 'Shop__Key', 'Shop__Note'])).toEqual({
        ConnectionStrings__Shop: 'mongodb://shop:TEST-SECRET-4471@localhost:27018/shop?authMechanism=SCRAM-SHA-256',
        Shop__Region: 'eu-north',
        Shop__Key: '',
        Shop__Note: '${MONGO_HOST}',
      });
      expect(fs.readFileSync(logFile(), 'utf8')).not.toContain('SQUAD-OWN-9931');
    } finally {
      delete process.env.SHOP_REGION;
      delete process.env.SQUAD_TEST_TOKEN;
    }
  });

  it('never writes a value in the log: the names only', async () => {
    const copy = storyCopy('SH-4');
    await seen(copy, ['Shop__Mode']);
    const port = await freePort();
    const app = await startApp(copy, `PORT=\${PORT:-${port}} node server.js`, `http://127.0.0.1:${port}`, 20_000);
    app.stop();
    const log = fs.readFileSync(logFile(), 'utf8');
    expect(log).toContain(`squad-kit gives the commands it runs in ${path.basename(copy)} the settings in .env.dev: ConnectionStrings__Shop, Shop__Mode, ConnectionStrings__Orders, Redis__ConnectionString, Remote__Mongo, PORT.`);
    expect(log).toContain('ConnectionStrings__Shop, ConnectionStrings__Orders, Redis__ConnectionString in .env.dev name a Docker service');
    for (const secret of ['TEST-SECRET-4471', 'TEST-MODE', 'REAL-SECRET-4471', 'REAL-MODE']) expect(log).not.toContain(secret);
    // Not even an address without its password: the app gets those, the log their names.
    expect(log).not.toMatch(/mongodb:\/\/|postgres:\/\/|203\.0\.113\.7/);
  }, 60_000);
});

describe("the story's own database", () => {
  it('is not made on another computer: an address in the env file that is not here keeps the rule, and the story says so', async () => {
    const remote = 'mongodb://shop:pw@203.0.113.7:27017/shop?authSource=admin';
    write(storyFile(bp, local), `ConnectionStrings__Shop=${remote}\nShop__Mode="TEST-MODE"\n`, '/');
    const copy = storyCopy();
    confirmDatabase(bp, 'Momen', { kind: 'mongo', env: 'ConnectionStrings__Shop', file: '.env.dev', address: remote });
    const r = await setUpStoryDb(bp, 'SH-1', copy, '.');
    expect(r).toMatchObject({ state: 'as-before', say: expect.stringContaining('on another computer (203.0.113.7)') });
    expect(await seen(copy, ['ConnectionStrings__Shop'])).toEqual({ ConnectionStrings__Shop: remote });
  });

  it('a copy without the env file says its app falls back to the database in its settings file', async () => {
    writeMeta(bp, { ...readMeta(bp), localFiles: [] });
    const copy = addWorktree(root, 'SH-2', 'main').dir;
    confirmDatabase(bp, 'Momen', { kind: 'mongo', env: 'ConnectionStrings__Shop', file: 'appsettings.Development.json', key: 'ConnectionStrings:Shop', address: 'mongodb://localhost:27018/shop' });
    const r = await setUpStoryDb(bp, 'SH-2', copy, '.');
    expect(r).toMatchObject({ state: 'as-before', say: "This story's copy has no .env.dev, so its app falls back to the database in appsettings.json, which is on another computer (203.0.113.7). An engineer can add .env.dev as a local file in Settings, with values for stories." });
  });
});
