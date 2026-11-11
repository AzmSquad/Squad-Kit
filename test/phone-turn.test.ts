import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakePhone, type FakePhone } from './fakes/phone.js';
import type { DeskHost } from '../src/engine/phone/turn.js';

/**
 * One phone at a time, gently: squad-kit's phone is shared through a queue (and a lock between squad-kits), only one
 * of its own devices runs, a busy computer is waited for and said so, an unused phone shuts down after 10 minutes, and
 * a device something else keeps open is left alone. Nobody else's simulator is ever shut down.
 */

const desk = await import('../src/engine/phone/turn.js');
const { ownDevice, phonesHome } = await import('../src/engine/phone/devices.js');
const { stepSeconds } = await import('../src/engine/phone/times.js');

let tmp: string;
let free: number;
let load: number;
let alive: Set<number>;
let slept: number[];
let lines: string[];

function host(over: Partial<DeskHost> = {}): DeskHost {
  return {
    freeBytes: async () => free,
    load: () => load,
    cores: () => 10,
    alive: (pid) => pid === process.pid || alive.has(pid),
    sleep: async (ms) => {
      slept.push(ms);
    },
    ...over,
  };
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-phone-turn-')));
  process.env.SQUAD_KIT_HOME = path.join(tmp, 'home');
  free = 8 * 1024 ** 3;
  load = 2;
  alive = new Set();
  slept = [];
  lines = [];
  desk.resetDesk();
  desk.useDeskHost(host());
});
afterEach(() => {
  desk.resetDesk();
  desk.useDeskHost(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const say = (t: string) => lines.push(t);
const states = (f: FakePhone) => Object.fromEntries(f.devices.map((d) => [d.name, d.state]));

describe('one phone at a time', () => {
  it('boots squad-kit\'s iPhone hidden for a turn, says it with its usual time, and keeps the boot time', async () => {
    const f = fakePhone();
    const r = await desk.withPhone(f.module, 'phone', async (t) => ({ fresh: t.fresh, model: t.device.model }), { say });
    expect(r).toEqual({ fresh: true, model: 'iPhone 18 Pro' });
    expect(lines).toEqual(["Starting squad-kit's iPhone, about a minute"]);
    expect(f.calls.filter((c) => c.startsWith('boot'))).toHaveLength(1);
    // The time it took is kept for the next guess, in the tools' times.
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'home', 'tools', 'times.json'), 'utf8'))).toHaveProperty('iphone-boot');
    expect(stepSeconds('boot')).toBeGreaterThanOrEqual(1);
    // Up already: the next turn does not boot it again.
    const again = await desk.withPhone(f.module, 'phone', async (t) => t.fresh, { say });
    expect(again).toBe(false);
    expect(f.calls.filter((c) => c.startsWith('boot'))).toHaveLength(1);
  });

  it('runs one turn at a time, in order, however many stories ask at once', async () => {
    const f = fakePhone();
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const first = desk.withPhone(f.module, 'phone', async () => {
      order.push('first starts');
      await held;
      order.push('first ends');
    });
    const second = desk.withPhone(f.module, 'phone', async () => {
      order.push('second starts');
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual(['first starts']);
    expect(desk.phoneInUse()).toBe(true);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first starts', 'first ends', 'second starts']);
  });

  it('only one of its own phones runs: the iPad shuts down before the iPhone starts, and nobody else\'s is touched', async () => {
    const theirs = { id: 'BBBBBBBB-0000-0000-0000-000000000002', name: 'iPhone 15 (theirs)', state: 'booted' as const, runtime: 'x' };
    const named = { id: 'CCCCCCCC-0000-0000-0000-000000000003', name: 'squad-kit iPhone', state: 'booted' as const, runtime: 'x' };
    const f = fakePhone({ devices: [theirs, named] });
    await desk.withPhone(f.module, 'tablet', async () => undefined);
    await desk.withPhone(f.module, 'phone', async () => undefined);
    const ipad = f.devices.find((d) => d.name === 'squad-kit iPad')!;
    const iphone = f.devices.find((d) => d.name === 'squad-kit iPhone' && d.id !== named.id)!;
    expect(ipad.state).toBe('shutdown');
    expect(iphone.state).toBe('booted');
    // Somebody else's devices, even one with squad-kit's name, are never started, stopped or changed.
    expect(f.calls.filter((c) => c.includes(theirs.id) || c.includes(named.id))).toEqual([]);
    expect(theirs.state).toBe('booted');
    expect(named.state).toBe('booted');
  });

  it('waits while the computer is busy, says so plainly once, and starts the iPhone once there is room', async () => {
    const f = fakePhone();
    let looks = 0;
    desk.useDeskHost(host({ freeBytes: async () => (looks++ < 3 ? 1 * 1024 ** 3 : 8 * 1024 ** 3) }));
    const fresh = await desk.withPhone(f.module, 'phone', async (t) => t.fresh, { say });
    expect(fresh).toBe(true);
    expect(lines).toEqual(['The computer is busy. squad-kit waits a moment before starting the iPhone.', "Starting squad-kit's iPhone, about a minute"]);
    expect(slept.filter((ms) => ms === desk.BUSY_LOOK_MS).length).toBe(3);
  });

  it('a high load is busy too; after the longest wait it goes ahead, as a story never fails over it', async () => {
    const f = fakePhone();
    load = 40;
    expect(await desk.tooBusy()).toBe('load 40.0 on 10 cores');
    const logs: string[] = [];
    await desk.withPhone(f.module, 'phone', async () => undefined, { say, log: (t) => logs.push(t) });
    expect(lines[0]).toBe('The computer is busy. squad-kit waits a moment before starting the iPhone.');
    expect(slept.filter((ms) => ms === desk.BUSY_LOOK_MS).length).toBe(Math.ceil(desk.BUSY_WAIT_MS / desk.BUSY_LOOK_MS));
    expect(logs.some((l) => l.includes('boots its iPhone anyway'))).toBe(true);
    expect(f.devices[0]!.state).toBe('booted');
    expect(desk.freeMemoryOf('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:      4707.\nPages active:  272303.\nPages inactive:  271008.\nPages speculative:  557.\n')).toBe((4707 + 271008 + 557) * 16384);
  });

  it('waits its turn while another squad-kit on this computer holds the phone, and says so once', async () => {
    const f = fakePhone();
    const other = 999_991;
    alive.add(other);
    fs.mkdirSync(phonesHome(), { recursive: true });
    fs.writeFileSync(path.join(phonesHome(), 'lock.json'), JSON.stringify({ pid: other, at: new Date().toISOString() }));
    let looks = 0;
    desk.useDeskHost(host({ sleep: async (ms) => void (slept.push(ms), ++looks === 3 && alive.delete(other)) }));
    await desk.withPhone(f.module, 'phone', async () => undefined, { say });
    expect(lines[0]).toBe('Another squad-kit on this computer is using the iPhone. squad-kit waits for its turn.');
    expect(lines.filter((l) => l.startsWith('Another squad-kit'))).toHaveLength(1);
    // Its own lock is gone after the turn.
    expect(fs.existsSync(path.join(phonesHome(), 'lock.json'))).toBe(false);
  });
});

describe('shutting down', () => {
  it('an iPhone unused for 10 minutes shuts down; one used just now stays up', async () => {
    const f = fakePhone();
    await desk.withPhone(f.module, 'phone', async () => undefined);
    expect(await desk.idleNow(f.module, Date.now() + 60_000)).toEqual([]);
    expect(f.devices[0]!.state).toBe('booted');
    const down = await desk.idleNow(f.module, Date.now() + desk.IDLE_MS + 1000);
    expect(down).toEqual([f.devices[0]!.id]);
    expect(f.devices[0]!.state).toBe('shutdown');
  });

  it('when the board stops, its own phone shuts down; one in use is left and said so', async () => {
    const f = fakePhone();
    await desk.withPhone(f.module, 'phone', async () => undefined);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const using = desk.withPhone(f.module, 'phone', () => held);
    await new Promise((r) => setTimeout(r, 20));
    expect(await desk.stopPhones(f.module)).toEqual({ stopped: [], left: [], busy: true });
    release();
    await using;
    const id = f.devices[0]!.id;
    expect(await desk.stopPhones(f.module)).toEqual({ stopped: [id], left: [], busy: false });
    expect(states(f)).toEqual({ 'squad-kit iPhone': 'shutdown' });
  });

  it('a phone something else keeps open (a Simulator window starts it again) is left, and never fought', async () => {
    const f = fakePhone();
    const logs: string[] = [];
    const dev = await ownDevice(f.module, 'phone');
    await desk.withPhone(f.module, 'phone', async () => undefined);
    f.keepUp.add(dev.id);
    expect(await desk.shutDownGently(f.module, dev.id, (t) => logs.push(t))).toBe(false);
    expect(desk.keptUp(dev.id)).toBe(true);
    expect(logs[0]).toContain('something else started it again');
    // From now on squad-kit leaves it: no second shutdown, at the board's stop or when idle.
    expect(await desk.stopPhones(f.module)).toEqual({ stopped: [], left: [dev.id], busy: false });
    await desk.idleNow(f.module, Date.now() + desk.IDLE_MS * 2);
    expect(f.calls.filter((c) => c === `shutdown ${dev.id}`)).toHaveLength(1);
    // The next turn uses it as it is.
    expect(await desk.withPhone(f.module, 'phone', async (t) => t.fresh)).toBe(false);
  });

  it('on a computer where squad-kit never made a phone, the board stops without looking at any simulator', async () => {
    const f = fakePhone({ devices: [{ id: 'DDDDDDDD-0000-0000-0000-000000000004', name: 'Theirs', state: 'booted', runtime: 'x' }] });
    expect(await desk.stopPhones(f.module)).toEqual({ stopped: [], left: [], busy: false });
    expect(f.calls).toEqual([]);
  });
});
