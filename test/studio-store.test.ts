import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { Hono } from 'hono';
import { boardPaths, listDecisions, listReleases, listTickets, readMeta, type BoardPaths } from '../src/board/store.js';
import { seedDemoBoard } from '../src/board/demo.js';
import { buildPaths, chooseProject } from '../src/core/paths.js';
import { mountStudioApi } from '../src/console/api/studio.js';
import {
  CHANGED_ELSEWHERE,
  addVariant,
  checkStudioStamp,
  defaultDesignSystemOf,
  pickVariant,
  readChat,
  readDefaultDesignSystem,
  readDesignSystem,
  readSketch,
  readStudio,
  readThumbnail,
  saveChat,
  saveDesignSystem,
  saveSketch,
  saveThumbnail,
  studioIdFor,
} from '../src/board/studio.js';
import { chatFile, checkedStudioId, designSystemDir, sketchDir, thumbnailFile } from '../src/board/studio-paths.js';

/**
 * US-03 Studio storage (AB-128): sketches and design systems saved in the project's `.squad/studio/`, so a teammate
 * gets them through git; thumbnails and AI Designer chats stay in this computer's folder for the project.
 */

let tmp: string;
let home: string;
let bp: BoardPaths;
let oldHome: string | undefined;

beforeEach(() => {
  oldHome = process.env.SQUAD_KIT_HOME;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-studio-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-studio-home-'));
  process.env.SQUAD_KIT_HOME = home;
  fs.mkdirSync(path.join(tmp, 'project', '.squad'), { recursive: true });
  bp = boardPaths(path.join(tmp, 'project', '.squad'));
});

afterEach(() => {
  vi.useRealTimers();
  if (oldHome === undefined) delete process.env.SQUAD_KIT_HOME;
  else process.env.SQUAD_KIT_HOME = oldHome;
  chooseProject(null);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

/** Every file under a folder, as paths inside it with `/`, with its bytes and change time. */
function snapshot(dir: string, skip?: string): Record<string, { bytes: string; mtime: number }> {
  const out: Record<string, { bytes: string; mtime: number }> = {};
  const walk = (d: string, rel: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (skip && (r === skip || r.startsWith(`${skip}/`))) continue;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out[r] = { bytes: fs.readFileSync(path.join(d, e.name)).toString('base64'), mtime: fs.statSync(path.join(d, e.name)).mtimeMs };
    }
  };
  walk(dir, '');
  return out;
}

const filesIn = (dir: string) => Object.keys(snapshot(dir)).sort();

const BRAND_TOKENS = { colors: { primary: '#2563eb', surface: '#ffffff', text: '#0f172a' } };
const BUTTON = '<button class="btn">Pay now</button>\n';
const PAYMENT_DESKTOP = '<main><h1>Payment</h1><button class="btn">Pay now</button></main>\n';

/** Done when 1's work: Brand v1 with its colours and a button, and Checkout on Brand v1 with Payment drawn for desktop. */
function saveBrandAndCheckout(paths: BoardPaths = bp) {
  const brand = saveDesignSystem(paths, { name: 'Brand', tokens: BRAND_TOKENS, components: { button: BUTTON } });
  const sketch = saveSketch(paths, { name: 'Checkout', designSystem: { id: 'brand', version: 1 }, frames: ['desktop'], screens: [{ name: 'Payment' }] });
  const drawn = addVariant(paths, 'checkout', 'payment', { frames: { desktop: PAYMENT_DESKTOP }, madeBy: 'person' }, sketch.stamp);
  return { brand, sketch: drawn };
}

describe('done when 1: the layout in .squad/studio/', () => {
  it('saves Brand and Checkout as plain files, one folder each, and nothing else in .squad/ changes', () => {
    seedDemoBoard(bp, { speed: 1000 });
    const before = snapshot(bp.squadDir);
    saveBrandAndCheckout();

    expect(filesIn(bp.studioDir)).toEqual([
      'design-systems/brand/system.yaml',
      'design-systems/brand/v1/components/button.html',
      'design-systems/brand/v1/tokens.json',
      'sketches/checkout/screens/payment/screen.yaml',
      'sketches/checkout/screens/payment/v1/desktop.html',
      'sketches/checkout/screens/payment/v1/meta.yaml',
      'sketches/checkout/sketch.yaml',
    ]);
    const read = (rel: string) => fs.readFileSync(path.join(bp.studioDir, rel), 'utf8');
    expect(yaml.load(read('design-systems/brand/system.yaml'))).toEqual({ name: 'Brand', default: true, version: 1, madeAt: expect.any(String) });
    expect(Number.isNaN(Date.parse((yaml.load(read('design-systems/brand/system.yaml')) as { madeAt: string }).madeAt))).toBe(false);
    // The first design system made is the project's default.
    expect(readStudio(bp).defaultDesignSystem).toBe('brand');
    expect(JSON.parse(read('design-systems/brand/v1/tokens.json'))).toEqual(BRAND_TOKENS);
    expect(read('design-systems/brand/v1/components/button.html')).toBe(BUTTON);
    expect(yaml.load(read('sketches/checkout/sketch.yaml'))).toEqual({ name: 'Checkout', designSystem: { id: 'brand', version: 1 }, frames: ['desktop'] });
    expect(yaml.load(read('sketches/checkout/screens/payment/screen.yaml'))).toEqual({ name: 'Payment', order: 1, status: 'draft', chosen: 1 });
    expect(read('sketches/checkout/screens/payment/v1/desktop.html')).toBe(PAYMENT_DESKTOP);
    expect(yaml.load(read('sketches/checkout/screens/payment/v1/meta.yaml'))).toMatchObject({ madeBy: 'person', madeAt: expect.any(String) });

    // Nothing else in .squad/ changed: the same files, byte for byte, untouched.
    expect(snapshot(bp.squadDir, 'studio')).toEqual(before);
    // The lock is gone once the change is done, and nothing local was made for these saves.
    expect(fs.existsSync(bp.studioLocalDir)).toBe(false);
  });

  it('takes locations from BoardPaths and only checked short ids, so no name can point outside the Studio', () => {
    expect(bp.studioDir).toBe(path.join(bp.squadDir, 'studio'));
    expect(bp.studioLocalDir).toBe(path.join(home, 'projects', bp.projectId, 'studio'));
    expect(designSystemDir(bp, 'brand')).toBe(path.join(bp.studioDir, 'design-systems', 'brand'));
    for (const bad of ['../etc', 'Brand', 'a/b', '', '.hidden', 'x'.repeat(65), '-x']) expect(() => checkedStudioId(bad)).toThrow(/not a Studio id/);
    expect(() => sketchDir(bp, '..')).toThrow();
    expect(() => saveSketch(bp, { id: '../../x', name: 'X', frames: ['desktop'] })).toThrow(/not a Studio id/);
    expect(fs.existsSync(bp.studioDir)).toBe(false);
    expect(studioIdFor('Order history')).toBe('order-history');
    expect(studioIdFor('Café')).toBe('cafe');
    expect(studioIdFor('الدفع')).toMatch(/^item-[0-9a-f]{8}$/);
  });

  it('keeps every design system version: a changed save becomes v2 and an unchanged one writes nothing', () => {
    const { brand } = saveBrandAndCheckout();
    const files = snapshot(bp.studioDir);
    const v1 = snapshot(path.join(bp.studioDir, 'design-systems/brand/v1'));
    const same = saveDesignSystem(bp, { id: 'brand', name: 'Brand', tokens: BRAND_TOKENS, components: { button: BUTTON } }, brand.stamp);
    expect(same.stamp).toBe(brand.stamp);
    expect(snapshot(bp.studioDir)).toEqual(files);

    const v2 = saveDesignSystem(bp, { id: 'brand', name: 'Brand', tokens: { colors: { ...BRAND_TOKENS.colors, primary: '#16a34a' } } }, brand.stamp);
    expect(v2.version).toBe(2);
    expect(v2.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(v2.versions[0]!.tokens).toEqual(BRAND_TOKENS);
    expect(v2.versions[1]!.components).toEqual({ button: BUTTON });
    expect(v2.stamp).not.toBe(brand.stamp);
    // The saved v1 is never written again.
    expect(snapshot(path.join(bp.studioDir, 'design-systems/brand/v1'))).toEqual(v1);
  });
});

describe('done when 2: variants are all kept and either one can be picked', () => {
  it('keeps both Payment variants with the second chosen, then picks the first without losing the second', () => {
    const { sketch } = saveBrandAndCheckout();
    const second = '<main><h1>Payment</h1><p>Card or wallet</p></main>\n';
    const two = addVariant(bp, 'checkout', 'payment', { frames: { desktop: second }, madeBy: 'ai-designer', choose: true }, sketch.stamp);
    const pay = two.screens.find((s) => s.id === 'payment')!;
    expect(pay.variants.map((v) => v.version)).toEqual([1, 2]);
    expect(pay.chosen).toBe(2);
    expect(pay.variants[1]!.frames.desktop).toBe(second);

    const v2files = snapshot(path.join(bp.studioDir, 'sketches/checkout/screens/payment/v2'));
    const back = pickVariant(bp, 'checkout', 'payment', 1, two.stamp);
    const again = back.screens.find((s) => s.id === 'payment')!;
    expect(again.chosen).toBe(1);
    expect(again.variants.map((v) => v.version)).toEqual([1, 2]);
    expect(again.variants[0]!.frames.desktop).toBe(PAYMENT_DESKTOP);
    expect(again.variants[1]!.frames.desktop).toBe(second);
    expect(snapshot(path.join(bp.studioDir, 'sketches/checkout/screens/payment/v2'))).toEqual(v2files);
    expect(yaml.load(fs.readFileSync(path.join(bp.studioDir, 'sketches/checkout/screens/payment/screen.yaml'), 'utf8'))).toMatchObject({ chosen: 1 });

    // And the second can be picked again later.
    expect(pickVariant(bp, 'checkout', 'payment', 2, back.stamp).screens[0]!.chosen).toBe(2);
  });

  it('refuses a variant that is not there and a frame the sketch does not have', () => {
    const { sketch } = saveBrandAndCheckout();
    expect(() => pickVariant(bp, 'checkout', 'payment', 7, sketch.stamp)).toThrow(/no variant 7/);
    expect(() => addVariant(bp, 'checkout', 'payment', { frames: { mobile: '<p/>' } }, sketch.stamp)).toThrow(/no frame "mobile"/);
    expect(readSketch(bp, 'checkout')!.stamp).toBe(sketch.stamp);
  });
});

describe('done when 3: thumbnails and chats stay on this computer', () => {
  it('saves the Payment thumbnail and an AI Designer chat only under studio/thumbnails/ and studio/chats/', () => {
    const { sketch } = saveBrandAndCheckout();
    const shared = snapshot(bp.squadDir);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const thumb = saveThumbnail(bp, 'checkout', 'payment', 1, png);
    const chat = saveChat(bp, 'checkout', 'payment-ideas', { screen: 'payment', messages: [{ role: 'person', text: 'Make the button bigger' }, { role: 'designer', text: 'Done in variant 2' }] });

    expect(thumb).toBe(thumbnailFile(bp, 'checkout', 'payment', 1));
    expect(chat).toBe(chatFile(bp, 'checkout', 'payment-ideas'));
    expect(thumb.startsWith(path.join(bp.studioLocalDir, 'thumbnails') + path.sep)).toBe(true);
    expect(chat.startsWith(path.join(bp.studioLocalDir, 'chats') + path.sep)).toBe(true);
    expect(filesIn(bp.studioLocalDir)).toEqual(['chats/checkout/payment-ideas.json', 'thumbnails/checkout/payment/v1.png']);
    expect(readThumbnail(bp, 'checkout', 'payment', 1)).toEqual(png);
    expect(readChat(bp, 'checkout', 'payment-ideas')!.messages).toHaveLength(2);

    // Nothing about them in .squad/, and the sketch's stamp is the same.
    expect(snapshot(bp.squadDir)).toEqual(shared);
    expect(readSketch(bp, 'checkout')!.stamp).toBe(sketch.stamp);
  });
});

describe('done when 4: a teammate gets the same work through git', () => {
  it('reads back the same design system and sketch from a copy of .squad/studio/ alone, with an empty home', () => {
    const { sketch } = saveBrandAndCheckout();
    const two = addVariant(bp, 'checkout', 'payment', { frames: { desktop: '<main>B</main>\n' }, madeBy: 'ai-designer', choose: true }, sketch.stamp);
    saveThumbnail(bp, 'checkout', 'payment', 1, Buffer.from('png'));
    saveChat(bp, 'checkout', 'talk', { messages: [] });
    const mine = readStudio(bp);

    // The teammate: another folder, another computer (another home), and only what git carries.
    const theirHome = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-studio-mate-'));
    try {
      process.env.SQUAD_KIT_HOME = theirHome;
      const theirs = boardPaths(path.join(tmp, 'teammate', '.squad'));
      expect(theirs.projectId).not.toBe(bp.projectId);
      fs.cpSync(bp.studioDir, theirs.studioDir, { recursive: true });

      const read = readStudio(theirs);
      expect(read).toEqual(mine);
      expect(read.sketches[0]!.stamp).toBe(two.stamp);
      expect(read.sketches[0]!.screens[0]).toMatchObject({ name: 'Payment', chosen: 2 });
      expect(read.sketches[0]!.screens[0]!.variants.map((v) => v.version)).toEqual([1, 2]);
      expect(read.designSystems[0]).toMatchObject({ name: 'Brand', version: 1, markedDefault: true, madeAt: mine.designSystems[0]!.madeAt });
      expect(read.defaultDesignSystem).toBe('brand');
      expect(read.designSystems[0]!.stamp).toBe(mine.designSystems[0]!.stamp);
      expect(readThumbnail(theirs, 'checkout', 'payment', 1)).toBeNull();
      expect(readChat(theirs, 'checkout', 'talk')).toBeNull();
      expect(fs.existsSync(theirs.studioLocalDir)).toBe(false);

      // Their stamp works for their next change, the same as it would here.
      const picked = pickVariant(theirs, 'checkout', 'payment', 1, read.sketches[0]!.stamp);
      expect(picked.screens[0]!.chosen).toBe(1);
    } finally {
      fs.rmSync(theirHome, { recursive: true, force: true });
    }
  });

  it('counts work that arrives through git as a change: an old stamp is refused after a pull', () => {
    const { sketch } = saveBrandAndCheckout();
    // A pull brings a teammate's new screen variant.
    const v2 = path.join(bp.studioDir, 'sketches/checkout/screens/payment/v2');
    fs.mkdirSync(v2, { recursive: true });
    fs.writeFileSync(path.join(v2, 'desktop.html'), '<main>theirs</main>\n');
    expect(() => pickVariant(bp, 'checkout', 'payment', 2, sketch.stamp)).toThrow(CHANGED_ELSEWHERE);
  });
});

describe('the one default design system (AB-158.1)', () => {
  /** Saves with the clock at `at`, so which one is older is plain. Only Date is faked: the Studio lock still waits for real. */
  const madeAt = <T>(at: string, save: () => T): T => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(at));
    try {
      return save();
    } finally {
      vi.useRealTimers();
    }
  };
  const systemYaml = (paths: BoardPaths, id: string) => yaml.load(fs.readFileSync(path.join(designSystemDir(paths, id), 'system.yaml'), 'utf8')) as Record<string, unknown>;

  it('a second design system leaves Brand as the default, and saving either one never moves the mark', () => {
    const { brand } = saveBrandAndCheckout();
    const ocean = saveDesignSystem(bp, { name: 'Ocean', tokens: { colors: { primary: '#0ea5e9' } } });
    expect(ocean.markedDefault).toBe(false);
    expect(systemYaml(bp, 'ocean')).toMatchObject({ name: 'Ocean', default: false, version: 1 });
    expect(readStudio(bp).defaultDesignSystem).toBe('brand');

    const ocean2 = saveDesignSystem(bp, { id: 'ocean', name: 'Ocean sea', tokens: { colors: { primary: '#0284c7' } } }, ocean.stamp);
    const brand2 = saveDesignSystem(bp, { id: 'brand', name: 'Brand', tokens: { colors: { primary: '#16a34a' } } }, brand.stamp);
    expect(ocean2).toMatchObject({ version: 2, markedDefault: false, madeAt: ocean.madeAt });
    expect(brand2).toMatchObject({ version: 2, markedDefault: true, madeAt: brand.madeAt });
    expect(readStudio(bp).defaultDesignSystem).toBe('brand');
    expect(readDefaultDesignSystem(bp)).toBe('brand');
  });

  it("reads the older of two teammates' first design systems as the default once git merges them, without writing", () => {
    // Here: Brand, the first one in this project, made second.
    madeAt('2026-11-10T10:00:00.000Z', () => saveDesignSystem(bp, { name: 'Brand', tokens: { colors: {} } }));
    // A teammate, on their own computer and folder: Ocean, their first one, made the day before.
    const theirHome = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-studio-mate-'));
    try {
      process.env.SQUAD_KIT_HOME = theirHome;
      const theirs = boardPaths(path.join(tmp, 'teammate', '.squad'));
      madeAt('2026-11-09T10:00:00.000Z', () => saveDesignSystem(theirs, { name: 'Ocean', tokens: { colors: {} } }));
      expect(systemYaml(theirs, 'ocean')).toMatchObject({ default: true });
      // The merge brings their folder in beside ours.
      fs.cpSync(designSystemDir(theirs, 'ocean'), designSystemDir(bp, 'ocean'), { recursive: true });
    } finally {
      process.env.SQUAD_KIT_HOME = home;
      fs.rmSync(theirHome, { recursive: true, force: true });
    }

    const files = snapshot(bp.studioDir);
    const read = readStudio(bp);
    expect(read.designSystems.map((d) => [d.id, d.markedDefault])).toEqual([['brand', true], ['ocean', true]]);
    expect(read.defaultDesignSystem).toBe('ocean');
    expect(readDefaultDesignSystem(bp)).toBe('ocean');
    // Both marks stay as git brought them: reading settles the tie and writes nothing.
    expect(snapshot(bp.studioDir)).toEqual(files);
    expect(systemYaml(bp, 'brand')).toMatchObject({ default: true });
  });

  it('with none marked reads the oldest as the default, and changes no file on disk', async () => {
    madeAt('2026-11-10T10:00:00.000Z', () => saveDesignSystem(bp, { name: 'Brand', tokens: {} }));
    madeAt('2026-11-09T10:00:00.000Z', () => saveDesignSystem(bp, { name: 'Ocean', tokens: {} }));
    // A hand edit takes the mark off Brand: now none is marked.
    const brandFile = path.join(designSystemDir(bp, 'brand'), 'system.yaml');
    fs.writeFileSync(brandFile, fs.readFileSync(brandFile, 'utf8').replace('default: true', 'default: false'));
    const files = snapshot(bp.studioDir);

    expect(readStudio(bp).defaultDesignSystem).toBe('ocean');
    expect(readDefaultDesignSystem(bp)).toBe('ocean');
    const app = new Hono();
    mountStudioApi(app, { paths: buildPaths(bp.root) });
    const body = (await (await app.request('/api/v1/studio')).json()) as { defaultDesignSystem: string; designSystems: { id: string; isDefault: boolean; markedDefault: boolean }[] };
    expect(body.defaultDesignSystem).toBe('ocean');
    expect(body.designSystems.map((d) => [d.id, d.isDefault, d.markedDefault])).toEqual([['brand', false, false], ['ocean', true, false]]);
    expect(snapshot(bp.studioDir)).toEqual(files);
  });

  it('on equal times picks the lower id, counts a time it cannot read as made last, and has none with no design systems', () => {
    const at = '2026-11-09T10:00:00.000Z';
    expect(defaultDesignSystemOf([{ id: 'ocean', markedDefault: true, madeAt: at }, { id: 'brand', markedDefault: true, madeAt: at }])).toBe('brand');
    expect(defaultDesignSystemOf([{ id: 'brand', markedDefault: false, madeAt: 'someday' }, { id: 'ocean', markedDefault: false, madeAt: at }])).toBe('ocean');
    expect(defaultDesignSystemOf([{ id: 'ocean', markedDefault: false, madeAt: at }, { id: 'brand', markedDefault: true, madeAt: '2026-12-01T00:00:00.000Z' }])).toBe('brand');
    expect(defaultDesignSystemOf([])).toBeNull();
    expect(readDefaultDesignSystem(bp)).toBeNull();
    expect(fs.existsSync(bp.studioDir)).toBe(false);
  });

  it('reads a made time typed without quotes the same as squad-kit writes it', () => {
    saveDesignSystem(bp, { name: 'Brand', tokens: {} });
    const file = path.join(designSystemDir(bp, 'brand'), 'system.yaml');
    fs.writeFileSync(file, 'name: Brand\ndefault: true\nversion: 1\nmadeAt: 2026-11-09T10:00:00.000Z\n');
    expect(readDesignSystem(bp, 'brand')!.madeAt).toBe('2026-11-09T10:00:00.000Z');
  });
});

describe('done when 5: a project with no Studio work stays exactly as it was', () => {
  it('opens and reads the Studio with no folder made and every file outside .squad/studio/ untouched', async () => {
    seedDemoBoard(bp, { speed: 1000 });
    const shared = snapshot(bp.squadDir);
    const local = snapshot(bp.localDir);
    const meta = readMeta(bp);
    const tickets = listTickets(bp).length;

    const app = new Hono();
    mountStudioApi(app, { paths: buildPaths(bp.root) });
    const r = await app.request('/api/v1/studio');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ designSystems: [], defaultDesignSystem: null, sketches: [] });
    expect(readStudio(bp)).toEqual({ designSystems: [], defaultDesignSystem: null, sketches: [], broken: [] });
    expect(readDesignSystem(bp, 'brand')).toBeNull();
    expect(readSketch(bp, 'checkout')).toBeNull();

    expect(fs.existsSync(bp.studioDir)).toBe(false);
    expect(fs.existsSync(bp.studioLocalDir)).toBe(false);
    expect(snapshot(bp.squadDir)).toEqual(shared);
    expect(snapshot(bp.localDir)).toEqual(local);
    expect(readMeta(bp)).toEqual(meta);
    expect(listTickets(bp)).toHaveLength(tickets);
    expect(listDecisions(bp).length).toBeGreaterThan(0);
    expect(listReleases(bp).length).toBeGreaterThan(0);
  });
});

describe('a stale save is refused (AB-129.1)', () => {
  it('refuses a second save with an old stamp, with every file on disk byte for byte the same', () => {
    const { sketch } = saveBrandAndCheckout();
    const old = sketch.stamp;
    const newer = saveSketch(bp, { id: 'checkout', name: 'Checkout flow', designSystem: { id: 'brand', version: 1 }, frames: ['desktop'] }, old);
    expect(newer.stamp).not.toBe(old);
    const files = snapshot(bp.studioDir);

    expect(() => saveSketch(bp, { id: 'checkout', name: 'Checkout again', frames: ['desktop', 'mobile'] }, old)).toThrow(CHANGED_ELSEWHERE);
    expect(() => addVariant(bp, 'checkout', 'payment', { frames: { desktop: '<p/>' } }, old)).toThrow(CHANGED_ELSEWHERE);
    expect(snapshot(bp.studioDir)).toEqual(files);
    expect(readSketch(bp, 'checkout')!.name).toBe('Checkout flow');
  });

  it('refuses a variant pick with an old stamp the same way', () => {
    const { sketch } = saveBrandAndCheckout();
    const two = addVariant(bp, 'checkout', 'payment', { frames: { desktop: '<main>B</main>\n' } }, sketch.stamp);
    expect(two.screens[0]!.chosen).toBe(1);
    const files = snapshot(bp.studioDir);
    expect(() => pickVariant(bp, 'checkout', 'payment', 2, sketch.stamp)).toThrow(CHANGED_ELSEWHERE);
    expect(snapshot(bp.studioDir)).toEqual(files);
    expect(readSketch(bp, 'checkout')!.screens[0]!.chosen).toBe(1);
  });

  it('refuses a brand-new item whose id is taken, a design system save with an old stamp, and an old stamp at the shared check', () => {
    const { brand } = saveBrandAndCheckout();
    const files = snapshot(bp.studioDir);
    expect(() => saveDesignSystem(bp, { name: 'Brand', tokens: {} })).toThrow(/already has a design system called "brand"/);
    expect(() => saveSketch(bp, { name: 'Checkout', frames: ['desktop'] })).toThrow(/already has a sketch called "checkout"/);
    const v2 = saveDesignSystem(bp, { id: 'brand', name: 'Brand', tokens: { colors: {} } }, brand.stamp);
    expect(() => saveDesignSystem(bp, { id: 'brand', name: 'Brand', tokens: { colors: { a: 1 } } }, brand.stamp)).toThrow(CHANGED_ELSEWHERE);
    // The check a later delete uses.
    expect(() => checkStudioStamp(bp, { kind: 'design-system', id: 'brand' }, brand.stamp)).toThrow(CHANGED_ELSEWHERE);
    expect(() => checkStudioStamp(bp, { kind: 'design-system', id: 'brand' }, v2.stamp)).not.toThrow();
    expect(() => checkStudioStamp(bp, { kind: 'sketch', id: 'gone' }, 'abc')).toThrow(CHANGED_ELSEWHERE);
    expect(Object.keys(snapshot(bp.studioDir)).filter((f) => !(f in files))).toEqual(['design-systems/brand/v2/components/button.html', 'design-systems/brand/v2/tokens.json']);
  });

  it('refuses a sketch on a design system version the project does not have', () => {
    expect(() => saveSketch(bp, { name: 'Checkout', designSystem: { id: 'brand', version: 1 }, frames: ['desktop'] })).toThrow(/no design system "brand" version 1/);
    expect(fs.existsSync(bp.studioDir)).toBe(false);
  });
});

describe('a symbolic link under .squad/studio/', () => {
  it('is neither read nor counted in the stamp, so a read never leaves the Studio folder', () => {
    const { brand, sketch } = saveBrandAndCheckout();
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.html'), '<p>not the Studio</p>');
    fs.writeFileSync(path.join(outside, 'system.yaml'), 'name: Elsewhere\ndefault: true\nversion: 1\n');
    // A link to a file beside the saved ones, and a link to a whole folder as if it were a design system.
    fs.symlinkSync(path.join(outside, 'secret.html'), path.join(bp.studioDir, 'design-systems/brand/v1/components/secret.html'));
    fs.symlinkSync(path.join(outside, 'secret.html'), path.join(bp.studioDir, 'sketches/checkout/screens/payment/v1/mobile.html'));
    fs.symlinkSync(outside, path.join(bp.studioDir, 'design-systems/elsewhere'));

    const read = readStudio(bp);
    expect(read.designSystems.map((d) => d.id)).toEqual(['brand']);
    expect(read.designSystems[0]!.versions[0]!.components).toEqual({ button: BUTTON });
    expect(read.designSystems[0]!.stamp).toBe(brand.stamp);
    expect(read.sketches[0]!.screens[0]!.variants[0]!.frames).toEqual({ desktop: PAYMENT_DESKTOP });
    expect(read.sketches[0]!.stamp).toBe(sketch.stamp);
    expect(readDesignSystem(bp, 'elsewhere')).toBeNull();
    expect(read.defaultDesignSystem).toBe('brand');
  });
});

describe('a broken Studio file', () => {
  it('is listed as broken, and the rest still reads', () => {
    saveBrandAndCheckout();
    fs.writeFileSync(path.join(bp.studioDir, 'design-systems/brand/system.yaml'), '<<<<<<< ours\nname: A\n=======\nname: B\n>>>>>>> theirs\n');
    const s = readStudio(bp);
    expect(s.designSystems).toEqual([]);
    expect(s.broken).toEqual([{ kind: 'design-system', id: 'brand', problem: expect.stringContaining('could not be read') }]);
    expect(s.sketches.map((x) => x.id)).toEqual(['checkout']);
  });
});
