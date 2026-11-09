import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { findTool } from '../../src/engine/db/run.js';

/**
 * Throwaway database servers for the adapter tests: a mongod and a mysqld on their own folders and ports, and a
 * Postgres in a container the test makes and removes by its exact name. Each is stopped by the exact process or
 * container the test started, never by a pattern. A test whose tools are missing, or whose server will not start
 * here, skips, so a computer or a CI machine without them still passes.
 *
 * Folders go under SQUAD_DB_TEST_DIR when it is set, else the system's temp folder.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

/**
 * A free port for a database server, picked at random well away from the ports the other tests use (tiny-app.ts) and
 * from every database's usual port, so two test runs on one computer do not reach for the same one.
 */
async function freePort(): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const port = randomInt(42_000, 48_999);
    if ((await isFree(port, '127.0.0.1')) && (await isFree(port, '0.0.0.0'))) return port;
  }
  throw new Error('No free port for a test database server');
}

/** A new folder for one server or one test's files. */
export function scratch(name: string): string {
  const base = process.env.SQUAD_DB_TEST_DIR || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, `sk-db-${name}-`));
}

/** Stops a process this test started, by its own number, after checking it is still that program. */
async function stopPid(child: ChildProcess, program: string): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null) return;
  let comm = '';
  try {
    comm = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim();
  } catch {
    return;
  }
  if (!comm.includes(program)) return;
  const gone = new Promise<void>((r) => child.once('exit', () => r()));
  process.kill(pid, 'SIGTERM');
  await Promise.race([gone, sleep(20_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Gone.
    }
  }
}

async function until(what: string, ok: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ok()) return;
    await sleep(300);
  }
  throw new Error(`${what} did not start in time`);
}

const quiet = { stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], timeout: 15_000 };

export interface Server {
  /** The address of a database on it, with the given name and the test user's password. */
  address(name: string): string;
  /** Runs SQL or a script on it as its admin, and gives back what it printed. */
  admin(script: string, database?: string): string;
  stop(): Promise<void>;
}

/** A MySQL server on a temp folder and its own port, with a user `app` whose password has odd characters in it. */
export async function startMysql(password: string): Promise<Server | null> {
  const mysqld = findTool('mysqld');
  const mysql = findTool('mysql');
  if (!mysqld || !mysql || !findTool('mysqldump')) return null;
  const dir = scratch('mysql');
  const port = await freePort();
  const sock = path.join(dir, 'm.sock');
  try {
    execFileSync(mysqld, ['--no-defaults', '--initialize-insecure', `--datadir=${path.join(dir, 'data')}`, `--log-error=${path.join(dir, 'init.err')}`], { ...quiet, timeout: 120_000 });
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
  const child = spawn(
    mysqld,
    ['--no-defaults', `--datadir=${path.join(dir, 'data')}`, `--port=${port}`, '--bind-address=127.0.0.1', `--socket=${sock}`, '--mysqlx=OFF', `--pid-file=${path.join(dir, 'm.pid')}`, `--log-error=${path.join(dir, 'm.err')}`, '--skip-log-bin'],
    { stdio: 'ignore' },
  );
  const root = (script: string, database?: string) => execFileSync(mysql, ['--no-defaults', '-h127.0.0.1', `-P${port}`, '-uroot', '--batch', '--skip-column-names', ...(database ? [database] : [])], { ...quiet, input: script, encoding: 'utf8' });
  const stop = async () => {
    await stopPid(child, 'mysqld');
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    await until(
      'mysqld',
      () => {
        try {
          root('SELECT 1');
          return true;
        } catch {
          return false;
        }
      },
      60_000,
    );
    // The server that answers is this test's own, not another on the same port.
    if (root('SELECT @@datadir').trim() !== `${path.join(fs.realpathSync(dir), 'data')}/`) throw new Error('Another MySQL answered');
    const pw = password.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    root(`CREATE USER 'app'@'%' IDENTIFIED BY '${pw}'; GRANT ALL ON *.* TO 'app'@'%';`);
  } catch {
    await stop();
    return null;
  }
  return {
    address: (name) => `mysql://app:${encodeURIComponent(password)}@127.0.0.1:${port}/${name}`,
    admin: root,
    stop,
  };
}

/** A MongoDB server on a temp folder and its own port, with a user `app` (in admin) whose password has odd characters. */
export async function startMongo(password: string): Promise<Server | null> {
  const mongod = findTool('mongod');
  const mongosh = findTool('mongosh');
  if (!mongod || !mongosh || !findTool('mongodump') || !findTool('mongorestore')) return null;
  const dir = scratch('mongo');
  const port = await freePort();
  fs.mkdirSync(path.join(dir, 'db'));
  const child = spawn(mongod, ['--dbpath', path.join(dir, 'db'), '--port', String(port), '--bind_ip', '127.0.0.1', '--logpath', path.join(dir, 'mongod.log')], { stdio: 'ignore' });
  const shell = (script: string, database = 'admin') => execFileSync(mongosh, ['--quiet', '--norc', `mongodb://127.0.0.1:${port}/${database}`, '--eval', script], { ...quiet, timeout: 60_000, encoding: 'utf8' });
  const stop = async () => {
    await stopPid(child, 'mongod');
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    await until(
      'mongod',
      () => {
        try {
          return shell('print("up")').includes('up');
        } catch {
          return false;
        }
      },
      60_000,
    );
    if (!shell('print(db.serverCmdLineOpts().parsed.storage.dbPath)').includes(path.join(dir, 'db'))) throw new Error('Another mongod answered');
    shell(`db.getSiblingDB('admin').createUser({ user: 'app', pwd: ${JSON.stringify(password)}, roles: [{ role: 'root', db: 'admin' }] })`);
  } catch {
    await stop();
    return null;
  }
  return {
    address: (name) => `mongodb://app:${encodeURIComponent(password)}@127.0.0.1:${port}/${name}?authSource=admin`,
    admin: shell,
    stop,
  };
}

/** Throwaway Postgres containers carry this name and a random end, so each is removed by its exact name. */
const PG_PREFIX = 'sk-db-180-pg-';
const PG_IMAGE = 'postgres:16';

/**
 * A Postgres 16 server in a container this test makes, on its own port, its data in the container's memory. Only when
 * Docker answers and the image is already here: a test never downloads one.
 */
export async function startPostgres(password: string): Promise<Server | null> {
  const docker = findTool('docker');
  const psql = findTool('psql');
  if (!docker || !psql || !findTool('pg_dump')) return null;
  try {
    execFileSync(docker, ['image', 'inspect', PG_IMAGE], quiet);
  } catch {
    return null;
  }
  const name = `${PG_PREFIX}${randomBytes(4).toString('hex')}`;
  const port = await freePort();
  try {
    execFileSync(docker, ['run', '-d', '--name', name, '-p', `127.0.0.1:${port}:5432`, '--tmpfs', '/var/lib/postgresql/data:rw', '-e', `POSTGRES_PASSWORD=${password}`, PG_IMAGE, '-c', `cluster_name=${name}`], { ...quiet, timeout: 60_000 });
  } catch {
    return null;
  }
  const env = { ...process.env, PGPASSWORD: password, PGCONNECT_TIMEOUT: '5' };
  const admin = (script: string, database = 'postgres') =>
    execFileSync(psql, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', database], { ...quiet, env, input: script, encoding: 'utf8' });
  const stop = async () => {
    try {
      execFileSync(docker, ['rm', '-f', '-v', name], { ...quiet, timeout: 60_000 });
    } catch {
      // Gone already.
    }
  };
  try {
    // The image starts Postgres once to set it up, then again for real: wait for two answers in a row.
    let answers = 0;
    await until(
      'Postgres',
      () => {
        try {
          // Only this test's own server says this name.
          if (admin('SHOW cluster_name').trim() === name) answers++;
          else answers = 0;
        } catch {
          answers = 0;
        }
        return answers >= 3;
      },
      90_000,
    );
  } catch {
    await stop();
    return null;
  }
  return {
    address: (db) => `postgres://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/${db}`,
    admin,
    stop,
  };
}

/** The made-up clinic every kind is tested on: 3 doctors, 300 patients, 900 visits. */
export const CLINIC = { doctors: 3, patients: 300, visits: 900 };
