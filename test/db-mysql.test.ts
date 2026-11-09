import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CLINIC, scratch, startMysql, type Server } from './support/db-servers.js';

/**
 * The MySQL adapter, for real: a throwaway mysqld on a temp folder and its own port, a made-up clinic in it, and a
 * template and story databases made from it. Skips when mysqld, mysql or mysqldump are not here, or will not start.
 */

const { mysql } = await import('../src/engine/db/mysql.js');
const { DbError } = await import('../src/engine/db/types.js');

const PASSWORD = "my;Pa ss'w\"rd@1";
let server: Server | null = null;
let dir = '';
let source = '';

const CLINIC_SQL = `
CREATE TABLE doctors (id int AUTO_INCREMENT PRIMARY KEY, full_name varchar(100) NOT NULL, email varchar(100) UNIQUE, specialty varchar(50));
CREATE TABLE patients (id bigint AUTO_INCREMENT PRIMARY KEY, first_name varchar(50), last_name varchar(50), national_id varchar(20) UNIQUE,
  phone varchar(30), birth_date date, address text, created_at datetime NOT NULL, doctor_id int, photo blob, FOREIGN KEY (doctor_id) REFERENCES doctors(id));
CREATE TABLE visits (id int AUTO_INCREMENT PRIMARY KEY, patient_id bigint NOT NULL, doctor_id int, visited_at datetime NOT NULL, notes text, total decimal(10,2),
  twice decimal(12,2) GENERATED ALWAYS AS (total * 2) STORED, FOREIGN KEY (patient_id) REFERENCES patients(id), FOREIGN KEY (doctor_id) REFERENCES doctors(id), INDEX visits_when (visited_at));
CREATE VIEW recent_visits AS SELECT id, patient_id FROM visits ORDER BY visited_at DESC LIMIT 10;
CREATE TRIGGER visits_note BEFORE INSERT ON visits FOR EACH ROW SET NEW.notes = CONCAT(COALESCE(NEW.notes, ''), ' (checked)');
INSERT INTO doctors (full_name, email, specialty) VALUES ('Doctor One', 'doctor1@clinic.test', 'General'), ('Doctor Two', 'doctor2@clinic.test', 'Kids'), ('Doctor Three', 'doctor3@clinic.test', 'Eyes');
INSERT INTO patients (first_name, last_name, national_id, phone, birth_date, address, created_at, doctor_id, photo)
  WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < ${CLINIC.patients})
  SELECT CONCAT('Realname', n), IF(n % 2 = 0, 'Samefamily', CONCAT('Other', n)), CONCAT('NID', LPAD(n, 6, '0')), CONCAT('+1 555 01', LPAD(n, 4, '0')),
    DATE_ADD('1980-01-01', INTERVAL n DAY), CONCAT(n, ' Real Street\\nFlat ''2'''), NOW() - INTERVAL n DAY, 1 + n % ${CLINIC.doctors}, IF(n = 1, 0x00FF10, NULL) FROM s;
INSERT INTO visits (patient_id, doctor_id, visited_at, notes, total)
  WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < ${CLINIC.visits})
  SELECT 1 + (n * 7) % ${CLINIC.patients}, 1 + n % ${CLINIC.doctors}, NOW() - INTERVAL n HOUR, CONCAT('note\\twith a tab ', n, ' ', REPEAT('ملاحظة طويلة ', 40)), n * 1.5 FROM s;
`;

const one = (sql: string, db: string) => server!.admin(sql, db).trim();

beforeAll(async () => {
  server = await startMysql(PASSWORD);
  if (!server) return;
  dir = scratch('mysql-files');
  server.admin('CREATE DATABASE clinic');
  server.admin(CLINIC_SQL, 'clinic');
  source = server.address('clinic');
}, 180_000);

afterAll(async () => {
  await server?.stop();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}, 120_000);

const fingerprint = () => one('CHECKSUM TABLE patients, visits, doctors', 'clinic');

describe('MySQL databases per story', () => {
  it('makes a template: schema and indexes kept, small tables whole, big ones sampled, linked rows kept', async (ctx) => {
    if (!server) return ctx.skip();
    const before = fingerprint();
    const t = await mysql.makeTemplate(source, { folder: path.join(dir, 'template'), smallRows: 50, sampleRows: 100 });
    expect(fingerprint()).toBe(before);
    const byName = Object.fromEntries(t.info.tables.map((x) => [x.name, x]));
    expect(byName.doctors).toMatchObject({ kept: 'whole', rows: CLINIC.doctors });
    expect(byName.visits).toMatchObject({ kept: 'sampled', rows: 100, newestBy: 'visited_at' });
    expect(byName.patients).toMatchObject({ kept: 'sampled', newestBy: 'created_at' });
    expect(byName.patients!.linked).toBeGreaterThan(0);
    expect(t.info.linksComplete).toBe(true);
    expect(t.info.source).not.toContain('Pa ss');
    for (const f of fs.readdirSync(t.folder)) expect(fs.readFileSync(path.join(t.folder, f), 'utf8')).not.toContain('Pa ss');

    const story = await mysql.createStoryDb(t, { id: 'CLINIC-12' });
    expect(story).toMatchObject({ kind: 'mysql', name: 'clinic_clinic_12', existed: false });
    expect(story.address).toBe(source.replace('/clinic', '/clinic_clinic_12'));
    const db = story.name;
    expect(one(`SELECT GROUP_CONCAT(TABLE_NAME ORDER BY TABLE_NAME) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${db}'`, db)).toBe('doctors,patients,recent_visits,visits');
    expect(one(`SELECT GROUP_CONCAT(DISTINCT INDEX_NAME ORDER BY INDEX_NAME) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = '${db}' AND TABLE_NAME = 'visits'`, db)).toBe('doctor_id,patient_id,PRIMARY,visits_when');
    expect(one(`SELECT COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = '${db}'`, db)).toBe('3');
    expect(one(`SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = '${db}'`, db)).toBe('1');
    expect(one('SELECT COUNT(*) FROM doctors', db)).toBe(String(CLINIC.doctors));
    expect(one('SELECT COUNT(*) FROM visits', db)).toBe('100');
    expect(one('SELECT MAX(visited_at) = (SELECT MAX(visited_at) FROM clinic.visits) FROM visits', db)).toBe('1');
    expect(one('SELECT COUNT(*) FROM visits v LEFT JOIN patients p ON p.id = v.patient_id WHERE p.id IS NULL', db)).toBe('0');
    // Values exactly as in the source: the trigger did not run again on the copy, binary data and odd text kept.
    expect(one('SELECT notes FROM visits ORDER BY visited_at DESC LIMIT 1', db)).toBe(one('SELECT notes FROM visits ORDER BY visited_at DESC LIMIT 1', 'clinic'));
    expect(one('SELECT HEX(photo) FROM patients WHERE id = 1', db)).toBe('00FF10');
    expect(one('SELECT address FROM patients WHERE id = 1', db)).toBe(one('SELECT address FROM patients WHERE id = 1', 'clinic'));
    expect(one('SELECT COUNT(*) FROM visits WHERE twice = total * 2', db)).toBe('100');
    expect(one('SELECT COUNT(*) FROM recent_visits', db)).toBe('10');
    // New rows never take a kept row's id.
    one("INSERT INTO patients (first_name, created_at) VALUES ('New', NOW())", db);
    expect(Number(one("SELECT id FROM patients WHERE first_name = 'New'", db))).toBeGreaterThan(CLINIC.patients);

    expect(await mysql.createStoryDb(t, { id: 'CLINIC-12' })).toMatchObject({ existed: true });
    expect(await mysql.dropStoryDb(story.address, source)).toBe(true);
    expect(one("SELECT GROUP_CONCAT(SCHEMA_NAME ORDER BY SCHEMA_NAME) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'clinic%'", 'clinic')).toBe('clinic');
    expect(fingerprint()).toBe(before);
    expect(await mysql.dropStoryDb(story.address, source)).toBe(false);
  }, 180_000);

  it('hides personal data when asked: consistent fake values, real ones never written', async (ctx) => {
    if (!server) return ctx.skip();
    const t = await mysql.makeTemplate(source, { folder: path.join(dir, 'hidden'), smallRows: 50, sampleRows: 100, hidePersonal: true });
    expect(t.info.hidden).toEqual(expect.arrayContaining(['doctors.full_name', 'doctors.email', 'patients.first_name', 'patients.last_name', 'patients.national_id', 'patients.phone', 'patients.birth_date', 'patients.address']));
    for (const f of fs.readdirSync(t.folder)) {
      const text = fs.readFileSync(path.join(t.folder, f), 'utf8');
      for (const real of ['Realname', 'Samefamily', 'Real Street', '@clinic.test', 'NID000', '+1 555 01', 'Doctor One']) expect(text).not.toContain(real);
    }
    const story = await mysql.createStoryDb(t, { id: 'CLINIC-13' });
    const db = story.name;
    expect(one('SELECT COUNT(DISTINCT last_name) FROM patients WHERE id % 2 = 0', db)).toBe('1');
    expect(one('SELECT COUNT(DISTINCT national_id) = COUNT(*) FROM patients', db)).toBe('1');
    expect(one("SELECT MIN(email LIKE '%@example.com') FROM doctors", db)).toBe('1');
    expect(one("SELECT MIN(phone REGEXP '^[+][0-9] [0-9]{3} [0-9]{6}$') FROM patients", db)).toBe('1');
    expect(one("SELECT MIN(birth_date BETWEEN '1950-01-01' AND '2005-12-31') FROM patients", db)).toBe('1');
    expect(one('SELECT HEX(photo) FROM patients WHERE id = 1', db)).toBe('00FF10');
    // Long Arabic notes, cut between chunks on the way, come through whole.
    expect(one('SELECT CONCAT(COUNT(*), \' \', SUM(MD5(v.notes) <> MD5(s.notes))) FROM visits v JOIN clinic.visits s ON s.id = v.id', db)).toBe('100 0');
    expect(one('SELECT COUNT(*) FROM visits v JOIN patients p ON p.id = v.patient_id', db)).toBe('100');
    expect(await mysql.dropStoryDb(story.address, source)).toBe(true);
  }, 180_000);

  it('never makes, changes or drops the person’s own database, or one squad-kit did not make', async (ctx) => {
    if (!server) return ctx.skip();
    expect(mysql.isPersonsOwn(source, source)).toBe(true);
    expect(mysql.isPersonsOwn(mysql.storyAddress(source, { id: 'CLINIC-12' }), source)).toBe(false);
    await expect(mysql.dropStoryDb(source, source)).rejects.toMatchObject({ reason: 'persons-own' });
    await expect(mysql.dropStoryDb(source.replace('/clinic', '/mysql'), source)).rejects.toMatchObject({ reason: 'persons-own' });
    server.admin('CREATE DATABASE clinic_clinic_99');
    await expect(mysql.dropStoryDb(mysql.storyAddress(source, { id: 'CLINIC-99' }), source)).rejects.toMatchObject({ reason: 'not-ours' });
    const t = await mysql.makeTemplate(source, { folder: path.join(dir, 'template'), smallRows: 50, sampleRows: 100 });
    await expect(mysql.createStoryDb(t, { id: 'CLINIC-99' })).rejects.toMatchObject({ reason: 'not-ours' });
    expect(one("SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = 'clinic_clinic_99'", 'clinic')).toBe('1');
  }, 180_000);

  it('never shows the password in an error', async (ctx) => {
    if (!server) return ctx.skip();
    const wrong = source.replace(encodeURIComponent(PASSWORD), encodeURIComponent('Wr0ng;secret pass'));
    const e = await mysql.makeTemplate(wrong, { folder: path.join(dir, 'wrong') }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DbError);
    expect((e as Error).message).toMatch(/Access denied/);
    expect((e as Error).message).not.toContain('Wr0ng');
    const missing = await mysql.makeTemplate(source.replace('/clinic', '/no_such_db'), { folder: path.join(dir, 'missing') }).catch((x: unknown) => x);
    expect((missing as Error).message).toMatch(/Unknown database/);
    expect((missing as Error).message).not.toContain('Pa ss');
  }, 120_000);
});
