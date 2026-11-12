import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { findDatabase, hasPassword, kindOf, readAddress, storyCopyIgnored, withoutPassword } from '../src/engine/find-database.js';

/**
 * Learning a project's database from its own files: the kind, its name, where it runs, and the setting that points the
 * app at it. Every project here is made up for the test.
 */

let root: string;
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};
const look = (repos = ['.']) => findDatabase(root, repos);

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-find-db-')));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('a Node project', () => {
  it('with Prisma, its address in .env.example and a compose file: Postgres, DATABASE_URL in .env', () => {
    write('package.json', JSON.stringify({ dependencies: { '@prisma/client': '5.0.0' } }));
    write('prisma/schema.prisma', 'generator client {\n  provider = "prisma-client-js"\n}\n\ndatasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n  shadowDatabaseUrl = env("SHADOW_DATABASE_URL")\n}\n');
    write('.env.example', 'DATABASE_URL="postgresql://clinic:clinic-pass@localhost:5433/clinic_dev?schema=public"\nSHADOW_DATABASE_URL=\nPORT=3000\n');
    write('docker-compose.yml', 'services:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_USER: clinic\n      POSTGRES_PASSWORD: clinic-pass\n      POSTGRES_DB: clinic_dev\n    ports:\n      - "5433:5432"\n');
    const { found } = look();
    expect(found).toMatchObject({ kind: 'postgres', repo: '.', name: 'clinic_dev', setting: { env: 'DATABASE_URL', file: '.env' }, where: 'the db service in docker-compose.yml, on port 5433' });
    expect(found!.address).toBe('postgresql://clinic:clinic-pass@localhost:5433/clinic_dev?schema=public');
    expect(found!.from).toEqual(expect.arrayContaining(['prisma/schema.prisma', '.env.example', 'docker-compose.yml']));
  });

  it("takes the address the person's own .env holds over the example's", () => {
    write('prisma/schema.prisma', 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n');
    write('.env.example', 'DATABASE_URL=postgresql://user:pass@localhost:5432/example_db\n');
    write('.env', 'DATABASE_URL=postgresql://me:mine@localhost:5432/my_dev\n');
    const { found } = look();
    expect(found).toMatchObject({ name: 'my_dev', setting: { env: 'DATABASE_URL', file: '.env' }, address: 'postgresql://me:mine@localhost:5432/my_dev' });
  });

  it('with a Mongo address in .env.example and Mongoose reading it: Mongo, MONGO_URL', () => {
    write('package.json', JSON.stringify({ dependencies: { mongoose: '8.0.0', express: '4.0.0' } }));
    write('.env.example', '# The database\nMONGO_URL=mongodb://localhost:27017/bookings\nREDIS_URL=redis://localhost:6379\n');
    write('src/db.js', "const mongoose = require('mongoose');\nmongoose.connect(process.env.MONGO_URL);\n");
    const { found } = look();
    expect(found).toMatchObject({ kind: 'mongo', name: 'bookings', setting: { env: 'MONGO_URL', file: '.env' }, address: 'mongodb://localhost:27017/bookings', where: 'localhost:27017' });
  });

  it('with only a compose file: the app service names the setting, the database service where it runs', () => {
    write('compose.yaml', 'services:\n  api:\n    build: .\n    environment:\n      - MONGODB_URI=mongodb://mongo:27017/shop\n  mongo:\n    image: mongo:7\n    environment:\n      MONGO_INITDB_DATABASE: shop\n    ports:\n      - "127.0.0.1:27018:27017"\n');
    const { found } = look();
    expect(found).toMatchObject({ kind: 'mongo', name: 'shop', setting: { env: 'MONGODB_URI' }, address: 'mongodb://localhost:27018/shop', where: 'the mongo service in compose.yaml, on port 27018' });
  });

  it('with a SQLite file in Prisma', () => {
    write('prisma/schema.prisma', 'datasource db {\n  provider = "sqlite"\n  url = env("DATABASE_URL")\n}\n');
    write('.env', 'DATABASE_URL="file:./dev.db"\n');
    const { found } = look();
    expect(found).toMatchObject({ kind: 'sqlite', name: './dev.db', setting: { env: 'DATABASE_URL', file: '.env' }, where: 'a file in the project' });
  });
});

describe('a .NET project', () => {
  it("reads appsettings.Development.json's connection string, the one the code asks for, and its package", () => {
    write('src/Clinic.Api/Clinic.Api.csproj', '<Project Sdk="Microsoft.NET.Sdk.Web">\n  <ItemGroup>\n    <PackageReference Include="Npgsql.EntityFrameworkCore.PostgreSQL" Version="8.0.0" />\n  </ItemGroup>\n</Project>\n');
    write('src/Clinic.Api/appsettings.json', '{\n  // Shared settings\n  "ConnectionStrings": { "Reports": "Host=reports;Database=reports;Username=r;Password=r" },\n  "Logging": {}\n}\n');
    write('src/Clinic.Api/appsettings.Development.json', '{\n  "ConnectionStrings": {\n    "Default": "Host=localhost;Port=5432;Database=clinic_local;Username=app;Password=dev-pass-77",\n  }\n}\n');
    write('src/Clinic.Api/Program.cs', 'builder.Services.AddDbContext<ClinicDb>(o => o.UseNpgsql(builder.Configuration.GetConnectionString("Default")));\n');
    const { found } = look();
    expect(found).toMatchObject({
      kind: 'postgres',
      name: 'clinic_local',
      setting: { file: 'src/Clinic.Api/appsettings.Development.json', key: 'ConnectionStrings:Default', env: 'ConnectionStrings__Default' },
      address: 'Host=localhost;Port=5432;Database=clinic_local;Username=app;Password=dev-pass-77',
      where: 'localhost:5432',
    });
  });

  it('reads a Mongo settings block with its database name beside it', () => {
    write('Api.csproj', '<Project><ItemGroup><PackageReference Include="MongoDB.Driver" Version="2.0.0" /></ItemGroup></Project>');
    write('appsettings.Development.json', '{ "MongoSettings": { "ConnectionString": "mongodb://localhost:27017", "DatabaseName": "cases" } }');
    const { found } = look();
    expect(found).toMatchObject({ kind: 'mongo', name: 'cases', setting: { file: 'appsettings.Development.json', key: 'MongoSettings:ConnectionString', env: 'MongoSettings__ConnectionString' } });
  });

  it("takes this computer's env file over the address in appsettings.json: the setting is that name in that file, never a file for another place", () => {
    write('Api.csproj', '<Project><ItemGroup><PackageReference Include="MongoDB.Driver" Version="2.0.0" /></ItemGroup></Project>');
    write('appsettings.json', '{ "ConnectionStrings": { "Shop": "mongodb://admin:pw@203.0.113.7:27018/shop" } }');
    write('docker-compose.yml', 'services:\n  api:\n    build: .\n    env_file: .env.dev\n  app.db:\n    image: mongo:7\n    ports: ["27017:27017"]\n');
    write('.env.beta', 'ConnectionStrings__Shop=mongodb://shop:pw@10.0.0.5:27017/shop\n');
    write('.env.dev', 'ConnectionStrings__Shop=mongodb://shop:pw@app.db:27017/shop?authSource=admin\n');
    write('.env.prod', 'ConnectionStrings__Shop=mongodb://shop:pw@10.0.0.9:27017/shop\n');
    const { found } = look();
    expect(found).toMatchObject({ kind: 'mongo', name: 'shop', address: 'mongodb://shop:pw@app.db:27017/shop?authSource=admin', where: 'the app.db service in docker-compose.yml, on port 27017' });
    expect(found!.setting).toEqual({ env: 'ConnectionStrings__Shop', file: '.env.dev' });
    expect(found!.from).toEqual(expect.arrayContaining(['appsettings.json', '.env.dev']));
  });

  const ordersApi = () => {
    write('Orders.Api/Orders.Api.csproj', '<Project><ItemGroup><PackageReference Include="MongoDB.Driver" Version="2.0.0" /></ItemGroup></Project>');
    write('Orders.Api/appsettings.json', '{ "ConnectionStrings": { "OrdersDb": "mongodb://admin:remote-pw@203.0.113.7:27017/orders_remote" } }');
    write('Orders.Api/Program.cs', 'var cs = builder.Configuration.GetConnectionString("OrdersDb");\n');
    write('docker-compose.yml', 'services:\n  api:\n    build: .\n    env_file: deploy/dev.env\n  orders-db:\n    image: mongo:7\n    environment:\n      MONGO_INITDB_ROOT_USERNAME: ${MONGO_USER}\n    ports: ["27019:27017"]\n');
  };
  const ordersEnv = (tail: string) => `MONGO_USER=orders\nMONGO_PASSWORD=orders-pw\nMONGO_HOST=orders-db\nMONGO_PORT=27017\nConnectionStrings__OrdersDb=mongodb://\${MONGO_USER}:\${MONGO_PASSWORD}@\${MONGO_HOST}:\${MONGO_PORT}${tail}?authMechanism=SCRAM-SHA-256\n`;

  it("learns from the part's env file, whatever its name, with its address filled in from the file's other settings", () => {
    ordersApi();
    write('deploy/dev.env', ordersEnv('/orders'));
    // Not the part's env file, and not named like one: the settings file's address, as before.
    expect(look().found).toMatchObject({ name: 'orders_remote', setting: { file: 'Orders.Api/appsettings.json', key: 'ConnectionStrings:OrdersDb' } });
    const { found } = findDatabase(root, ['.'], { '.': ['deploy/dev.env'] });
    expect(found).toMatchObject({ kind: 'mongo', name: 'orders', address: 'mongodb://orders:orders-pw@orders-db:27017/orders?authMechanism=SCRAM-SHA-256', where: 'the orders-db service in docker-compose.yml, on port 27019' });
    expect(found!.setting).toEqual({ env: 'ConnectionStrings__OrdersDb', file: 'deploy/dev.env' });
    expect(found!.from).toEqual(expect.arrayContaining(['Orders.Api/appsettings.json', 'deploy/dev.env']));
  });

  it("an env file's address with no database's name in it: no name from the address it overrides, and no copy for stories", () => {
    ordersApi();
    write('.env.dev', ordersEnv('/'));
    const { found } = findDatabase(root, ['.'], { '.': ['.env.dev'] });
    expect(found).toMatchObject({ kind: 'mongo', address: 'mongodb://orders:orders-pw@orders-db:27017/?authMechanism=SCRAM-SHA-256', setting: { env: 'ConnectionStrings__OrdersDb', file: '.env.dev' } });
    expect(found!.name).toBeUndefined();
    execSync('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm start', { cwd: root, stdio: 'ignore' });
    expect(storyCopyIgnored(root, found!, found!.address)).toContain('The address in .env.dev names no database');
  });

  it('an env file value that names a setting nothing sets is no address, as before', () => {
    write('package.json', JSON.stringify({ dependencies: { pg: '8.0.0' } }));
    write('.env', 'DATABASE_URL=postgres://${DB_USER}@localhost:5432/orders\n');
    write('src/db.ts', 'export const pool = new Pool({ connectionString: process.env.DATABASE_URL });\n');
    expect(look().found).toMatchObject({ setting: { env: 'DATABASE_URL', file: '.env' } });
    expect(look().found!.address).toBeUndefined();
  });

  it('says plainly that SQL Server comes later, and learns nothing', () => {
    write('Api.csproj', '<Project><ItemGroup><PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="8.0.0" /></ItemGroup></Project>');
    write('appsettings.Development.json', '{ "ConnectionStrings": { "Default": "Server=localhost;Database=Library;Trusted_Connection=True;TrustServerCertificate=True" } }');
    const r = look();
    expect(r.found).toBeNull();
    expect(r.later).toMatch(/SQL Server.*later version/);
  });
});

describe('a Spring project', () => {
  it('reads spring.datasource.url with its user and password: MySQL, SPRING_DATASOURCE_URL', () => {
    write('pom.xml', '<project/>');
    write('src/main/resources/application.properties', 'server.port=8080\nspring.datasource.url=jdbc:mysql://localhost:3306/library\nspring.datasource.username=lib\nspring.datasource.password=lib-pass\n');
    const { found } = look();
    expect(found).toMatchObject({ kind: 'mysql', name: 'library', setting: { file: 'src/main/resources/application.properties', key: 'spring.datasource.url', env: 'SPRING_DATASOURCE_URL' }, address: 'jdbc:mysql://lib:lib-pass@localhost:3306/library' });
  });

  it('takes the environment name a ${NAME:default} value reads', () => {
    write('src/main/resources/application.yml', 'spring:\n  datasource:\n    url: ${DB_URL:jdbc:postgresql://localhost:5432/orders}\n');
    const { found } = look();
    expect(found).toMatchObject({ kind: 'postgres', name: 'orders', setting: { env: 'DB_URL', key: 'spring.datasource.url' }, address: 'jdbc:postgresql://localhost:5432/orders' });
  });
});

describe('a workspace and an empty project', () => {
  it('finds it in the repo that has it', () => {
    write('web/package.json', JSON.stringify({ dependencies: { react: '18.0.0' } }));
    write('api/.env.example', 'MONGODB_URI=mongodb://localhost:27017/fleet\n');
    expect(look(['web', 'api']).found).toMatchObject({ repo: 'api', kind: 'mongo', name: 'fleet' });
  });

  it('finds nothing in a project with no database', () => {
    write('package.json', JSON.stringify({ dependencies: { react: '18.0.0' } }));
    write('.env.example', 'API_URL=http://localhost:4000\n');
    expect(look()).toEqual({ found: null });
  });
});

describe('addresses', () => {
  it('says the kind, the name and whether a password is in it, and hides the password', () => {
    expect(kindOf('mongodb+srv://u:p@cluster.example.net/app')).toBe('mongo');
    expect(kindOf('jdbc:postgresql://localhost/app')).toBe('postgres');
    expect(kindOf('Data Source=app.db')).toBe('sqlite');
    expect(kindOf('redis://localhost')).toBeNull();
    expect(readAddress('mongodb://a:1,b:2/cases?replicaSet=r')).toMatchObject({ name: 'cases', host: 'a', port: '1', password: false });
    expect(hasPassword('postgres://app:secret@localhost/app')).toBe(true);
    expect(hasPassword('Host=localhost;Database=app;Password=x')).toBe(true);
    expect(hasPassword('mongodb://localhost:27017/app')).toBe(false);
    expect(withoutPassword('postgres://app:secret@localhost/app')).toBe('postgres://app:***@localhost/app');
    expect(withoutPassword('Host=localhost;Database=app;Password=x;Port=5')).toBe('Host=localhost;Database=app;Password=***;Port=5');
  });
});

describe('whether the app would use a story\'s own copy', () => {
  const MONGO = { kind: 'mongo' as const, name: 'shop', setting: { env: 'MONGO_URL', file: '.env' } };
  const ADDRESS = 'mongodb://shop:shop-pass@localhost:27017/shop?authSource=admin';
  const commit = () => execSync('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm start', { cwd: root, stdio: 'ignore' });

  it('an app that takes the name from its setting: nothing in the way', () => {
    write('src/db.ts', 'export const client = new MongoClient(process.env.MONGO_URL!);\nexport const db = client.db();\nconst title = "shop";\n');
    write('.env.example', 'MONGO_URL=mongodb://localhost:27017/shop\n');
    write('docker-compose.yml', 'services:\n  api:\n    environment:\n      - MONGO_URL=${MONGO_URL}\n      - PORT\n  web:\n    environment:\n      MONGO_URL: ${MONGO_URL:-mongodb://localhost:27017/shop}\n');
    commit();
    expect(storyCopyIgnored(root, MONGO, ADDRESS)).toBeUndefined();
  });

  it('code that names the database itself, in quotes on a database line', () => {
    write('Infrastructure/Repo.cs', 'class Repo {\n  private const string DatabaseName = "shop";\n}\n');
    commit();
    expect(storyCopyIgnored(root, MONGO, ADDRESS)).toBe("The code names the database shop itself, in Infrastructure/Repo.cs:2, so it would not use a story's own copy under another name. squad-kit gives each story its own copy when the app takes the database's name from MONGO_URL.");
  });

  it('a connection string named like the database is only the setting being read', () => {
    write('src/Db.cs', 'var cs = configuration.GetConnectionString("shop") ?? configuration["ConnectionStrings:shop"];\nvar database = new MongoClient(cs).GetDatabase(MongoUrl.Create(cs).DatabaseName);\n');
    commit();
    expect(storyCopyIgnored(root, { ...MONGO, setting: { env: 'ConnectionStrings__shop', file: 'appsettings.json', key: 'ConnectionStrings:shop' } }, ADDRESS)).toBeUndefined();
  });

  it('code that opens a database by a name of its own, outside its tests', () => {
    write('test/setup.ts', "const db = client.db('scratch');\n");
    commit();
    expect(storyCopyIgnored(root, MONGO, ADDRESS)).toBeUndefined();
    write('src/audit.py', "audit = client.get_database('audit_log')\n");
    commit();
    expect(storyCopyIgnored(root, MONGO, ADDRESS)).toContain('The code opens the database audit_log by its name, in src/audit.py:1');
    write('src/audit.py', '');
    write('src/conn.js', "mongoose.connect(process.env.MONGO_URL, { dbName: 'other' });\n");
    commit();
    expect(storyCopyIgnored(root, MONGO, ADDRESS)).toContain('The code opens the database other by its name, in src/conn.js:1');
  });

  it('test code is left out, .NET test projects too; the same lines in the app count', () => {
    write('Web.Api.Integration.Test/Fixture.cs', 'var db = client.GetDatabase("shop");\nprivate const string DatabaseName = "shop";\n');
    write('Orders.UnitTests/Repository.cs', 'private const string DatabaseName = "shop";\n');
    write('MyApp.Tests/Setup.cs', 'var db = client.GetDatabase("scratch");\n');
    write('Shop.IntegrationTests/Db.cs', 'var db = mongo.GetDatabase("shop_it");\n');
    write('IntegrationTests/Seed.cs', 'const string DatabaseName = "shop";\n');
    write('test/db.spec.ts', 'const databaseName = "shop";\n');
    write('src/Shop.Api/Db.cs', 'var db = client.GetDatabase(MongoUrl.Create(configuration.GetConnectionString("Shop")).DatabaseName);\n');
    commit();
    expect(storyCopyIgnored(root, MONGO, ADDRESS)).toBeUndefined();
    write('src/Contests/Repo.cs', 'private const string DatabaseName = "shop";\n');
    commit();
    expect(storyCopyIgnored(root, MONGO, ADDRESS)).toContain('The code names the database shop itself, in src/Contests/Repo.cs:1');
    write('src/Contests/Repo.cs', 'var db = client.GetDatabase("audit");\n');
    commit();
    expect(storyCopyIgnored(root, MONGO, ADDRESS)).toContain('The code opens the database audit by its name, in src/Contests/Repo.cs:1');
  });

  it('an address that names no database', () => {
    write('.env.example', 'MONGO_URL=mongodb://${MONGO_USER}:${MONGO_PASSWORD}@${MONGO_HOST}:27017/?authSource=admin\n');
    commit();
    expect(storyCopyIgnored(root, MONGO, ADDRESS)).toContain('The address in .env.example names no database');
    expect(storyCopyIgnored(root, { ...MONGO, name: undefined }, 'mongodb://localhost:27017')).toContain('names no database');
  });

  it('a compose file that builds the setting from other settings', () => {
    write('docker-compose.yml', 'services:\n  api:\n    environment:\n      - MONGO_URL=mongodb://${MONGO_USER}@${MONGO_HOST}:27017/shop\n');
    commit();
    expect(storyCopyIgnored(root, MONGO, ADDRESS)).toBe("docker-compose.yml sets MONGO_URL itself for the api service, from other settings, so the app there would not see a story's own database.");
  });

  it('a name too common to look for, and a SQLite file, are left alone', () => {
    write('src/db.ts', 'const pool = new Pool({ client: "postgres" });\n');
    commit();
    expect(storyCopyIgnored(root, { kind: 'postgres', name: 'postgres', setting: { env: 'DATABASE_URL' } }, 'postgres://localhost:5432/postgres')).toBeUndefined();
    write('src/db.ts', 'const db = new Database("dev.db");\n');
    commit();
    expect(storyCopyIgnored(root, { kind: 'sqlite', name: 'dev.db', setting: { env: 'DATABASE_URL' } }, 'file:./dev.db')).toBeUndefined();
  });
});
