import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PhoneDriverModule } from '../src/modules/phone-driver/types.js';
import type { WindowPhone } from '../src/engine/window.js';
import { StepFailure } from '../src/modules/browser/types.js';
import { fakeAndroid, fakePhone, type FakePhone } from './fakes/phone.js';
import { pngBytes } from './support/png.js';

/**
 * The Tester's pictures on squad-kit's own phone, through the window: the tools say plainly that the pictures come
 * from a real iPhone and iPad, take the same steps as in the browser, and check them the same way; each picture is
 * labelled with its device. The phone session builds nothing here (the app is given), and phone and Maestro are fakes.
 */

const h = vi.hoisted(() => ({ phone: null as FakePhone | null, driver: null as PhoneDriverModule | null }));
vi.mock('../src/modules/registry.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/registry.js')>()),
  shotPhone: () => h.phone!.module,
  phoneDriver: () => h.driver!,
}));

const { AgentWindow, PHONE_STARTING } = await import('../src/engine/window.js');
const { PhoneSession, NO_LINKS, closeDrivers } = await import('../src/engine/phone/session.js');
const desk = await import('../src/engine/phone/turn.js');
const { shotSizeOf } = await import('../src/engine/proof-check.js');
const { stepWords } = await import('../src/engine/shots.js');

let tmp: string;
let lines: string[];
let tapped: string[];

/** A made-up Maestro: each step is written down; a part named "Missing" is never on the screen. */
/** Where each made-up Maestro was started: the device it was given, and the environment. */
let opened: { device: string; env?: Record<string, string> }[] = [];

function fakeDriver(): PhoneDriverModule {
  return {
    name: 'fake-maestro',
    label: 'Maestro',
    async open(o) {
      opened.push({ device: o.device, ...(o.env ? { env: o.env } : {}) });
      return {
        alive: true,
        async act(appId, step) {
          tapped.push(`${appId}: ${stepWords(step)}`);
          if (step.target?.name === 'Missing' || step.target?.text === 'Missing') throw new StepFailure('missing', 'Element not found: Text matching regex: Missing');
        },
        screenText: async () => '- "Welcome Sara"',
        close: async () => undefined,
      };
    },
  };
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-window-phone-')));
  process.env.SQUAD_KIT_HOME = path.join(tmp, 'home');
  lines = [];
  tapped = [];
  opened = [];
  h.phone = fakePhone();
  h.driver = fakeDriver();
  desk.resetDesk();
  desk.useDeskHost({ freeBytes: async () => 8 * 1024 ** 3, load: () => 1, cores: () => 10, alive: () => false, sleep: async () => undefined });
});
afterEach(() => {
  closeDrivers();
  desk.resetDesk();
  desk.useDeskHost(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const app = () => {
  const a = path.join(tmp, 'Runner.app');
  fs.mkdirSync(a, { recursive: true });
  return a;
};
const session = () => new PhoneSession({ cwd: tmp, kind: 'flutter', tools: { maestro: '/sk/maestro' }, app: app(), say: (t) => lines.push(t) });

function windowWith(phone: WindowPhone, limits: { callMs?: number } = {}) {
  return new AgentWindow({
    ticket: 'WA-1',
    step: 'proof',
    who: 'Tester',
    tools: ['take_screenshots', 'look_at_page', 'i_am_stuck'],
    phone,
    proofDir: path.join(tmp, 'proof'),
    prefix: 'wa-1-after',
    say: (t) => lines.push(t),
    ...(Object.keys(limits).length ? { limits } : {}),
  });
}

const text = (r: { content: { type: string; text?: string }[] }) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

describe("the phone's tools", () => {
  it('say plainly that the pictures come from a real iPhone and iPad, with phone and tablet as the sizes', async () => {
    const s = session();
    await s.ready();
    const w = windowWith(s);
    const tools = w.listTools();
    const shots = tools.find((t) => t.name === 'take_screenshots')!;
    expect(shots.description).toContain('a real iPhone 18 Pro (phone) or iPad Air 13-inch (M4) (tablet): an iPhone simulator it runs itself, hidden, on this computer');
    const item = (shots.inputSchema as { properties: { shots: { items: { properties: Record<string, { enum?: string[]; description?: string }> } } } }).properties.shots.items.properties;
    expect(item.size!.enum).toEqual(['phone', 'tablet']);
    expect(item.page!.description).toContain('This app has no links of its own');
    expect(Object.keys(item)).toEqual(['page', 'steps', 'size', 'language']);
    expect(tools.find((t) => t.name === 'look_at_page')!.description).toContain('gives back what the screen shows as text');
    await w.close();
  });

  it("on Android: the tools name Google's emulator and its Pixel, and Maestro taps it by its serial", async () => {
    h.phone = fakeAndroid();
    const s = new PhoneSession({ cwd: tmp, kind: 'flutter', system: 'android', tools: { maestro: '/sk/maestro' }, app: path.join(tmp, 'app-debug.apk'), say: (t) => lines.push(t) });
    await s.ready();
    const w = windowWith(s);
    const shots = w.listTools().find((t) => t.name === 'take_screenshots')!;
    expect(shots.description).toContain('a real Pixel 9 (phone) or Pixel Tablet (tablet): an Android emulator it runs itself, hidden, on this computer');
    expect(opened).toEqual([{ device: 'emulator-5560', env: { ANDROID_HOME: '/sk/sdk', HOME: '/sk/phones/android' } }]);
    expect(lines).toEqual([
      "Starting squad-kit's Android phone, about 40 seconds",
      "Putting the app on squad-kit's Android phone, about 5 seconds",
      "Getting squad-kit's Android phone ready to tap through the app, about 30 seconds",
    ]);
    const r = await s.shoot({ page: '/', language: 'ar' }, { deadline: Date.now() + 30_000, stepMs: 5000 });
    expect(r).toMatchObject({ device: 'Pixel 9' });
    expect(h.phone.calls).toContain('launch squad-kit-android-phone dev.test.app ar');
    await w.close();
  });

  it('takes a picture on the tablet in Arabic, saved with its device; each picture lists its device', async () => {
    const s = session();
    const w = windowWith(s);
    const r = await w.call('take_screenshots', { shots: [{ page: '/', steps: [{ action: 'fill', target: { label: 'Name' }, value: 'Sara' }, { action: 'click', target: { role: 'button', name: 'Sign up' } }], size: 'tablet', language: 'ar' }] });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain('Shot 1: saved as wa-1-after-1.png, at / (tablet, iPad Air 13-inch (M4), language ar).');
    expect(r.content.some((c) => c.type === 'image')).toBe(true);
    expect(w.pictures.get('wa-1-after-1.png')).toEqual({ file: 'wa-1-after-1.png', page: '/', size: 'tablet', device: 'iPad Air 13-inch (M4)' });
    expect(w.pictureList()).toContain('- wa-1-after-1.png: /, tablet (iPad Air 13-inch (M4))');
    // The app opened fresh, in Arabic, on the iPad; the keyboard goes away only when it covers what a step needs.
    const ipad = h.phone!.devices.find((d) => d.name === 'squad-kit iPad')!.id;
    expect(h.phone!.calls).toContain(`launch ${ipad} dev.test.app ar`);
    expect(tapped).toEqual(['dev.test.app: fill the field labelled "Name" with "Sara"', 'dev.test.app: click the button named "Sign up"']);
    await w.close();
  });

  it('checks the calls the same way, with words for a phone: no desktop, no css, a two-letter language', async () => {
    const s = session();
    await s.ready();
    const w = windowWith(s);
    const desktop = await w.call('take_screenshots', { shots: [{ page: '/', size: 'desktop' }] });
    expect(text(desktop)).toContain('size is "phone" or "tablet" on this phone app');
    const css = await w.call('look_at_page', { page: '/', steps: [{ action: 'click', target: { css: '#go' } }] });
    expect(text(css)).toContain('names its part by css, and a phone screen has none');
    const lang = await w.call('look_at_page', { page: '/', language: 'Arabic' });
    expect(text(lang)).toContain('language is a two-letter code, like "en" or "ar"');
    const other = await w.call('look_at_page', { page: 'https://example.com' });
    expect(text(other)).toContain('squad-kit refused this');
    expect(w.mistakes).toHaveLength(3);
    await w.close();
  });

  it('a step that does not work says which and why in plain words, with what the screen showed', async () => {
    const s = session();
    const w = windowWith(s);
    const r = await w.call('take_screenshots', { shots: [{ page: '/', steps: [{ action: 'click', target: { role: 'button', name: 'Missing' } }] }] });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Shot 1 (/) did not work at step 1 (click the button named "Missing"): no button named "Missing" on the page.');
    expect(text(r)).toContain('- "Welcome Sara"');
    await w.close();
  });

  it('look_at_page reads the screen as text, on the device it names; a page with no link starts on the start screen', async () => {
    const s = session();
    const w = windowWith(s);
    const r = await w.call('look_at_page', { page: '/book' });
    expect(text(r)).toBe(`The screen is at / on the iPhone 18 Pro. ${NO_LINKS}\nWhat it shows (the words of each part, one a line), cut short:\n- "Welcome Sara"`);
    await w.close();
  });

  it("while the phone still gets ready, a call says so and the getting ready goes on", async () => {
    let release!: () => void;
    const slow: WindowPhone = { sizes: ['phone'], labels: () => ({ phone: 'iPhone 18 Pro' }), links: () => [], ready: () => new Promise<void>((r) => (release = r)), shoot: async () => ({ png: pngBytes(), page: '/', device: 'iPhone 18 Pro' }), look: async () => ({ page: '/', snapshot: '', device: 'iPhone 18 Pro' }), close: async () => undefined };
    const w = windowWith(slow, { callMs: 300 });
    const r = await w.call('take_screenshots', { shots: [{ page: '/' }] });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(PHONE_STARTING);
    release();
    await w.close();
  });
});

describe('the phone session', () => {
  it('gets ready before the clock starts: the iPhone up hidden, the app on it, Maestro warmed, each said with its time', async () => {
    const s = session();
    await s.ready();
    const id = h.phone!.devices.find((d) => d.name === 'squad-kit iPhone')!.id;
    expect(h.phone!.calls.filter((c) => c.endsWith(id) || c.includes(`${id} `))).toEqual([`boot ${id}`, `install ${id} ${path.join(tmp, 'Runner.app')}`]);
    expect(lines).toEqual([
      "Starting squad-kit's iPhone, about a minute",
      "Putting the app on squad-kit's iPhone, about 15 seconds",
      "Getting squad-kit's iPhone ready to tap through the app, about a minute",
    ]);
    expect(s.labels()).toEqual({ phone: 'iPhone 18 Pro', tablet: 'iPad Air 13-inch (M4)' });
    // Never the Simulator window for the pictures.
    expect(h.phone!.calls.some((c) => c.startsWith('window'))).toBe(false);
  });

  it("opens a page by the app's own link when it has one", async () => {
    h.phone = fakePhone({ app: { appId: 'dev.wasl', schemes: ['wasl'] } });
    const s = session();
    const r = await s.shoot({ page: '/book?day=2' }, { deadline: Date.now() + 30_000, stepMs: 5000 });
    expect(r).toMatchObject({ page: '/book?day=2', device: 'iPhone 18 Pro' });
    const id = h.phone.devices[0]!.id;
    expect(h.phone.calls).toContain(`openurl ${id} wasl://book?day=2`);
    expect(s.links()).toEqual(['wasl']);
  });

  it("puts this story's app back when another story's build of the same app went on the phone meanwhile", async () => {
    const a = session();
    await a.shoot({ page: '/' }, { deadline: Date.now() + 30_000, stepMs: 5000 });
    const other = path.join(tmp, 'other', 'Runner.app');
    fs.mkdirSync(other, { recursive: true });
    const b = new PhoneSession({ cwd: tmp, kind: 'flutter', tools: { maestro: '/sk/maestro' }, app: other, say: () => undefined });
    await b.shoot({ page: '/' }, { deadline: Date.now() + 30_000, stepMs: 5000 });
    await a.shoot({ page: '/' }, { deadline: Date.now() + 30_000, stepMs: 5000 });
    expect(h.phone!.calls.filter((c) => c.startsWith('install')).map((c) => path.basename(path.dirname(c.split(' ')[2]!)))).toEqual([path.basename(tmp), 'other', path.basename(tmp)]);
  });
});

describe("a real phone's pictures", () => {
  it('are told apart by their shape: a tall one is a phone, a less tall one a tablet', () => {
    const save = (name: string, w: number, hgt: number) => {
      const file = path.join(tmp, name);
      fs.writeFileSync(file, pngBytes(w, hgt));
      return file;
    };
    expect(shotSizeOf(save('web-phone.png', 390, 844))).toBe('phone');
    expect(shotSizeOf(save('desktop.png', 1280, 800))).toBe('desktop');
    expect(shotSizeOf(save('iphone.png', 900, 1960))).toBe('phone');
    expect(shotSizeOf(save('ipad.png', 820, 1180))).toBe('tablet');
  });
});
