import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CLINIC, scratch } from './support/db-servers.js';

/**
 * The SQLite adapter, for real: a made-up clinic in a SQLite file, a template made from it with sqlite3 itself, and a
 * story's own copy in the story's folder. Skips when sqlite3 is not here.
 */

const { sqlite } = await import('../src/engine/db/sqlite.js');
const { findTool } = await import('../src/engine/db/run.js');

const sqlite3 = findTool('sqlite3');
let dir = '';
let file = '';
let source = '';

const CLINIC_SQL = `
PRAGMA journal_mode = WAL;
CREATE TABLE doctors (id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL, email TEXT UNIQUE);
CREATE TABLE patients (id INTEGER PRIMARY KEY AUTOINCREMENT, first_name TEXT, last_name TEXT, national_id TEXT UNIQUE, phone TEXT, birth_date TEXT,
  address TEXT, created_at TEXT NOT NULL, doctor_id INTEGER REFERENCES doctors);
CREATE TABLE visits (id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patients(id), visited_at DATETIME NOT NULL, notes TEXT, total REAL,
  twice REAL GENERATED ALWAYS AS (total * 2) STORED);
CREATE INDEX visits_when ON visits (visited_at DESC);
CREATE VIEW recent_visits AS SELECT id, patient_id FROM visits ORDER BY visited_at DESC LIMIT 10;
CREATE TRIGGER visits_note AFTER INSERT ON visits BEGIN UPDATE visits SET notes = notes || ' (checked)' WHERE id = new.id; END;
CREATE VIRTUAL TABLE notes_search USING fts5(body);
WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < ${CLINIC.doctors})
  INSERT INTO doctors (full_name, email) SELECT 'Doctor ' || n, 'doctor' || n || '@clinic.test' FROM s;
WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < ${CLINIC.patients})
  INSERT INTO patients (first_name, last_name, national_id, phone, birth_date, address, created_at, doctor_id)
  SELECT 'Realname' || n, CASE WHEN n % 2 = 0 THEN 'Samefamily' ELSE 'Other' || n END, 'NID' || printf('%06d', n), '+1 555 01' || printf('%04d', n),
    date('1980-01-01', '+' || n || ' days'), n || ' Real Street, ''Flat'' 2', datetime('now', '-' || n || ' days'), 1 + n % ${CLINIC.doctors} FROM s;
WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < ${CLINIC.visits})
  INSERT INTO visits (patient_id, visited_at, notes, total) SELECT 1 + (n * 7) % ${CLINIC.patients}, datetime('now', '-' || n || ' hours'), 'note ' || n, n * 1.5 FROM s;
INSERT INTO notes_search (body) VALUES ('first visit note'), ('second visit note');
`;

const one = (sql: string, db: string) => execFileSync(sqlite3!, ['-batch', '-noheader', db, sql], { encoding: 'utf8' }).trim();
const hash = () => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

beforeAll(() => {
  if (!sqlite3) return;
  dir = scratch('sqlite');
  file = path.join(dir, 'project', 'clinic.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(sqlite3, ['-batch', file], { input: CLINIC_SQL });
  source = `file:${file}`;
});

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!sqlite3)('SQLite databases per story', () => {
  it('makes a template: schema and indexes kept, small tables whole, big ones sampled, linked rows kept', async () => {
    const before = hash();
    const t = await sqlite.makeTemplate(source, { folder: path.join(dir, 'template'), smallRows: 50, sampleRows: 100 });
    expect(hash()).toBe(before);
    const byName = Object.fromEntries(t.info.tables.map((x) => [x.name, x]));
    expect(byName.doctors).toMatchObject({ kept: 'whole', rows: CLINIC.doctors });
    expect(byName.visits).toMatchObject({ kept: 'sampled', rows: 100, newestBy: 'visited_at' });
    expect(byName.patients).toMatchObject({ kept: 'sampled', newestBy: 'created_at' });
    expect(byName.patients!.linked).toBeGreaterThan(0);
    expect(byName.notes_search).toMatchObject({ kept: 'whole', rows: 2 });
    expect(t.info.tables.map((x) => x.name)).not.toContain('notes_search_data');
    expect(t.info.linksComplete).toBe(true);

    const storyFolder = path.join(dir, 'story-copy');
    const story = await sqlite.createStoryDb(t, { id: 'CLINIC-12', folder: storyFolder });
    expect(story).toMatchObject({ kind: 'sqlite', name: path.join(storyFolder, 'clinic_clinic_12.db'), existed: false });
    expect(story.address).toBe(`file:${story.name}`);
    const db = story.name;
    expect(one(`SELECT group_concat(name) FROM (SELECT name FROM sqlite_master WHERE type IN ('table', 'view', 'trigger') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'notes_search_%' ORDER BY name)`, db)).toBe(
      'doctors,notes_search,patients,recent_visits,visits,visits_note',
    );
    expect(one(`SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = 'visits_when'`, db)).toBe('1');
    expect(one('SELECT count(*) FROM doctors', db)).toBe(String(CLINIC.doctors));
    expect(one('SELECT count(*) FROM visits', db)).toBe('100');
    expect(one('SELECT count(*) FROM visits v LEFT JOIN patients p ON p.id = v.patient_id WHERE p.id IS NULL', db)).toBe('0');
    expect(one(`SELECT notes FROM visits ORDER BY visited_at DESC LIMIT 1`, db)).toBe(one(`SELECT notes FROM visits ORDER BY visited_at DESC LIMIT 1`, file));
    expect(one(`SELECT count(*) FROM visits WHERE twice = total * 2`, db)).toBe('100');
    expect(one(`SELECT body FROM notes_search WHERE notes_search MATCH 'second'`, db)).toBe('second visit note');
    expect(one('PRAGMA integrity_check', db)).toBe('ok');
    // New rows never take a kept row's id.
    expect(one(`INSERT INTO patients (first_name, created_at) VALUES ('New', datetime('now')) RETURNING id`, db)).toBe(String(CLINIC.patients + 1));

    expect(await sqlite.createStoryDb(t, { id: 'CLINIC-12', folder: storyFolder })).toMatchObject({ existed: true });
    expect(await sqlite.dropStoryDb(story.address, source)).toBe(true);
    expect(fs.existsSync(db)).toBe(false);
    expect(hash()).toBe(before);
    expect(await sqlite.dropStoryDb(story.address, source)).toBe(false);
  });

  it('hides personal data when asked: consistent fake values, real ones never written', async () => {
    const t = await sqlite.makeTemplate(source, { folder: path.join(dir, 'hidden'), smallRows: 50, sampleRows: 100, hidePersonal: true });
    expect(t.info.hidden).toEqual(expect.arrayContaining(['doctors.full_name', 'doctors.email', 'patients.first_name', 'patients.last_name', 'patients.national_id', 'patients.phone', 'patients.birth_date', 'patients.address']));
    for (const f of fs.readdirSync(t.folder)) {
      const text = fs.readFileSync(path.join(t.folder, f)).toString('latin1');
      for (const real of ['Realname', 'Samefamily', 'Real Street', '@clinic.test', 'NID000', '+1 555 01', 'Doctor 1']) expect(text).not.toContain(real);
    }
    const story = await sqlite.createStoryDb(t, { id: 'CLINIC-13', folder: path.join(dir, 'story-copy') });
    const db = story.name;
    expect(one('SELECT count(DISTINCT last_name) FROM patients WHERE id % 2 = 0', db)).toBe('1');
    expect(one('SELECT count(DISTINCT national_id) = count(*) FROM patients', db)).toBe('1');
    expect(one(`SELECT min(email LIKE '%@example.com') FROM doctors`, db)).toBe('1');
    expect(one(`SELECT min(birth_date BETWEEN '1950-01-01' AND '2005-12-31') FROM patients`, db)).toBe('1');
    expect(one('SELECT count(*) FROM visits v JOIN patients p ON p.id = v.patient_id', db)).toBe('100');
    expect(await sqlite.dropStoryDb(story.address, source)).toBe(true);
  });

  it('never makes, changes or drops the person’s own file, or one squad-kit did not make', async () => {
    expect(sqlite.isPersonsOwn(source, source)).toBe(true);
    expect(sqlite.isPersonsOwn(file, source)).toBe(true);
    // The same file through a link is still the person's own.
    const link = path.join(dir, 'link.db');
    fs.symlinkSync(file, link);
    expect(sqlite.isPersonsOwn(link, source)).toBe(true);
    await expect(sqlite.dropStoryDb(link, source)).rejects.toMatchObject({ reason: 'persons-own' });
    await expect(sqlite.dropStoryDb(source, source)).rejects.toMatchObject({ reason: 'persons-own' });
    expect(fs.existsSync(file)).toBe(true);
    // A file with a story's name that squad-kit did not make stays.
    const theirs = path.join(dir, 'story-copy', 'clinic_clinic_99.db');
    fs.mkdirSync(path.dirname(theirs), { recursive: true });
    fs.writeFileSync(theirs, 'mine');
    await expect(sqlite.dropStoryDb(theirs, source)).rejects.toMatchObject({ reason: 'not-ours' });
    const t = await sqlite.makeTemplate(source, { folder: path.join(dir, 'template'), smallRows: 50, sampleRows: 100 });
    await expect(sqlite.createStoryDb(t, { id: 'CLINIC-99', folder: path.dirname(theirs) })).rejects.toMatchObject({ reason: 'not-ours' });
    expect(fs.readFileSync(theirs, 'utf8')).toBe('mine');
    // A story file needs the story's folder.
    await expect(sqlite.createStoryDb(t, { id: 'CLINIC-100' })).rejects.toMatchObject({ reason: 'bad-address' });
  });

  it('never keeps a template inside a git folder', async () => {
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    await expect(sqlite.makeTemplate(source, { folder: path.join(repo, 'db-template') })).rejects.toMatchObject({ reason: 'bad-address' });
    expect(fs.readdirSync(repo)).toEqual(['.git']);
  });
});
