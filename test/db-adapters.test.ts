import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The database adapters' own rules, with no database server: reading addresses in every form an app writes them,
 * story names, the person's own database, which columns hold personal data and how they are made fake, which rows a
 * template keeps, and passwords kept out of what squad-kit says. The real servers are in db-postgres, db-mysql,
 * db-mongo and db-sqlite tests.
 */

const { readAddress, kindOfAddress, storyName, templateName, isPersonsOwn, refuseOwn, safePart } = await import('../src/engine/db/address.js');
const { personalKind, makeFaker, fitLength, fits, typeClass, fakeDateMs } = await import('../src/engine/db/hide.js');
const { newestColumn, chosen, planRows } = await import('../src/engine/db/sample.js');
const { fakeDocument, fakeBson } = await import('../src/engine/db/bson.js');
const { readValues, fakeLine } = await import('../src/engine/db/mysql.js');
const { scrub, secretsOf, lineByLine } = await import('../src/engine/db/run.js');
const { putMark, readMark, dropMark } = await import('../src/engine/db/made.js');
const { dbAdapter, readTemplate } = await import('../src/engine/db/index.js');
const { DbError } = await import('../src/engine/db/types.js');
type Dialect = import('../src/engine/db/sample.js').Dialect;
type Table = import('../src/engine/db/sample.js').Table;

afterEach(() => {
  delete process.env.SQUAD_DB_TOOL_DIRS;
});

describe('addresses, in the forms apps write them', () => {
  it('reads a Postgres link and changes only the name', () => {
    const a = readAddress('postgres', 'postgres://app:p%40ss%3Aword@db.local:6543/clinic?sslmode=require');
    expect(a).toMatchObject({ name: 'clinic', host: 'db.local', port: 6543, user: 'app', password: 'p@ss:word', params: { sslmode: 'require' } });
    expect(a.withName('clinic_t_1')).toBe('postgres://app:p%40ss%3Aword@db.local:6543/clinic_t_1?sslmode=require');
    expect(a.safe).toBe('postgres://app:***@db.local:6543/clinic?sslmode=require');
    expect(a.server).toBe('postgres:db.local:6543');
  });

  it('reads JDBC links, key=value strings and .NET connection strings', () => {
    const jdbc = readAddress('postgres', 'jdbc:postgresql://localhost:5432/clinic?user=app&password=secret1');
    expect(jdbc).toMatchObject({ name: 'clinic', user: 'app', password: 'secret1' });
    expect(jdbc.withName('x')).toBe('jdbc:postgresql://localhost:5432/x?user=app&password=secret1');
    expect(jdbc.safe).not.toContain('secret1');

    const libpq = readAddress('postgres', "host=localhost port=5433 dbname=clinic user=app password='a b c'");
    expect(libpq).toMatchObject({ name: 'clinic', port: 5433, password: 'a b c' });
    expect(libpq.withName('clinic_t_1')).toBe("host=localhost port=5433 dbname=clinic_t_1 user=app password='a b c'");

    const net = readAddress('postgres', 'Host=127.0.0.1;Port=5432;Database=Clinic;Username=app;Password="semi;colon"');
    expect(net).toMatchObject({ name: 'Clinic', password: 'semi;colon', server: 'postgres:localhost:5432' });
    expect(net.withName('clinic_t_1')).toBe('Host=127.0.0.1;Port=5432;Database=clinic_t_1;Username=app;Password="semi;colon"');
    expect(net.safe).not.toContain('semi');

    const my = readAddress('mysql', 'Server=localhost;Database=clinic;Uid=root;Pwd=pw12345;');
    expect(my).toMatchObject({ name: 'clinic', user: 'root', password: 'pw12345' });
    expect(my.withName('clinic_t_1')).toBe('Server=localhost;Database=clinic_t_1;Uid=root;Pwd=pw12345;');
  });

  it('reads Mongo links with many hosts, and keeps where the user signs in', () => {
    const a = readAddress('mongo', 'mongodb://app:pw@h2:27018,h1:27017/clinic?replicaSet=rs0');
    expect(a).toMatchObject({ name: 'clinic', user: 'app', password: 'pw', hosts: 'h2:27018,h1:27017' });
    expect(a.server).toBe('mongo:h1:27017,h2:27018');
    // The user is in "clinic": the story's link still signs in there.
    expect(a.withName('clinic_t_1')).toBe('mongodb://app:pw@h2:27018,h1:27017/clinic_t_1?replicaSet=rs0&authSource=clinic');
    expect(readAddress('mongo', 'mongodb://app:pw@h/clinic?authSource=admin').withName('x')).toBe('mongodb://app:pw@h/x?authSource=admin');
    expect(readAddress('mongo', 'mongodb://h:27017/clinic').withName('x')).toBe('mongodb://h:27017/x');
    expect(readAddress('mongo', 'mongodb+srv://u:p@cluster0.example.net/clinic').srv).toBe(true);
    expect(() => readAddress('mongo', 'mongodb://localhost:27017')).toThrow(/names no database/);
  });

  it("a Mongo story's address stays valid with a ? or & already there, and a link with no name gets none", () => {
    expect(readAddress('mongo', 'mongodb://u:p@h:27017/orders?').withName('orders_s_1')).toBe('mongodb://u:p@h:27017/orders_s_1?authSource=orders');
    expect(readAddress('mongo', 'mongodb://u:p@h:27017/orders?w=1&').withName('orders_s_1')).toBe('mongodb://u:p@h:27017/orders_s_1?w=1&authSource=orders');
    expect(dbAdapter('mongo').storyAddress('mongodb://u:p@h:27017/orders?authMechanism=SCRAM-SHA-256', { id: 'S-1' })).toBe('mongodb://u:p@h:27017/orders_s_1?authMechanism=SCRAM-SHA-256&authSource=orders');
    // No name to give it another of: refused in plain words before any story address is made.
    expect(() => dbAdapter('mongo').storyAddress('mongodb://u:p@h:27017/?authMechanism=SCRAM-SHA-256', { id: 'S-1' })).toThrow(/names no database/);
  });

  it('reads SQLite files in their forms, and only by a full path', () => {
    expect(readAddress('sqlite', 'file:/srv/app/dev.db').withName('/tmp/x.db')).toBe('file:/tmp/x.db');
    expect(readAddress('sqlite', 'sqlite:////srv/app/dev.db').name).toBe('/srv/app/dev.db');
    expect(readAddress('sqlite', 'Data Source=/srv/app/dev.db;Cache=Shared').withName('/tmp/x.db')).toBe('Data Source=/tmp/x.db;Cache=Shared');
    expect(readAddress('sqlite', 'jdbc:sqlite:/srv/app/dev.db').name).toBe('/srv/app/dev.db');
    expect(() => readAddress('sqlite', 'file:./dev.db')).toThrow(/full path/);
  });

  it('guesses the kind from the form', () => {
    expect(kindOfAddress('postgresql://x/y')).toBe('postgres');
    expect(kindOfAddress('mysql://x/y')).toBe('mysql');
    expect(kindOfAddress('mongodb+srv://x/y')).toBe('mongo');
    expect(kindOfAddress('file:/x/dev.db')).toBe('sqlite');
    expect(kindOfAddress('host=x dbname=y')).toBe('postgres');
    expect(kindOfAddress('Server=x;Database=y;Uid=a;Pwd=b')).toBe('mysql');
    expect(kindOfAddress('Server=x;Database=y')).toBeNull();
  });

  it('turns a bad address into plain words', () => {
    expect(() => readAddress('postgres', 'postgres://localhost:5432')).toThrow(DbError);
    expect(() => readAddress('postgres', '')).toThrow(/empty/);
  });
});

describe('story names', () => {
  it('are `<source>_<story>` in a safe form', () => {
    expect(storyName('clinic', 'CLINIC-12')).toBe('clinic_clinic_12');
    expect(storyName('Clinic-DB', 'Story 7/b')).toBe('clinic_db_story_7_b');
    expect(safePart('Ünïcode ñame')).toBe('unicode_name');
    expect(templateName('clinic')).toBe('clinic_sk_template');
    expect(() => storyName('clinic', '---')).toThrow(DbError);
  });

  it('fit every server’s limit, the same way every time', () => {
    const long = storyName('a_very_long_database_name_that_goes_on_and_on_for_ever_and_ever', 'PROJECT-123456');
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long.endsWith('_project_123456')).toBe(true);
    expect(storyName('a_very_long_database_name_that_goes_on_and_on_for_ever_and_ever', 'PROJECT-123456')).toBe(long);
    expect(storyName('a_very_long_database_name_that_goes_on_and_on_for_ever_and_ever_2', 'PROJECT-123456')).not.toBe(long);
  });

  it('every adapter writes the story’s address in the person’s own form', () => {
    expect(dbAdapter('postgres').storyAddress('Host=db;Database=clinic;Password=x1', { id: 'C-1' })).toBe('Host=db;Database=clinic_c_1;Password=x1');
    expect(dbAdapter('mysql').storyAddress('mysql://u:p@db/clinic', { id: 'C-1' })).toBe('mysql://u:p@db/clinic_c_1');
    expect(dbAdapter('mongo').storyAddress('mongodb://db/clinic', { id: 'C-1' })).toBe('mongodb://db/clinic_c_1');
    expect(dbAdapter('sqlite').storyAddress('file:/srv/app/dev.db', { id: 'C-1', folder: '/work/c-1' })).toBe('file:/work/c-1/dev_c_1.db');
    expect(dbAdapter('postgres').nameOf('postgres://db/clinic')).toBe('clinic');
  });
});

describe('the person’s own database', () => {
  it('is the same name on any host, port or user, and anything that cannot be read', () => {
    expect(isPersonsOwn('postgres', 'postgres://a@localhost:5432/clinic', 'postgres://b@127.0.0.1/clinic')).toBe(true);
    expect(isPersonsOwn('postgres', 'postgres://other-host/CLINIC', 'postgres://localhost/clinic')).toBe(true);
    expect(isPersonsOwn('postgres', 'postgres://localhost/clinic_c_1', 'postgres://localhost/clinic')).toBe(false);
    expect(isPersonsOwn('mysql', 'not an address', 'mysql://localhost/clinic')).toBe(true);
    expect(dbAdapter('mongo').isPersonsOwn('mongodb://h/clinic', 'mongodb://h/clinic')).toBe(true);
  });

  it('is refused with plain words, and so are the server’s own databases', () => {
    expect(() => refuseOwn('postgres', 'postgres://h/clinic', 'postgres://h/clinic', 'drops')).toThrow(/never drops your own database/);
    for (const [kind, name] of [
      ['postgres', 'template1'],
      ['mysql', 'mysql'],
      ['mongo', 'admin'],
    ] as const) {
      const scheme = kind === 'mongo' ? 'mongodb' : kind;
      try {
        refuseOwn(kind, `${scheme}://h/${name}`, `${scheme}://h/clinic`, 'drops');
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(DbError);
        expect((e as InstanceType<typeof DbError>).reason).toBe('persons-own');
      }
    }
  });

  it('is refused before any tool runs', async () => {
    for (const kind of ['postgres', 'mysql', 'mongo'] as const) {
      const scheme = kind === 'mongo' ? 'mongodb' : kind;
      await expect(dbAdapter(kind).dropStoryDb(`${scheme}://h/clinic`, `${scheme}://h/clinic`)).rejects.toMatchObject({ reason: 'persons-own' });
    }
    await expect(dbAdapter('sqlite').dropStoryDb('/srv/app/dev.db', 'file:/srv/app/dev.db')).rejects.toMatchObject({ reason: 'persons-own' });
  });
});

describe('personal data, by column name', () => {
  it('finds names, ID numbers, phones, emails, addresses and birth dates', () => {
    const cases: [string, string, string | null][] = [
      ['first_name', 'patients', 'first-name'],
      ['FirstNameAr', 'patients', 'first-name'],
      ['lastName', 'x', 'last-name'],
      ['surname', 'x', 'last-name'],
      ['full_name', 'doctors', 'name'],
      ['patient_name', 'visits', 'name'],
      ['name', 'patients', 'name'],
      ['name_ar', 'customers', 'name'],
      ['name', 'specialties', null],
      ['company_name', 'clients', null],
      ['file_name', 'patients', null],
      ['username', 'users', 'username'],
      ['user_name', 'users', 'username'],
      ['email', 'x', 'email'],
      ['contactEmail', 'x', 'email'],
      ['email_address', 'x', 'email'],
      ['email_verified_at', 'x', null],
      ['phone', 'x', 'phone'],
      ['mobileNumber', 'x', 'phone'],
      ['phone_verified', 'x', null],
      ['national_id', 'x', 'id-number'],
      ['nationalNumber', 'x', 'id-number'],
      ['passport_no', 'x', 'id-number'],
      ['ssn', 'x', 'id-number'],
      ['id_number', 'x', 'id-number'],
      ['patient_id', 'visits', null],
      ['id', 'patients', null],
      ['_id', 'patients', null],
      ['address', 'x', 'address'],
      ['home_address_line1', 'x', 'address'],
      ['street', 'x', 'address'],
      ['ip_address', 'x', null],
      ['address_id', 'x', null],
      ['birth_date', 'x', 'birth-date'],
      ['dateOfBirth', 'x', 'birth-date'],
      ['dob', 'x', 'birth-date'],
      ['birth_place', 'x', null],
      ['created_at', 'patients', null],
      ['is_email_public', 'x', null],
    ];
    for (const [column, table, kind] of cases) expect([column, personalKind(column, table)]).toEqual([column, kind]);
  });

  it('fakes only where the fake fits the column', () => {
    expect(fits('name', typeClass('character varying(50)'))).toBe(true);
    expect(fits('phone', typeClass('bigint'))).toBe(true);
    expect(fits('name', typeClass('jsonb'))).toBe(false);
    expect(fits('birth-date', typeClass('timestamp without time zone'))).toBe(true);
    expect(fits('email', typeClass('integer'))).toBe(false);
    expect(fits('name', typeClass('text[]'))).toBe(false);
    expect(fitLength('user_123456789abc@example.com', 'varchar(10)')).toBe('user_12345');
    expect(fitLength('Lina Haddad', 'text')).toBe('Lina Haddad');
  });
});

describe('fake values', () => {
  it('are the same for the same value within a template, and new for each template', () => {
    const f = makeFaker();
    expect(f('name', 'Fatima Saleh')).toBe(f('name', 'Fatima Saleh'));
    expect(f('email', 'fatima@clinic.test')).toMatch(/^user_[0-9a-f]{12}@example\.com$/);
    expect(f('email', 'a@b.test')).not.toBe(f('email', 'c@d.test'));
    const other = makeFaker();
    const values = ['a@b.test', 'c@d.test', 'e@f.test'];
    expect(values.map((v) => other('email', v))).not.toEqual(values.map((v) => f('email', v)));
  });

  it('keep the shape of phones and ID numbers, and never make two the same', () => {
    const f = makeFaker(Buffer.alloc(32, 7));
    const phone = f('phone', '+966 (50) 123-4567');
    expect(phone).toMatch(/^\+\d{3} \(\d{2}\) \d{3}-\d{4}$/);
    expect(phone).not.toBe('+966 (50) 123-4567');
    expect(f('id-number', 'AB0123')).toMatch(/^[A-Z]{2}0\d{3}$/);
    expect(f('phone', '5551234')).toMatch(/^[1-9]\d{6}$/);
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(f('id-number', `N${String(i).padStart(4, '0')}`));
    expect(seen.size).toBe(5000);
    for (let i = 0; i < 300; i++) seen.add(f('phone', String(100 + i)));
    expect(seen.size).toBe(5300);
  });

  it('keep dates as dates, in their format', () => {
    const f = makeFaker();
    expect(f('birth-date', '1987-06-15')).toMatch(/^(19[5-9]\d|200[0-5])-\d{2}-\d{2}$/);
    expect(f('birth-date', '1987-06-15 08:30:00+00')).toMatch(/^\d{4}-\d{2}-\d{2} 08:30:00\+00$/);
    expect(f('birth-date', '15/06/1987')).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    const ms = Date.UTC(1987, 5, 15, 9, 30);
    const fake = new Date(fakeDateMs(f, ms));
    expect(fake.getUTCHours()).toBe(9);
    expect(fake.getUTCMinutes()).toBe(30);
    expect(fakeDateMs(f, ms)).toBe(fakeDateMs(f, ms));
  });
});

describe('which rows a template keeps', () => {
  const dialect: Dialect = {
    quote: (n) => `"${n}"`,
    text: (c) => `${c}::text`,
    jsonArray: (v) => `json_build_array(${v.join(', ')})`,
    literal: (t) => `'${t.replace(/'/g, "''")}'`,
    rowId: 'ctid',
    inTuples: (cols, tuples) => (cols.length === 1 ? `${cols[0]} IN (${tuples.map((t) => t[0]).join(', ')})` : `(${cols.join(', ')}) IN (${tuples.map((t) => `(${t.join(', ')})`).join(', ')})`),
    nullsLast: ' NULLS LAST',
  };
  const table = (name: string, columns: [string, string][], pk: string[] = ['id']): Table => ({ name, ref: `"${name}"`, columns: columns.map(([n, type]) => ({ name: n, type })), pk });

  it('picks the newest rows by a created time, else another time, else the id', () => {
    expect(newestColumn(table('a', [['id', 'int'], ['updated_at', 'timestamp'], ['created_at', 'timestamp']]))).toBe('created_at');
    expect(newestColumn(table('a', [['id', 'int'], ['updated_at', 'timestamp'], ['visited_at', 'timestamp']]))).toBe('visited_at');
    expect(newestColumn(table('a', [['id', 'int'], ['birth_date', 'date']]))).toBe('id');
    expect(newestColumn(table('a', [['id', 'INTEGER'], ['created_at', 'TEXT']]))).toBe('created_at');
    expect(newestColumn(table('a', [['code', 'text']], []))).toBeNull();
  });

  it('follows foreign keys from kept rows to the rows they point at, until nothing is missing', async () => {
    const visits = table('visits', [['id', 'int'], ['patient_id', 'int'], ['visited_at', 'timestamp']]);
    const patients = table('patients', [['id', 'int'], ['created_at', 'timestamp']]);
    const asked: string[] = [];
    let pass = 0;
    const query = async (sql: string) => {
      asked.push(sql);
      if (sql.includes('count(*)')) return ['[0, 1001]', '[1, 1001]'];
      pass++;
      // Pass 1: kept visits point at patients 5 and 6; patient 6 is among the newest. Pass 2: nothing missing.
      return pass === 1 ? ['["n0", "5"]', '["n0", "6"]', '["h0", "6"]'] : ['["n0", "5"]', '["n0", "6"]', '["h0", "5"]', '["h0", "6"]'];
    };
    const plan = await planRows([visits, patients], [{ child: 'visits', cols: ['patient_id'], parent: 'patients', refCols: ['id'] }], dialect, query, { smallRows: 1000, sampleRows: 100 });
    expect(plan.complete).toBe(true);
    expect(pass).toBe(2);
    expect(chosen(plan, dialect, visits)).toEqual({ where: '1=1', tail: ' ORDER BY "visited_at" DESC NULLS LAST, "id" DESC LIMIT 100' });
    expect(chosen(plan, dialect, patients).where).toBe(
      `("id" IN (SELECT "id" FROM (SELECT "id" FROM "patients" ORDER BY "created_at" DESC NULLS LAST, "id" DESC LIMIT 100) sk_newest) OR "id" IN ('5'))`,
    );
  });

  it('stops when a row points at one that is not there, and keeps small tables whole', async () => {
    const child = table('visits', [['id', 'int'], ['patient_id', 'int']]);
    const parent = table('patients', [['id', 'int']]);
    let passes = 0;
    const query = async (sql: string) => {
      if (sql.includes('count(*)')) return ['[0, 1001]', '[1, 1001]'];
      passes++;
      // Patient 9 is missing in the source itself: asked for once, never again.
      return ['["n0", "9"]'];
    };
    const plan = await planRows([child, parent], [{ child: 'visits', cols: ['patient_id'], parent: 'patients', refCols: ['id'] }], dialect, query, { smallRows: 1000, sampleRows: 100 });
    expect(passes).toBe(2);
    expect(plan.complete).toBe(true);

    const small = await planRows([child, parent], [{ child: 'visits', cols: ['patient_id'], parent: 'patients', refCols: ['id'] }], dialect, async () => ['[0, 5]', '[1, 5]'], { smallRows: 1000, sampleRows: 100 });
    expect(chosen(small, dialect, child)).toEqual({ where: '1=1', tail: '' });
  });
});

/** A tiny BSON writer for the tests: strings, 32-bit numbers, dates, documents and arrays. */
function bson(doc: Record<string, unknown>): Buffer {
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(doc)) {
    const name = Buffer.from(`${k}\0`);
    if (typeof v === 'string') {
      const body = Buffer.from(`${v}\0`);
      const len = Buffer.alloc(4);
      len.writeInt32LE(body.length);
      parts.push(Buffer.from([0x02]), name, len, body);
    } else if (typeof v === 'number') {
      const b = Buffer.alloc(4);
      b.writeInt32LE(v);
      parts.push(Buffer.from([0x10]), name, b);
    } else if (v instanceof Date) {
      const b = Buffer.alloc(8);
      b.writeBigInt64LE(BigInt(v.getTime()));
      parts.push(Buffer.from([0x09]), name, b);
    } else if (Array.isArray(v)) {
      parts.push(Buffer.from([0x04]), name, bson(Object.fromEntries(v.map((x, i) => [String(i), x]))));
    } else {
      parts.push(Buffer.from([0x03]), name, bson(v as Record<string, unknown>));
    }
  }
  const body = Buffer.concat(parts);
  const size = Buffer.alloc(4);
  size.writeInt32LE(body.length + 5);
  return Buffer.concat([size, body, Buffer.from([0])]);
}

/** Reads back what the tiny writer wrote. */
function unbson(buf: Buffer, asArray = false): unknown {
  const out: Record<string, unknown> = {};
  let i = 4;
  while (i < buf.readInt32LE(0) - 1) {
    const type = buf[i]!;
    const end = buf.indexOf(0, i + 1);
    const name = buf.toString('utf8', i + 1, end);
    i = end + 1;
    if (type === 0x02) {
      const len = buf.readInt32LE(i);
      out[name] = buf.toString('utf8', i + 4, i + 4 + len - 1);
      i += 4 + len;
    } else if (type === 0x10) {
      out[name] = buf.readInt32LE(i);
      i += 4;
    } else if (type === 0x09) {
      out[name] = new Date(Number(buf.readBigInt64LE(i)));
      i += 8;
    } else {
      const len = buf.readInt32LE(i);
      out[name] = unbson(buf.subarray(i, i + len), type === 0x04);
      i += len;
    }
  }
  return asArray ? Object.values(out) : out;
}

describe('hiding personal data in a MongoDB dump', () => {
  const kindOf = (field: string, inside: string) => personalKind(field, inside);

  it('fakes personal strings and birth dates, and copies everything else byte for byte', () => {
    const f = makeFaker(Buffer.alloc(32, 1));
    const born = new Date(Date.UTC(1987, 5, 15, 9, 30));
    const doc = bson({ firstName: 'Fatima', visits: 4, birthDate: born, notes: 'kept', contact: { phone: '+1 555 0100', city: 'Town' }, family: [{ name: 'Kin One' }], phones: ['+1 555 0101'] });
    const out = unbson(fakeDocument(doc, 'patients', kindOf, f)!) as Record<string, any>;
    expect(out.firstName).not.toBe('Fatima');
    expect(out.firstName).toBe(f('first-name', 'Fatima'));
    expect(out.visits).toBe(4);
    expect(out.notes).toBe('kept');
    expect(out.contact.city).toBe('Town');
    expect(out.contact.phone).toMatch(/^\+\d \d{3} \d{4}$/);
    expect(out.family[0].name).toBe(f('name', 'Kin One'));
    expect(out.phones[0]).not.toBe('+1 555 0101');
    expect(out.birthDate.getUTCHours()).toBe(9);
    expect(out.birthDate.getTime()).not.toBe(born.getTime());
    // Nothing personal: the same bytes, untouched.
    expect(fakeDocument(bson({ title: 'x', count: 2 }), 'notes', kindOf, f)).toBeNull();
  });

  it('works on a stream cut anywhere', async () => {
    const f = makeFaker();
    const docs = Buffer.concat([bson({ email: 'one@clinic.test' }), bson({ email: 'two@clinic.test', n: 1 })]);
    const t = fakeBson('users', kindOf, f);
    const out: Buffer[] = [];
    t.on('data', (d: Buffer) => out.push(d));
    for (let i = 0; i < docs.length; i += 7) t.write(docs.subarray(i, i + 7));
    t.end();
    await new Promise((r) => t.on('end', r));
    const all = Buffer.concat(out);
    const first = all.readInt32LE(0);
    expect((unbson(all.subarray(0, first)) as { email: string }).email).toMatch(/@example\.com$/);
    expect((unbson(all.subarray(first)) as { n: number }).n).toBe(1);
    expect(all.toString('latin1')).not.toContain('clinic.test');
  });
});

describe('hiding personal data in a MySQL dump', () => {
  it('reads each value of a dumped row, quotes and escapes and all', () => {
    expect(readValues(`1,'O\\'Neil, Sr.',NULL,0x00FF,'a\\nb',-2.5,_binary 'x'`)).toEqual(['1', `'O\\'Neil, Sr.'`, 'NULL', '0x00FF', `'a\\nb'`, '-2.5', `_binary 'x'`]);
  });

  it('fakes the personal columns of a dumped row and leaves the rest', () => {
    const f = makeFaker();
    const line = "INSERT INTO `patients` (`id`, `first_name`, `phone`, `photo`, `notes`) VALUES (7,'Fatima','+1 555 0100',0x00FF,'it\\'s fine');";
    const out = fakeLine(
      line,
      new Map([
        ['first_name', { kind: 'first-name' as const, type: 'varchar(50)' }],
        ['phone', { kind: 'phone' as const, type: 'varchar(30)' }],
      ]),
      f,
    );
    expect(out).toBe(`INSERT INTO \`patients\` (\`id\`, \`first_name\`, \`phone\`, \`photo\`, \`notes\`) VALUES (7,'${f('first-name', 'Fatima')}','${f('phone', '+1 555 0100')}',0x00FF,'it\\'s fine');`);
  });
});

describe('reading a tool’s output line by line', () => {
  it('never cuts a letter in two where a chunk ends', async () => {
    const t = lineByLine((l) => l);
    const out: string[] = [];
    t.on('data', (d: Buffer) => out.push(d.toString()));
    const bytes = Buffer.from('ملاحظة طويلة\nسطر ثان', 'utf8');
    for (let i = 0; i < bytes.length; i += 3) t.write(bytes.subarray(i, i + 3));
    t.end();
    await new Promise((r) => t.on('end', r));
    expect(out.join('')).toBe('ملاحظة طويلة\nسطر ثان');
  });
});

describe('passwords', () => {
  it('never show in what squad-kit says, in any of their forms', () => {
    const pw = 'p@ss:w rd';
    const said = `could not connect to mongodb://app:${encodeURIComponent(pw)}@h/x with ${pw}`;
    const out = scrub(said, secretsOf(pw));
    expect(out).not.toContain(pw);
    expect(out).not.toContain(encodeURIComponent(pw));
  });
});

describe('tools that are not on this computer', () => {
  it('are named, and making a template says so in plain words', async () => {
    process.env.SQUAD_DB_TOOL_DIRS = path.join(os.tmpdir(), 'no-such-folder');
    expect(dbAdapter('postgres').missingTools()).toEqual(['psql', 'pg_dump']);
    expect(dbAdapter('mongo').missingTools()).toEqual(['mongosh', 'mongodump', 'mongorestore']);
    await expect(dbAdapter('mysql').makeTemplate('mysql://u:p@h/clinic', { folder: path.join(os.tmpdir(), 'never-made') })).rejects.toMatchObject({ reason: 'missing-tool' });
    await expect(dbAdapter('postgres').makeTemplate('postgres://u:p@h/clinic', { folder: path.join(os.tmpdir(), 'never-made') })).rejects.toThrow(/needs pg_dump, which is not on this computer/);
    expect(fs.existsSync(path.join(os.tmpdir(), 'never-made'))).toBe(false);
  });
});

describe('squad-kit’s mark on what it made', () => {
  it('is one file per database in squad-kit’s own folder', () => {
    putMark({ kind: 'mysql', server: 'mysql:localhost:3306', name: 'clinic_c_1', role: 'story', story: 'C-1', sourceName: 'clinic', madeAt: '2026-11-09T00:00:00Z' });
    expect(readMark('mysql', 'mysql:localhost:3306', 'CLINIC_C_1')).toMatchObject({ story: 'C-1' });
    expect(readMark('mysql', 'mysql:otherhost:3306', 'clinic_c_1')).toBeNull();
    expect(readMark('postgres', 'mysql:localhost:3306', 'clinic_c_1')).toBeNull();
    dropMark('mysql', 'mysql:localhost:3306', 'clinic_c_1');
    expect(readMark('mysql', 'mysql:localhost:3306', 'clinic_c_1')).toBeNull();
  });
});

describe('a template made earlier', () => {
  it('reads back from its folder, with the address given now', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-template-'));
    fs.writeFileSync(path.join(folder, 'template.json'), JSON.stringify({ kind: 'mongo', source: 'mongodb://h/clinic', sourceName: 'clinic', tables: [] }));
    expect(readTemplate(folder, 'mongodb://u:p@h/clinic')).toMatchObject({ kind: 'mongo', folder, source: 'mongodb://u:p@h/clinic' });
    expect(readTemplate(path.join(folder, 'nothing'), 'x')).toBeNull();
    fs.rmSync(folder, { recursive: true, force: true });
  });
});
