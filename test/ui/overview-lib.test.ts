import { describe, it, expect } from 'vitest';
import type { CodePart, PartLink } from '../../console-ui/src/api/onboard-types.js';
import { addWish, dropWish, partColumns, readWishes, readyText, readyToTell, stepTime, usesLine } from '../../console-ui/src/lib/overview.js';

/** The Overview's picture of the code, a setup step's time, and "Notify me when it is ready", without React. */

const part = (id: string, kind?: CodePart['kind']): CodePart => ({ id, name: id.toUpperCase(), what: '', files: [], ...(kind ? { kind } : {}) });

describe("the picture of the code's parts", () => {
  it('puts each part one column right of the parts that use it, with the tests under the picture', () => {
    const parts = [part('staff', 'people'), part('pages'), part('api'), part('rules'), part('db'), part('signin', 'outside'), part('tests', 'tests')];
    const links: PartLink[] = [
      { from: 'staff', to: 'pages', label: 'uses' },
      { from: 'pages', to: 'api', label: 'calls' },
      { from: 'api', to: 'rules' },
      { from: 'rules', to: 'db', label: 'stores in' },
      { from: 'api', to: 'signin', label: 'signs in with' },
      { from: 'tests', to: 'rules', label: 'checks' },
    ];
    const { columns, below } = partColumns(parts, links);
    expect(columns.map((c) => c.map((p) => p.id))).toEqual([['staff'], ['pages'], ['api'], ['rules', 'signin'], ['db']]);
    expect(below.map((p) => p.id)).toEqual(['tests']);
    expect(usesLine(parts[2]!, parts, links)).toBe('uses RULES · signs in with SIGNIN');
  });

  it('a loop in the links, or no links at all, still draws every part once', () => {
    const parts = [part('a'), part('b'), part('c')];
    const loop = partColumns(parts, [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
      { from: 'b', to: 'c' },
    ]);
    expect(loop.columns.flat().map((p) => p.id).sort()).toEqual(['a', 'b', 'c']);
    expect(partColumns(parts, []).columns).toEqual([parts]);
  });
});

describe("a setup step's time", () => {
  it('counts up while it runs, says how long it took once over, and nothing before it starts', () => {
    const since = '2026-11-03T07:00:00.000Z';
    expect(stepTime({ state: 'now', since }, Date.parse(since) + 100_000)).toBe('1:40');
    expect(stepTime({ state: 'done', seconds: 2 }, 0)).toBe('2 s');
    expect(stepTime({ state: 'failed', seconds: 190 }, 0)).toBe('3 min');
    expect(stepTime({ state: 'todo' }, 0)).toBe('');
    expect(stepTime({ state: 'skipped', seconds: 0 }, 0)).toBe('');
  });
});

describe('Notify me when it is ready', () => {
  it('tells once, for the projects asked about, when their overview is ready and nobody checked it yet', () => {
    const data = new Map<string, string>();
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    addWish(store, 'rf');
    addWish(store, 'rf');
    expect(readWishes(store)).toEqual(['rf']);
    const projects = [
      { id: 'rf', name: 'roomflow', setup: { ready: true, approved: false } },
      { id: 'cp', name: 'Case portal', setup: { ready: true, approved: false } },
      { id: 'mw', name: 'Mawid', setup: { ready: false } },
    ];
    expect(readyToTell(projects, readWishes(store)).map((p) => p.id)).toEqual(['rf']);
    expect(readyToTell([{ ...projects[0]!, setup: { ready: true, approved: true } }], ['rf'])).toEqual([]);
    dropWish(store, 'rf');
    expect(readWishes(store)).toEqual([]);
    expect(readyText('roomflow')).toEqual({ title: 'roomflow is ready', body: 'squad-kit has read your project. Check what it understood, then start.' });
    // Storage that refuses: nothing breaks.
    expect(readWishes(null)).toEqual([]);
  });
});
