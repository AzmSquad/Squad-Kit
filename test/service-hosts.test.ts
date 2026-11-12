import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort } from './support/tiny-app.js';
import { startApp } from '../src/engine/checks.js';
import { forgetWiring, wireCopy } from '../src/engine/db-env.js';
import { addressKind, appEnvHere, appSettings, composeServices, isThisComputer, safeAddress, serverOf, serverPlace, settingsFileAddress, swapServiceHost, type ComposeService } from '../src/engine/service-hosts.js';

/**
 * Where a database or a Redis runs, from the app's own settings: a compose service's name reached through the port it
 * publishes on this computer (rule one), and whether a server is on this computer at all (rule two). Made-up projects
 * only: a shop API whose daily stack runs in Compose, with a Mongo, a Postgres and a cache.
 */

const COMPOSE = `services:
  api:
    build: .
    env_file: .env.dev
    environment:
      ConnectionStrings__Orders: postgres://shop:pw@orders-db:5432/orders
  app.db:
    image: mongo:7
    container_name: Shop-Mongo
    ports:
      - "27018:27017"
  orders-db:
    image: postgres:16
    ports:
      - target: 5432
        published: 5433
  cache:
    image: redis:7
    ports: ["\${CACHE_PORT:-6380}:6379/tcp"]
  hidden:
    image: mongo:7
    expose: ["27017"]
`;

let dir: string;
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-hosts-')));
  forgetWiring();
});

afterEach(() => {
  forgetWiring();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the compose services', () => {
  it('knows each by its name and container_name, any case, with the ports it publishes here', () => {
    write('docker-compose.yml', COMPOSE);
    const s = composeServices(dir);
    expect(s.find((x) => x.names.includes('app.db'))).toEqual({ names: ['app.db', 'shop-mongo'], ports: { 27017: 27018 } });
    expect(s.find((x) => x.names.includes('orders-db'))?.ports).toEqual({ 5432: 5433 });
    expect(s.find((x) => x.names.includes('cache'))?.ports).toEqual({ 6379: 6380 });
    expect(s.find((x) => x.names.includes('hidden'))?.ports).toEqual({});
  });

  it('leaves out a compose file for another place', () => {
    write('docker-compose.prod.yml', 'services:\n  db:\n    image: postgres\n    ports: ["5432:5432"]\n');
    expect(composeServices(dir)).toEqual([]);
  });
});

describe('swapServiceHost: rule one', () => {
  const services: ComposeService[] = [
    { names: ['app.db', 'shop-mongo'], ports: { 27017: 27017 } },
    { names: ['mongo2'], ports: { 27017: 27019 } },
    { names: ['orders-db'], ports: { 5432: 5433 } },
    { names: ['redis'], ports: { 6379: 6379 } },
    { names: ['cache'], ports: { 6379: 6380 } },
    { names: ['hidden'], ports: {} },
  ];

  it('swaps a Mongo service for localhost and its published port, keeping the rest as written', () => {
    expect(swapServiceHost('mongodb://user:p%40ss@app.db:27017/shop?authSource=admin', services)).toBe('mongodb://user:p%40ss@localhost:27017/shop?authSource=admin');
    expect(swapServiceHost('mongodb://SHOP-MONGO/shop', services)).toBe('mongodb://localhost/shop');
  });

  it('swaps each host of a Mongo link with several, and only the services', () => {
    expect(swapServiceHost('mongodb://app.db:27017,mongo2:27017,10.0.0.9:27017/shop?replicaSet=rs0', services)).toBe('mongodb://localhost:27017,localhost:27019,10.0.0.9:27017/shop?replicaSet=rs0');
  });

  it('adds the published port when the link had none and it is not the usual one', () => {
    expect(swapServiceHost('postgres://shop@orders-db/orders', services)).toBe('postgres://shop@localhost:5433/orders');
    expect(swapServiceHost('jdbc:postgresql://orders-db:5432/orders', services)).toBe('jdbc:postgresql://localhost:5433/orders');
  });

  it('swaps key=value addresses, the port in its own pair or added', () => {
    expect(swapServiceHost('Host=orders-db;Port=5432;Database=orders;Username=shop;Password=pw', services)).toBe('Host=localhost;Port=5433;Database=orders;Username=shop;Password=pw');
    expect(swapServiceHost('Host=orders-db;Database=orders;Username=shop', services)).toBe('Host=localhost;Database=orders;Username=shop;Port=5433');
    expect(swapServiceHost('host=orders-db dbname=orders sslmode=disable', services)).toBe('host=localhost dbname=orders sslmode=disable port=5433');
  });

  it('swaps Redis: a redis link, and the StackExchange form', () => {
    expect(swapServiceHost('redis://:secret@cache:6379/0', services)).toBe('redis://:secret@localhost:6380/0');
    expect(swapServiceHost('redis:6379,abortConnect=false', services)).toBe('localhost:6379,abortConnect=false');
    expect(swapServiceHost('cache:6379,password=x,ssl=false', services)).toBe('localhost:6380,password=x,ssl=false');
    // Known to be Redis by its setting's name: a bare host and port.
    expect(swapServiceHost('cache:6379', services, true)).toBe('localhost:6380');
    // A host alone has nowhere for another port: left as it is.
    expect(swapServiceHost('cache', services, true)).toBeNull();
    expect(swapServiceHost('redis', services, true)).toBe('localhost');
  });

  it('leaves alone what is no service, a service that publishes nothing, and an srv link', () => {
    expect(swapServiceHost('mongodb://203.0.113.7:27018/shop', services)).toBeNull();
    expect(swapServiceHost('mongodb://hidden:27017/shop', services)).toBeNull();
    expect(swapServiceHost('mongodb+srv://app.db/shop', services)).toBeNull();
    expect(swapServiceHost('https://app.db/', services)).toBeNull();
    expect(swapServiceHost('mongodb://app.db/shop', [])).toBeNull();
  });
});

describe('serverPlace: rule two', () => {
  const services: ComposeService[] = [{ names: ['app.db'], ports: { 27017: 27018 } }, { names: ['hidden'], ports: {} }];

  it('this computer in every form', () => {
    for (const a of ['mongodb://localhost:27017/shop', 'mongodb://127.0.0.1/shop', 'mongodb://[::1]:27017/shop', 'mongodb://0.0.0.0/shop', 'mongodb://host.docker.internal:27017/shop', 'postgres:///shop?host=/tmp', 'postgresql://shop@127.0.0.2:5432/shop']) {
      expect(serverPlace(a, services)).toEqual({ here: true, address: a });
    }
    expect(isThisComputer('api.localhost')).toBe(true);
  });

  it('a compose service that publishes its port here, reached through that port', () => {
    expect(serverPlace('mongodb://u:p@app.db:27017/shop?authSource=admin', services)).toEqual({ here: true, address: 'mongodb://u:p@localhost:27018/shop?authSource=admin' });
    expect(serverPlace('mongodb://hidden:27017/shop', services)).toEqual({ here: false, host: 'hidden', service: true });
  });

  it('another computer: a public IP, a private IP, a cloud host, IPv6, an srv link', () => {
    expect(serverPlace('mongodb://admin:pw@203.0.113.7:27018/shop', services)).toEqual({ here: false, host: '203.0.113.7' });
    expect(serverPlace('Host=10.20.30.40;Database=shop;Username=u', services)).toEqual({ here: false, host: '10.20.30.40' });
    expect(serverPlace('postgres://u@shop.abc123.eu-west-1.rds.amazonaws.com:5432/shop', services)).toEqual({ here: false, host: 'shop.abc123.eu-west-1.rds.amazonaws.com' });
    expect(serverPlace('mongodb://[2001:db8::7]:27017/shop', services)).toEqual({ here: false, host: '2001:db8::7' });
    expect(serverPlace('host=2001:db8::7 port=5432 dbname=shop', services)).toEqual({ here: false, host: '2001:db8::7' });
    expect(serverPlace('host=::1 dbname=shop', services)).toMatchObject({ here: true });
    expect(serverPlace('mongodb+srv://u:p@cluster0.example.net/shop', services)).toEqual({ here: false, host: 'cluster0.example.net' });
  });

  it('several hosts in one Mongo link: every one must be here', () => {
    expect(serverPlace('mongodb://localhost:27017,app.db:27017/shop', services)).toEqual({ here: true, address: 'mongodb://localhost:27017,localhost:27018/shop' });
    expect(serverPlace('mongodb://localhost:27017,198.51.100.4:27017/shop', services)).toEqual({ here: false, host: '198.51.100.4' });
  });

  it("reads a form only the database's kind knows", () => {
    expect(serverPlace('Server=192.0.2.10;Database=shop;User=root', services, { kind: 'mysql' })).toEqual({ here: false, host: '192.0.2.10' });
    expect(serverPlace('Server=localhost;Database=shop;User=root', services, { kind: 'mysql' })).toMatchObject({ here: true });
  });

  it('Redis too, and its server as host:port', () => {
    expect(serverPlace('redis.example.net:6379,abortConnect=false', services, { redis: true })).toEqual({ here: false, host: 'redis.example.net' });
    expect(serverOf('localhost:6379,abortConnect=false', true)).toBe('localhost:6379');
    expect(serverOf('redis://127.0.0.1/2', true)).toBe('localhost:6379');
  });
});

describe('the app settings', () => {
  it('reads the env files compose gives, the compose environment and appsettings, never a file for another place', () => {
    write('docker-compose.yml', COMPOSE);
    write('.env.dev', 'ConnectionStrings__Shop=mongodb://shop:pw@app.db:27017/shop?authSource=admin\nRedis__ConnectionString=cache:6379,abortConnect=false\nRedis__Enabled=true\nGREETING=hello\n');
    write('.env.prod', 'ConnectionStrings__Shop=mongodb://shop:pw@10.1.1.1:27017/shop\n');
    write('src/Api/appsettings.json', '{ // comments, as .NET allows\n "ConnectionStrings": { "Shop": "mongodb://203.0.113.7:27018/shop" },\n "Cache": { "Enabled": true, },\n}');
    const s = appSettings(dir);
    expect(s.map((x) => [x.name, x.kind, x.file])).toEqual([
      ['ConnectionStrings__Shop', 'mongo', '.env.dev'],
      ['Redis__ConnectionString', 'redis', '.env.dev'],
      ['ConnectionStrings__Orders', 'postgres', 'docker-compose.yml'],
    ]);
  });

  it('knows a Redis address by its form or by its setting name', () => {
    expect(addressKind('REDIS_URL', 'redis://cache:6379')).toBe('redis');
    expect(addressKind('ConnectionStrings__Cache', 'cache:6379,abortConnect=false')).toBe('redis');
    expect(addressKind('Redis__ConnectionString', 'localhost')).toBe('redis');
    expect(addressKind('REDIS_HOST', 'cache')).toBe('redis');
    expect(addressKind('Redis__Enabled', 'true')).toBeNull();
    expect(addressKind('Redis__Timeout', '5000')).toBeNull();
    expect(addressKind('API_URL', 'http://api:8080')).toBeNull();
    expect(addressKind('CACHE', 'cache:6379')).toBeNull();
  });

  it('never shows a password', () => {
    expect(safeAddress('mongodb://shop:s3cret@localhost:27017/shop')).toBe('mongodb://shop:***@localhost:27017/shop');
    expect(safeAddress('redis://:s3cret@localhost:6379/2')).toBe('redis://:***@localhost:6379/2');
    expect(safeAddress('localhost:6379,password=s3cret,abortConnect=false')).toBe('localhost:6379,password=***,abortConnect=false');
    expect(safeAddress('Host=db;Password=s3cret;Database=shop')).toBe('Host=db;Password=***;Database=shop');
  });
});

describe('appEnvHere: the app squad-kit starts on this computer', () => {
  beforeEach(() => {
    write('docker-compose.yml', COMPOSE);
    write('.env.dev', 'ConnectionStrings__Shop=mongodb://shop:s3cret@app.db:27017/shop?authSource=admin\nRedis__ConnectionString=cache:6379,abortConnect=false\nREMOTE_DB_URL=mongodb://203.0.113.7:27018/shop\n');
  });

  it('gets each address that names a service, through the port it publishes here; a password never reaches the log', () => {
    const said: string[] = [];
    const env = appEnvHere(dir, 'dotnet run --project src/Api', (t) => said.push(t));
    expect(env).toEqual({
      ConnectionStrings__Shop: 'mongodb://shop:s3cret@localhost:27018/shop?authSource=admin',
      Redis__ConnectionString: 'localhost:6380,abortConnect=false',
      ConnectionStrings__Orders: 'postgres://shop:pw@localhost:5433/orders',
    });
    expect(said.join('\n')).not.toContain('s3cret');
    expect(said[0]).toContain('mongodb://shop:***@localhost:27018/shop');
  });

  it("fills an address in from the env file's other settings first, as Compose does, then swaps the service", () => {
    write('.env.dev', 'MONGO_USER=shop\nMONGO_PASSWORD=s3cret\nMONGO_HOST=app.db\nConnectionStrings__Shop="mongodb://${MONGO_USER}:${MONGO_PASSWORD}@${MONGO_HOST}:27017/shop?authSource=admin"\n');
    const said: string[] = [];
    expect(appEnvHere(dir, 'dotnet run', (t) => said.push(t))).toMatchObject({ ConnectionStrings__Shop: 'mongodb://shop:s3cret@localhost:27018/shop?authSource=admin' });
    expect(said.join('\n')).not.toContain('s3cret');
  });

  it('leaves everything as it is when the app runs in Compose', () => {
    expect(appEnvHere(dir, 'docker compose up --build', () => undefined)).toEqual({});
    expect(appEnvHere(dir, 'docker-compose up', () => undefined)).toEqual({});
  });

  it("in a story's copy with its own database, only Redis changes: the story's address is the database's", () => {
    wireCopy(dir, { env: { ConnectionStrings__Shop: 'mongodb://shop:s3cret@localhost:27018/shop_sh_1?authSource=admin' }, value: 'x' });
    expect(appEnvHere(dir, 'dotnet run', () => undefined)).toEqual({ Redis__ConnectionString: 'localhost:6380,abortConnect=false' });
  });

  it('the app really gets it when squad-kit starts it', async () => {
    const port = await freePort();
    write('server.js', `require('http').createServer((q, r) => r.end(String(process.env.ConnectionStrings__Shop))).listen(${port}, '127.0.0.1');`);
    const app = await startApp(dir, 'node server.js', `http://127.0.0.1:${port}`, 20_000);
    try {
      expect(await (await fetch(app.url)).text()).toBe('mongodb://shop:s3cret@localhost:27018/shop?authSource=admin');
    } finally {
      app.stop();
    }
  }, 30_000);
});

describe('settingsFileAddress: what a copy falls back to', () => {
  it("reads the project's own settings file when no env file in the folder sets it", () => {
    write('src/Api/appsettings.json', '{ "ConnectionStrings": { "Shop": "mongodb://admin:pw@203.0.113.7:27018/shop" } }');
    expect(settingsFileAddress(dir, { file: 'src/Api/appsettings.Development.json', key: 'ConnectionStrings:Shop', env: 'ConnectionStrings__Shop' })).toEqual({ file: 'src/Api/appsettings.json', value: 'mongodb://admin:pw@203.0.113.7:27018/shop' });
    expect(settingsFileAddress(dir, { file: '.env.dev', env: 'ConnectionStrings__Shop' })).toMatchObject({ file: 'src/Api/appsettings.json' });
    // appsettings.Development.json, when the copy has it, is read before appsettings.json.
    write('src/Api/appsettings.Development.json', '{ "ConnectionStrings": { "Shop": "mongodb://localhost:27017/shop" } }');
    expect(settingsFileAddress(dir, { file: '.env.dev', env: 'ConnectionStrings__Shop' })).toEqual({ file: 'src/Api/appsettings.Development.json', value: 'mongodb://localhost:27017/shop' });
  });

  it('nothing when an env file sets it first, or no settings file holds an address', () => {
    write('src/Api/appsettings.json', '{ "ConnectionStrings": { "Shop": "mongodb://admin:pw@203.0.113.7:27018/shop" } }');
    write('.env.dev', 'ConnectionStrings__Shop=mongodb://localhost:27017/shop\n');
    expect(settingsFileAddress(dir, { file: '.env.dev', env: 'ConnectionStrings__Shop' })).toBeUndefined();
    expect(settingsFileAddress(dir, { file: '.env', env: 'DATABASE_URL' })).toBeUndefined();
  });
});
