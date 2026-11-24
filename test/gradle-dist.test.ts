import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { zip } from '../src/core/zip.js';
import { cacheHomeEnv } from '../src/engine/cache-home.js';
import { ANDROID_CHECK_MS, ANDROID_SILENT_MS, gradleDownloads, limitFor, useGradleFetch, wrapperDist, type GradleFetch } from '../src/engine/gradle-dist.js';
import { CHECK_MS, CHECK_SILENT_MS } from '../src/engine/checks.js';

/**
 * The Gradle a project's wrapper asks for, got by squad-kit before a check that builds the Android app: from Gradle's
 * own site only, checked against the SHA-256 Gradle publishes, kept in squad-kit's shared Gradle home and linked into the
 * check's cache home, so the first Android build is not stopped as silent while the wrapper downloads it. A made-up
 * download: nothing real is fetched.
 */

const ROOT = fs.realpathSync(process.cwd());
let base: string;
let home: string;
let copy: string;
let asked: string[];
let archive: Buffer;
let published: string;

const URL = 'https://services.gradle.org/distributions/gradle-9.3.1-all.zip';
const HASH_DIR = path.join('wrapper', 'dists', 'gradle-9.3.1-all', '9ot9r568e8zfvvd4mn8rbu1j0');

const fake: GradleFetch = async (url) => {
  asked.push(url);
  const body = url.endsWith('.sha256') ? Buffer.from(`${published}\n`) : archive;
  return { ok: true, body: new Response(body).body, text: async () => body.toString('utf8') };
};

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(ROOT, '.gd-')));
  home = path.join(base, 'squad');
  copy = path.join(base, 'copy');
  fs.mkdirSync(path.join(copy, 'android', 'gradle', 'wrapper'), { recursive: true });
  fs.writeFileSync(path.join(copy, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties'), `distributionBase=GRADLE_USER_HOME\ndistributionPath=wrapper/dists\ndistributionUrl=https\\://services.gradle.org/distributions/gradle-9.3.1-all.zip\n`);
  archive = zip([{ name: 'gradle-9.3.1/bin/gradle', data: '#!/bin/sh\necho 9.3.1\n' }]);
  published = createHash('sha256').update(archive).digest('hex');
  asked = [];
  useGradleFetch(fake);
});

afterEach(() => {
  useGradleFetch(null);
  fs.rmSync(base, { recursive: true, force: true });
});

describe("the Gradle a project's wrapper asks for", () => {
  it('is read from android/ or the top folder, with the wrapper\'s own folder name for it', () => {
    expect(wrapperDist(copy)).toEqual({ url: URL, name: 'gradle-9.3.1-all', hash: '9ot9r568e8zfvvd4mn8rbu1j0', rel: HASH_DIR, ok: 'gradle-9.3.1-all.zip.ok' });
    expect(wrapperDist(path.join(base, 'nothing'))).toBeNull();
  });

  it('squad-kit gets it before an Android build, checked against Gradle\'s SHA-256, once, and the check\'s cache home links it in', async () => {
    expect(await gradleDownloads(copy, 'fvm flutter build apk --debug', { home, env: { HOME: path.join(base, 'h') } })).toBe('done');
    expect(asked).toEqual([`${URL}.sha256`, URL]);
    const shared = path.join(home, 'caches', 'gradle', HASH_DIR);
    expect(fs.readdirSync(shared).sort()).toEqual(['gradle-9.3.1', 'gradle-9.3.1-all.zip.ok']);
    expect(await gradleDownloads(copy, 'flutter build apk', { home, env: { HOME: path.join(base, 'h') } })).toBe('had');
    expect(asked).toHaveLength(2);
    // A check that builds nothing for Android gets nothing.
    expect(await gradleDownloads(copy, 'flutter test', { home })).toBe('not-needed');
    // A half Gradle a stopped build left in the check's own cache home makes way for the whole one.
    const cache = path.join(base, 'cache');
    const half = path.join(cache, 'gradle', HASH_DIR);
    fs.mkdirSync(half, { recursive: true });
    fs.writeFileSync(path.join(half, 'gradle-9.3.1-all.zip.part'), 'half');
    const prev = process.env.SQUAD_KIT_HOME;
    process.env.SQUAD_KIT_HOME = home;
    try {
      cacheHomeEnv(cache, { wall: 'project', cwd: path.join(copy, 'android'), home: path.join(base, 'h'), env: {} });
    } finally {
      process.env.SQUAD_KIT_HOME = prev;
    }
    expect(fs.readdirSync(half).sort()).toEqual(['gradle-9.3.1', 'gradle-9.3.1-all.zip.ok']);
    expect(fs.readlinkSync(path.join(half, 'gradle-9.3.1'))).toBe(path.join(shared, 'gradle-9.3.1'));
  });

  it('a download that does not match its SHA-256 is thrown away, and the build downloads it itself', async () => {
    published = '0'.repeat(64);
    expect(await gradleDownloads(copy, 'flutter build apk', { home })).toBe('failed');
    expect(fs.existsSync(path.join(home, 'caches', 'gradle', HASH_DIR))).toBe(false);
  });

  it("never from anywhere but Gradle's own site", async () => {
    fs.writeFileSync(path.join(copy, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties'), 'distributionUrl=https\\://example.com/gradle-9.3.1-all.zip\n');
    expect(await gradleDownloads(copy, 'flutter build apk', { home })).toBe('not-needed');
    expect(asked).toEqual([]);
  });
});

describe('an Android build check', () => {
  it('gets more time, and more quiet, than other checks: its first run downloads its libraries', () => {
    expect(limitFor('fvm flutter build apk --debug', CHECK_MS, ANDROID_CHECK_MS)).toBe(ANDROID_CHECK_MS);
    expect(limitFor('./gradlew assembleDebug', CHECK_SILENT_MS, ANDROID_SILENT_MS)).toBe(ANDROID_SILENT_MS);
    expect(limitFor('flutter test', CHECK_SILENT_MS, ANDROID_SILENT_MS)).toBe(CHECK_SILENT_MS);
  });
});
