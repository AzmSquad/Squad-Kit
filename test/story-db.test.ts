import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { Hono } from 'hono';
import type { Ticket } from '../src/board/types.js';
import type { DbTemplate, StoryRef, TemplateOptions } from '../src/engine/db/types.js';

/**
 * A database of its own for each story, with a fake adapter in place of a real server: learning the database and
 * keeping it (shared settings, and this computer's secrets), a story's copy pointed at its own database, the database
 * going at merge, release, delete and with the leftovers, and the person's own database never touched.
 */

const fake = vi.hoisted(() => ({
  templates: [] as TemplateOptions[],
  made: [] as string[],
  dropped: [] as { address: string; persons: string }[],
  createFails: null as Error | null,
  dropFails: null as Error | null,
  /** A broken adapter that hands back the person's own address. */
  givesOwn: false,
  missing: [] as string[],
}));

vi.mock('../src/engine/db/index.js', async () => {
  const types = await import('../src/engine/db/types.js');
  const nodeFs = await import('node:fs');
  const nodePath = await import('node:path');
  const nameOf = (a: string) => (a.startsWith('file:') ? a.slice(5) : (/\/([^/?]+)(?:\?|$)/.exec(a)?.[1] ?? ''));
  const storyAddress = (source: string, story: StoryRef) => source.replace(/\/([^/?]+)(\?|$)/, `/$1_${story.id.toLowerCase().replace(/-/g, '_')}$2`);
  const adapter = (kind: 'postgres') => ({
    kind,
    missingTools: () => fake.missing,
    async makeTemplate(source: string, opts: TemplateOptions): Promise<DbTemplate> {
      fake.templates.push(opts);
      const info = { kind, source: source.replace(/:[^:@/]+@/, ':***@'), sourceName: nameOf(source), madeAt: new Date().toISOString(), bytes: 2048, smallRows: 1000, sampleRows: opts.sampleRows ?? 1000, hidePersonal: Boolean(opts.hidePersonal), tables: [{ name: 'patients', kept: 'sampled' as const, rows: 1000 }, { name: 'clinics', kept: 'whole' as const, rows: 4 }], hidden: [], linksComplete: true, notes: [] };
      nodeFs.mkdirSync(opts.folder, { recursive: true });
      nodeFs.writeFileSync(nodePath.join(opts.folder, 'template.json'), JSON.stringify(info));
      return { kind, folder: opts.folder, source, info };
    },
    async createStoryDb(template: DbTemplate, story: StoryRef) {
      if (fake.createFails) throw fake.createFails;
      // A SQLite story database is a file in the story's copy, as the real adapter makes it.
      if ((kind as string) === 'sqlite') {
        const file = nodePath.join(story.folder!, `dev_${story.id.toLowerCase().replace(/-/g, '_')}.db`);
        nodeFs.writeFileSync(file, 'the template, with the person\'s data');
        return { kind, name: file, address: `file:${file}`, existed: false };
      }
      const address = fake.givesOwn ? template.source : storyAddress(template.source, story);
      const name = nameOf(address);
      const existed = fake.made.includes(name);
      if (!existed) fake.made.push(name);
      return { kind, name, address, existed };
    },
    async dropStoryDb(address: string, persons: string) {
      if (nameOf(address) === nameOf(persons)) throw new types.DbError('squad-kit never drops your own database.', 'persons-own');
      if (fake.dropFails) throw fake.dropFails;
      fake.dropped.push({ address, persons });
      return true;
    },
    storyAddress,
    nameOf,
    isPersonsOwn: (a: string, p: string) => nameOf(a) === nameOf(p),
    async removeTemplate() {},
  });
  const readTemplate = (folder: string, source: string): DbTemplate | null => {
    const file = nodePath.join(folder, 'template.json');
    if (!nodeFs.existsSync(file)) return null;
    const info = JSON.parse(nodeFs.readFileSync(file, 'utf8'));
    return { kind: info.kind, folder, source, info };
  };
  return { ...types, dbAdapter: adapter, kindOfAddress: () => null, readTemplate };
});

const { boardPaths, readMeta, readTicket, writeMeta, writeTicket, updateTicket } = await import('../src/board/store.js');
const { loadSecrets } = await import('../src/core/secrets.js');
const S = await import('../src/engine/story-db.js');
const { copyDbEnv, copyDbFiles, forgetWiring } = await import('../src/engine/db-env.js');
const { hiddenFiles, placeStoryFiles } = await import('../src/engine/local-files.js');
const { addLocalFile, storyFile } = await import('../src/board/project-files.js');
const { saveScan } = await import('../src/engine/onboard.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { deleteTicket } = await import('../src/engine/delete.js');
const { addWorktree } = await import('./support/copy.js');
const { stageAll } = await import('../src/engine/git.js');
const { mountBoardApi } = await import('../src/console/api/board.js');
const { buildPaths, chooseProject } = await import('../src/core/paths.js');
const { runDb, runDbHide, runDbSample } = await import('../src/commands/db.js');

const PERSONS = 'postgresql://clinic:clinic-pass@localhost:5433/clinic_dev';
const STORY = 'postgresql://clinic:clinic-pass@localhost:5433/clinic_dev_cl_1';

let root: string;
let bp: ReturnType<typeof boardPaths>;
const sh = (cmd: string, cwd = root) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (file: string, text: string, dir = root) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};

function story(more: Partial<Ticket> = {}): Ticket {
  const t = {
    id: 'CL-1',
    title: 'Book a visit',
    ask: 'Let patients book a visit',
    kind: 'feature',
    source: { type: 'manual' },
    priority: 'normal',
    stage: 'implement',
    status: '',
    waiting: null,
    createdAt: new Date().toISOString(),
    createdBy: 'Momen',
    activity: [],
    story: 'As a patient, I book a visit.',
    criteria: [{ given: 'a free slot', when: 'I book it', then: 'it is mine' }],
    ...more,
  } as Ticket;
  writeTicket(bp, t);
  return readTicket(bp, t.id)!;
}

/** The learned database, confirmed, with a template made: what a story needs to get its own. */
async function readyDatabase(): Promise<void> {
  S.learnDatabase(bp);
  S.confirmDatabase(bp, 'Momen');
  await S.makeDbTemplate(bp, 'Momen');
}

beforeEach(() => {
  fake.templates.length = 0;
  fake.made.length = 0;
  fake.dropped.length = 0;
  fake.createFails = null;
  fake.dropFails = null;
  fake.givesOwn = false;
  fake.missing = [];
  forgetWiring();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-story-db-')));
  write('.gitignore', '.env\n.squad/\nnode_modules\n');
  write('package.json', JSON.stringify({ name: 'clinic', dependencies: { '@prisma/client': '5.0.0' } }));
  write('prisma/schema.prisma', 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n');
  write('.env.example', 'DATABASE_URL=postgresql://user:pass@localhost:5432/example\n');
  sh('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm start');
  // The person's own settings: their copy of the app uses their own database.
  write('.env', `DATABASE_URL=${PERSONS}\nSECRET_KEY=persons-own-key\n`);
  bp = boardPaths(path.join(root, '.squad'));
  writeMeta(bp, {
    project: 'Clinic',
    key: 'CL',
    nextNumber: 2,
    engine: 'live',
    runner: 'direct',
    user: { name: 'Momen', role: 'Engineer' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
    commands: {},
    git: { base: 'main', remote: '' },
    scan: { status: 'done', empty: false },
  });
});

afterEach(() => {
  forgetWiring();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('learning the database', () => {
  it("keeps the kind, name and setting with the team's settings, and the address with its password on this computer only", () => {
    const r = S.learnDatabase(bp);
    expect(r.database).toMatchObject({ kind: 'postgres', repo: '.', name: 'clinic_dev', setting: { env: 'DATABASE_URL', file: '.env' } });
    const shared = fs.readFileSync(bp.configFile, 'utf8');
    expect((yaml.load(shared) as { board: { database: unknown } }).board.database).toMatchObject({ kind: 'postgres', name: 'clinic_dev', setting: { env: 'DATABASE_URL' } });
    expect(shared).not.toContain('clinic-pass');
    expect(readMeta(bp).database?.address).toBeUndefined();
    expect(loadSecrets(bp.secretsFile).database?.address).toBe(PERSONS);
    expect(S.personsAddress(bp)).toBe(PERSONS);
  });

  it('keeps an address with no password in the shared settings', () => {
    write('.env', 'DATABASE_URL=postgresql://localhost:5433/clinic_dev\n');
    S.learnDatabase(bp);
    expect(readMeta(bp).database?.address).toBe('postgresql://localhost:5433/clinic_dev');
    expect(loadSecrets(bp.secretsFile).database?.address).toBeUndefined();
  });

  it("at the project's first read, and a confirmed one stays as it is on the next read", () => {
    saveScan(bp, { empty: false, summary: 'A clinic app', map: [], decisions: [], commands: {} }, []);
    expect(readMeta(bp).database).toMatchObject({ kind: 'postgres', name: 'clinic_dev' });
    S.confirmDatabase(bp, 'Momen', { name: 'clinic_dev' });
    write('.env', 'DATABASE_URL=postgresql://other:x@localhost:5433/other_db\n');
    saveScan(bp, { empty: false, summary: 'A clinic app', map: [], decisions: [], commands: {} }, []);
    expect(readMeta(bp).database).toMatchObject({ name: 'clinic_dev', confirmed: { by: 'Momen' } });
    // Asked again by an engineer: the new one, not confirmed until they say so.
    S.learnDatabase(bp, { again: true });
    expect(readMeta(bp).database?.name).toBe('other_db');
    expect(readMeta(bp).database?.confirmed).toBeUndefined();
  });

  it('an engineer corrects it when confirming, and is told plainly what is wrong', () => {
    S.learnDatabase(bp);
    const db = S.confirmDatabase(bp, 'Momen', { env: 'APP_DB_URL', address: 'postgresql://localhost:5433/clinic_main' });
    expect(db).toMatchObject({ name: 'clinic_main', setting: { env: 'APP_DB_URL' }, address: 'postgresql://localhost:5433/clinic_main', confirmed: { by: 'Momen' } });
    expect(loadSecrets(bp.secretsFile).database?.address).toBeUndefined();
    expect(() => S.confirmDatabase(bp, 'Momen', { kind: 'oracle' })).toThrow('"oracle" is not a kind squad-kit can copy');
    expect(() => S.confirmDatabase(bp, 'Momen', { address: 'mongodb://localhost/x' })).toThrow('That address is for Mongo, not Postgres.');
    expect(() => S.confirmDatabase(bp, 'Momen', { env: '', file: '' })).toThrow('Name the setting that points the app at the database');
    expect(() => S.confirmDatabase(bp, 'Momen', { file: '../outside.env' })).toThrow('must be inside the repo');
  });
});

describe('the template', () => {
  it('is made only once an engineer confirmed the database, with the hiding switch and the sample size', async () => {
    S.learnDatabase(bp);
    await expect(S.makeDbTemplate(bp, 'Momen')).rejects.toThrow('An engineer confirms the database first');
    S.confirmDatabase(bp, 'Momen');
    S.setDatabaseOptions(bp, { hidePersonal: true, sampleRows: 250 });
    expect(() => S.setDatabaseOptions(bp, { sampleRows: 3 })).toThrow('The sample size is a number of rows from 10 to 1,000,000');
    const info = await S.makeDbTemplate(bp, 'Momen');
    expect(info).toMatchObject({ sourceName: 'clinic_dev', bytes: 2048 });
    expect(fake.templates).toEqual([{ folder: S.templateFolder(bp), hidePersonal: true, sampleRows: 250 }]);
    // On this computer, in squad-kit's own folder for the project, never in the project's folder.
    expect(S.templateFolder(bp).startsWith(bp.localDir)).toBe(true);
    expect(S.databaseView(bp).template).toMatchObject({ bytes: 2048, source: 'postgresql://clinic:***@localhost:5433/clinic_dev' });
  });

  it('says which tool this computer lacks', async () => {
    S.learnDatabase(bp);
    S.confirmDatabase(bp, 'Momen');
    fake.missing = ['pg_dump'];
    await expect(S.makeDbTemplate(bp, 'Momen')).rejects.toThrow('Making a template of a Postgres database needs pg_dump on this computer.');
  });
});

describe("a story's own database", () => {
  it('is made from the template, and the copy points at it, never at the person\'s own', async () => {
    await readyDatabase();
    const wt = addWorktree(root, 'CL-1', 'main');
    const r = await S.setUpStoryDb(bp, 'CL-1', wt.dir, '.');
    expect(r).toEqual({ state: 'own', name: 'clinic_dev_cl_1', made: true });
    // The copy's own .env, which git leaves out, and every command in the copy.
    expect(fs.readFileSync(path.join(wt.dir, '.env'), 'utf8')).toBe(`DATABASE_URL=${STORY}\n`);
    expect(copyDbEnv(wt.dir)).toEqual({ DATABASE_URL: STORY });
    expect(copyDbEnv(path.join(wt.dir, 'src'))).toEqual({ DATABASE_URL: STORY });
    // The person's own folder is as it was.
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toContain(PERSONS);
    // Its address is in the secrets; the copy's settings file is hidden from agents.
    expect(loadSecrets(bp.secretsFile).database?.stories).toEqual({ 'CL-1': STORY });
    expect(copyDbFiles(wt.dir)).toEqual([path.join(wt.dir, '.env')]);
    expect(await hiddenFiles(bp, wt.dir)).toContain(path.join(wt.dir, '.env'));
    expect(S.storyDbs(bp)).toEqual([expect.objectContaining({ story: 'CL-1', name: 'clinic_dev_cl_1', dir: wt.dir })]);
    // Used again by a later step: the same database.
    expect(await S.setUpStoryDb(bp, 'CL-1', wt.dir, '.')).toEqual({ state: 'own', name: 'clinic_dev_cl_1', made: false });
  });

  it('keeps pointing at it when the local files are placed again over the copy\'s .env', async () => {
    await readyDatabase();
    addLocalFile(bp, '.', '.env');
    fs.mkdirSync(path.dirname(storyFile(bp, { repo: '.', path: '.env' })), { recursive: true });
    fs.writeFileSync(storyFile(bp, { repo: '.', path: '.env' }), 'DATABASE_URL=postgresql://test:test@localhost:5433/clinic_dev\nSECRET_KEY=test-key\n');
    const wt = addWorktree(root, 'CL-1', 'main');
    await S.setUpStoryDb(bp, 'CL-1', wt.dir, '.');
    placeStoryFiles(bp, '.', wt.dir);
    const text = fs.readFileSync(path.join(wt.dir, '.env'), 'utf8');
    expect(text).toContain(`DATABASE_URL=${STORY}`);
    expect(text).toContain('SECRET_KEY=test-key');
    expect(text).not.toContain('localhost:5433/clinic_dev\n');
  });

  it('never writes a settings file git would save: the environment alone points the copy', async () => {
    write('.gitignore', '.squad/\n');
    write('.env', 'DATABASE_URL=postgresql://localhost:5433/clinic_dev\n');
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm "env in git"');
    await readyDatabase();
    const wt = addWorktree(root, 'CL-1', 'main');
    await S.setUpStoryDb(bp, 'CL-1', wt.dir, '.');
    expect(fs.readFileSync(path.join(wt.dir, '.env'), 'utf8')).toBe('DATABASE_URL=postgresql://localhost:5433/clinic_dev\n');
    expect(copyDbEnv(wt.dir)).toEqual({ DATABASE_URL: 'postgresql://localhost:5433/clinic_dev_cl_1' });
    expect(copyDbFiles(wt.dir)).toEqual([]);
  });

  it("refuses an address that is the person's own, whatever the adapter says, and the story goes on as before", async () => {
    await readyDatabase();
    fake.givesOwn = true;
    const wt = addWorktree(root, 'CL-1', 'main');
    const r = await S.setUpStoryDb(bp, 'CL-1', wt.dir, '.');
    expect(r).toMatchObject({ state: 'as-before', why: expect.stringContaining('refused to point CL-1 at your own database') });
    expect(copyDbEnv(wt.dir)).toEqual({});
    expect(fs.existsSync(path.join(wt.dir, '.env'))).toBe(false);
    expect(S.storyDbs(bp)).toEqual([]);
  });

  it('when the code names the database itself: no template, no copy, and engineers are told why', async () => {
    write('src/db.ts', 'export const pool = new Pool({ connectionString: process.env.DATABASE_URL, database: "clinic_dev" });\n');
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm "named in code"');
    S.learnDatabase(bp);
    S.confirmDatabase(bp, 'Momen');
    const why = "The code names the database clinic_dev itself, in src/db.ts:1, so it would not use a story's own copy under another name.";
    // No template: it would read the person's data for nothing.
    await expect(S.makeDbTemplate(bp, 'Momen')).rejects.toThrow(why);
    expect(fake.templates).toEqual([]);
    const wt = addWorktree(root, 'CL-1', 'main');
    const r = await S.setUpStoryDb(bp, 'CL-1', wt.dir, '.');
    expect(r).toMatchObject({ state: 'as-before', why: expect.stringContaining(`CL-1 uses the database as before. ${why}`) });
    // The database is on this computer: engineers read that the story uses their own data.
    expect(r).toMatchObject({ why: expect.stringContaining("That is your own database on this computer: the story's app and tests can change its data.") });
    expect(fake.made).toEqual([]);
    expect(copyDbEnv(wt.dir)).toEqual({});
    const v = S.databaseView(bp);
    expect(v.blocked).toContain(why);
    expect(v.words).toBe('Stories use the database as before. The app chooses its database itself, so squad-kit cannot give each story a copy.');
  });

  it('with no template yet, the story goes on as before and engineers get one plain note', async () => {
    S.learnDatabase(bp);
    S.confirmDatabase(bp, 'Momen');
    const wt = addWorktree(root, 'CL-1', 'main');
    for (let i = 0; i < 3; i++) expect((await S.setUpStoryDb(bp, 'CL-1', wt.dir, '.')).state).toBe('as-before');
    const notes = S.databaseView(bp).notes.filter((n) => n.story === 'CL-1');
    expect(notes).toEqual([expect.objectContaining({ text: expect.stringContaining('There is no template of the database yet, so CL-1 uses it as before') })]);
    expect(copyDbEnv(wt.dir)).toEqual({});
  });

  it('with the database out of reach, the same: one note, with no password in it', async () => {
    await readyDatabase();
    const { DbError } = await import('../src/engine/db/types.js');
    fake.createFails = new DbError('The Postgres server at localhost:5433 did not answer (clinic-pass).', 'failed');
    const wt = addWorktree(root, 'CL-1', 'main');
    const r = await S.setUpStoryDb(bp, 'CL-1', wt.dir, '.');
    expect(r.state).toBe('as-before');
    const text = S.databaseView(bp).notes[0]!.text;
    expect(text).toContain('CL-1 uses the database as before: The Postgres server at localhost:5433 did not answer');
    expect(text).not.toContain('clinic-pass');
  });

  it('a SQLite file stays per copy; one in the person\'s folder moves into the copy', async () => {
    write('prisma/schema.prisma', 'datasource db {\n  provider = "sqlite"\n  url = env("DATABASE_URL")\n}\n');
    write('.env', 'DATABASE_URL="file:./dev.db"\n');
    S.learnDatabase(bp);
    expect(readMeta(bp).database).toMatchObject({ kind: 'sqlite', name: './dev.db' });
    const wt = addWorktree(root, 'CL-1', 'main');
    // Not confirmed: nothing said, nothing changed.
    expect(await S.setUpStoryDb(bp, 'CL-1', wt.dir, '.')).toEqual({ state: 'none' });
    S.confirmDatabase(bp, 'Momen');
    expect(await S.setUpStoryDb(bp, 'CL-1', wt.dir, '.')).toEqual({ state: 'none' });
    expect(copyDbEnv(wt.dir)).toEqual({});
    // The template is made from the person's own file, found where Prisma finds it.
    expect(S.personsAddress(bp)).toBe(`file:${path.join(root, 'prisma/dev.db')}`);
    S.confirmDatabase(bp, 'Momen', { address: `file:${root}/prisma/dev.db` });
    await S.setUpStoryDb(bp, 'CL-1', wt.dir, '.');
    expect(copyDbEnv(wt.dir)).toEqual({ DATABASE_URL: `file:${path.join(wt.dir, 'prisma/dev.db')}` });
    expect(S.databaseView(bp).notes).toEqual([]);
  });

  it("a story's own SQLite file never goes in its commit: it holds the person's data", async () => {
    write('prisma/schema.prisma', 'datasource db {\n  provider = "sqlite"\n  url = env("DATABASE_URL")\n}\n');
    write('.env', 'DATABASE_URL="file:./dev.db"\n');
    write('prisma/dev.db', 'the person\'s data');
    S.learnDatabase(bp);
    S.confirmDatabase(bp, 'Momen');
    await S.makeDbTemplate(bp, 'Momen');
    const wt = addWorktree(root, 'CL-1', 'main');
    const own = await S.setUpStoryDb(bp, 'CL-1', wt.dir, '.');
    expect(own).toMatchObject({ state: 'own' });
    expect(fs.existsSync(path.join(wt.dir, 'dev_cl_1.db'))).toBe(true);
    write('src/app.ts', 'export const a = 1;\n', wt.dir);
    fs.writeFileSync(path.join(wt.dir, 'dev_cl_1.db-journal'), 'x');
    stageAll(wt.dir);
    expect(sh('git diff --cached --name-only', wt.dir)).toBe('src/app.ts');
    // Nor does any step or agent see it as the story's work: git status leaves it out.
    expect(sh('git status --porcelain', wt.dir)).not.toContain('dev_cl_1');
    const exclude = path.join(root, '.git/info/exclude');
    expect(fs.readFileSync(exclude, 'utf8')).toContain('/dev_cl_1.db\n');
    // Dropped with the story, it leaves git's ignore list too.
    expect(await S.dropStoryDb(bp, 'CL-1')).toBe(true);
    expect(fs.readFileSync(exclude, 'utf8')).not.toContain('dev_cl_1');
  });

  it('a project with no database, or a copy of another repo, is left as it is', async () => {
    const wt = addWorktree(root, 'CL-1', 'main');
    expect(await S.setUpStoryDb(bp, 'CL-1', wt.dir, '.')).toEqual({ state: 'none' });
    await readyDatabase();
    expect(await S.setUpStoryDb(bp, 'CL-1', wt.dir, 'web')).toEqual({ state: 'none' });
  });
});

describe('the squad sets it up with the copy', () => {
  it('before the setup runs, so the setup and every command reach the story\'s database; a PM reads one plain line', async () => {
    await readyDatabase();
    // squad-kit's own environment has the person's address: the copy's commands must not get it.
    vi.stubEnv('DATABASE_URL', PERSONS);
    writeMeta(bp, { ...readMeta(bp), commands: { setup: 'node -e "require(\'fs\').writeFileSync(\'seen.txt\', String(process.env.DATABASE_URL))"' } });
    story();
    const squad = new LiveSquad(bp) as unknown as { workspace(id: string): Promise<Ticket> };
    const t = await squad.workspace('CL-1');
    expect(fs.readFileSync(path.join(t.worktree!, 'seen.txt'), 'utf8')).toBe(STORY);
    expect(fs.readFileSync(path.join(t.worktree!, '.env'), 'utf8')).toBe(`DATABASE_URL=${STORY}\n`);
    const said = readTicket(bp, 'CL-1')!.activity.map((a) => a.text);
    expect(said.filter((x) => /database/i.test(x))).toEqual(['The story has its own copy of the database.']);
    // A later step uses the same copy and the same database: nothing new, nothing said again.
    await squad.workspace('CL-1');
    expect(fake.made).toEqual(['clinic_dev_cl_1']);
    expect(readTicket(bp, 'CL-1')!.activity.filter((a) => a.text === S.OWN_DB_WORDS)).toHaveLength(1);
  });

  it('after a restart the copy points at it again', async () => {
    await readyDatabase();
    const wt = addWorktree(root, 'CL-1', 'main');
    await S.setUpStoryDb(bp, 'CL-1', wt.dir, '.');
    forgetWiring();
    expect(copyDbEnv(wt.dir)).toEqual({});
    S.rewireStoryDbs(bp);
    expect(copyDbEnv(wt.dir)).toEqual({ DATABASE_URL: STORY });
  });
});

describe('it goes when the story is done with it', () => {
  async function withOwn(): Promise<string> {
    await readyDatabase();
    story();
    const wt = addWorktree(root, 'CL-1', 'main');
    updateTicket(bp, 'CL-1', (x) => {
      x.worktree = wt.dir;
      x.branch = wt.branch;
      x.baseCommit = wt.baseCommit;
    });
    await S.setUpStoryDb(bp, 'CL-1', wt.dir, '.');
    return wt.dir;
  }
  const gone = (dir: string) => {
    expect(fake.dropped).toEqual([{ address: STORY, persons: PERSONS }]);
    expect(S.storyDbs(bp)).toEqual([]);
    expect(loadSecrets(bp.secretsFile).database?.stories).toBeUndefined();
    expect(loadSecrets(bp.secretsFile).database?.address).toBe(PERSONS);
    expect(copyDbEnv(dir)).toEqual({});
  };

  it('while it is open, it stays', async () => {
    await withOwn();
    expect(await S.tidyStoryDbs(bp)).toEqual([]);
    expect(fake.dropped).toEqual([]);
  });

  it('at merge', async () => {
    const dir = await withOwn();
    updateTicket(bp, 'CL-1', (x) => (x.mergedAt = new Date().toISOString()));
    expect(await S.tidyStoryDbs(bp)).toEqual(['CL-1']);
    gone(dir);
  });

  it('at merge, beside everything else, once the merge is written down', async () => {
    const dir = await withOwn();
    // The merge says so first, and writes the merge down right after.
    S.tidyStoryDbsBeside(bp, Date.now(), true);
    updateTicket(bp, 'CL-1', (x) => (x.mergedAt = new Date().toISOString()));
    await vi.waitFor(() => expect(fake.dropped).toHaveLength(1));
    gone(dir);
  });

  it('at release', async () => {
    const dir = await withOwn();
    updateTicket(bp, 'CL-1', (x) => (x.stage = 'done'));
    await S.tidyStoryDbs(bp);
    gone(dir);
  });

  it('at delete, with its copy', async () => {
    const dir = await withOwn();
    await deleteTicket(bp, 'CL-1', { waitMs: 2000 });
    expect(readTicket(bp, 'CL-1')).toBeNull();
    gone(dir);
  });

  it('with the leftovers: a story whose files are gone', async () => {
    const dir = await withOwn();
    fs.rmSync(path.join(bp.ticketsDir, 'CL-1'), { recursive: true, force: true });
    for (const f of fs.readdirSync(bp.stateDir)) if (f.toLowerCase().startsWith('cl-1')) fs.rmSync(path.join(bp.stateDir, f), { recursive: true, force: true });
    expect(readTicket(bp, 'CL-1')).toBeNull();
    await S.tidyStoryDbs(bp);
    gone(dir);
  });

  it('one the server cannot drop now stays on the list for the next tidy-up, with a note', async () => {
    await withOwn();
    updateTicket(bp, 'CL-1', (x) => (x.mergedAt = new Date().toISOString()));
    fake.dropFails = new Error('The server did not answer.');
    expect(await S.tidyStoryDbs(bp)).toEqual([]);
    expect(S.storyDbs(bp)).toHaveLength(1);
    expect(S.databaseView(bp).notes[0]!.text).toContain('could not drop clinic_dev_cl_1');
    fake.dropFails = null;
    expect(await S.tidyStoryDbs(bp)).toEqual(['CL-1']);
  });

  it("never the person's own, even when a story's record names it", async () => {
    await withOwn();
    // A record changed by hand to the person's own address.
    const file = bp.secretsFile;
    const s = loadSecrets(file);
    fs.writeFileSync(file, yaml.dump({ ...s, database: { ...s.database, stories: { 'CL-1': PERSONS } } }));
    updateTicket(bp, 'CL-1', (x) => (x.mergedAt = new Date().toISOString()));
    await S.tidyStoryDbs(bp);
    expect(fake.dropped).toEqual([]);
    expect(S.storyDbs(bp)).toEqual([]);
    expect(S.databaseView(bp).notes[0]!.text).toContain('left clinic_dev_cl_1 alone');
  });
});

describe('Harness, Settings and the terminal', () => {
  const app = () => {
    const a = new Hono();
    mountBoardApi(a, { paths: buildPaths(root) });
    return a;
  };
  const call = (a: Hono, url: string, method = 'POST', body?: unknown) => a.request(url, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

  it('one call each: see it, find it again, confirm it, the switches, make the template; no password passes', async () => {
    const a = app();
    let v = (await (await a.request('/api/v1/database')).json()) as ReturnType<typeof S.databaseView>;
    expect(v.database).toBeNull();
    v = (await (await call(a, '/api/v1/database/find')).json()) as typeof v;
    expect(v.database).toMatchObject({ kindName: 'Postgres', name: 'clinic_dev', address: 'postgresql://clinic:***@localhost:5433/clinic_dev', secret: true });
    const early = await call(a, '/api/v1/database/template');
    expect(early.status).toBe(400);
    expect(((await early.json()) as { error: string }).error).toBe('An engineer confirms the database first: squad db confirm');
    v = (await (await call(a, '/api/v1/database/confirm', 'POST', { name: 'clinic_dev' })).json()) as typeof v;
    expect(v.database?.confirmed?.by).toBe('Momen');
    v = (await (await call(a, '/api/v1/database', 'PUT', { hidePersonal: true, sampleRows: 500 })).json()) as typeof v;
    expect(v.database).toMatchObject({ hidePersonal: true, sampleRows: 500 });
    expect(readMeta(bp).database).toMatchObject({ hidePersonal: true, sampleRows: 500 });
    v = (await (await call(a, '/api/v1/database/template')).json()) as typeof v;
    expect(v.making?.by).toBe('Momen');
    await vi.waitFor(() => expect(S.databaseView(bp).template).not.toBeNull());
    const text = JSON.stringify(await (await a.request('/api/v1/database')).json());
    expect(text).not.toContain('clinic-pass');
  });

  it('squad db shows it, finds it, confirms it and makes the template; db-hide and db-sample set the switches', async () => {
    const said: string[] = [];
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((s) => (said.push(String(s)), true));
    chooseProject(root);
    try {
      await runDb(undefined);
      expect(said.join('')).toContain('squad-kit has not found a database in this project.');
      await runDb('find');
      await runDb('confirm', { env: 'DATABASE_URL' });
      await runDb('template');
      await runDbHide('on');
      await runDbSample('5000');
      await runDbHide(undefined);
      const shown = said.join('');
      expect(shown).toContain('Postgres clinic_dev');
      expect(shown).toContain('confirmed by Momen');
      expect(shown).toContain('DATABASE_URL in .env');
      expect(shown).toContain('postgresql://clinic:***@localhost:5433/clinic_dev');
      expect(shown).not.toContain('clinic-pass');
      expect(readMeta(bp).database).toMatchObject({ hidePersonal: true, sampleRows: 5000 });
      await expect(runDbHide('maybe')).rejects.toThrow('"maybe" is not a setting here. Use on or off.');
      await expect(runDb('drop')).rejects.toThrow('"drop" is not something squad db does.');
    } finally {
      chooseProject(null);
      out.mockRestore();
    }
  });
});

describe('plain words', () => {
  it('a PM reads at most one line; the engineers\' notes stay off the story', async () => {
    expect(S.OWN_DB_WORDS).toBe('The story has its own copy of the database.');
    S.learnDatabase(bp);
    story();
    const wt = addWorktree(root, 'CL-1', 'main');
    await S.setUpStoryDb(bp, 'CL-1', wt.dir, '.');
    expect(readTicket(bp, 'CL-1')!.activity).toEqual([]);
    expect(S.databaseView(bp).words).toBe('Stories use the database as before, until an engineer sets up a copy for each story.');
    await readyDatabase();
    expect(S.databaseView(bp).words).toBe('Each story gets its own copy of the database, made from a small template. Your own database is never changed.');
    for (const w of [S.databaseView(bp).words, S.OWN_DB_WORDS]) expect(w).not.toMatch(/postgres|mongo|DATABASE_URL|server|address|setting|\.env/i);
  });
});

describe('only on this computer', () => {
  const AWAY = 'postgresql://clinic:clinic-pass@203.0.113.7:5432/clinic_dev';
  const SAY = "This project's database is on another computer (203.0.113.7). squad-kit makes a story's own database only on this computer, so this story uses no copy of its own. An engineer can point the project at a local database in Settings.";

  it('makes no template and no story database on another computer, and the story says so in plain words', async () => {
    write('.env', `DATABASE_URL=${AWAY}\n`);
    S.learnDatabase(bp);
    S.confirmDatabase(bp, 'Momen');
    await expect(S.makeDbTemplate(bp, 'Momen')).rejects.toThrow("This project's database is on another computer (203.0.113.7). squad-kit makes a story's own database only on this computer, so it makes no template of it.");
    expect(fake.templates).toEqual([]);
    // Even with a template made earlier, from when the database was here.
    fs.mkdirSync(S.templateFolder(bp), { recursive: true });
    fs.writeFileSync(path.join(S.templateFolder(bp), 'template.json'), JSON.stringify({ kind: 'postgres', source: 'x', sourceName: 'clinic_dev', madeAt: new Date().toISOString(), bytes: 1, tables: [] }));
    const wt = addWorktree(root, 'CL-1', 'main');
    const r = await S.setUpStoryDb(bp, 'CL-1', wt.dir, '.');
    expect(r).toEqual({ state: 'as-before', why: SAY.replace('this story', 'CL-1'), say: SAY });
    expect(fake.made).toEqual([]);
    expect(copyDbEnv(wt.dir)).toEqual({});
    const v = S.databaseView(bp);
    expect(v.words).toBe("Stories use the database as before. It is on another computer, and squad-kit makes each story's own copy only on this one.");
    expect(v.blocked).toContain('so stories use it as before');
    expect(JSON.stringify(v)).not.toContain('clinic-pass');
  });

  it('on the story itself, once, for whoever reads it', async () => {
    write('.env', `DATABASE_URL=${AWAY}\n`);
    S.learnDatabase(bp);
    S.confirmDatabase(bp, 'Momen');
    story();
    const squad = new LiveSquad(bp) as unknown as { workspace(id: string): Promise<Ticket> };
    await squad.workspace('CL-1');
    await squad.workspace('CL-1');
    expect(readTicket(bp, 'CL-1')!.activity.filter((a) => a.text === SAY)).toHaveLength(1);
  });

  it('every host form: an srv link, several Mongo hosts with one away, IPv6, a cloud host', async () => {
    for (const [address, host] of [
      ['mongodb+srv://clinic:pw@cluster0.example.net/clinic_dev', 'cluster0.example.net'],
      ['mongodb://localhost:27017,198.51.100.4:27017/clinic_dev', '198.51.100.4'],
      ['mongodb://[2001:db8::7]:27017/clinic_dev', '2001:db8::7'],
      ['postgresql://clinic@clinic.abc.eu-west-1.rds.amazonaws.com:5432/clinic_dev', 'clinic.abc.eu-west-1.rds.amazonaws.com'],
    ]) {
      S.confirmDatabase(bp, 'Momen', { kind: address!.startsWith('mongo') ? 'mongo' : 'postgres', env: 'DATABASE_URL', address });
      await expect(S.makeDbTemplate(bp, 'Momen')).rejects.toThrow(`on another computer (${host})`);
    }
    expect(fake.templates).toEqual([]);
  });

  it('a compose service that publishes its port here: reached through it, and the copy keeps the name for Compose', async () => {
    write('docker-compose.yml', 'services:\n  db:\n    image: postgres:16\n    container_name: clinic-db\n    ports: ["5434:5432"]\n');
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm compose');
    write('.env', 'DATABASE_URL=postgresql://clinic:clinic-pass@Clinic-DB:5432/clinic_dev\n');
    await readyDatabase();
    expect(S.databaseView(bp).template?.source).toBe('postgresql://clinic:***@localhost:5434/clinic_dev');
    const wt = addWorktree(root, 'CL-1', 'main');
    expect(await S.setUpStoryDb(bp, 'CL-1', wt.dir, '.')).toMatchObject({ state: 'own', name: 'clinic_dev_cl_1' });
    expect(copyDbEnv(wt.dir)).toEqual({ DATABASE_URL: 'postgresql://clinic:clinic-pass@localhost:5434/clinic_dev_cl_1' });
    expect(fs.readFileSync(path.join(wt.dir, '.env'), 'utf8')).toBe('DATABASE_URL=postgresql://clinic:clinic-pass@Clinic-DB:5432/clinic_dev_cl_1\n');
  });

  it('a compose service that publishes no port here gets no copy either', async () => {
    write('docker-compose.yml', 'services:\n  db:\n    image: postgres:16\n    container_name: clinic-db\n    expose: ["5432"]\n');
    write('.env', 'DATABASE_URL=postgresql://clinic:clinic-pass@clinic-db:5432/clinic_dev\n');
    S.learnDatabase(bp);
    S.confirmDatabase(bp, 'Momen');
    await expect(S.makeDbTemplate(bp, 'Momen')).rejects.toThrow("This project's database runs in Docker as the clinic-db service, which does not publish its port on this computer.");
  });

  it('a settings file missing in the copy, so the app would fall back to another computer: said plainly', async () => {
    write('.gitignore', '.env\n.squad/\nnode_modules\nappsettings.Development.json\n');
    write('appsettings.json', JSON.stringify({ ConnectionStrings: { Clinic: 'Host=203.0.113.7;Port=5432;Database=clinic_dev;Username=clinic;Password=clinic-pass' } }));
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm settings');
    write('appsettings.Development.json', JSON.stringify({ ConnectionStrings: { Clinic: 'Host=localhost;Port=5433;Database=clinic_dev;Username=clinic' } }));
    S.learnDatabase(bp);
    S.confirmDatabase(bp, 'Momen', { file: 'appsettings.Development.json', key: 'ConnectionStrings:Clinic', env: 'ConnectionStrings__Clinic', address: 'Host=localhost;Port=5433;Database=clinic_dev;Username=clinic' });
    const wt = addWorktree(root, 'CL-1', 'main');
    const r = await S.setUpStoryDb(bp, 'CL-1', wt.dir, '.');
    const say = "This story's copy has no appsettings.Development.json, so its app falls back to the database in appsettings.json, which is on another computer (203.0.113.7). An engineer can add appsettings.Development.json as a local file in Settings, with values for stories.";
    expect(r).toEqual({ state: 'as-before', why: say, say });
    expect(JSON.stringify(S.databaseView(bp))).not.toContain('clinic-pass');
  });

  it('the same when the env file the daily stack reads is missing in the copy', async () => {
    fs.rmSync(path.join(root, 'prisma'), { recursive: true });
    fs.rmSync(path.join(root, '.env'));
    write('.gitignore', '.env\n.env.dev\n.squad/\nnode_modules\n');
    write('appsettings.json', JSON.stringify({ ConnectionStrings: { Clinic: 'Host=203.0.113.7;Port=5432;Database=clinic_dev;Username=clinic;Password=clinic-pass' } }));
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm dotnet');
    write('.env.dev', 'ConnectionStrings__Clinic=Host=localhost;Port=5433;Database=clinic_dev;Username=clinic\n');
    S.learnDatabase(bp);
    expect(readMeta(bp).database).toMatchObject({ kind: 'postgres', setting: { env: 'ConnectionStrings__Clinic', file: '.env.dev' }, address: 'Host=localhost;Port=5433;Database=clinic_dev;Username=clinic', from: ['appsettings.json', '.env.dev'] });
    S.confirmDatabase(bp, 'Momen');
    const wt = addWorktree(root, 'CL-1', 'main');
    const r = await S.setUpStoryDb(bp, 'CL-1', wt.dir, '.');
    expect(r).toMatchObject({ state: 'as-before', say: "This story's copy has no .env.dev, so its app falls back to the database in appsettings.json, which is on another computer (203.0.113.7). An engineer can add .env.dev as a local file in Settings, with values for stories." });
  });
});

describe("a part's env file that fills its address from other settings", () => {
  /** A .NET API whose daily stack runs in Compose: the database address in appsettings.json is another computer's. */
  function ordersApi(address: string): void {
    fs.rmSync(path.join(root, 'prisma'), { recursive: true });
    fs.rmSync(path.join(root, '.env'));
    write('.gitignore', '.env\n.env.dev\n.squad/\nnode_modules\n');
    write('docker-compose.yml', 'services:\n  api:\n    build: .\n    env_file: .env.dev\n  orders-db:\n    image: mongo:7\n    ports: ["27019:27017"]\n');
    write('Orders.Api/appsettings.json', JSON.stringify({ ConnectionStrings: { Orders: 'mongodb://orders:remote-pass@203.0.113.7:27017/orders' } }));
    write('Orders.Api/Program.cs', 'var cs = builder.Configuration.GetConnectionString("Orders");\nvar db = new MongoClient(cs).GetDatabase(MongoUrl.Create(cs).DatabaseName);\n');
    // Its tests name the database themselves: that is the tests' own business.
    write('Orders.Api.Integration.Test/Fixture.cs', 'var db = client.GetDatabase("orders");\n');
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm dotnet');
    write('.env.dev', `MONGO_USER=orders\nMONGO_PASSWORD=orders-pass\nMONGO_HOST=orders-db\nMONGO_PORT=27017\nConnectionStrings__Orders=${address}\n`);
    writeMeta(bp, { ...readMeta(bp), commands: { envFile: '.env.dev' } });
  }

  it('is learned from that file, filled in, and each story gets its own copy through the port Compose publishes', async () => {
    ordersApi('mongodb://${MONGO_USER}:${MONGO_PASSWORD}@${MONGO_HOST}:${MONGO_PORT}/orders?authMechanism=SCRAM-SHA-256');
    S.learnDatabase(bp);
    expect(readMeta(bp).database).toMatchObject({ kind: 'mongo', name: 'orders', setting: { env: 'ConnectionStrings__Orders', file: '.env.dev' }, where: 'the orders-db service in docker-compose.yml, on port 27019' });
    expect(S.personsAddress(bp)).toBe('mongodb://orders:orders-pass@orders-db:27017/orders?authMechanism=SCRAM-SHA-256');
    expect(fs.readFileSync(bp.configFile, 'utf8')).not.toContain('orders-pass');
    S.confirmDatabase(bp, 'Momen');
    await S.makeDbTemplate(bp, 'Momen');
    expect(S.databaseView(bp).template?.source).toBe('mongodb://orders:***@localhost:27019/orders?authMechanism=SCRAM-SHA-256');
    const wt = addWorktree(root, 'CL-1', 'main');
    expect(await S.setUpStoryDb(bp, 'CL-1', wt.dir, '.')).toMatchObject({ state: 'own', name: 'orders_cl_1' });
    expect(copyDbEnv(wt.dir)).toEqual({ ConnectionStrings__Orders: 'mongodb://orders:orders-pass@localhost:27019/orders_cl_1?authMechanism=SCRAM-SHA-256' });
    // The copy's own .env.dev keeps the service's name, for an app that Compose runs there.
    expect(fs.readFileSync(path.join(wt.dir, '.env.dev'), 'utf8')).toBe('ConnectionStrings__Orders=mongodb://orders:orders-pass@orders-db:27017/orders_cl_1?authMechanism=SCRAM-SHA-256\n');
  });

  it("with no database's name in it: stories use it as before, engineers are told why, and no password shows", async () => {
    ordersApi('mongodb://${MONGO_USER}:${MONGO_PASSWORD}@${MONGO_HOST}:${MONGO_PORT}/?authMechanism=SCRAM-SHA-256');
    S.learnDatabase(bp);
    expect(readMeta(bp).database).toMatchObject({ kind: 'mongo', setting: { env: 'ConnectionStrings__Orders', file: '.env.dev' } });
    expect(readMeta(bp).database?.name).toBeUndefined();
    S.confirmDatabase(bp, 'Momen');
    await expect(S.makeDbTemplate(bp, 'Momen')).rejects.toThrow('The address in .env.dev names no database');
    expect(fake.templates).toEqual([]);
    const wt = addWorktree(root, 'CL-1', 'main');
    expect((await S.setUpStoryDb(bp, 'CL-1', wt.dir, '.')).state).toBe('as-before');
    expect(copyDbEnv(wt.dir)).toEqual({});
    const v = S.databaseView(bp);
    expect(v.blocked).toContain('The address in .env.dev names no database');
    expect(v.notes.map((n) => n.text).join('\n')).toContain('CL-1 uses the database as before.');
    expect(JSON.stringify(v)).not.toContain('orders-pass');
  });
});

describe("a story's own Redis, with its database", () => {
  let tools: string;
  beforeEach(() => {
    // A stand-in redis-cli that only writes down what it was given: no real Redis.
    tools = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-redis-cli-'));
    fs.writeFileSync(path.join(tools, 'redis-cli'), `#!/bin/sh\necho "$@" >> "${tools}/calls.txt"\necho OK\n`, { mode: 0o755 });
    vi.stubEnv('SQUAD_DB_TOOL_DIRS', tools);
    write('docker-compose.yml', 'services:\n  api:\n    build: .\n    environment:\n      REDIS_URL: redis://cache:6379\n  cache:\n    image: redis:7\n    ports: ["6379:6379"]\n');
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm cache');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tools, { recursive: true, force: true });
  });

  it('comes with the copy, shows on Harness, and its keys are cleared when the story is deleted', async () => {
    await readyDatabase();
    story();
    const wt = addWorktree(root, 'CL-1', 'main');
    updateTicket(bp, 'CL-1', (x) => {
      x.worktree = wt.dir;
      x.branch = wt.branch;
      x.baseCommit = wt.baseCommit;
    });
    await S.setUpStoryDb(bp, 'CL-1', wt.dir, '.');
    const n = S.databaseView(bp).redis!.stories[0]!.number;
    expect(n).toBeGreaterThanOrEqual(1);
    expect(copyDbEnv(wt.dir)).toEqual({ DATABASE_URL: STORY, REDIS_URL: `redis://localhost:6379/${n}` });
    expect(S.databaseView(bp).redis).toMatchObject({ server: 'localhost:6379', here: true, own: 0 });
    await deleteTicket(bp, 'CL-1', { waitMs: 2000 });
    expect(fs.readFileSync(path.join(tools, 'calls.txt'), 'utf8')).toBe(`-h localhost -p 6379 -n ${n} FLUSHDB\n`);
    expect(S.databaseView(bp).redis!.stories).toEqual([]);
  });

  it('a story with a Redis number and no database of its own still has it cleared at merge', async () => {
    S.learnDatabase(bp);
    story();
    const wt = addWorktree(root, 'CL-1', 'main');
    await S.setUpStoryDb(bp, 'CL-1', wt.dir, '.');
    expect(Object.keys(copyDbEnv(wt.dir))).toEqual(['REDIS_URL']);
    updateTicket(bp, 'CL-1', (x) => (x.mergedAt = new Date().toISOString()));
    expect(await S.tidyStoryDbs(bp)).toEqual(['CL-1']);
    expect(fs.readFileSync(path.join(tools, 'calls.txt'), 'utf8')).toMatch(/^-h localhost -p 6379 -n ([1-9]|1[0-5]) FLUSHDB\n$/);
  });
});
