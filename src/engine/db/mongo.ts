import fs from 'node:fs';
import path from 'node:path';
import { isPersonsOwn, readAddress, refuseOwn, storyName, type Address } from './address.js';
import { fakeBson } from './bson.js';
import { dropFolder, finishFolder, readTemplate, startFolder, withDefaults } from './folder.js';
import { makeFaker, personalKind } from './hide.js';
import { dropMark, putMark, readMark } from './made.js';
import { missing, needTool, runTool, secretsOf, withPrivateDir, writePrivate } from './run.js';
import { DbError, type DbAdapter, type DbTemplate, type StoryDb, type StoryRef, type TemplateInfo, type TemplateOptions } from './types.js';

/**
 * MongoDB. The template is a mongodump-style folder on this computer, made with Mongo's own tools reading the source:
 * a small mongosh script (reads only) picks the documents to keep and reads each collection's indexes and options,
 * then mongodump reads those documents, a collection at a time. A story's database is `mongorestore` of that folder
 * under the story's name. MongoDB does not record how documents link, except DBRefs: squad-kit follows those, and ids
 * in fields named like a collection (`patientId` → `patients`), as a best effort. squad-kit's mark on this computer is
 * what says it made a database.
 */

const TOOLS = ['mongosh', 'mongodump', 'mongorestore'];

function tools(): { mongosh: string; mongodump: string; mongorestore: string } {
  const mongodump = needTool('mongodump', 'Making a MongoDB template');
  return { mongodump, mongorestore: needTool('mongorestore', 'Making a MongoDB database', mongodump), mongosh: needTool('mongosh', 'Reading a MongoDB database') };
}

/** The link for the tools: no database in it (they are told which), and the same place to sign in as the app's. */
const toolUri = (a: Address) => a.withName('');

/**
 * The plan, worked out inside mongosh (reads only): which collections are small, the newest documents of the big
 * ones, and the documents those point at. Printed as one line of canonical Extended JSON, so ids keep their types.
 */
const PLAN_SCRIPT = String.raw`
const conn = new Mongo(process.env.SK_DB_URI);
const db = conn.getDB(process.env.SK_DB_NAME);
const SMALL = Number(process.env.SK_DB_SMALL), SAMPLE = Number(process.env.SK_DB_SAMPLE);
const CREATED = /^(created|creation|inserted|added|registered|opened|submitted|issued|posted|recorded)/i;
const words = (n) => n.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const infos = db.getCollectionInfos().filter((i) => !i.name.startsWith('system.'));
const names = infos.filter((i) => i.type === 'collection').map((i) => i.name);
const out = { collections: [], notes: [] };
const picks = new Map();
const key = (id) => EJSON.stringify(id, { relaxed: false });
for (const info of infos) {
  const meta = { indexes: [], collectionName: info.name, type: info.type || 'collection', options: info.options || {} };
  if (info.type === 'view') { out.collections.push({ name: info.name, view: true, meta }); continue; }
  if (info.type !== 'collection') { out.notes.push('The ' + info.type + ' collection ' + info.name + ' is not copied.'); continue; }
  const c = db.getCollection(info.name);
  meta.indexes = c.getIndexes();
  const n = c.countDocuments({}, { limit: SMALL + 1 });
  const p = { name: info.name, whole: n <= SMALL, order: null, ids: new Map(), linked: 0, meta };
  if (!p.whole) {
    const last = c.find({}).sort({ $natural: -1 }).limit(1).toArray()[0] || {};
    const field = Object.keys(last).find((k) => last[k] instanceof Date && words(k).some((w) => CREATED.test(w)));
    const sort = field ? { [field]: -1, _id: -1 } : last._id && last._id._bsontype === 'ObjectId' ? { _id: -1 } : { $natural: -1 };
    p.order = field || (sort._id ? '_id' : null);
    for (const d of c.find({}, { projection: { _id: 1 } }).sort(sort).limit(SAMPLE).toArray()) p.ids.set(key(d._id), d._id);
  }
  picks.set(info.name, p);
}
// Links: DBRefs, and ObjectIds in fields named like a collection (patientId, doctor_ids).
const target = (field) => {
  const stem = field.replace(/_?(id|ids|Id|Ids|ID|IDs)$/, '').toLowerCase();
  if (!stem || stem === field.toLowerCase()) return null;
  const forms = [stem, stem + 's', stem + 'es', stem.replace(/y$/, 'ies')];
  return names.find((n) => forms.includes(n.toLowerCase())) || null;
};
const refsIn = (doc, found) => {
  for (const [k, v] of Object.entries(doc)) {
    for (const x of Array.isArray(v) ? v : [v]) {
      if (x && x._bsontype === 'DBRef' && (!x.db || x.db === db.getName())) found.push([x.collection, x.oid]);
      else if (x && x._bsontype === 'ObjectId') { const t = target(k); if (t) found.push([t, x]); }
    }
  }
};
let fresh = new Map([...picks.values()].map((p) => [p.name, p.whole ? null : [...p.ids.values()]]));
let complete = true;
for (let pass = 0; pass < 10 && fresh.size; pass++) {
  const wanted = new Map();
  for (const [name, ids] of fresh) {
    const docs = (ids === null ? db.getCollection(name).find({}) : db.getCollection(name).find({ _id: { $in: ids } })).toArray();
    for (const d of docs) {
      const found = [];
      refsIn(d, found);
      for (const [t, id] of found) {
        const p = picks.get(t);
        if (!p || p.whole || p.ids.has(key(id))) continue;
        if (!wanted.has(t)) wanted.set(t, new Map());
        wanted.get(t).set(key(id), id);
      }
    }
  }
  fresh = new Map();
  for (const [t, ids] of wanted) {
    const p = picks.get(t);
    const got = db.getCollection(t).find({ _id: { $in: [...ids.values()] } }, { projection: { _id: 1 } }).toArray();
    for (const d of got) p.ids.set(key(d._id), d._id);
    p.linked += got.length;
    if (got.length) fresh.set(t, got.map((d) => d._id));
  }
  if (pass === 9 && fresh.size) complete = false;
}
for (const p of picks.values()) {
  const rows = p.whole ? db.getCollection(p.name).countDocuments({}) : p.ids.size;
  // Counts as text: canonical Extended JSON would wrap a number.
  out.collections.push({ name: p.name, whole: p.whole, order: p.order, ids: p.whole ? null : [...p.ids.values()], rows: String(rows), linked: String(p.linked), meta: p.meta });
}
out.complete = complete;
print(EJSON.stringify(out, { relaxed: false }));
`;

interface PlanOut {
  collections: { name: string; view?: boolean; whole?: boolean; order?: string | null; ids?: unknown[] | null; rows?: string; linked?: string; meta: unknown }[];
  notes: string[];
  complete: boolean;
}

/** Runs a small mongosh script with the connection in its environment, never on its command line. */
async function shell(a: Address, script: string, vars: Record<string, string>, doing: string): Promise<string> {
  return withPrivateDir(async (dir) => {
    const file = path.join(dir, 'script.js');
    writePrivate(file, script);
    return runTool(tools().mongosh, ['--nodb', '--quiet', '--norc', file], { env: { SK_DB_URI: toolUri(a), ...vars }, secrets: secretsOf(a.password, toolUri(a)), doing });
  });
}

/** Runs mongodump or mongorestore with the connection in a private config file. */
async function withConfig<T>(a: Address, work: (config: string, dir: string) => Promise<T>): Promise<T> {
  return withPrivateDir(async (dir) => {
    const config = path.join(dir, 'config.yaml');
    writePrivate(config, `uri: ${JSON.stringify(toolUri(a))}\n`);
    return work(config, dir);
  });
}

async function exists(a: Address, name: string): Promise<boolean> {
  const out = await shell(
    a,
    `const c = new Mongo(process.env.SK_DB_URI); const n = process.env.SK_DB_NAME;
let r; try { r = c.getDB('admin').adminCommand({ listDatabases: 1, nameOnly: true, filter: { name: n } }).databases.length > 0; }
catch (e) { r = c.getDB(n).getCollectionNames().length > 0; }
print(r ? 'yes' : 'no');`,
    { SK_DB_NAME: name },
    'Looking for a database on the MongoDB server',
  );
  return out.trim().endsWith('yes');
}

async function dropDb(a: Address, name: string): Promise<void> {
  await shell(a, `const r = new Mongo(process.env.SK_DB_URI).getDB(process.env.SK_DB_NAME).dropDatabase(); if (!r.ok) throw new Error('dropDatabase said no');`, { SK_DB_NAME: name }, `Dropping the database ${name}`);
}

function storyRef(story: StoryRef): string {
  if (!story?.id?.trim()) throw new DbError('A story database needs the story id.', 'bad-address');
  return story.id.trim();
}

const DUMP = 'dump';

export const mongo: DbAdapter = {
  kind: 'mongo',

  missingTools: () => missing(TOOLS),

  nameOf: (address) => readAddress('mongo', address).name,

  storyAddress(sourceAddress, story) {
    const a = readAddress('mongo', sourceAddress);
    return a.withName(storyName(a.name, storyRef(story)));
  },

  isPersonsOwn: (address, personsAddress) => isPersonsOwn('mongo', address, personsAddress),

  async makeTemplate(source: string, opts: TemplateOptions): Promise<DbTemplate> {
    const o = withDefaults(opts);
    const a = readAddress('mongo', source);
    const t = tools();
    const secrets = secretsOf(a.password, toolUri(a));
    const making = startFolder(o.folder);
    try {
      const printed = await shell(a, PLAN_SCRIPT, { SK_DB_NAME: a.name, SK_DB_SMALL: String(o.smallRows), SK_DB_SAMPLE: String(o.sampleRows) }, `Reading ${a.name}`);
      const plan = JSON.parse(printed.trim().split('\n').pop()!) as PlanOut;
      const dir = path.join(making, DUMP, a.name);
      fs.mkdirSync(dir, { recursive: true });
      const faker = o.hidePersonal ? makeFaker() : null;
      const hidden = new Set<string>();
      const kindOf = (field: string, inside: string, where: string) => {
        const k = personalKind(field, inside);
        if (k) hidden.add(where);
        return k;
      };
      await withConfig(a, async (config, tmp) => {
        for (const c of plan.collections) {
          // The collection's indexes and options, in mongodump's own form, for mongorestore.
          fs.writeFileSync(path.join(dir, `${c.name}.metadata.json`), JSON.stringify(c.meta));
          if (c.view) continue;
          const args = ['--config', config, '--db', a.name, '--collection', c.name, '--out', '-', '--quiet'];
          if (!c.whole) {
            const queryFile = path.join(tmp, 'query.json');
            fs.writeFileSync(queryFile, JSON.stringify({ _id: { $in: c.ids ?? [] } }));
            args.push('--queryFile', queryFile);
          }
          await runTool(t.mongodump, args, {
            outFile: path.join(dir, `${c.name}.bson`),
            ...(faker ? { through: fakeBson(c.name, kindOf, faker) } : {}),
            secrets,
            doing: `Copying documents from ${a.name}.${c.name}`,
          });
        }
      });
      const notes = [...plan.notes];
      notes.push('MongoDB does not record how documents link. squad-kit kept the documents that DBRefs point at, and those whose ids are in fields named like a collection (patientId → patients); other links are not followed.');
      const tables: TemplateInfo['tables'] = plan.collections
        .filter((c) => !c.view)
        .map((c) => ({
          name: c.name,
          kept: c.whole ? 'whole' : 'sampled',
          rows: Number(c.rows ?? 0),
          ...(!c.whole && c.order ? { newestBy: c.order } : {}),
          ...(!c.whole && Number(c.linked) ? { linked: Number(c.linked) } : {}),
        }));
      const info = finishFolder(making, o.folder, {
        kind: 'mongo',
        source: a.safe,
        sourceName: a.name,
        madeAt: new Date().toISOString(),
        smallRows: o.smallRows,
        sampleRows: o.sampleRows,
        hidePersonal: o.hidePersonal,
        tables,
        hidden: [...hidden].sort(),
        linksComplete: plan.complete,
        notes,
      });
      return { kind: 'mongo', folder: o.folder, source, info };
    } catch (e) {
      dropFolder(making);
      throw e;
    }
  },

  async createStoryDb(template: DbTemplate, story: StoryRef): Promise<StoryDb> {
    const a = readAddress('mongo', template.source);
    const id = storyRef(story);
    const name = storyName(a.name, id);
    const address = a.withName(name);
    refuseOwn('mongo', address, template.source, 'makes or changes');
    if (await exists(a, name)) {
      const mark = readMark('mongo', a.server, name);
      if (mark?.role === 'story' && mark.story === id) return { kind: 'mongo', name, address, existed: true };
      throw new DbError(`A database named ${name} is already on the server, and squad-kit did not make it for this story. squad-kit leaves it alone.`, 'not-ours');
    }
    if (!readTemplate(template.folder, template.source, 'mongo')) throw new DbError('The template’s files are not on this computer any more. Make the template again.', 'failed');
    const from = template.info.sourceName || a.name;
    putMark({ kind: 'mongo', server: a.server, name, role: 'story', story: id, sourceName: a.name, madeAt: new Date().toISOString() });
    try {
      await withConfig(a, (config) =>
        runTool(tools().mongorestore, ['--config', config, '--dir', path.join(template.folder, DUMP), '--nsInclude', `${from}.*`, '--nsFrom', `${from}.*`, '--nsTo', `${name}.*`, '--stopOnError'], {
          secrets: secretsOf(a.password, toolUri(a)),
          doing: `Making ${name} from the template`,
        }),
      );
    } catch (e) {
      await dropDb(a, name).catch(() => undefined);
      dropMark('mongo', a.server, name);
      throw e;
    }
    return { kind: 'mongo', name, address, existed: false };
  },

  async dropStoryDb(address: string, personsAddress: string): Promise<boolean> {
    refuseOwn('mongo', address, personsAddress, 'drops');
    const a = readAddress('mongo', address);
    const p = readAddress('mongo', personsAddress);
    const mark = readMark('mongo', a.server, a.name);
    if (!(await exists(a, a.name))) {
      if (mark?.role === 'story') dropMark('mongo', a.server, a.name);
      return false;
    }
    if (mark?.role !== 'story' || !mark.story || a.name !== storyName(p.name, mark.story)) {
      throw new DbError(`squad-kit did not make ${a.name} for a story of this project, so it leaves it alone.`, 'not-ours');
    }
    await dropDb(a, a.name);
    dropMark('mongo', a.server, a.name);
    return true;
  },

  async removeTemplate(template: DbTemplate): Promise<void> {
    fs.rmSync(template.folder, { recursive: true, force: true });
  },
};
