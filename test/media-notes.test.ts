import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardPaths, type BoardPaths } from '../src/board/store.js';
import { seedDemoBoard } from '../src/board/demo.js';
import { loadSecrets, mergeSecrets, saveSecrets } from '../src/core/secrets.js';
import { prepareMedia, transcriptOf, videoNotesWork } from '../src/engine/media.js';
import { MUNSIT_URL, munsitKey } from '../src/modules/munsit/speech.js';

let tmp: string;
let bp: BoardPaths;
let dir: string;
const savedEnv = process.env.MUNSIT_API_KEY;

beforeEach(() => {
  delete process.env.MUNSIT_API_KEY;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-media-test-'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  dir = path.join(tmp, 'files');
  fs.mkdirSync(dir);
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.MUNSIT_API_KEY;
  else process.env.MUNSIT_API_KEY = savedEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function file(name: string, body = 'x'): string {
  const f = path.join(dir, name);
  fs.writeFileSync(f, body);
  return f;
}

function munsit(answer: unknown, status = 200) {
  const calls: { url: string; auth: string }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get('authorization') ?? '' });
    return new Response(JSON.stringify(answer), { status });
  }) as unknown as typeof fetch;
  return { calls, fake };
}

describe('voice and video notes', () => {
  it('without a Munsit key, keeps the note and says nobody can hear it', async () => {
    const r = await prepareMedia(bp, [file('voice.ogg'), file('shot.png')]);
    expect(r.missingKey).toBe(true);
    expect(r.added).toEqual([]);
    expect(r.notes[0]).toMatch(/Add a Munsit key in Settings/);
  });

  it('reads the key saved in Settings', () => {
    const secretsFile = path.join(tmp, '.squad', 'secrets.yaml');
    saveSecrets(secretsFile, mergeSecrets(loadSecrets(secretsFile), { speech: { munsit: 'k-123' } }));
    expect(munsitKey(bp.root)).toBe('k-123');
  });

  it('writes out a voice note once, and leaves pictures alone', async () => {
    const note = file('voice.ogg');
    const { calls, fake } = munsit({ data: { transcription: 'المدير يقول لا أكثر من ٣ مواعيد' } });
    const r = await prepareMedia(bp, [note, file('shot.png')], { key: 'k-1', fetch: fake });
    expect(calls).toEqual([{ url: MUNSIT_URL, auth: 'Bearer k-1' }]);
    expect(r.added).toEqual([transcriptOf(note)]);
    expect(fs.readFileSync(transcriptOf(note), 'utf8')).toContain('لا أكثر من ٣ مواعيد');
    const again = await prepareMedia(bp, [note], { key: 'k-1', fetch: fake });
    expect(again.added).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('gives long notes their times', async () => {
    const note = file('long.m4a');
    const words = [{ word: 'first', start: 1 }, { word: 'second', start: 12 }, { word: 'late', start: 65 }];
    const { fake } = munsit({ data: { transcription: 'first second late', timestamps: words } });
    await prepareMedia(bp, [note], { key: 'k', fetch: fake });
    const text = fs.readFileSync(transcriptOf(note), 'utf8');
    expect(text).toContain('0:00  first');
    expect(text).toContain('0:10  second');
    expect(text).toContain('1:00  late');
  });

  it('takes the sound and pictures out of a video', async () => {
    const video = file('screen.mp4');
    const shot = file('screen.mp4.screen-01-0m02s.jpg');
    const { fake } = munsit({ data: { transcription: 'click here' } });
    const r = await prepareMedia(bp, [video], {
      key: 'k',
      fetch: fake,
      extractAudio: (_v, out) => fs.writeFileSync(out, 'sound'),
      extractFrames: () => [shot],
    });
    expect(r.added).toEqual([shot, transcriptOf(video)]);
  });

  it('a wrong key is reported, not thrown', async () => {
    const { fake } = munsit({}, 401);
    const r = await prepareMedia(bp, [file('voice.opus')], { key: 'bad', fetch: fake });
    expect(r.added).toEqual([]);
    expect(r.notes[0]).toMatch(/did not accept the key/);
  });
});

describe('a video note', () => {
  /** A real program on the PATH that takes its time, as avconvert does on a long video. */
  function slowTools(ms: number, fails = false) {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    const sleep = `perl -e 'select(undef,undef,undef,${ms / 1000})'`;
    fs.writeFileSync(path.join(bin, 'avconvert'), `#!/bin/sh\n${sleep}\n${fails ? 'echo boom >&2; exit 3' : 'while [ "$1" != "-o" ]; do shift; done; echo sound > "$2"'}\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'swift'), `#!/bin/sh\n${sleep}\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  }
  const realPath = process.env.PATH;
  const realPlatform = process.platform;
  afterEach(() => {
    process.env.PATH = realPath;
    Object.defineProperty(process, 'platform', { value: realPlatform });
  });

  it('does not hold up the board while it is converted: the app goes on answering', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    slowTools(250);
    const { fake } = munsit({ data: { transcription: 'kalam' } });
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 10);
    const done = await prepareMedia(bp, [file('note.mp4')], { key: 'k', fetch: fake });
    clearInterval(timer);
    expect(done.notes).toEqual(['Wrote out note.mp4']);
    // Two programs of 250 ms each: a blocking call would leave next to no ticks.
    expect(ticks).toBeGreaterThan(15);
  });

  it('a conversion that fails reads in plain words, with no command in them', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    slowTools(1, true);
    const { fake } = munsit({ data: { transcription: 'kalam' } });
    const done = await prepareMedia(bp, [file('note.mp4')], { key: 'k', fetch: fake });
    expect(done.notes).toEqual(['Could not write out note.mp4: something went wrong with it, so nobody can hear it for now']);
    expect(done.notes.join()).not.toMatch(/avconvert|Command failed/);
  });

  it('on a computer that cannot do video it says so, and a voice note still works', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const { fake } = munsit({ data: { transcription: 'kalam' } });
    const done = await prepareMedia(bp, [file('note.mp4'), file('voice.ogg')], { key: 'k', fetch: fake });
    expect(done.notes).toEqual(['Could not write out note.mp4: taking the sound out of a video needs a Mac for now', 'Wrote out voice.ogg']);
    expect(videoNotesWork('linux')).toBe(false);
    expect(videoNotesWork('win32')).toBe(false);
    expect(videoNotesWork('darwin')).toBe(true);
  });

  it('a lost connection and a wrong key read in plain words', async () => {
    const lost = (async () => {
      throw new TypeError('getaddrinfo ENOTFOUND api.munsit.com');
    }) as unknown as typeof fetch;
    const off = await prepareMedia(bp, [file('a.ogg')], { key: 'k', fetch: lost });
    expect(off.notes).toEqual(['Could not write out a.ogg: Could not reach Munsit. Check the connection']);
    const { fake } = munsit({}, 401);
    const wrong = await prepareMedia(bp, [file('b.ogg')], { key: 'k', fetch: fake });
    expect(wrong.notes).toEqual(['Could not write out b.ogg: Munsit did not accept the key. Check it in Settings']);
  });
});

