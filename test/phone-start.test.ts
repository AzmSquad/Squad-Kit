import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { fakePhone, type FakePhone } from './fakes/phone.js';
import { tinyApp } from './support/tiny-app.js';
import type { Found, FoundBook } from '../src/engine/tools/detect.js';
import type { BuildRun } from '../src/engine/phone/build.js';

/**
 * Start in Your apps and Try it yourself for an iPhone app on a Mac: squad-kit's copy is built, put on its iPhone,
 * started in the language picked and shown in the window; "Use the web version now" stops that and starts the web
 * version the way Start does; Stop shuts the iPhone down; with the tools missing, Start opens the web version and says
 * why. The phone and the build are fakes: no simulator, no window, no Xcode.
 */

const h = vi.hoisted(() => ({ phone: null as FakePhone | null }));
vi.mock('../src/modules/registry.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/registry.js')>()),
  shotPhone: () => h.phone!.module,
}));

const { boardPaths, readMeta, writeMeta, listTickets, removeTicket, updateTicket, readTicket } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { AppRunner } = await import('../src/engine/run-app.js');
const { TryRunner } = await import('../src/engine/try-app.js');
const { useBuildRun } = await import('../src/engine/phone/build.js');
const { writeFound } = await import('../src/engine/tools/detect.js');
const { useDetectHost } = await import('../src/engine/tools/index.js');
const desk = await import('../src/engine/phone/turn.js');
const { mountAppsApi } = await import('../src/console/api/apps.js');
const { mountTryApi } = await import('../src/console/api/try.js');
const { buildPaths } = await import('../src/core/paths.js');
const { usePrecacheRunner } = await import('../src/engine/flutter-downloads.js');

let tmp: string;
let root: string;
let bp: ReturnType<typeof boardPaths>;

const READY: Record<string, Found> = {
  flutter: { state: 'found', version: '3.44.8', where: '/fl' },
  xcode: { state: 'found', version: '27.2' },
  simulator: { state: 'found', version: '27.2' },
  cocoapods: { state: 'found', version: '1.16.2' },
};
function found(over: Record<string, Found> = {}): void {
  writeFound({ at: new Date().toISOString(), system: 'mac', tools: { ...READY, ...over } as FoundBook['tools'] });
  useDetectHost(null);
}

const build: BuildRun = async (_cmd, _args, o) => {
  fs.mkdirSync(path.join(o.cwd, 'build', 'ios', 'iphonesimulator', 'Runner.app'), { recursive: true });
  return { ok: true, output: '' };
};

const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-phone-start-')));
  root = path.join(tmp, 'app');
  for (const d of ['ios', 'web', path.join('lib', 'l10n')]) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'pubspec.yaml'), 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
  for (const l of ['en', 'ar']) fs.writeFileSync(path.join(root, 'lib', 'l10n', `app_${l}.arb`), '{}\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '/build/\n.squad/\n');
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'app');
  bp = boardPaths(path.join(root, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  for (const t of listTickets(bp)) removeTicket(bp, t.id);
  writeMeta(bp, { ...readMeta(bp), project: 'Wasl', commands: { test: 'flutter test' } });
  // A Flutter app with iPhone and web folders: Flutter's own downloads never really run here.
  usePrecacheRunner(async () => ({ ok: true, output: '' }));
  h.phone = fakePhone();
  useBuildRun(build);
  found();
  desk.resetDesk();
  desk.useDeskHost({ freeBytes: async () => 8 * 1024 ** 3, load: () => 1, cores: () => 10, alive: () => false, sleep: () => new Promise((r) => setTimeout(r, 5)) });
});
afterEach(() => {
  useBuildRun(null);
  useDetectHost(null);
  desk.resetDesk();
  desk.useDeskHost(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ipad = () => h.phone!.devices.find((d) => d.name === 'squad-kit iPhone')!.id;

describe('Start in Your apps, for an iPhone app on a Mac', () => {
  it('builds, puts it on squad-kit\'s iPhone, starts it in the language picked and opens the window; Stop shuts the iPhone down', async () => {
    const runner = new AppRunner(bp);
    // A phone app with no start command of its own is still one of Your apps.
    const [app] = await runner.status();
    expect(app).toMatchObject({ name: 'Wasl', state: 'not-running', phone: { ready: true, languages: ['en', 'ar'], web: false } });
    expect(() => runner.start('Wasl', { language: 'fr' })).toThrow('This app comes in en, ar. Pick one of them.');
    const first = runner.start('Wasl', { language: 'ar' });
    expect(first).toMatchObject({ state: 'starting', phone: { on: true } });
    const s = await runner.settled('Wasl');
    expect(s.state).toBe('running');
    expect(s.phone?.run).toMatchObject({ state: 'running', device: 'iPhone 18 Pro', language: 'ar' });
    const id = ipad();
    expect(h.phone!.calls).toContain(`launch ${id} dev.test.app ar`);
    expect(h.phone!.calls).toContain(`window ${id}`);
    const stopped = await runner.stop('Wasl');
    expect(stopped.state).toBe('stopped');
    expect(h.phone!.calls.slice(-1)).toEqual([`shutdown ${id}`]);
  });

  it('"Use the web version now" stops the phone and starts the web version the way Start does', async () => {
    const web = await tinyApp();
    writeMeta(bp, { ...readMeta(bp), commands: { test: 'flutter test', start: web.start, url: web.url } });
    const runner = new AppRunner(bp);
    runner.start('Wasl');
    expect((await runner.settled('Wasl')).phone?.run?.state).toBe('running');
    const now = await runner.startAs('Wasl', { web: true });
    expect(now.state).toBe('starting');
    expect(now.phone?.on).toBeUndefined();
    expect(h.phone!.calls.slice(-1)).toEqual([`shutdown ${ipad()}`]);
    const s = await runner.settled('Wasl');
    expect(s).toMatchObject({ state: 'running', address: web.url });
    await runner.stop('Wasl');
  });

  it('when the person closes the window, Start shows it stopped, in plain words', async () => {
    const runner = new AppRunner(bp);
    runner.start('Wasl');
    await runner.settled('Wasl');
    h.phone!.windows.clear();
    const end = Date.now() + 5000;
    while ((await runner.statusOf('Wasl')).state === 'running' && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    const s = await runner.statusOf('Wasl');
    expect(s.state).toBe('stopped');
    expect(s.phone?.run?.ended).toBe('You closed the iPhone window, so squad-kit stopped the app.');
  });

  it("with Xcode missing, Start opens the web version, and says why with the Tools page line; asking for the phone says the same", async () => {
    found({ xcode: { state: 'missing' }, simulator: { state: 'missing' } });
    const web = await tinyApp();
    writeMeta(bp, { ...readMeta(bp), commands: { test: 'flutter test', start: web.start, url: web.url } });
    const runner = new AppRunner(bp);
    const [app] = await runner.status();
    expect(app!.phone).toMatchObject({ ready: false, why: "squad-kit can't start the app on a phone yet: Xcode and iPhone simulator aren't on this computer.", link: '/tools#xcode', web: true });
    expect(() => runner.start('Wasl', { phone: true })).toThrow("squad-kit can't start the app on a phone yet");
    runner.start('Wasl');
    expect((await runner.settled('Wasl')).address).toBe(web.url);
    await runner.stop('Wasl');
    expect(h.phone!.calls).toEqual([]);
  });

  it('one REST call per button: phone, web and language in the body', async () => {
    const api = new Hono();
    mountAppsApi(api, { paths: buildPaths(root) });
    const r = await api.request('/api/v1/apps/Wasl/start', { method: 'POST', body: JSON.stringify({ language: 'ar' }), headers: { 'content-type': 'application/json' } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { phone?: { on?: boolean } }).phone?.on).toBe(true);
    const bad = await api.request('/api/v1/apps/Wasl/start', { method: 'POST', body: JSON.stringify({ language: 'Arabic' }), headers: { 'content-type': 'application/json' } });
    expect(bad.status).toBe(400);
  });
});

describe('Try it yourself on the iPhone', () => {
  function story(): string {
    const copy = path.join(tmp, 'copy');
    fs.cpSync(root, copy, { recursive: true, filter: (p) => !p.includes(`${path.sep}.git`) && !p.includes(`${path.sep}.squad`) });
    const t = actions.createTicket(bp, { title: 'Sign up' });
    updateTicket(bp, t.id, (x) => {
      x.stage = 'review';
      x.live = false;
      x.squad = null;
      x.worktree = copy;
      x.waiting = { kind: 'proof', summary: 'The proof is ready' };
    });
    return t.id;
  }

  it("opens the story's own copy on the iPhone; when the person closes the window, the story says so", async () => {
    const id = story();
    const runner = new TryRunner(bp, { watchMs: 20 });
    const before = runner.status(id);
    expect(before).toMatchObject({ can: true, phone: { ready: true, languages: ['en', 'ar'] } });
    const first = runner.start(id);
    expect(first.phone?.on).toBe(true);
    const s = await runner.settled(id);
    expect(s).toMatchObject({ state: 'running', phone: { run: { state: 'running', device: 'iPhone 18 Pro' } } });
    expect(readTicket(bp, id)!.activity.map((a) => a.text)).toContain("Opened this story's own copy of the app on squad-kit's iPhone 18 Pro for you to try. Nothing is merged.");
    h.phone!.windows.clear();
    const end = Date.now() + 5000;
    while (runner.status(id).state === 'running' && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(runner.status(id)).toMatchObject({ state: 'off', ended: 'You closed the iPhone window, so squad-kit stopped the app.' });
    expect(readTicket(bp, id)!.activity.map((a) => a.text)).toContain('You closed the iPhone window, so squad-kit stopped the app.');
    runner.stopAll();
  });

  it('with no web version and Xcode missing, it says what the iPhone needs', () => {
    found({ xcode: { state: 'missing' }, simulator: { state: 'missing' } });
    const id = story();
    const s = new TryRunner(bp).status(id);
    expect(s).toMatchObject({ can: false, why: "squad-kit can't open Try it yourself on a phone yet: Xcode and iPhone simulator aren't on this computer." });
  });

  it('the REST call takes web, phone and language', async () => {
    const id = story();
    const api = new Hono();
    mountTryApi(api, { paths: buildPaths(root) });
    const r = await api.request(`/api/v1/tickets/${id}/try`, { method: 'POST', body: JSON.stringify({ phone: true, language: 'ar' }), headers: { 'content-type': 'application/json' } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { phone?: { on?: boolean } }).phone?.on).toBe(true);
    await api.request(`/api/v1/tickets/${id}/try/stop`, { method: 'POST' });
  });
});
