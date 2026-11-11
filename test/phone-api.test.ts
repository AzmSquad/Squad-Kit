import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { fakePhone, type FakePhone } from './fakes/phone.js';

/**
 * squad-kit's phones on the board and in the terminal, the same: GET /api/v1/phone and `squad phone` show which of its
 * own devices run and when each shuts down by itself; POST /api/v1/phone/stop and `squad phone stop` shut them down,
 * and only them. On Windows and Linux it says plainly that an iPhone simulator needs a Mac.
 */

const h = vi.hoisted(() => ({ phone: null as FakePhone | null }));
vi.mock('../src/modules/registry.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/registry.js')>()),
  shotPhone: () => h.phone!.module,
}));

const { mountPhoneApi } = await import('../src/console/api/phone.js');
const { phoneWith } = await import('../src/commands/phone.js');
const desk = await import('../src/engine/phone/turn.js');

let tmp: string;
let out: string[];
const THEIRS = { id: 'EEEEEEEE-0000-0000-0000-000000000005', name: 'iPhone 15', state: 'booted' as const, runtime: 'x' };

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-phone-api-')));
  process.env.SQUAD_KIT_HOME = path.join(tmp, 'home');
  h.phone = fakePhone({ devices: [{ ...THEIRS }] });
  out = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => (out.push(String(s)), true));
  desk.resetDesk();
  desk.useDeskHost({ freeBytes: async () => 8 * 1024 ** 3, load: () => 1, cores: () => 10, alive: () => false, sleep: async () => undefined });
});
afterEach(() => {
  desk.resetDesk();
  desk.useDeskHost(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function api() {
  const app = new Hono();
  mountPhoneApi(app);
  return async (method: 'GET' | 'POST', p: string) => {
    const r = await app.request(p, { method });
    return { status: r.status, body: (await r.json()) as any };
  };
}

describe('squad-kit phones, on the board and in the terminal', () => {
  it("GET shows squad-kit's own phones only, running, with when each shuts down by itself", async () => {
    await desk.withPhone(h.phone!.module, 'phone', async () => undefined);
    const r = await api()('GET', '/api/v1/phone');
    expect(r.status).toBe(200);
    expect(r.body.devices).toHaveLength(1);
    expect(r.body.devices[0]).toMatchObject({ size: 'phone', name: 'squad-kit iPhone', model: 'iPhone 18 Pro', runtime: '27.2', state: 'booted', inUse: false, keptUp: false });
    expect(Date.parse(r.body.devices[0].offAt) - Date.parse(r.body.devices[0].lastUsed)).toBe(desk.IDLE_MS);
    expect(r.body.idleMinutes).toBe(10);
    expect(r.body.times).toMatchObject({ build: 300, install: 15, 'first-run': 60 });
  });

  it("POST /phone/stop shuts down squad-kit's own phone, and nobody else's", async () => {
    await desk.withPhone(h.phone!.module, 'phone', async () => undefined);
    const r = await api()('POST', '/api/v1/phone/stop');
    expect(r.body.message).toBe('squad-kit shut down its iPhone.');
    expect(r.body.devices[0].state).toBe('shutdown');
    expect(h.phone!.devices.find((d) => d.id === THEIRS.id)!.state).toBe('booted');
    expect(h.phone!.calls.filter((c) => c.includes(THEIRS.id))).toEqual([]);
    const again = await api()('POST', '/api/v1/phone/stop');
    expect(again.body.message).toBe("squad-kit's phones are not running.");
  });

  it('squad phone and squad phone stop say the same in the terminal', async () => {
    await desk.withPhone(h.phone!.module, 'phone', async () => undefined);
    expect(await phoneWith(null, undefined)).toBe(true);
    const shown = out.join('');
    expect(shown).toContain('squad-kit iPhone');
    expect(shown).toContain('iPhone 18 Pro, iOS 27.2');
    expect(shown).toContain('Shuts down by itself at');
    expect(shown).toContain('squad phone stop');
    out.length = 0;
    expect(await phoneWith(null, 'stop')).toBe(true);
    expect(out.join('')).toContain('shut down');
    await expect(phoneWith(null, 'erase')).rejects.toThrow('squad phone erase: there is no such action. Use squad phone, or squad phone stop.');
  });

  it('on Windows and Linux it says plainly that an iPhone simulator needs a Mac, and touches nothing', async () => {
    h.phone = fakePhone({ notHere: 'An iPhone simulator needs a Mac.' });
    const r = await api()('GET', '/api/v1/phone');
    expect(r.body).toMatchObject({ notHere: 'An iPhone simulator needs a Mac.', devices: [] });
    const stop = await api()('POST', '/api/v1/phone/stop');
    expect(stop.body.message).toBe('An iPhone simulator needs a Mac. There is nothing to stop here.');
    expect(h.phone.calls).toEqual([]);
  });

  it('a phone taking pictures for a story is left, and the answer says so', async () => {
    await desk.withPhone(h.phone!.module, 'phone', async () => undefined);
    let release!: () => void;
    const using = desk.withPhone(h.phone!.module, 'phone', () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 20));
    const r = await api()('POST', '/api/v1/phone/stop');
    expect(r.body.message).toBe("squad-kit's iPhone is taking pictures for a story now. It shuts down by itself when it has been unused for 10 minutes.");
    expect(r.body.devices[0]).toMatchObject({ state: 'booted', inUse: true });
    release();
    await using;
  });
});
