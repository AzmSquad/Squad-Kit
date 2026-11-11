import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zip } from '../src/core/zip.js';
import { ownTool } from '../src/engine/tools/detect.js';
import { GetTrouble, clearHalfGets, firstGuess, getTool, gettingNow, javaSource, lastTrouble, maestroSource, startGets, type ToolSource } from '../src/engine/tools/get.js';

/**
 * squad-kit's own installs, with a made-up source: a good download is checked, unpacked and marked ready; a wrong
 * checksum or a cut download leaves nothing behind. No real download and no network.
 */

let home: string;

const ARCHIVE = zip([
  { name: 'fake/bin/fake', data: '#!/bin/sh\necho 1.0.0\n' },
  // Bytes that do not pack smaller, so the download is as big as a real one's start.
  { name: 'fake/lib/fake.jar', data: randomBytes(64 * 1024) },
]);
const SUM = createHash('sha256').update(ARCHIVE).digest('hex');

async function* chunks(data: Buffer, upTo = data.length, size = 8 * 1024, breakAt?: number): AsyncIterable<Uint8Array> {
  for (let i = 0; i < upTo; i += size) {
    if (breakAt !== undefined && i >= breakAt) throw new TypeError('terminated');
    yield data.subarray(i, Math.min(i + size, upTo));
  }
}

function source(over: Partial<ToolSource> & { upTo?: number; breakAt?: number } = {}): ToolSource {
  return {
    version: '1.0.0',
    file: 'fake.zip',
    pack: 'zip',
    sha256: async () => SUM,
    open: async () => ({ body: chunks(ARCHIVE, over.upTo, undefined, over.breakAt), size: ARCHIVE.length }),
    binary: (dir) => (fs.existsSync(path.join(dir, 'fake', 'bin', 'fake')) ? path.join(dir, 'fake', 'bin', 'fake') : null),
    ...over,
  };
}

/** Everything in squad-kit's tools folder, but its own notes. */
const leftovers = () => {
  const base = path.join(home, 'tools');
  return fs.existsSync(base) ? fs.readdirSync(base).filter((n) => n !== 'times.json') : [];
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-tool-get-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('getting a tool', () => {
  it('a good download: checked, unpacked into its own folder and marked ready last', async () => {
    const seen: string[] = [];
    const got = await getTool('maestro', source(), { home, onProgress: (p) => seen.push(p.step) });
    expect(got.version).toBe('1.0.0');
    expect(got.dir).toBe(path.join(home, 'tools', 'maestro', '1.0.0'));
    expect(fs.existsSync(got.binary)).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(got.binary).mode & 0o111).toBeTruthy();
    const mark = JSON.parse(fs.readFileSync(path.join(got.dir, 'ready.json'), 'utf8'));
    expect(mark).toMatchObject({ version: '1.0.0', binary: path.join('fake', 'bin', 'fake'), sha256: SUM });
    expect(ownTool('maestro', home)?.binary).toBe(got.binary);
    expect(seen).toContain('download');
    expect(seen.at(-1)).toBe('unpack');
    // Only the tool is left: the download folder went.
    expect(leftovers()).toEqual(['maestro']);
    // The time it took here is the next first guess.
    expect(firstGuess('maestro', home)).toBeLessThan(80);
  });

  it('a download that does not match its published checksum is thrown away', async () => {
    const err = await getTool('maestro', source({ sha256: async () => 'a'.repeat(64) }), { home }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GetTrouble);
    expect((err as Error).message).toBe('The download of Maestro did not match its published checksum, so squad-kit threw it away. Nothing was installed.');
    expect(leftovers()).toEqual([]);
    expect(ownTool('maestro', home)).toBeNull();
  });

  it('a download cut short, or broken off, leaves nothing half there', async () => {
    for (const cut of [source({ upTo: 20_000 }), source({ breakAt: 16 * 1024 })]) {
      const err = await getTool('java', cut, { home }).catch((e: unknown) => e);
      expect((err as Error).message).toBe('The download of Java stopped before the end, so squad-kit threw it away. Nothing was installed. Press Get it again.');
      expect(leftovers()).toEqual([]);
    }
  });

  it('a download without the program squad-kit expects is not used', async () => {
    const err = await getTool('maestro', source({ binary: () => null }), { home }).catch((e: unknown) => e);
    expect((err as Error).message).toContain('did not have the program squad-kit expected');
    expect(leftovers()).toEqual([]);
  });

  it('what a cut-off squad-kit left behind is cleared, and nothing else in the folder', () => {
    fs.mkdirSync(path.join(home, 'tools', '.part-maestro-x1'), { recursive: true });
    fs.mkdirSync(path.join(home, 'tools', 'maestro', '2.12.1', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(home, 'tools', 'java', '21'), { recursive: true });
    fs.writeFileSync(path.join(home, 'tools', 'java', '21', 'ready.json'), '{}');
    // squad-kit's browser lives in the same folder, without the mark: it is not this file's to clear.
    fs.mkdirSync(path.join(home, 'tools', 'playwright', 'chromium-1200'), { recursive: true });
    clearHalfGets(home);
    expect(fs.readdirSync(path.join(home, 'tools')).sort()).toEqual(['java', 'maestro', 'playwright']);
    expect(fs.readdirSync(path.join(home, 'tools', 'maestro'))).toEqual([]);
    expect(fs.readdirSync(path.join(home, 'tools', 'java'))).toEqual(['21']);
    expect(fs.readdirSync(path.join(home, 'tools', 'playwright'))).toEqual(['chromium-1200']);
  });

  it('one download at a time, then it says how it went', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = source({
      open: async () => {
        await gate;
        return { body: chunks(ARCHIVE), size: ARCHIVE.length };
      },
    });
    let ended!: () => void;
    const done = new Promise<void>((r) => (ended = r));
    const g = startGets(['maestro'], { home, source: async () => slow, after: () => ended() });
    expect(g).toMatchObject({ tool: 'maestro', name: 'Maestro', step: 'download' });
    expect(gettingNow()?.tool).toBe('maestro');
    expect(() => startGets(['java'], { home, source: async () => slow })).toThrow('squad-kit is getting Maestro now. One download at a time: press Get it again once it is done.');
    release();
    await done;
    expect(gettingNow()).toBeNull();
    expect(ownTool('maestro', home)?.version).toBe('1.0.0');

    // A failed one says why on its line, and stops what came after it.
    let ended2!: () => void;
    const done2 = new Promise<void>((r) => (ended2 = r));
    startGets(['java', 'maestro'], { home, source: async () => source({ sha256: async () => 'b'.repeat(64) }), after: () => ended2() });
    await done2;
    expect(lastTrouble('java')).toContain('did not match its published checksum');
    expect(lastTrouble('maestro')).toBeUndefined();
  });
});

describe('the official sources', () => {
  const answer = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 404, text: async () => String(body), json: async () => body, headers: new Headers(), body: null }) as unknown as Response;

  it("Maestro: the pinned release, checked against the checksum its release publishes", async () => {
    const asked: string[] = [];
    const f = (async (url: string) => {
      asked.push(url);
      return answer('54dbb0716425626604973cbb374c585ca30272375d9ce15177a1152765ddd9d7  maestro.zip\n');
    }) as unknown as typeof fetch;
    const s = maestroSource(f, 'mac');
    expect(s.version).toBe('2.12.1');
    expect(await s.sha256(new AbortController().signal)).toBe('54dbb0716425626604973cbb374c585ca30272375d9ce15177a1152765ddd9d7');
    expect(asked).toEqual(['https://github.com/mobile-dev-inc/maestro/releases/download/cli-2.12.1/checksums_sha256.txt']);
    const changed = maestroSource((async () => answer(`${'c'.repeat(64)}  maestro.zip\n`)) as unknown as typeof fetch, 'mac');
    await expect(changed.sha256(new AbortController().signal)).rejects.toThrow('is not the one squad-kit knows');
  });

  it("Java: the newest runtime for this system and chip, from Adoptium's own API, with its checksum", async () => {
    const asked: string[] = [];
    const f = (async (url: string) => {
      asked.push(url);
      return answer([{ release_name: 'jdk-21.0.5+11', binary: { package: { link: 'https://github.com/adoptium/temurin21-binaries/releases/download/x/OpenJDK21U-jre_aarch64_mac_hotspot_21.0.5_11.tar.gz', checksum: 'D'.repeat(64), size: 52_000_000, name: 'OpenJDK21U-jre_aarch64_mac_hotspot_21.0.5_11.tar.gz' } } }]);
    }) as unknown as typeof fetch;
    const s = await javaSource(f, 'mac', 'arm64');
    expect(asked[0]).toBe('https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=aarch64&image_type=jre&os=mac&vendor=eclipse');
    expect(s).toMatchObject({ version: '21.0.5+11', pack: 'tar.gz', size: 52_000_000 });
    expect(await s.sha256(new AbortController().signal)).toBe('d'.repeat(64));
    // Its program is found inside the release's own top folder.
    const dir = fs.mkdtempSync(path.join(home, 'jre-'));
    fs.mkdirSync(path.join(dir, 'jdk-21.0.5+11-jre', 'Contents', 'Home', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'jdk-21.0.5+11-jre', 'Contents', 'Home', 'bin', 'java'), '');
    expect(s.binary(dir)).toBe(path.join(dir, 'jdk-21.0.5+11-jre', 'Contents', 'Home', 'bin', 'java'));
  });

  it('no internet says so plainly', async () => {
    const f = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(javaSource(f, 'linux', 'x64')).rejects.toThrow("squad-kit could not reach Java's official download. Check the internet connection, then press Get it again.");
  });
});
