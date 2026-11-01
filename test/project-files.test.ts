import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  boardPaths,
  hasLegacyBoard,
  listDecisions,
  listReleases,
  listTickets,
  readMeta,
  readTicket,
  updateTicket,
  type BoardPaths,
} from '../src/board/store.js';
import { seedDemoBoard } from '../src/board/demo.js';
import * as actions from '../src/board/actions.js';
import { moveBoard, MoveError } from '../src/board/move.js';
import type { Ticket } from '../src/board/types.js';

let tmp: string;
let bp: BoardPaths;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-files-')));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const files = (dir: string): string[] =>
  fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => path.relative(dir, path.join(d.parentPath, d.name)));

describe('the project keeps its own memory (ADR-001)', () => {
  it('keeps the documents in .squad and the live state on this computer', () => {
    expect(fs.existsSync(path.join(bp.squadDir, 'board'))).toBe(false);
    expect(files(path.join(bp.ticketsDir, 'SK-148')).sort()).toEqual(['questions.md', 'ticket.md']);
    const t = readTicket(bp, 'SK-150')!;
    expect(t.stuck).toBeTruthy();
    const shared = files(bp.squadDir).map((f) => fs.readFileSync(path.join(bp.squadDir, f), 'utf8')).join('\n');
    expect(shared).not.toContain(t.stuck!.question);
    expect(shared).not.toContain(t.activity[0]!.text);
    expect((yaml.load(fs.readFileSync(path.join(bp.stateDir, 'SK-150.yaml'), 'utf8')) as Ticket).stuck!.question).toBe(t.stuck!.question);
    expect(bp.localDir.startsWith(process.env.SQUAD_KIT_HOME!)).toBe(true);
  });

  it('comes back from .squad alone on a new computer: specs, answers, designs, stages and decisions', () => {
    const before = listTickets(bp);
    const decisions = listDecisions(bp);
    fs.rmSync(bp.localDir, { recursive: true, force: true });
    const after = listTickets(bp);
    expect(after.map((t) => [t.id, t.stage, t.title])).toEqual(before.map((t) => [t.id, t.stage, t.title]));
    for (const t of before) {
      const a = after.find((x) => x.id === t.id)!;
      expect(a.story).toEqual(t.story);
      expect(a.criteria).toEqual(t.criteria);
      expect(a.questions?.map((q) => [q.id, q.text, q.answer])).toEqual(t.questions?.map((q) => [q.id, q.text, q.answer]));
      expect(a.decision?.title).toEqual(t.decision?.title);
      expect(a.steps?.map((s) => s.title)).toEqual(t.steps?.map((s) => s.title));
      expect(a.activity).toEqual([]);
    }
    expect(listDecisions(bp).map((d) => d.id)).toEqual(decisions.map((d) => d.id));
  });

  it('keeps pictures and documents with the project, and voice notes on this computer', () => {
    const t = actions.createTicket(bp, {
      title: 'Hours',
      files: [
        { name: 'screen.png', data: Buffer.from('png').toString('base64') },
        { name: 'voice.ogg', data: Buffer.from('ogg').toString('base64') },
      ],
    });
    const saved = readTicket(bp, t.id)!;
    expect(saved.attachments!.find((f) => f.endsWith('screen.png'))).toBe(path.join(bp.ticketsDir, t.id, 'files', 'screen.png'));
    expect(saved.attachments!.find((f) => f.endsWith('voice.ogg'))).toBe(path.join(bp.mediaDir, t.id, 'voice.ogg'));
    expect(fs.readFileSync(path.join(bp.ticketsDir, t.id, 'ticket.md'), 'utf8')).toContain('files/screen.png');
  });

  it('keeps steps and question talk apart: titles and answers with the project, progress here', () => {
    updateTicket(bp, 'SK-148', (t) => {
      t.steps = [{ title: 'Add the table', status: 'doing', live: 'Editing schema' }];
      t.questions![0]!.thinking = false;
    });
    expect(fs.readFileSync(path.join(bp.ticketsDir, 'SK-148', 'design.md'), 'utf8')).toContain('1. Add the table');
    const t = readTicket(bp, 'SK-148')!;
    expect(t.steps).toEqual([{ title: 'Add the table', status: 'doing', live: 'Editing schema' }]);
    expect(t.questions![0]!.thinking).toBe(false);
  });

  it('keeps the board settings in config.yaml, next to the 0.x settings', () => {
    const config = yaml.load(fs.readFileSync(bp.configFile, 'utf8')) as { board: { key: string; layout: number; id: string } };
    expect(config.board).toMatchObject({ key: 'SK', layout: 2, id: bp.projectId });
    expect(readMeta(bp).key).toBe('SK');
  });
});

/** Writes the demo board in the layout before ADR-001, the way squad-kit kept it in .squad/board/. */
function legacyBoard(): Ticket[] {
  const meta = readMeta(bp);
  const tickets = listTickets(bp);
  const decisions = listDecisions(bp);
  const releases = listReleases(bp);
  const legacy = path.join(bp.squadDir, 'board');
  const dump = (file: string, data: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, yaml.dump(JSON.parse(JSON.stringify(data))));
  };
  const { id: _id, layout: _layout, documentsInGit: _g, ...oldMeta } = meta;
  dump(path.join(legacy, 'board.yaml'), oldMeta);
  const old: Ticket[] = [];
  for (const t of tickets) {
    const o = structuredClone(t);
    if (t.mockup) {
      const to = path.join(legacy, 'attachments', t.id, 'mockup.html');
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(t.mockup, to);
      o.mockup = to;
    }
    dump(path.join(legacy, 'tickets', `${t.id}.yaml`), o);
    old.push(o);
  }
  for (const d of decisions) dump(path.join(legacy, 'decisions', `${d.id}.yaml`), d);
  for (const r of releases) dump(path.join(legacy, 'releases', `${r.version}.yaml`), r);
  for (const dir of [bp.ticketsDir, bp.decisionsDir, bp.releasesDir, bp.rulesDir, bp.knowledgeDir, bp.localDir]) fs.rmSync(dir, { recursive: true, force: true });
  const config = yaml.load(fs.readFileSync(bp.configFile, 'utf8')) as Record<string, unknown>;
  delete config.board;
  fs.writeFileSync(bp.configFile, yaml.dump(config));
  fs.writeFileSync(path.join(bp.squadDir, 'secrets.yaml'), 'tracker:\n  azure:\n    pat: s\n');
  return old;
}

describe('moving a board to the new layout', () => {
  it('moves everything, checks it, keeps a backup, and removes the old layout', () => {
    const mockup = path.join(bp.ticketsDir, 'SK-148', 'mockup.html');
    fs.writeFileSync(mockup, '<p>Hours</p>');
    updateTicket(bp, 'SK-148', (t) => (t.mockup = mockup));
    const old = legacyBoard();
    const legacyBp = boardPaths(bp.squadDir);
    expect(hasLegacyBoard(legacyBp)).toBe(true);
    const r = moveBoard(legacyBp);
    expect(r).toMatchObject({ tickets: old.length });
    expect(fs.existsSync(path.join(bp.squadDir, 'board'))).toBe(false);
    expect(fs.existsSync(path.join(r.backup, 'board', 'board.yaml'))).toBe(true);
    const moved = boardPaths(bp.squadDir);
    expect(moved.localDir).toBe(r.localDir);
    expect(listTickets(moved).map((t) => t.id)).toEqual(old.map((t) => t.id));
    const mocked = old.find((t) => t.mockup)!;
    expect(readTicket(moved, mocked.id)!.mockup).toBe(path.join(moved.ticketsDir, mocked.id, 'mockup.html'));
    expect(fs.existsSync(moved.secretsFile)).toBe(true);
    expect(fs.existsSync(path.join(bp.squadDir, 'secrets.yaml'))).toBe(false);
  });

  it('keeps a ticket in the middle of building where it was, so the squad carries on', () => {
    updateTicket(bp, 'SK-148', (t) => {
      t.stage = 'implement';
      t.status = 'Step 2 of 3 with Claude Code';
      t.live = true;
      t.worktree = path.join(tmp, 'copies', 'sk-148');
      t.branch = 'squad/sk-148';
      t.baseCommit = 'a1b2c3d';
      t.steps = [
        { title: 'Add the table', status: 'done', minutes: 4 },
        { title: 'Show the hours', status: 'doing', live: 'Editing src/hours.ts' },
        { title: 'Write the tests', status: 'todo' },
      ];
    });
    legacyBoard();
    moveBoard(boardPaths(bp.squadDir));
    const t = readTicket(boardPaths(bp.squadDir), 'SK-148')!;
    expect(t).toMatchObject({ stage: 'implement', live: true, branch: 'squad/sk-148', baseCommit: 'a1b2c3d', worktree: path.join(tmp, 'copies', 'sk-148') });
    expect(t.steps!.map((s) => [s.title, s.status])).toEqual([
      ['Add the table', 'done'],
      ['Show the hours', 'doing'],
      ['Write the tests', 'todo'],
    ]);
  });

  it('puts everything back and stops when the new files would not match', () => {
    legacyBoard();
    const file = path.join(bp.squadDir, 'board', 'tickets', 'SK-148.yaml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + 'somethingNew: lost on the way\n');
    const configBefore = fs.readFileSync(bp.configFile, 'utf8');
    expect(() => moveBoard(boardPaths(bp.squadDir))).toThrow(MoveError);
    expect(fs.existsSync(path.join(bp.squadDir, 'board', 'board.yaml'))).toBe(true);
    expect(fs.existsSync(bp.ticketsDir)).toBe(false);
    expect(fs.readFileSync(bp.configFile, 'utf8')).toBe(configBefore);
    expect(fs.existsSync(path.join(bp.squadDir, 'secrets.yaml'))).toBe(true);
  });
});
