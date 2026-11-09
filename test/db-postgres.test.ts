import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CLINIC, scratch, startPostgres, type Server } from './support/db-servers.js';

/**
 * The Postgres adapter, for real: a throwaway Postgres 16 in a container this test makes and removes, a made-up clinic
 * in it, and a template and story databases made from it. Skips when Docker, the image or psql and pg_dump are not here.
 */

const { postgres } = await import('../src/engine/db/postgres.js');
const { DbError } = await import('../src/engine/db/types.js');

const PASSWORD = 'pg:Pa ss@w/rd%1';
let server: Server | null = null;
let dir = '';
let source = '';

const CLINIC_SQL = `
CREATE TABLE doctors (id serial PRIMARY KEY, full_name text NOT NULL, email text UNIQUE, specialty text);
CREATE TABLE patients (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, first_name text, last_name text, national_id varchar(20) UNIQUE,
  phone text, birth_date date, address text, created_at timestamptz NOT NULL, doctor_id int REFERENCES doctors(id));
CREATE TABLE visits (id serial PRIMARY KEY, patient_id bigint NOT NULL REFERENCES patients(id), doctor_id int REFERENCES doctors(id),
  visited_at timestamp NOT NULL, notes text, total numeric(10,2), twice numeric GENERATED ALWAYS AS (total * 2) STORED);
CREATE INDEX visits_when ON visits (visited_at DESC);
CREATE VIEW recent_visits AS SELECT id, patient_id FROM visits ORDER BY visited_at DESC LIMIT 10;
CREATE SCHEMA billing;
CREATE TABLE billing.invoices (id serial PRIMARY KEY, visit_id int REFERENCES visits(id), amount numeric(10,2));
INSERT INTO doctors (full_name, email, specialty) SELECT 'Doctor ' || g, 'doctor' || g || '@clinic.test', 'General' FROM generate_series(1, ${CLINIC.doctors}) g;
INSERT INTO patients (first_name, last_name, national_id, phone, birth_date, address, created_at, doctor_id)
  SELECT 'Realname' || g, CASE WHEN g % 2 = 0 THEN 'Samefamily' ELSE 'Other' || g END, 'NID' || lpad(g::text, 6, '0'), '+1 555 01' || lpad(g::text, 4, '0'),
    date '1980-01-01' + g, g || E' Real Street\\nFlat 2', now() - (g || ' days')::interval, 1 + g % ${CLINIC.doctors}
  FROM generate_series(1, ${CLINIC.patients}) g;
INSERT INTO visits (patient_id, doctor_id, visited_at, notes, total)
  SELECT (SELECT min(id) FROM patients) + (g * 7) % ${CLINIC.patients}, 1 + g % ${CLINIC.doctors}, now() - (g || ' hours')::interval, E'note\\twith a tab ' || g || ' ' || repeat('ملاحظة طويلة ', 40), g * 1.5
  FROM generate_series(1, ${CLINIC.visits}) g;
INSERT INTO billing.invoices (visit_id, amount) SELECT id, total FROM visits;
`;

const one = (sql: string, db: string) => server!.admin(sql, db).trim();

beforeAll(async () => {
  server = await startPostgres(PASSWORD);
  if (!server) return;
  dir = scratch('pg-files');
  server.admin('CREATE DATABASE clinic');
  server.admin(CLINIC_SQL, 'clinic');
  source = server.address('clinic');
}, 180_000);

afterAll(async () => {
  await server?.stop();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}, 120_000);

const fingerprint = () => one(`SELECT md5(string_agg(t::text, ',' ORDER BY t::text)) FROM (SELECT * FROM patients) t`, 'clinic') + one('SELECT count(*) FROM visits', 'clinic');

describe('Postgres databases per story', () => {
  it('makes a template: schema and indexes kept, small tables whole, big ones sampled, linked rows kept', async (ctx) => {
    if (!server) return ctx.skip();
    const before = fingerprint();
    const t = await postgres.makeTemplate(source, { folder: path.join(dir, 'template'), smallRows: 50, sampleRows: 100 });
    // Read only: the person's database is just as it was.
    expect(fingerprint()).toBe(before);
    const byName = Object.fromEntries(t.info.tables.map((x) => [x.name, x]));
    expect(byName.doctors).toMatchObject({ kept: 'whole', rows: CLINIC.doctors });
    // The 100 newest visits, and the 100 older ones the newest invoices are for.
    expect(byName.visits).toMatchObject({ kept: 'sampled', rows: 200, newestBy: 'visited_at', linked: 100 });
    expect(byName.patients!.kept).toBe('sampled');
    expect(byName.patients!.newestBy).toBe('created_at');
    expect(byName.patients!.linked).toBeGreaterThan(0);
    expect(byName['billing.invoices']).toMatchObject({ kept: 'sampled' });
    expect(t.info.linksComplete).toBe(true);
    expect(t.info.source).not.toContain('Pa ss');
    expect(t.info.hidden).toEqual([]);
    expect(t.info.bytes).toBeGreaterThan(0);
    // The template database waits on the server, closed to connections, marked as squad-kit's.
    expect(one(`SELECT datallowconn::text || ' ' || shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = 'clinic_sk_template'`, 'postgres')).toBe('false squad-kit template of clinic');
    // Never in the template's files: the password.
    for (const f of fs.readdirSync(t.folder)) expect(fs.readFileSync(path.join(t.folder, f), 'utf8')).not.toContain('Pa ss');

    const story = await postgres.createStoryDb(t, { id: 'CLINIC-12' });
    expect(story).toMatchObject({ kind: 'postgres', name: 'clinic_clinic_12', existed: false });
    expect(story.address).toBe(source.replace('/clinic', '/clinic_clinic_12'));
    const db = story.name;
    expect(one(`SELECT string_agg(tablename, ',' ORDER BY tablename) FROM pg_tables WHERE schemaname IN ('public', 'billing')`, db)).toBe('doctors,invoices,patients,visits');
    expect(one(`SELECT string_agg(indexname, ',' ORDER BY indexname) FROM pg_indexes WHERE tablename = 'visits'`, db)).toBe('visits_pkey,visits_when');
    expect(one(`SELECT count(*) FROM pg_constraint WHERE contype = 'f'`, db)).toBe('4');
    expect(one(`SELECT count(*) FROM pg_views WHERE viewname = 'recent_visits'`, db)).toBe('1');
    expect(one('SELECT count(*) FROM doctors', db)).toBe(String(CLINIC.doctors));
    expect(one('SELECT count(*) FROM visits', db)).toBe('200');
    // The newest visits, each with its patient and doctor.
    expect(one('SELECT max(visited_at) = (SELECT max(visited_at) FROM visits) FROM visits', db)).toBe('t');
    expect(one('SELECT count(*) FROM visits v LEFT JOIN patients p ON p.id = v.patient_id WHERE p.id IS NULL', db)).toBe('0');
    expect(one('SELECT count(*) FROM billing.invoices i LEFT JOIN visits v ON v.id = i.visit_id WHERE v.id IS NULL', db)).toBe('0');
    // Values exactly as in the source: tabs, new lines, generated columns.
    expect(one(`SELECT notes FROM visits ORDER BY visited_at DESC LIMIT 1`, db)).toBe(one(`SELECT notes FROM visits ORDER BY visited_at DESC LIMIT 1`, 'clinic'));
    expect(one(`SELECT count(*) FROM visits WHERE twice = total * 2`, db)).toBe('200');
    // Long Arabic notes, cut between chunks on the way, come through whole.
    const ids = one('SELECT string_agg(id::text, \',\') FROM visits', db);
    const notes = `SELECT string_agg(id::text || ':' || md5(notes), ',' ORDER BY id) FROM visits WHERE id IN (${ids})`;
    expect(one(notes, db)).toBe(one(notes, 'clinic'));
    expect(one(`SELECT first_name FROM patients ORDER BY created_at DESC LIMIT 1`, db)).toBe('Realname1');
    // New rows never take a kept row's id.
    const maxId = one('SELECT max(id) FROM patients', 'clinic');
    expect(Number(one(`INSERT INTO patients (first_name, created_at) VALUES ('New', now()) RETURNING id`, db))).toBeGreaterThan(Number(maxId));

    // Asked again for the same story: kept as it is.
    expect(await postgres.createStoryDb(t, { id: 'CLINIC-12' })).toMatchObject({ existed: true });
    expect(one(`SELECT count(*) FROM patients WHERE first_name = 'New'`, db)).toBe('1');

    // Dropped: only the story's database goes.
    expect(await postgres.dropStoryDb(story.address, source)).toBe(true);
    expect(one(`SELECT string_agg(datname, ',' ORDER BY datname) FROM pg_database WHERE datname LIKE 'clinic%'`, 'postgres')).toBe('clinic,clinic_sk_template');
    expect(fingerprint()).toBe(before);
    expect(await postgres.dropStoryDb(story.address, source)).toBe(false);
  }, 180_000);

  it('hides personal data when asked: consistent fake values, real ones never written', async (ctx) => {
    if (!server) return ctx.skip();
    const t = await postgres.makeTemplate(source, { folder: path.join(dir, 'hidden'), smallRows: 50, sampleRows: 100, hidePersonal: true });
    expect(t.info.hidden).toEqual(expect.arrayContaining(['doctors.full_name', 'doctors.email', 'patients.first_name', 'patients.last_name', 'patients.national_id', 'patients.phone', 'patients.birth_date', 'patients.address']));
    expect(t.info.hidden).not.toContain('visits.notes');
    for (const f of fs.readdirSync(t.folder)) {
      const text = fs.readFileSync(path.join(t.folder, f), 'utf8');
      for (const real of ['Realname', 'Samefamily', 'Real Street', '@clinic.test', 'NID000', '+1 555 01', 'Doctor 1']) expect(text).not.toContain(real);
    }
    const story = await postgres.createStoryDb(t, { id: 'CLINIC-13' });
    const db = story.name;
    // The same real value became the same fake one; unique ones stayed unique; shapes kept.
    expect(one(`SELECT count(DISTINCT last_name) FROM patients WHERE id % 2 = 0`, db)).toBe('1');
    expect(one(`SELECT count(DISTINCT national_id) = count(*) FROM patients`, db)).toBe('t');
    expect(one(`SELECT bool_and(email LIKE '%@example.com') FROM doctors`, db)).toBe('t');
    expect(one(`SELECT bool_and(length(phone) = length('+1 555 010001') AND phone ~ '^\\+\\d \\d{3} \\d{6}$') FROM patients`, db)).toBe('t');
    expect(one(`SELECT bool_and(birth_date BETWEEN '1950-01-01' AND '2005-12-31') FROM patients`, db)).toBe('t');
    const ids = one('SELECT string_agg(id::text, \',\') FROM visits', db);
    const notes = `SELECT string_agg(id::text || ':' || md5(notes), ',' ORDER BY id) FROM visits WHERE id IN (${ids})`;
    expect(one(notes, db)).toBe(one(notes, 'clinic'));
    // Links still hold: ids are never faked.
    expect(one('SELECT count(*) FROM visits v JOIN patients p ON p.id = v.patient_id', db)).toBe('200');
    expect(await postgres.dropStoryDb(story.address, source)).toBe(true);
  }, 180_000);

  it('never makes, changes or drops the person’s own database, or one squad-kit did not make', async (ctx) => {
    if (!server) return ctx.skip();
    expect(postgres.isPersonsOwn(source, source)).toBe(true);
    expect(postgres.isPersonsOwn(source.replace('127.0.0.1', 'localhost'), source)).toBe(true);
    expect(postgres.isPersonsOwn(postgres.storyAddress(source, { id: 'CLINIC-12' }), source)).toBe(false);
    await expect(postgres.dropStoryDb(source, source)).rejects.toMatchObject({ reason: 'persons-own' });
    await expect(postgres.dropStoryDb(source.replace('/clinic', '/postgres'), source)).rejects.toMatchObject({ reason: 'persons-own' });
    // A database with a story's name that squad-kit did not make stays.
    server.admin('CREATE DATABASE clinic_clinic_99');
    const look = postgres.storyAddress(source, { id: 'CLINIC-99' });
    await expect(postgres.dropStoryDb(look, source)).rejects.toMatchObject({ reason: 'not-ours' });
    const t = await postgres.makeTemplate(source, { folder: path.join(dir, 'template'), smallRows: 50, sampleRows: 100 });
    await expect(postgres.createStoryDb(t, { id: 'CLINIC-99' })).rejects.toMatchObject({ reason: 'not-ours' });
    expect(one(`SELECT count(*) FROM pg_database WHERE datname = 'clinic_clinic_99'`, 'postgres')).toBe('1');
  }, 180_000);

  it('makes the story database from the files when the template database is gone', async (ctx) => {
    if (!server) return ctx.skip();
    const t = await postgres.makeTemplate(source, { folder: path.join(dir, 'files'), smallRows: 50, sampleRows: 100 });
    server.admin('DROP DATABASE clinic_sk_template');
    const story = await postgres.createStoryDb(t, { id: 'CLINIC-14' });
    expect(one('SELECT count(*) FROM visits', story.name)).toBe('200');
    expect(one(`SELECT count(*) FROM pg_indexes WHERE indexname = 'visits_when'`, story.name)).toBe('1');
    expect(await postgres.dropStoryDb(story.address, source)).toBe(true);
    await postgres.removeTemplate(t);
    expect(fs.existsSync(t.folder)).toBe(false);
  }, 180_000);

  it('says plainly when not every linked row could be kept, and the story database still loads', async (ctx) => {
    if (!server) return ctx.skip();
    // A chain of 100 referrals, each pointing at the one before: far longer than the passes a template takes.
    server.admin('CREATE DATABASE chain');
    server.admin(
      `CREATE TABLE referrals (id int PRIMARY KEY, referred_by int REFERENCES referrals(id));
       INSERT INTO referrals SELECT g, NULLIF(g - 1, 0) FROM generate_series(1, 100) g;`,
      'chain',
    );
    const chain = server.address('chain');
    const t = await postgres.makeTemplate(chain, { folder: path.join(dir, 'chain'), smallRows: 5, sampleRows: 10 });
    expect(t.info.linksComplete).toBe(false);
    expect(t.info.notes.join(' ')).toMatch(/Not every row that a kept row points at could be kept/);
    const story = await postgres.createStoryDb(t, { id: 'CHAIN-1' });
    // The newest 10 and the 30 they lead back to; the last one's link to a row not kept is emptied.
    expect(one('SELECT count(*) || \' \' || count(*) FILTER (WHERE referred_by IS NULL) FROM referrals', story.name)).toBe('40 1');
    expect(one(`SELECT count(*) FROM pg_constraint WHERE contype = 'f'`, story.name)).toBe('1');
    expect(await postgres.dropStoryDb(story.address, chain)).toBe(true);
    await postgres.removeTemplate(t);
  }, 180_000);

  it('never shows the password in an error', async (ctx) => {
    if (!server) return ctx.skip();
    const wrong = source.replace(encodeURIComponent(PASSWORD), encodeURIComponent('Wr0ng:secret-pass'));
    const e = await postgres.makeTemplate(wrong, { folder: path.join(dir, 'wrong') }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DbError);
    expect((e as Error).message).toMatch(/password authentication failed/);
    expect((e as Error).message).not.toContain('Wr0ng');
    const missing = await postgres.makeTemplate(source.replace('/clinic', '/no_such_db'), { folder: path.join(dir, 'missing') }).catch((x: unknown) => x);
    expect((missing as Error).message).toMatch(/does not exist/);
    expect((missing as Error).message).not.toContain('Pa ss');
    expect(fs.existsSync(path.join(dir, 'missing'))).toBe(false);
  }, 120_000);
});
