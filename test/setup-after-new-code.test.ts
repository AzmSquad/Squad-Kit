import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { boardPaths, readTicket, writeMeta } = await import('../src/board/store.js');
const { createTicket } = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { changesSetup } = await import('../src/engine/run-app.js');

/**
 * New packages or database changes come into a story's copy after its setup ran (the newest code came in, or the
 * Builder renamed its own change): the setup runs again before the checks and before the app starts, so the app never
 * runs on an old database. A copy's own database that is out of step is set aside and made again. Real git, and a
 * setup that works like a migration tool: it refuses a change it applied that is gone, and applies the new ones.
 */

let tmp: string;
let project: string;
let ran: string;
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();

/** Like prisma migrate dev: a change applied that is not in the files any more needs the database made again. */
const MIGRATE = [
  'echo ran >> "$RAN"',
  'touch app.db',
  'for a in $(cat app.db); do test -e "migrations/$a" || { echo "drift: $a was applied and is gone, the database must be reset"; exit 1; }; done',
  'for m in $(ls migrations); do grep -qx "$m" app.db || echo "$m" >> app.db; done',
].join('; ');

type Copy = { repo: { path: string; base: string; remote: string; commands: { setup?: string } }; dir: string; label: string };
type Squad = { workspace(id: string): Promise<unknown>; guardFor(): undefined; setUpAgain(id: string, c: Copy): Promise<{ name: string; ok: boolean; output: string } | null> };

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-setup-new-code-')));
  project = path.join(tmp, 'app');
  ran = path.join(tmp, 'ran.txt');
  process.env.RAN = ran;
  fs.mkdirSync(path.join(project, 'migrations'), { recursive: true });
  sh('git init -q -b main', project);
  fs.writeFileSync(path.join(project, '.gitignore'), '.env\napp.db\n');
  fs.writeFileSync(path.join(project, 'migrations', '001_init'), 'create table owners;\n');
  sh('git add -A && git -c user.name=t -c user.email=t@t commit -q -m first', project);
});

afterEach(() => {
  delete process.env.RAN;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function story(setup = MIGRATE): Promise<{ squad: Squad; id: string; copy: Copy; bp: ReturnType<typeof boardPaths> }> {
  const bp = boardPaths(path.join(project, '.squad'));
  writeMeta(bp, {
    project: 'App',
    key: 'AP',
    nextNumber: 1,
    engine: 'live',
    user: { name: 'Momen', role: 'Project manager' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
    commands: { setup },
    git: { base: 'main', remote: '' },
    scan: { status: 'done', empty: false },
  });
  const t = createTicket(bp, { title: 'Opening hours' });
  const squad = new LiveSquad(bp) as unknown as Squad;
  squad.guardFor = () => undefined;
  await squad.workspace(t.id);
  const dir = readTicket(bp, t.id)!.worktree!;
  fs.writeFileSync(path.join(dir, '.env'), 'DATABASE_URL="file:./app.db"\n');
  return { squad, id: t.id, bp, copy: { repo: { path: '.', base: 'main', remote: '', commands: { setup } }, dir, label: 'app' } };
}

const runs = () => fs.readFileSync(ran, 'utf8').trim().split('\n').length;
const applied = (dir: string) => fs.readFileSync(path.join(dir, 'app.db'), 'utf8').trim().split('\n');

describe('the setup again, after new code came into a copy', () => {
  it('runs only when packages or database changes came in, saved or not', async () => {
    const { squad, id, copy } = await story();
    expect(runs()).toBe(1);
    expect(await squad.setUpAgain(id, copy)).toBeNull();
    fs.writeFileSync(path.join(copy.dir, 'page.tsx'), 'export const page = 1;\n');
    expect(await squad.setUpAgain(id, copy)).toBeNull();
    expect(runs()).toBe(1);

    // The newest main came in with a change to the database.
    fs.writeFileSync(path.join(copy.dir, 'migrations', '002_services'), 'create table services;\n');
    expect(await squad.setUpAgain(id, copy)).toBeNull();
    expect(runs()).toBe(2);
    expect(applied(copy.dir)).toEqual(['001_init', '002_services']);
    expect(await squad.setUpAgain(id, copy)).toBeNull();
    expect(runs()).toBe(2);
  });

  it("makes the copy's own database again when it is out of step, and keeps the old one aside, out of commits", async () => {
    const { squad, id, copy, bp } = await story();
    fs.writeFileSync(path.join(copy.dir, 'migrations', '002_hours'), 'create table hours;\n');
    await squad.setUpAgain(id, copy);
    expect(applied(copy.dir)).toEqual(['001_init', '002_hours']);
    // Like MA-6: main brought a change of its own, and the Builder renamed the story's change to come after it.
    fs.renameSync(path.join(copy.dir, 'migrations', '002_hours'), path.join(copy.dir, 'migrations', '003_hours'));
    fs.writeFileSync(path.join(copy.dir, 'migrations', '002_staff'), 'create table staff;\n');

    expect(await squad.setUpAgain(id, copy)).toBeNull();
    expect(runs()).toBe(4);
    expect(applied(copy.dir)).toEqual(['001_init', '002_staff', '003_hours']);
    expect(fs.readFileSync(path.join(copy.dir, 'app.db.out-of-step'), 'utf8')).toBe('001_init\n002_hours\n');
    expect(sh('git status --short', copy.dir)).not.toContain('out-of-step');
    expect(readTicket(bp, id)!.activity.map((a) => a.text)).toContain("The copy's own database was out of step with the code, so squad-kit made it again");
  });

  it('a setup that still fails comes back as a failed check, for the Builder, and the story\'s work stays', async () => {
    const { squad, id, copy } = await story();
    fs.writeFileSync(path.join(copy.dir, 'page.tsx'), 'work in progress\n');
    sh('git add page.tsx', copy.dir);
    fs.writeFileSync(path.join(copy.dir, 'package.json'), '{ "name": "app", "dependencies": { "nope": "1" } }\n');
    const broken = { ...copy, repo: { ...copy.repo, commands: { setup: 'echo "npm ERR! nope not found"; exit 1' } } };
    const failed = await squad.setUpAgain(id, broken);
    expect(failed).toMatchObject({ name: 'setup', ok: false });
    expect(failed!.output).toContain('nope not found');
    expect(fs.readFileSync(path.join(copy.dir, 'page.tsx'), 'utf8')).toBe('work in progress\n');
    // Nothing of a database was there to set aside.
    expect(fs.existsSync(path.join(copy.dir, 'app.db.out-of-step'))).toBe(false);
  });

  it('counts packages and database changes, and nothing else', () => {
    for (const f of ['package.json', 'web/package-lock.json', 'prisma/schema.prisma', 'prisma/migrations/2026_hours/migration.sql', 'db/migrate/001_init.rb', 'shop/migrations/0002_auto.py', 'Data/Migrations/20261109_Hours.cs', 'alembic/versions/1a2b_hours.py', 'requirements-dev.txt', 'Api.csproj'])
      expect(changesSetup(f), f).toBe(true);
    for (const f of ['src/page.tsx', 'README.md', 'docs/migrating.md', 'src/lib/migrate-helper.ts']) expect(changesSetup(f), f).toBe(false);
  });
});
