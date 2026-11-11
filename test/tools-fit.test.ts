import { describe, expect, it } from 'vitest';
import type { FoundBook } from '../src/engine/tools/detect.js';
import type { PlaceKinds } from '../src/engine/tools/kinds.js';
import { CATALOG } from '../src/engine/tools/catalog.js';
import { atLeast, compareVersions, tooOld } from '../src/engine/tools/fit.js';
import { TOOLS_CHECKING, blockOf, linesFor, projectWords, waitsForTools } from '../src/engine/tools/index.js';

/**
 * Whether the versions fit, how much each tool matters for a project, and what each action needs: a missing Required
 * tool stops only the actions that need it, and a pair rule only the actions it is about.
 */

const FLUTTER_APP: PlaceKinds[] = [{ place: '.', kinds: ['flutter'], platforms: ['ios', 'android', 'web'] }];
const WEB: PlaceKinds[] = [{ place: '.', kinds: ['web'], platforms: ['web'] }];

/** What the Mac this was built on has, on 2026-11-10. */
const THIS_MAC: FoundBook = {
  at: '2026-11-10T15:00:00.000Z',
  system: 'mac',
  tools: {
    flutter: { state: 'found', version: '3.27.3' },
    xcode: { state: 'found', version: '27.2' },
    simulator: { state: 'found', version: '27.0' },
    cocoapods: { state: 'found', version: '1.16.2' },
    java: { state: 'found', version: '19.0.2' },
    maestro: { state: 'missing' },
    'android-studio': { state: 'missing' },
    docker: { state: 'missing' },
  },
};

const READY = { git: { ok: true }, tool: { ok: true, label: 'Claude Code' } };
const lineOf = (lines: ReturnType<typeof linesFor>, id: string) => lines.find((l) => l.id === id)!;

describe('versions', () => {
  it('compares number by number', () => {
    expect(compareVersions('3.27.3', '3.44.8')).toBeLessThan(0);
    expect(compareVersions('3.44.10', '3.44.8')).toBeGreaterThan(0);
    expect(compareVersions('27.2', '27')).toBeGreaterThan(0);
    expect(compareVersions('21.0.5+11', '21.0.5')).toBe(0);
    expect(atLeast('19.0.2', '17')).toBe(true);
    expect(atLeast('11.0.20', '17')).toBe(false);
  });

  it('with Xcode 27, a Flutter older than 3.44.8 is too old for iPhone builds only', () => {
    const ios = new Set(['ios' as const]);
    const old = tooOld('flutter', undefined, { flutter: '3.27.3', xcode: '27.2' }, ios);
    expect(old).toEqual({ needs: '3.44.8', why: 'Xcode 27 needs it for iPhone builds', for: ['pictures', 'start-app', 'try-it'] });
    expect(tooOld('flutter', undefined, { flutter: '3.44.8', xcode: '27.2' }, ios)).toBeNull();
    expect(tooOld('flutter', undefined, { flutter: '3.27.3', xcode: '26.4' }, ios)).toBeNull();
    // A Flutter app that does not build for the iPhone does not care.
    expect(tooOld('flutter', undefined, { flutter: '3.27.3', xcode: '27.2' }, new Set(['android' as const]))).toBeNull();
  });

  it("a tool's own oldest version counts for everything it is used for", () => {
    expect(tooOld('java', '17', { java: '11.0.20' }, new Set())).toEqual({ needs: '17' });
    expect(tooOld('java', '17', { java: '19.0.2' }, new Set())).toBeNull();
    // An unknown version never stops anyone.
    expect(tooOld('java', '17', {}, new Set())).toBeNull();
  });
});

describe('the lines of a project', () => {
  it("a Flutter app on this Mac: what it needs, how much, and what stops", () => {
    const lines = linesFor(FLUTTER_APP, THIS_MAC, 'mac', READY);
    expect(lines.map((l) => [l.id, l.priority, l.state])).toEqual([
      ['git', 'required', 'ready'],
      ['ai-tool', 'required', 'ready'],
      ['flutter', 'required', 'too-old'],
      ['xcode', 'required', 'ready'],
      ['simulator', 'required', 'ready'],
      ['cocoapods', 'required', 'ready'],
      ['maestro', 'required', 'missing'],
      ['java', 'required', 'ready'],
      ['android-studio', 'recommended', 'missing'],
    ]);
    const flutter = lineOf(lines, 'flutter');
    expect(flutter).toMatchObject({ version: '3.27.3', needs: '3.44.8', why: 'Xcode 27 needs it for iPhone builds' });
    // Too old for the iPhone only: building and the checks go on.
    expect(flutter.blocks).toEqual(['pictures', 'start-app', 'try-it']);
    expect(lineOf(lines, 'maestro')).toMatchObject({ installer: 'squad-kit', command: 'squad tools get maestro', blocks: ['pictures'] });
    // Recommended never stops anything.
    expect(lineOf(lines, 'android-studio').blocks).toEqual([]);
    expect(lineOf(lines, 'ai-tool').name).toBe('Claude Code');
  });

  it('you install it: the reason, the steps for this system and the official page', () => {
    const xcode = lineOf(linesFor(FLUTTER_APP, { ...THIS_MAC, tools: { ...THIS_MAC.tools, xcode: { state: 'missing' } } }, 'mac', READY), 'xcode');
    expect(xcode.state).toBe('missing');
    expect(xcode.reason).toBe('it comes from the App Store and needs your Apple ID');
    expect(xcode.steps[0]).toContain('App Store');
    expect(xcode.link).toMatch(/^https:\/\/apps\.apple\.com\//);
    expect(xcode.usedFor).toBe('Phone pictures, Start, Try it yourself');
  });

  it('a Flutter app without Flutter: building and the checks stop, nothing else', () => {
    const book = { ...THIS_MAC, tools: { ...THIS_MAC.tools, flutter: { state: 'missing' as const } } };
    expect(lineOf(linesFor(FLUTTER_APP, book, 'mac'), 'flutter').blocks).toEqual(['build', 'checks', 'pictures', 'start-app', 'try-it']);
  });

  it('on Windows the iPhone lines say they need a Mac', () => {
    const win: FoundBook = { at: THIS_MAC.at, system: 'windows', tools: { flutter: { state: 'found', version: '3.47.0' }, xcode: { state: 'not-here' }, simulator: { state: 'not-here' }, cocoapods: { state: 'not-here' } } };
    const xcode = lineOf(linesFor(FLUTTER_APP, win, 'windows', READY), 'xcode');
    expect(xcode).toMatchObject({ state: 'not-here', notHere: 'needs a Mac' });
  });

  it('a web project needs only what every project needs', () => {
    expect(linesFor(WEB, THIS_MAC, 'mac', READY).map((l) => l.id)).toEqual(['git', 'ai-tool']);
    // Git and the AI tool are checked as today: they never stop a step from here.
    expect(linesFor(WEB, THIS_MAC, 'mac').map((l) => l.id)).toEqual([]);
  });

  it('a sign-in still to do shows on the AI tool line', () => {
    const l = lineOf(linesFor(WEB, THIS_MAC, 'mac', { git: { ok: true }, tool: { ok: false, label: 'Claude Code', step: 'sign-in' } }), 'ai-tool');
    expect(l).toMatchObject({ state: 'missing', note: 'Claude Code is here. Sign in once, and the squad can work.', blocks: [] });
  });

  it('says what the project is, in one sentence', () => {
    expect(projectWords(FLUTTER_APP)).toBe('This project has a Flutter app for iPhone, Android and web.');
    expect(projectWords([...WEB, { place: 'mobile', kinds: ['react-native', 'docker'], platforms: ['ios'] }])).toBe('This project has web or Node.js code, a React Native app for iPhone and Docker files.');
  });

  it('every tool in the catalog has the words its line needs', () => {
    for (const e of CATALOG) {
      expect(e.gives, e.id).toBeTruthy();
      expect(e.link, e.id).toMatch(/^https:\/\//);
      if (e.installer === 'you') {
        expect(e.why, e.id).toBeTruthy();
        expect(e.steps?.mac ?? e.steps?.all, e.id).toBeTruthy();
      } else expect(e.getSeconds, e.id).toBeGreaterThan(0);
    }
  });
});

describe('what a block says', () => {
  const lines = (book: FoundBook) => linesFor(FLUTTER_APP, book, 'mac');

  it('what can not happen, why, the way out, and the card line', () => {
    const book = { ...THIS_MAC, tools: { ...THIS_MAC.tools, flutter: { state: 'missing' as const } } };
    const b = blockOf('build', lines(book).filter((l) => l.blocks.includes('build')));
    expect(b.text).toBe("squad-kit can't build this story yet: Flutter isn't on this computer.");
    expect(b.status).toBe("Waits for Flutter on this computer. Goes on by itself once it's there");
    expect(b.link).toBe('/tools#flutter');
    expect(waitsForTools(b.status)).toBe(true);
  });

  it('too old, and several at once', () => {
    const book = { ...THIS_MAC, tools: { ...THIS_MAC.tools, maestro: { state: 'missing' as const } } };
    const b = blockOf('pictures', lines(book).filter((l) => l.blocks.includes('pictures')));
    expect(b.text).toBe("squad-kit can't take the phone pictures yet: Maestro isn't on this computer; Flutter 3.27.3 is too old: it needs 3.44.8 or newer.");
    expect(b.status).toBe("Waits for Maestro and a newer Flutter on this computer. Goes on by itself once they're there");
    expect(waitsForTools(b.status)).toBe(true);
  });

  it('a tool this computer can never have says so', () => {
    const win: FoundBook = { at: THIS_MAC.at, system: 'linux', tools: { xcode: { state: 'not-here' }, simulator: { state: 'not-here' } } };
    const b = blockOf('build', linesFor([{ place: '.', kinds: ['ios'], platforms: ['ios'] }], win, 'linux').filter((l) => l.blocks.includes('build')));
    expect(b.text).toBe("squad-kit can't build this story on this computer: Xcode needs a Mac.");
    expect(waitsForTools(b.status)).toBe(true);
  });

  it('is told apart from the other waits', () => {
    expect(waitsForTools(TOOLS_CHECKING)).toBe(true);
    expect(waitsForTools('Waits for RO-1 to merge: it picks the tools for this project. Starts by itself.')).toBe(false);
    expect(waitsForTools('Next in line: starts when a slot is free (2 of 2 busy)')).toBe(false);
  });
});
