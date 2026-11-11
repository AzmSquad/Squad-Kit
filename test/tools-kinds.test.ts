import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BoardMeta } from '../src/board/types.js';
import { kindsOf, placesOf, projectKinds } from '../src/engine/tools/kinds.js';

/**
 * What kind of project each part is, from its files only: web, Flutter, React Native, a native iPhone app, an Android
 * app and Docker, with the phones it builds for. Made-up folders; nothing runs.
 */

let tmp: string;

const put = (rel: string, text = '') => {
  const f = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const folder = (rel: string) => fs.mkdirSync(path.join(tmp, rel), { recursive: true });
const at = (rel = '.') => path.join(tmp, rel);

const PUBSPEC = `name: wasl\nenvironment:\n  sdk: ">=3.6.0 <4.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\n  intl: ^0.19.0\n`;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-tool-kinds-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the kind of a folder', () => {
  it('a web project, from its package.json', () => {
    put('package.json', JSON.stringify({ dependencies: { react: '^18.0.0' } }));
    expect(kindsOf(at())).toEqual({ kinds: ['web'], platforms: ['web'] });
  });

  it('a Flutter app names the Flutter SDK, and says which phones it builds for', () => {
    put('pubspec.yaml', PUBSPEC);
    folder('ios/Runner.xcodeproj');
    folder('android/app');
    put('android/app/build.gradle', 'apply plugin: "com.android.application"');
    folder('web');
    const k = kindsOf(at());
    expect(k.kinds).toEqual(['flutter']);
    // Its own iPhone and Android folders are platforms of the Flutter app, not apps of their own.
    expect(k.platforms.sort()).toEqual(['android', 'ios', 'web']);
  });

  it('a plain Dart package is not a Flutter app', () => {
    put('pubspec.yaml', 'name: tools\ndependencies:\n  path: ^1.9.0\n');
    expect(kindsOf(at()).kinds).toEqual([]);
  });

  it('React Native, and Expo, which builds for both phones without their folders', () => {
    put('rn/package.json', JSON.stringify({ dependencies: { 'react-native': '0.76.0' } }));
    folder('rn/ios');
    expect(kindsOf(at('rn'))).toEqual({ kinds: ['react-native'], platforms: ['ios'] });
    put('expo/package.json', JSON.stringify({ dependencies: { expo: '~52.0.0', 'react-native': '0.76.0' } }));
    expect(kindsOf(at('expo')).platforms.sort()).toEqual(['android', 'ios']);
  });

  it('a native iPhone app, from its Xcode project', () => {
    folder('Wasl.xcodeproj');
    expect(kindsOf(at())).toEqual({ kinds: ['ios'], platforms: ['ios'] });
  });

  it('an Android app, from its Gradle files', () => {
    put('app/build.gradle.kts', 'plugins { id("com.android.application") }');
    expect(kindsOf(at())).toEqual({ kinds: ['android'], platforms: ['android'] });
  });

  it('Docker files add their own kind beside the rest', () => {
    put('package.json', '{}');
    put('docker-compose.yml', 'services: {}');
    expect(kindsOf(at()).kinds).toEqual(['web', 'docker']);
  });

  it('a folder with none of these has no kind', () => {
    put('main.py', 'print(1)');
    expect(kindsOf(at())).toEqual({ kinds: [], platforms: [] });
  });
});

describe('the places of a project', () => {
  const meta = (more: Partial<BoardMeta> = {}) => ({ project: 'Wasl', ...more }) as BoardMeta;

  it('reads each part in its own folder, with the part named', () => {
    put('package.json', JSON.stringify({ dependencies: { express: '4' } }));
    put('mobile/pubspec.yaml', PUBSPEC);
    folder('mobile/ios');
    const m = meta({
      parts: [
        { id: 'api', name: 'API', repo: '.', needs: [] },
        { id: 'mobile', name: 'Phone app', repo: '.', folder: 'mobile', needs: [] },
      ],
    });
    const found = projectKinds(tmp, m);
    expect(found).toEqual([
      { place: '.', part: 'API', kinds: ['web'], platforms: ['web'] },
      { place: 'mobile', part: 'Phone app', kinds: ['flutter'], platforms: ['ios'] },
    ]);
    // A story that changes only the API needs none of the phone's tools.
    expect(projectKinds(tmp, m, { parts: ['api'] }).map((p) => p.part)).toEqual(['API']);
  });

  it('reads the repos of a workspace, and only a story\'s own repo for that story', () => {
    put('web/package.json', '{}');
    put('app/pubspec.yaml', PUBSPEC);
    const m = meta({ repos: [{ path: 'web', base: 'main', remote: '', commands: {} }, { path: 'app', base: 'main', remote: '', commands: {} }] });
    expect(projectKinds(tmp, m).map((p) => [p.place, p.kinds])).toEqual([
      ['web', ['web']],
      ['app', ['flutter']],
    ]);
    expect(projectKinds(tmp, m, { repo: 'app' }).map((p) => p.place)).toEqual(['app']);
  });

  it("reads a story's own copy when it has one: a first story may add the app there", () => {
    put('copy/pubspec.yaml', PUBSPEC);
    const places = placesOf(tmp, meta(), { worktree: at('copy') });
    expect(places.map((p) => p.dir)).toEqual([at('copy')]);
    expect(projectKinds(tmp, meta(), { worktree: at('copy') })[0]!.kinds).toEqual(['flutter']);
    expect(projectKinds(tmp, meta())).toEqual([]);
  });

  it('works before the project has a board', () => {
    put('pubspec.yaml', PUBSPEC);
    expect(projectKinds(tmp, null)[0]).toMatchObject({ place: '.', kinds: ['flutter'] });
  });
});
