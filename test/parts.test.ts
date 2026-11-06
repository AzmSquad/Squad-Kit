import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardPaths, readMeta, writeMeta, type BoardPaths } from '../src/board/store.js';
import { seedDemoBoard } from '../src/board/demo.js';
import { addPart, changePart, cleanParts, findPart, partsAfterRead, partsOf, pictureInUse, productLine, removePart, repoInUse, severalParts } from '../src/board/parts.js';
import { findApp, projectApps } from '../src/board/apps.js';
import { overviewView } from '../src/board/first-run.js';
import { saveScan } from '../src/engine/onboard.js';
import { scanPrompt } from '../src/engine/prompts.js';
import type { BoardMeta, RepoInfo } from '../src/board/types.js';

/** What the product is made of: what the Architect's read leaves, and what an engineer can correct. */

let root: string;
let bp: BoardPaths;

const repo = (p: string, url?: string): RepoInfo => ({ path: p, base: 'main', remote: '', commands: url ? { url } : {} });
const twoRepos = (): BoardMeta => {
  const meta = readMeta(bp);
  const next = { ...meta, repos: [repo('web-ui'), repo('api-server')] };
  writeMeta(bp, next);
  return next;
};
const FOUND = [
  { id: 'web', name: 'Web app', repo: 'web-ui', needs: ['api'], url: 'http://localhost:3000' },
  { id: 'api', name: 'API', repo: 'api-server', needs: ['db', 'redis'], url: 'http://localhost:5180' },
  { id: 'db', name: 'Database', shared: true },
  { id: 'redis', name: 'Redis', shared: true },
];

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-parts-')));
  bp = boardPaths(path.join(root, '.squad'));
  seedDemoBoard(bp, { project: 'Rooms', user: 'Momen' } as never);
  for (const r of ['web-ui', 'api-server']) fs.mkdirSync(path.join(root, r), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('what the read finds', () => {
  it('keeps the parts, what they need and their addresses', () => {
    const parts = cleanParts(FOUND, twoRepos(), root);
    expect(parts.map((p) => p.id)).toEqual(['web', 'api', 'db', 'redis']);
    expect(parts[0]).toMatchObject({ name: 'Web app', repo: 'web-ui', needs: ['api'], url: 'http://localhost:3000' });
    expect(parts[1]!.needs).toEqual(['db', 'redis']);
    expect(parts[2]).toMatchObject({ shared: true, needs: [] });
    expect(parts[2]!.repo).toBeUndefined();
  });

  it('never stops the read: what does not fit is left out', () => {
    const parts = cleanParts(
      [
        null,
        'not a part',
        { id: 'web', name: 'Web app', repo: 'web-ui/', needs: ['web', 'ghost', 'api'], url: 'not an address', folder: '../../etc' },
        { id: 'web', name: 'Second with the same id', repo: 'web-ui' },
        { id: 'nowhere', name: 'In no repo', repo: 'no-such-repo' },
        { id: '', name: '' },
        { id: 'api', name: 'API', repo: 'api-server', needs: ['web'] },
      ],
      twoRepos(),
      root,
    );
    expect(parts.map((p) => p.id)).toEqual(['web', 'api']);
    const web = parts[0]!;
    expect(web.repo).toBe('web-ui');
    expect(web.url).toBeUndefined();
    expect(web.folder).toBeUndefined();
    // Itself and an unknown part went; api goes first, and api needing web back would be a loop, so that one stays out.
    expect(web.needs).toEqual(['api']);
    expect(parts[1]!.needs).toEqual([]);
    expect(cleanParts('nonsense', { ...readMeta(bp), repos: [] }, root)).toEqual([]);
  });

  it('an answer that places nothing leaves the list as it is: a part for each repo, all in use', () => {
    const meta = twoRepos();
    expect(cleanParts(undefined, meta, root)).toEqual([]);
    expect(cleanParts([{ id: 'db', name: 'Database', shared: true }], meta, root)).toEqual([]);
    expect(partsOf(meta).every((p) => !p.off)).toBe(true);
  });

  it('counts a repo it left out as Not used, where an engineer can see it', () => {
    const meta = twoRepos();
    writeMeta(bp, { ...meta, parts: cleanParts([{ id: 'web', name: 'Web app', repo: 'web-ui' }, { id: 'site', name: 'Site', repo: 'web-ui', folder: '.' }], meta, root) });
    const left = partsOf(readMeta(bp)).find((p) => p.repo === 'api-server');
    expect(left).toMatchObject({ id: 'api-server', name: 'Api server', off: true });
    expect(productLine(readMeta(bp))).toBe('The product has 2 parts: Web app and Site.');
  });

  it('never takes an id twice when a repo is left out', () => {
    const parts = cleanParts([{ id: 'api-server', name: 'Web app', repo: 'web-ui' }], twoRepos(), root);
    expect(parts.map((p) => p.id)).toEqual(['api-server', 'api-server-repo']);
  });

  it('keeps a folder only when it is really there, and only to tell apart parts in one repo', () => {
    fs.mkdirSync(path.join(root, 'web-ui', 'apps', 'site'), { recursive: true });
    fs.mkdirSync(path.join(root, 'api-server', 'Web.Api'), { recursive: true });
    const parts = cleanParts(
      [
        { id: 'site', name: 'Site', repo: 'web-ui', folder: './apps/site/' },
        { id: 'other', name: 'Other', repo: 'web-ui', folder: 'no/such/folder' },
        { id: 'api', name: 'API', repo: 'api-server', folder: 'Web.Api' },
      ],
      twoRepos(),
      root,
    );
    expect(parts[0]!.folder).toBe('apps/site');
    expect(parts[1]!.folder).toBeUndefined();
    expect(parts[2]!.folder).toBeUndefined();
  });

  it('is saved with the read, in the settings the team shares', () => {
    const meta = twoRepos();
    saveScan(bp, { empty: false, summary: 'Rooms', map: [], decisions: [], commands: {}, runs: FOUND }, meta.repos!);
    expect(readMeta(bp).parts?.map((p) => p.id)).toEqual(['web', 'api', 'db', 'redis']);
    expect(fs.readFileSync(bp.configFile, 'utf8')).toContain('Web app');
  });

  it('leaves nothing on a project with no code', () => {
    saveScan(bp, { empty: true, summary: 'Nothing yet', map: [], decisions: [], commands: {}, runs: FOUND }, []);
    expect(readMeta(bp).parts).toBeUndefined();
  });

  it('asks for them, and names the repos only on a workspace', () => {
    const meta = readMeta(bp);
    expect(scanPrompt(meta, [repo('web-ui')])).toContain('repo, the folder of its repo, exactly as in the list above');
    expect(scanPrompt(meta, [])).toContain('repo, "."');
  });
});

describe('a project with one part', () => {
  it('sees no change: one part, nothing to show, no sentence', () => {
    const meta = readMeta(bp);
    expect(partsOf(meta)).toHaveLength(1);
    expect(severalParts(meta)).toBe(false);
    expect(productLine(meta)).toBeUndefined();
    expect(overviewView(bp).product).toBeUndefined();
  });

  it('still sees no change when the read names its database', () => {
    saveScan(bp, { empty: false, summary: 'Rooms', map: [], decisions: [], commands: {}, runs: [{ id: 'app', name: 'App', repo: '.', needs: ['db'] }, { id: 'db', name: 'Database', shared: true }] }, []);
    const meta = readMeta(bp);
    expect(severalParts(meta)).toBe(false);
    expect(overviewView(bp).product).toBeUndefined();
  });

  it('has one address: the one in Settings', () => {
    const meta = readMeta(bp);
    writeMeta(bp, { ...meta, commands: { ...meta.commands, url: 'http://localhost:4000' } });
    expect(partsOf(readMeta(bp))[0]!.url).toBe('http://localhost:4000');
    changePart(bp, partsOf(readMeta(bp))[0]!.id, { url: 'http://localhost:4100' });
    expect(readMeta(bp).commands?.url).toBe('http://localhost:4100');
    expect(partsOf(readMeta(bp))[0]!.url).toBe('http://localhost:4100');
  });
});

describe('a project read before squad-kit kept parts', () => {
  it('keeps its repo names in Your apps until the Architect names the parts', () => {
    const meta = { ...readMeta(bp), engine: 'live' as const, repos: [repo('web-ui', 'http://localhost:3000'), repo('api-server')] };
    expect(projectApps(meta).map((a) => a.name)).toEqual(['web-ui']);
  });

  it('has one part for each repo, with the address each repo has', () => {
    const meta = { ...readMeta(bp), repos: [repo('web-ui', 'http://localhost:3000'), repo('api-server')] };
    expect(partsOf(meta).map((p) => [p.id, p.url])).toEqual([
      ['web-ui', 'http://localhost:3000'],
      ['api-server', undefined],
    ]);
    expect(severalParts(meta)).toBe(true);
  });
});

describe('the sentence on the Overview', () => {
  it('waits for the Architect to name the parts: a repo name says nothing to a person', () => {
    twoRepos();
    expect(severalParts(readMeta(bp))).toBe(true);
    expect(productLine(readMeta(bp))).toBeUndefined();
  });

  it('drops a part marked Not used from the picture, with its arrows', () => {
    const meta = twoRepos();
    writeMeta(bp, { ...meta, parts: cleanParts(FOUND, meta, root) });
    changePart(bp, 'web', { off: true });
    const picture = pictureInUse(readMeta(bp), {
      parts: [{ id: 'w', name: 'Web app', what: '', files: [] }, { id: 'a', name: 'API', what: '', files: [] }, { id: 'd', name: 'Database', what: '', files: [] }],
      links: [{ from: 'w', to: 'a' }, { from: 'a', to: 'd' }],
    });
    expect(picture.parts.map((p) => p.id)).toEqual(['a', 'd']);
    expect(picture.links).toEqual([{ from: 'a', to: 'd' }]);
  });

  it('shows the name an engineer gave, in the picture too', () => {
    const meta = twoRepos();
    writeMeta(bp, { ...meta, parts: cleanParts(FOUND, meta, root) });
    changePart(bp, 'api', { name: 'Case API' });
    const picture = pictureInUse(readMeta(bp), { parts: [{ id: 'api', name: 'T4 API', what: '', files: [] }, { id: 'db', name: 'Storage', what: '', files: [] }], links: [] });
    expect(picture.parts.map((p) => p.name)).toEqual(['Case API', 'Storage']);
  });

  it('names the parts and what they share, in plain words', () => {
    const meta = twoRepos();
    writeMeta(bp, { ...meta, parts: cleanParts(FOUND, meta, root) });
    expect(productLine(readMeta(bp))).toBe('The product has 2 parts: Web app and API. They share Database and Redis.');
    expect(overviewView(bp).product).toContain('Web app and API');
  });

  it('leaves out what is not used', () => {
    const meta = twoRepos();
    writeMeta(bp, { ...meta, parts: cleanParts(FOUND, meta, root) });
    changePart(bp, 'web', { off: true });
    expect(productLine(readMeta(bp))).toBe('The product has one part in use: API. It uses Database and Redis.');
  });
});

describe('what an engineer corrects', () => {
  beforeEach(() => {
    const meta = twoRepos();
    writeMeta(bp, { ...meta, parts: cleanParts(FOUND, meta, root) });
  });

  it('changes a part by id or by name', () => {
    expect(changePart(bp, 'web', { name: 'Site' }).name).toBe('Site');
    expect(changePart(bp, 'SITE', { needs: ['API', 'db'] }).needs).toEqual(['api', 'db']);
  });

  it('says plainly what is wrong, and changes nothing', () => {
    const before = readMeta(bp).parts;
    expect(() => changePart(bp, 'nope', {})).toThrow('There is no part "nope"');
    expect(() => changePart(bp, 'web', { name: ' ' })).toThrow('Give the part a name.');
    expect(() => changePart(bp, 'web', { name: 'api' })).toThrow('There is a part called api already.');
    expect(() => changePart(bp, 'web', { url: 'localhost' })).toThrow('is not a web address');
    expect(() => changePart(bp, 'web', { needs: ['web'] })).toThrow('cannot need itself');
    expect(() => changePart(bp, 'web', { needs: ['ghost'] })).toThrow('There is no part "ghost"');
    expect(() => changePart(bp, 'web', { repo: 'elsewhere' })).toThrow('There is no code repo at elsewhere');
    expect(() => changePart(bp, 'web', { folder: '../other' })).toThrow('must be inside the repo');
    expect(() => changePart(bp, 'web', { folder: '/etc' })).toThrow('must be inside the repo');
    expect(() => changePart(bp, 'web', { folder: 'no-such' })).toThrow('There is no folder no-such in web-ui');
    expect(() => changePart(bp, 'db', { needs: ['web'] })).toThrow('need each other');
    expect(readMeta(bp).parts).toEqual(before);
  });

  it('adds a part, with an id of its own', () => {
    expect(addPart(bp, { name: 'PDF service', repo: 'api-server' })).toMatchObject({ id: 'pdf-service', repo: 'api-server', byHand: true });
    expect(addPart(bp, { name: 'Queue', shared: true })).toMatchObject({ id: 'queue', shared: true });
    expect(() => addPart(bp, { name: 'No repo' })).toThrow('Say which repo it is in');
    expect(() => addPart(bp, { name: '' })).toThrow('Give the part a name.');
    expect(addPart(bp, { name: 'مخزن', shared: true }).id).toBe('مخزن');
  });

  it('keeps an address on the part when the repo has two', () => {
    addPart(bp, { name: 'Worker', repo: 'api-server', url: 'http://localhost:7000' });
    expect(findPart(partsOf(readMeta(bp)), 'worker').url).toBe('http://localhost:7000');
    expect(findPart(partsOf(readMeta(bp)), 'api').url).toBe('http://localhost:5180');
    expect(readMeta(bp).repos?.find((r) => r.path === 'api-server')?.commands.url).toBeUndefined();
  });

  it('makes an address the repo App address when the part is alone in it', () => {
    changePart(bp, 'web', { url: 'http://localhost:3100' });
    expect(readMeta(bp).repos?.find((r) => r.path === 'web-ui')?.commands.url).toBe('http://localhost:3100');
    // Changing the App address in Settings changes the part: there is one address.
    const meta = readMeta(bp);
    writeMeta(bp, { ...meta, repos: meta.repos!.map((r) => (r.path === 'web-ui' ? { ...r, commands: { url: 'http://localhost:3200' } } : r)) });
    expect(findPart(partsOf(readMeta(bp)), 'web').url).toBe('http://localhost:3200');
    changePart(bp, 'web', { url: '' });
    expect(readMeta(bp).repos?.find((r) => r.path === 'web-ui')?.commands.url).toBeUndefined();
    expect(findPart(partsOf(readMeta(bp)), 'web').url).toBeUndefined();
  });

  it('takes out only what would not come back, and clears what needed it', () => {
    expect(() => removePart(bp, 'db')).toThrow('Mark it Not used instead');
    addPart(bp, { name: 'Queue', shared: true });
    changePart(bp, 'api', { needs: ['db', 'queue'] });
    removePart(bp, 'queue');
    expect(findPart(partsOf(readMeta(bp)), 'api').needs).toEqual(['db']);
    expect(() => findPart(partsOf(readMeta(bp)), 'queue')).toThrow();
    // The last part of a repo: a story could no longer work on that repo.
    expect(() => removePart(bp, 'api')).toThrow('the only part in api-server');
  });

  it('a new read keeps what was corrected, and takes the rest from the read', () => {
    changePart(bp, 'web', { name: 'Site', off: true });
    addPart(bp, { name: 'Queue', shared: true });
    const meta = readMeta(bp);
    saveScan(bp, { empty: false, summary: 'Rooms', map: [], decisions: [], commands: {}, runs: [{ id: 'web', name: 'Web app', repo: 'web-ui' }, { id: 'api', name: 'API server', repo: 'api-server' }] }, meta.repos!);
    const parts = readMeta(bp).parts!;
    expect(findPart(parts, 'web')).toMatchObject({ name: 'Site', off: true });
    expect(findPart(parts, 'api').name).toBe('API server');
    expect(findPart(parts, 'queue').shared).toBe(true);
    expect(parts.some((p) => p.id === 'db')).toBe(false);
  });

  it('matches a corrected part by its name when the read gives it a new id', () => {
    const kept = [{ id: 'web', name: 'Web app', repo: 'web-ui', needs: [], byHand: true }];
    const parts = partsAfterRead([{ id: 'ui', name: 'web app', repo: 'web-ui', needs: [] }, { id: 'tests', name: 'Tester', repo: 'web-ui', needs: ['ui'] }], kept);
    expect(parts[0]).toEqual(kept[0]);
    // What needed the old id now needs the part as the engineer has it.
    expect(parts[1]!.needs).toEqual(['web']);
  });

  it('never loses what an engineer said a part needs: the read renamed Redis, or missed it', () => {
    const redis = { id: 'redis', name: 'Redis', shared: true, needs: [] };
    const db = { id: 'db', name: 'Database', shared: true, needs: [] };
    const api = { id: 'api', name: 'Case API', repo: 'api-server', needs: ['redis', 'db'], byHand: true };
    const renamed = partsAfterRead([{ id: 'api', name: 'API', repo: 'api-server', needs: [] }, { id: 't4redis', name: 'redis', shared: true, needs: [] }], [api, redis, db]);
    expect(renamed.find((p) => p.id === 'api')!.needs.sort()).toEqual(['db', 't4redis']);
    // Database was missed, and stays because the engineer's part needs it. A part nobody needs goes with the read.
    expect(renamed.some((p) => p.id === 'db')).toBe(true);
    const gone = { id: 'old', name: 'Old', shared: true, needs: [] };
    expect(partsAfterRead([{ id: 'web', name: 'Web', repo: 'web-ui', needs: [] }], [gone]).some((p) => p.id === 'old')).toBe(false);
  });

  it('asks the next read to keep the same ids and names', () => {
    expect(scanPrompt(readMeta(bp), [repo('web-ui')])).toContain('keep the same id and name');
    expect(scanPrompt(readMeta(bp), [repo('web-ui')])).toContain('- web: Web app');
    const none = readMeta(bp);
    delete none.parts;
    expect(scanPrompt(none, [])).not.toContain('keep the same id and name');
  });

  it('never marks the last part Not used: the squad would have nothing to work on', () => {
    changePart(bp, 'web', { off: true });
    expect(() => changePart(bp, 'api', { off: true })).toThrow('the only part in use');
    expect(changePart(bp, 'db', { off: true }).off).toBe(true);
    expect(changePart(bp, 'web', { off: false }).off).toBeUndefined();
    expect(changePart(bp, 'api', { off: true }).off).toBe(true);
  });

  it('Your apps names the parts, and leaves out what is not used', () => {
    expect(projectApps(readMeta(bp))).toEqual([]);
    changePart(bp, 'web', { url: 'http://localhost:3000' });
    changePart(bp, 'api', { url: 'http://localhost:5180' });
    expect(projectApps(readMeta(bp)).map((a) => [a.name, a.repo])).toEqual([
      ['Web app', 'web-ui'],
      ['API', 'api-server'],
    ]);
    // The repo's name still finds it, for an engineer.
    expect(findApp(readMeta(bp), 'web-ui').name).toBe('Web app');
    changePart(bp, 'web', { off: true });
    expect(projectApps(readMeta(bp)).map((a) => a.name)).toEqual(['API']);
  });

  it('skips a repo that is not used when it installs, tests and opens the app', () => {
    changePart(bp, 'web', { off: true });
    expect(repoInUse(readMeta(bp), 'web-ui')).toBe(false);
    expect(repoInUse(readMeta(bp), 'api-server')).toBe(true);
    expect(repoInUse(readMeta(bp), 'not-a-part')).toBe(true);
  });
});
