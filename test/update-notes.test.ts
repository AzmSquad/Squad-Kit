import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import type { InstalledPackage } from '../src/core/package-info.js';
import { fetchReleasesBetween } from '../src/core/update.js';
import { UpdateService, type UpdateDeps } from '../src/console/updates.js';

/**
 * What is new since your version: the update banner reads every release between the installed and the latest
 * version from GitHub's release list, keeps it, and reads it again on Check for updates. fetch is always a fake.
 */

const home = () => process.env.SQUAD_KIT_HOME!;
const REPO = 'https://github.com/AzmSquad/squad-kit';

interface Rel {
  tag: string;
  body: string;
  draft?: boolean;
  prerelease?: boolean;
}

const RELEASES: Rel[] = [
  { tag: 'v1.2.0-beta.1', body: '- A beta', prerelease: true },
  { tag: 'v1.1.2', body: '- Not out yet', draft: true },
  { tag: 'v1.1.1', body: '- Chat waits for the usage limit\n- Slim banners on a phone\n- Copy commands with quotes\n- A fourth line' },
  { tag: 'v1.1.0', body: '## New\n\n- Delete and Archive\n- Your apps' },
  { tag: 'v1.0.2', body: '- Small fixes' },
  { tag: 'v1.0.1', body: '- The Update button' },
  { tag: 'v1.0.0', body: '- First v1' },
];

/** GitHub with a release list (or none) and npm with `latest`. Every call is kept. */
function github(opts: { latest?: string; list?: Rel[] | null; calls?: string[] } = {}): typeof fetch {
  const list = opts.list === undefined ? RELEASES : opts.list;
  return (async (url: string) => {
    opts.calls?.push(url);
    if (url.startsWith('https://registry.npmjs.org/')) return Response.json({ 'dist-tags': { latest: opts.latest ?? '1.1.1' }, versions: {} });
    if (url.includes('/releases?')) {
      if (!list) return new Response('rate limited', { status: 403 });
      return Response.json(list.map((r) => ({ tag_name: r.tag, body: r.body, draft: r.draft ?? false, prerelease: r.prerelease ?? false, html_url: `${REPO}/releases/tag/${r.tag}` })));
    }
    const tag = /\/releases\/tags\/(v[\w.-]+)$/.exec(url)?.[1];
    const one = RELEASES.find((r) => r.tag === tag);
    return one ? Response.json({ body: one.body, html_url: `${REPO}/releases/tag/${one.tag}` }) : new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('notes for every release since your version', () => {
  it('lists each release after yours up to the latest, newest first, a few lines each, no drafts or betas', async () => {
    const calls: string[] = [];
    const notes = await fetchReleasesBetween(REPO, '1.0.1', '1.1.1', { fetch: github({ calls }) });
    expect(calls).toEqual(['https://api.github.com/repos/AzmSquad/squad-kit/releases?per_page=30']);
    expect(notes).toEqual([
      { version: '1.1.1', lines: ['Chat waits for the usage limit', 'Slim banners on a phone', 'Copy commands with quotes'], url: `${REPO}/releases/tag/v1.1.1` },
      { version: '1.1.0', lines: ['Delete and Archive', 'Your apps'], url: `${REPO}/releases/tag/v1.1.0` },
      { version: '1.0.2', lines: ['Small fixes'], url: `${REPO}/releases/tag/v1.0.2` },
    ]);
  });

  it('falls back to the latest release alone when the list cannot be read, and to the changelog with nothing', async () => {
    const one = await fetchReleasesBetween(REPO, '1.0.1', '1.1.1', { fetch: github({ list: null }) });
    expect(one).toEqual([{ version: '1.1.1', lines: ['Chat waits for the usage limit', 'Slim banners on a phone', 'Copy commands with quotes'], url: `${REPO}/releases/tag/v1.1.1` }]);
    const offline = await fetchReleasesBetween(REPO, '1.0.1', '1.1.1', { fetch: (async () => Promise.reject(new Error('offline'))) as unknown as typeof fetch });
    expect(offline).toEqual([{ version: '1.1.1', lines: [], url: `${REPO}/blob/v1.1.1/CHANGELOG.md` }]);
  });
});

function installed(version: string): () => InstalledPackage {
  return () => ({ name: 'squad-kit', version, root: '/usr/local/lib/node_modules/squad-kit', repositoryUrl: REPO, isDevInstall: false });
}

function service(more: UpdateDeps = {}): UpdateService {
  return new UpdateService({ fetch: github(), installed: installed('1.0.1'), hold: () => undefined, restart: () => undefined, busy: () => [], carrying: () => [], ...more });
}

beforeEach(() => {
  fs.rmSync(path.join(home(), 'update.json'), { force: true });
  fs.writeFileSync(path.join(home(), 'settings.yaml'), 'checkForUpdates: false\n');
});

describe('the update banner', () => {
  it('shows what is new in 1.1.1 and 1.1.0 to a person on 1.0.1, and keeps it for the next start', async () => {
    const s = await service().check();
    expect(s.releases?.map((r) => r.version)).toEqual(['1.1.1', '1.1.0', '1.0.2']);
    expect(s.releases?.[1]?.lines).toEqual(['Delete and Archive', 'Your apps']);
    // The latest version's own lines and link stay, for the terminal and older pages.
    expect(s.notes).toEqual(['Chat waits for the usage limit', 'Slim banners on a phone', 'Copy commands with quotes']);
    expect(s.notesUrl).toBe(`${REPO}/releases/tag/v1.1.1`);
    // Kept: a fresh app shows it without asking GitHub.
    expect(new UpdateService({ installed: installed('1.0.1') }).status().releases?.map((r) => r.version)).toEqual(['1.1.1', '1.1.0', '1.0.2']);
  });

  it('reads the notes once a day, and again at once on Check for updates, so an edited release shows', async () => {
    let now = Date.parse('2026-11-03T09:00:00Z');
    const list = RELEASES.map((r) => ({ ...r }));
    const calls: string[] = [];
    const svc = service({ fetch: github({ list, calls }), now: () => now });
    await svc.check();
    const lists = () => calls.filter((c) => c.includes('/releases?')).length;
    expect(lists()).toBe(1);

    // The release is edited on GitHub. A daily look within the day keeps what it read.
    list.find((r) => r.tag === 'v1.1.0')!.body = '- Delete and Archive\n- Your apps\n- Report a problem';
    now += 60 * 60_000;
    await svc.check();
    expect(lists()).toBe(1);
    expect(svc.status().releases?.[1]?.lines).toHaveLength(2);

    // The person presses Check for updates: the notes are read again.
    const s = await svc.check({ fresh: true });
    expect(lists()).toBe(2);
    expect(s.releases?.[1]?.lines).toEqual(['Delete and Archive', 'Your apps', 'Report a problem']);

    // A day later the daily look reads them again too.
    list.find((r) => r.tag === 'v1.0.2')!.body = '- Small fixes\n- Faster start';
    now += 25 * 60 * 60_000;
    await svc.check();
    expect(lists()).toBe(3);
    expect(svc.status().releases?.[2]?.lines).toEqual(['Small fixes', 'Faster start']);
  });

  it('after the update, the note shows every release since the version the person had', async () => {
    const svc = service({ install: async () => ({ ok: true, code: 0, output: '', timedOut: false }) });
    await svc.check();
    await svc.start();
    for (let i = 0; i < 100 && svc.status().progress.state !== 'restarting'; i++) await new Promise((r) => setTimeout(r, 10));
    const after = new UpdateService({ installed: installed('1.1.1') }).status();
    expect(after.progress).toMatchObject({ state: 'done', from: '1.0.1', to: '1.1.1' });
    expect(after.releases?.map((r) => r.version)).toEqual(['1.1.1', '1.1.0', '1.0.2']);
  });

  it('asks again while the newest release has no notes yet, and shows the older ones meanwhile', async () => {
    const list = RELEASES.filter((r) => r.tag !== 'v1.1.1');
    const calls: string[] = [];
    const svc = service({ fetch: github({ list, calls }) });
    const s = await svc.check();
    expect(s.releases?.map((r) => r.version)).toEqual(['1.1.0', '1.0.2']);
    expect(s.notesUrl).toBe(`${REPO}/blob/v1.1.1/CHANGELOG.md`);
    list.unshift(RELEASES.find((r) => r.tag === 'v1.1.1')!);
    const again = await svc.check();
    expect(again.releases?.map((r) => r.version)).toEqual(['1.1.1', '1.1.0', '1.0.2']);
  });
});
