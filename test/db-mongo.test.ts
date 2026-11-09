import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CLINIC, scratch, startMongo, type Server } from './support/db-servers.js';

/**
 * The MongoDB adapter, for real: a throwaway mongod on a temp folder and its own port, a made-up clinic in it, and a
 * template and story databases made from it. Skips when mongod, mongosh, mongodump or mongorestore are not here.
 */

const { mongo } = await import('../src/engine/db/mongo.js');
const { DbError } = await import('../src/engine/db/types.js');

const PASSWORD = 'mg:Pa ss@w/rd%1';
let server: Server | null = null;
let dir = '';
let source = '';

const CLINIC_JS = `
const doctors = [];
for (let i = 1; i <= ${CLINIC.doctors}; i++) doctors.push({ _id: new ObjectId(), fullName: 'Doctor ' + i, email: 'doctor' + i + '@clinic.test' });
db.doctors.insertMany(doctors);
const patients = [];
for (let i = 1; i <= ${CLINIC.patients}; i++) patients.push({
  firstName: 'Realname' + i, lastName: i % 2 === 0 ? 'Samefamily' : 'Other' + i, nationalId: 'NID' + String(i).padStart(6, '0'),
  phone: '+1 555 01' + String(i).padStart(4, '0'), birthDate: new Date(Date.UTC(1980, 0, 1 + i, 9, 30)), address: { street: i + ' Real Street', city: 'Town' },
  doctorId: doctors[i % ${CLINIC.doctors}]._id, createdAt: new Date(Date.now() - i * 86400000),
  visits: NumberLong('9007199254740993'), balance: NumberDecimal('10.50'), small: NumberInt(3), share: 0.25 });
db.patients.insertMany(patients);
const ids = db.patients.find({}, { _id: 1 }).sort({ createdAt: -1 }).toArray().map((p) => p._id);
const visits = [];
for (let i = 1; i <= ${CLINIC.visits}; i++) visits.push({ patientId: ids[(i * 7) % ${CLINIC.patients}], doctor: new DBRef('doctors', doctors[i % ${CLINIC.doctors}]._id),
  visitedAt: new Date(Date.now() - i * 3600000), notes: 'note\\twith a tab ' + i, family: [{ name: 'Kin ' + i, phone: '+44 20 ' + i }] });
db.visits.insertMany(visits);
db.visits.createIndex({ visitedAt: -1 }, { name: 'visits_when' });
db.patients.createIndex({ nationalId: 1 }, { unique: true });
db.createView('recent_visits', 'visits', [{ $sort: { visitedAt: -1 } }, { $limit: 10 }]);
print('ok');
`;

const js = (script: string, db: string) => server!.admin(script, db).trim();

beforeAll(async () => {
  server = await startMongo(PASSWORD);
  if (!server) return;
  dir = scratch('mongo-files');
  expect(server.admin(CLINIC_JS, 'clinic')).toContain('ok');
  source = server.address('clinic');
}, 180_000);

afterAll(async () => {
  await server?.stop();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}, 120_000);

const fingerprint = () => js(`print(db.patients.countDocuments() + ':' + db.visits.countDocuments() + ':' + db.patients.find().sort({ _id: 1 }).toArray().map((p) => p.firstName + p.phone).join('').length)`, 'clinic');

describe('MongoDB databases per story', () => {
  it('makes a template: indexes kept, small collections whole, big ones sampled, linked documents kept', async (ctx) => {
    if (!server) return ctx.skip();
    const before = fingerprint();
    const t = await mongo.makeTemplate(source, { folder: path.join(dir, 'template'), smallRows: 50, sampleRows: 100 });
    expect(fingerprint()).toBe(before);
    const byName = Object.fromEntries(t.info.tables.map((x) => [x.name, x]));
    expect(byName.doctors).toMatchObject({ kept: 'whole', rows: CLINIC.doctors });
    expect(byName.visits).toMatchObject({ kept: 'sampled', rows: 100, newestBy: '_id' });
    expect(byName.patients).toMatchObject({ kept: 'sampled', newestBy: 'createdAt' });
    expect(byName.patients!.linked).toBeGreaterThan(0);
    expect(t.info.linksComplete).toBe(true);
    expect(t.info.notes.join(' ')).toMatch(/does not record how documents link/);
    expect(t.info.source).not.toContain('Pa ss');

    const story = await mongo.createStoryDb(t, { id: 'CLINIC-12' });
    expect(story).toMatchObject({ kind: 'mongo', name: 'clinic_clinic_12', existed: false });
    expect(story.address).toBe(source.replace('/clinic?', '/clinic_clinic_12?'));
    const db = story.name;
    expect(js(`print(db.getCollectionInfos().map((c) => c.name + ':' + c.type).filter((n) => !n.startsWith('system.')).sort().join(','))`, db)).toBe(
      'doctors:collection,patients:collection,recent_visits:view,visits:collection',
    );
    expect(js(`print(db.visits.getIndexes().map((i) => i.name).sort().join(','))`, db)).toBe('_id_,visits_when');
    expect(js(`print(db.patients.getIndexes().find((i) => i.name === 'nationalId_1').unique)`, db)).toBe('true');
    expect(js('print(db.doctors.countDocuments())', db)).toBe(String(CLINIC.doctors));
    expect(js('print(db.visits.countDocuments())', db)).toBe('100');
    // Every kept visit's patient (by its patientId) and doctor (by its DBRef) is kept.
    expect(js(`print(db.visits.find().toArray().filter((v) => !db.patients.findOne({ _id: v.patientId }) || !db.doctors.findOne({ _id: v.doctor.oid })).length)`, db)).toBe('0');
    // Values keep their exact types.
    expect(js(`const p = db.patients.find().sort({ createdAt: -1 }).limit(1).toArray()[0]; print([p.firstName, p.visits, p.balance, typeof p.share].join('|'))`, db)).toBe(
      'Realname1|9007199254740993|10.50|number',
    );
    expect(js(`print(JSON.stringify(db.patients.aggregate([{ $limit: 1 }, { $project: { _id: 0, a: { $type: '$visits' }, b: { $type: '$balance' }, c: { $type: '$small' }, d: { $type: '$share' } } }]).toArray()[0]))`, db)).toBe(
      '{"a":"long","b":"decimal","c":"int","d":"double"}',
    );

    expect(await mongo.createStoryDb(t, { id: 'CLINIC-12' })).toMatchObject({ existed: true });
    expect(await mongo.dropStoryDb(story.address, source)).toBe(true);
    expect(js(`print(db.adminCommand({ listDatabases: 1, nameOnly: true }).databases.map((d) => d.name).filter((n) => n.startsWith('clinic')).join(','))`, 'admin')).toBe('clinic');
    expect(fingerprint()).toBe(before);
    expect(await mongo.dropStoryDb(story.address, source)).toBe(false);
  }, 180_000);

  it('hides personal data when asked: consistent fake values, real ones never written', async (ctx) => {
    if (!server) return ctx.skip();
    const t = await mongo.makeTemplate(source, { folder: path.join(dir, 'hidden'), smallRows: 50, sampleRows: 100, hidePersonal: true });
    expect(t.info.hidden).toEqual(expect.arrayContaining(['doctors.fullName', 'doctors.email', 'patients.firstName', 'patients.lastName', 'patients.nationalId', 'patients.phone', 'patients.birthDate', 'patients.address.street', 'visits.family.name', 'visits.family.phone']));
    const files = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of files(t.folder)) {
      const text = fs.readFileSync(f).toString('latin1');
      for (const real of ['Realname', 'Samefamily', 'Real Street', '@clinic.test', 'NID000', '+1 555 01', 'Doctor 1', 'Kin 1']) expect(text).not.toContain(real);
    }
    const story = await mongo.createStoryDb(t, { id: 'CLINIC-13' });
    const db = story.name;
    expect(js(`print(new Set(db.patients.find().toArray().filter((p) => p.lastName !== undefined && db.getSiblingDB('clinic').patients.findOne({ _id: p._id }).lastName === 'Samefamily').map((p) => p.lastName)).size)`, db)).toBe('1');
    expect(js(`const n = db.patients.find().toArray(); print(new Set(n.map((p) => p.nationalId)).size === n.length)`, db)).toBe('true');
    expect(js(`print(db.doctors.find().toArray().every((d) => d.email.endsWith('@example.com')))`, db)).toBe('true');
    expect(js(`print(db.patients.find().toArray().every((p) => /^[+]\\d \\d{3} \\d{6}$/.test(p.phone)))`, db)).toBe('true');
    // A birth date stays a date, with its time of day.
    expect(js(`print(db.patients.find().toArray().every((p) => p.birthDate instanceof Date && p.birthDate.getUTCHours() === 9 && p.birthDate.getUTCFullYear() >= 1950))`, db)).toBe('true');
    expect(js(`print(db.visits.find().toArray().filter((v) => !db.patients.findOne({ _id: v.patientId })).length)`, db)).toBe('0');
    expect(await mongo.dropStoryDb(story.address, source)).toBe(true);
  }, 180_000);

  it('never makes, changes or drops the person’s own database, or one squad-kit did not make', async (ctx) => {
    if (!server) return ctx.skip();
    expect(mongo.isPersonsOwn(source, source)).toBe(true);
    expect(mongo.isPersonsOwn(mongo.storyAddress(source, { id: 'CLINIC-12' }), source)).toBe(false);
    await expect(mongo.dropStoryDb(source, source)).rejects.toMatchObject({ reason: 'persons-own' });
    await expect(mongo.dropStoryDb(source.replace('/clinic?', '/admin?'), source)).rejects.toMatchObject({ reason: 'persons-own' });
    js(`db.notes.insertOne({ mine: true }); print('ok')`, 'clinic_clinic_99');
    await expect(mongo.dropStoryDb(mongo.storyAddress(source, { id: 'CLINIC-99' }), source)).rejects.toMatchObject({ reason: 'not-ours' });
    const t = await mongo.makeTemplate(source, { folder: path.join(dir, 'template'), smallRows: 50, sampleRows: 100 });
    await expect(mongo.createStoryDb(t, { id: 'CLINIC-99' })).rejects.toMatchObject({ reason: 'not-ours' });
    expect(js('print(db.notes.countDocuments())', 'clinic_clinic_99')).toBe('1');
  }, 180_000);

  it('never shows the password in an error', async (ctx) => {
    if (!server) return ctx.skip();
    const wrong = source.replace(encodeURIComponent(PASSWORD), encodeURIComponent('Wr0ng:secret pass'));
    const e = await mongo.makeTemplate(wrong, { folder: path.join(dir, 'wrong') }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DbError);
    expect((e as Error).message).toMatch(/Authentication failed/i);
    expect((e as Error).message).not.toContain('Wr0ng');
    expect((e as Error).message).not.toContain(encodeURIComponent('Wr0ng:secret pass'));
  }, 120_000);
});
