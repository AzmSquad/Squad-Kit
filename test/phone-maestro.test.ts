import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { BrowserStep } from '../src/modules/browser/types.js';

/**
 * Maestro behind squad-kit's tapping interface, with a made-up Maestro: no Java, no phone. One Maestro in its MCP mode
 * per phone, its usage numbers off and its home folder in squad-kit's own; each step of the Tester becomes one
 * Maestro command, said back in the same plain words as the browser's when it does not work.
 */

const { openMaestro, screenWords, partsOf, exactly, failureOf, stopChild } = await import('../src/modules/maestro/index.js');
const { spawn } = await import('node:child_process');
const { failureWords } = await import('../src/engine/shots.js');

/** The screen as Maestro read it on the sample app (measured 2026-11-11): a title and a button both say "Sign up". */
const SIGN_UP = JSON.stringify({
  ui_schema: { platform: 'ios' },
  elements: [
    {
      b: '[0,0][402,874]',
      a11y: 'Sample App',
      c: [
        { b: '[166,76][235,104]', a11y: 'Sign up' },
        { b: '[24,142][378,198]', a11y: 'Name', txt: 'Sara', val: 'Sara' },
        { b: '[24,210][378,266]', a11y: 'Email' },
        { b: '[24,290][378,338]', a11y: 'Sign up' },
        { b: '[0,538][402,583]', rid: 'SystemInputAssistantView', c: [{ b: '[0,538][134,583]', a11y: 'So' }] },
        { b: '[0,583][402,816]', rid: 'UIKeyboardLayoutStar Preview', c: [{ b: '[0,590][40,636]', a11y: 'q' }] },
        { b: '[56,22][91,42]', a11y: '1:48 AM' },
        { b: '[339,26][366,39]', a11y: '100% battery power', txt: 'Not charging' },
      ],
    },
  ],
});

interface Fake {
  args: string[];
  env: NodeJS.ProcessEnv;
  /** The inline flows Maestro was asked to run. */
  flows: string[];
  stopped: boolean;
  /** What `run` answers to a flow; ok by default. */
  answer: (yaml: string) => { isError?: boolean; text: string };
  screen: string;
}

function fakeMaestro(f: Fake) {
  return (binary: string, args: string[], env: NodeJS.ProcessEnv) => {
    f.args = args;
    f.env = env;
    const child = new EventEmitter() as ChildProcess;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    Object.assign(child, { stdin, stdout, stderr: new PassThrough(), pid: 4242, exitCode: null });
    let buf = '';
    stdin.on('data', (d: Buffer) => {
      buf += d.toString();
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const m = JSON.parse(buf.slice(0, i)) as { id?: number; method: string; params?: { name?: string; arguments?: { yaml?: string; device_id?: string } } };
        buf = buf.slice(i + 1);
        if (m.id === undefined) continue;
        let result: unknown = {};
        if (m.method === 'initialize') result = { serverInfo: { name: 'maestro', version: '1.0.0' } };
        if (m.method === 'tools/call' && m.params?.name === 'inspect_screen') result = { content: [{ type: 'text', text: f.screen }] };
        if (m.method === 'tools/call' && m.params?.name === 'run') {
          f.flows.push(m.params.arguments!.yaml!);
          const a = f.answer(m.params.arguments!.yaml!);
          result = { content: [{ type: 'text', text: a.text }], ...(a.isError ? { isError: true } : {}) };
        }
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, result })}\n`);
      }
    });
    return {
      child,
      stop: () => {
        f.stopped = true;
      },
    };
  };
}

let tmp: string;
let binary: string;
let f: Fake;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-maestro-')));
  binary = path.join(tmp, 'maestro');
  fs.writeFileSync(binary, '');
  f = { args: [], env: {}, flows: [], stopped: false, answer: () => ({ text: '{"success":true}' }), screen: SIGN_UP };
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const DEVICE = '5527D1B5-EBE4-4BFE-A20C-E6875652FD56';
const open = (javaHome?: string) => openMaestro({ device: DEVICE, binary, dir: path.join(tmp, 'phones', 'maestro'), ...(javaHome ? { javaHome } : {}) }, fakeMaestro(f));
const step = (s: BrowserStep) => s;
/** A flow's commands, without the app's header. */
const body = (yaml: string) => yaml.split('---\n')[1];

describe('Maestro, one per phone', () => {
  it('starts in its MCP mode with no viewer, its usage numbers off, and its home folder in squad-kit\'s own', async () => {
    const d = await open('/sk/tools/java/21/Contents/Home');
    expect(f.args).toEqual(['mcp', '--no-viewer', '--working-dir', path.join(tmp, 'phones', 'maestro')]);
    expect(f.env.MAESTRO_CLI_NO_ANALYTICS).toBe('1');
    expect(f.env.MAESTRO_OPTS).toContain(`-Duser.home=${path.join(tmp, 'phones', 'maestro', 'home')}`);
    expect(f.env.JAVA_HOME).toBe('/sk/tools/java/21/Contents/Home');
    expect(d.alive).toBe(true);
    await d.close();
    expect(f.stopped).toBe(true);
  });

  it("each step becomes Maestro's own command on the app, after the app's header", async () => {
    const d = await open();
    await d.act('dev.test.app', step({ action: 'fill', target: { label: 'Name' }, value: 'Sara' }), 3000);
    await d.act('dev.test.app', step({ action: 'click', target: { role: 'button', name: 'Sign up' } }), 3000);
    await d.act('dev.test.app', step({ action: 'click', target: { text: 'Sign up' } }), 3000);
    await d.act('dev.test.app', step({ action: 'press', key: 'Escape' }), 3000);
    await d.act('dev.test.app', step({ action: 'press', key: 'Enter' }), 3000);
    await d.act('dev.test.app', step({ action: 'press', key: 'a' }), 3000);
    await d.act('dev.test.app', step({ action: 'hover', target: { text: 'Room C' } }), 3000);
    await d.act('dev.test.app', step({ action: 'wait', target: { text: 'Email' } }), 3000);
    expect(f.flows.every((y) => y.startsWith('appId: "dev.test.app"\n---\n'))).toBe(true);
    expect(f.flows.map(body)).toEqual([
      // The field holds "Sara": only its own letters are cleared.
      '- tapOn:\n    text: "Name"\n- eraseText: 6\n- inputText: "Sara"',
      // Two parts say "Sign up": a button is the lower one, the screen's title is above it.
      '- tapOn:\n    text: "Sign up"\n    index: 1',
      '- tapOn:\n    text: "Sign up"',
      '- hideKeyboard',
      '- pressKey: Enter',
      '- inputText: "a"',
      '- scrollUntilVisible:\n    element:\n      text: ".*Room C.*"\n    direction: DOWN\n    timeout: 3000',
    ]);
    expect(exactly('Total (SAR) 1.5*')).toBe('Total \\(SAR\\) 1\\.5\\*');
  });

  it('a part not on the screen fails fast, in the same plain words as the browser', async () => {
    const d = await open();
    const t0 = Date.now();
    const err = await d.act('dev.test.app', step({ action: 'click', target: { role: 'button', name: 'Save' } }), 600).catch((e: unknown) => e);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(failureWords({ action: 'click', target: { role: 'button', name: 'Save' } }, err)).toEqual({ why: 'no button named "Save" on the page', plain: 'squad-kit could not find the button "Save" on the screen.' });
    // The keyboard was up and might have covered it: it went away once, then squad-kit looked again.
    expect(f.flows.map(body)).toEqual(['- hideKeyboard']);
  });

  it("Maestro's own errors become the reasons squad-kit puts in words; css and keys a phone lacks are said plainly", async () => {
    f.answer = () => ({ isError: true, text: 'Failed to run flow: Element not found: Text matching regex: Email' });
    const d = await open();
    const missing = await d.act('dev.test.app', step({ action: 'click', target: { text: 'Email' } }), 2000).catch((e: unknown) => e);
    expect(failureWords({ action: 'click', target: { text: 'Email' } }, missing).plain).toBe('squad-kit could not find the words "Email" on the screen.');
    expect(failureOf('Failed to run flow: App crashed or stopped').kind).toBe('closed');
    expect(failureOf('Failed to run flow: Timeout waiting').kind).toBe('timeout');
    await expect(d.act('dev.test.app', step({ action: 'click', target: { css: '#save' } }), 500)).rejects.toThrow('a phone screen has no css');
    await expect(d.act('dev.test.app', step({ action: 'press', key: 'ArrowUp' }), 500)).rejects.toThrow('a phone has no ArrowUp key');
  });

  it('reads the screen as text, one part a line: no clock or battery, no keyboard keys, with what a field holds', async () => {
    const d = await open();
    expect(await d.screenText(2000)).toBe(['- "Sign up"', '- "Name" showing "Sara"', '- "Email"', '- "Sign up"', '- (the keyboard is open)'].join('\n'));
    expect(partsOf('not json')).toEqual({ parts: [], keyboard: false, keys: [] });
    expect(screenWords(JSON.stringify({ elements: [{ b: '[0,118][402,182]', a11y: 'أهلاً Sara' }] }))).toBe('- "أهلاً Sara"');
  });

  it('a Maestro that cannot start is said plainly, with its own words kept for engineers', async () => {
    fs.rmSync(binary);
    await expect(open()).rejects.toThrow("squad-kit could not find Maestro, which taps through the app.");
  });
});

describe('Maestro, only what is needed', () => {
  it('an empty field is not cleared, and Escape with no keyboard up does nothing', async () => {
    f.screen = JSON.stringify({ elements: [{ b: '[0,0][402,874]', c: [{ b: '[24,142][378,198]', a11y: 'Name' }, { b: '[24,290][378,338]', a11y: 'Sign up' }] }] });
    const d = await open();
    await d.act('dev.test.app', step({ action: 'fill', target: { label: 'Name' }, value: 'Sara' }), 3000);
    await d.act('dev.test.app', step({ action: 'press', key: 'Escape' }), 3000);
    expect(f.flows.map(body)).toEqual(['- tapOn:\n    text: "Name"\n- inputText: "Sara"']);
  });

  it('a part the keyboard covers: the keyboard goes away first, then the tap', async () => {
    let hidden = false;
    const covered = JSON.stringify({ elements: [{ b: '[0,0][402,874]', c: [{ b: '[24,142][378,198]', a11y: 'Name' }, { b: '[0,583][402,816]', rid: 'UIKeyboardLayoutStar Preview' }, { b: '[24,700][378,750]', a11y: 'Save' }] }] });
    const open2 = JSON.stringify({ elements: [{ b: '[0,0][402,874]', c: [{ b: '[24,142][378,198]', a11y: 'Name' }, { b: '[24,700][378,750]', a11y: 'Save' }] }] });
    f.screen = covered;
    f.answer = (yaml) => {
      if (yaml.includes('hideKeyboard')) {
        hidden = true;
        f.screen = open2;
      }
      return { text: '{"success":true}' };
    };
    const d = await open();
    await d.act('dev.test.app', step({ action: 'click', target: { role: 'button', name: 'Save' } }), 3000);
    expect(hidden).toBe(true);
    expect(f.flows.map(body)).toEqual(['- hideKeyboard', '- tapOn:\n    text: "Save"']);
  });
});

describe('Maestro on Android', () => {
  // The screen of the sample app on squad-kit's Android phone, as Maestro read it (the spike, 2026-11-11): pixels,
  // Android's status bar and navigation, and Gboard open with its suggestions for the name just typed.
  const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
  const TYPED = fixture('maestro-android-typed.json');

  it("reads Android's screen by its own rules: no status bar, no keyboard or its suggestions, a field's label with its text", () => {
    expect(screenWords(TYPED)).toBe(['- "Sign up"', '- "Name" showing "Sara"', '- "Email"', '- "Sign up"', '- (the keyboard is open)'].join('\n'));
    const seen = partsOf(TYPED);
    // The keyboard's own words are kept apart: its suggestion strip repeats the name just typed.
    expect(seen.keys.map((k) => k.words)).toContain('Sara');
    expect(seen.parts.some((p) => /AM|battery|T-Mobile|notification|Back/.test(p.words))).toBe(false);
    // Sizes are pixels: the button sits far below where an iPhone's points would put it.
    expect(seen.parts.at(-1)).toMatchObject({ words: 'Sign up', top: 741, bottom: 867 });
    expect(screenWords(fixture('maestro-android-welcome-ar.json'))).toContain('أهلاً Sara');
    expect(partsOf(fixture('maestro-android-welcome-ar.json')).keyboard).toBe(false);
  });

  it('a step whose words the keyboard also shows puts the keyboard away first; another one taps at once', async () => {
    const closed = JSON.stringify({ elements: [{ b: '[0,0][1080,2424]', cls: 'android.widget.FrameLayout', c: [{ b: '[63,352][1017,499]', cls: 'android.widget.EditText', hint: 'Name', txt: 'Sara' }, { b: '[63,741][1017,867]', cls: 'android.widget.Button', a11y: 'Sign up' }] }] });
    f.screen = TYPED;
    f.answer = (yaml) => {
      if (yaml.includes('hideKeyboard')) f.screen = closed;
      return { text: '{"success":true}' };
    };
    const d = await open();
    await d.act('dev.test.app', step({ action: 'click', target: { label: 'Email' } }), 3000);
    expect(f.flows.map(body)).toEqual(['- tapOn:\n    text: "Email"']);
    f.flows = [];
    await d.act('dev.test.app', step({ action: 'click', target: { text: 'Sara' } }), 3000);
    expect(f.flows.map(body)).toEqual(['- hideKeyboard', '- tapOn:\n    text: "Sara"']);
  });

  it("fill on Android replaces a field's text, and Escape with no keyboard up does nothing (Back would leave the screen)", async () => {
    f.screen = JSON.stringify({ elements: [{ b: '[0,0][1080,2424]', cls: 'android.widget.FrameLayout', c: [{ b: '[63,352][1017,499]', cls: 'android.widget.EditText', hint: 'Name', txt: 'Sara' }] }] });
    const d = await open();
    await d.act('dev.test.app', step({ action: 'fill', target: { label: 'Name' }, value: 'Huda' }), 3000);
    await d.act('dev.test.app', step({ action: 'press', key: 'Escape' }), 3000);
    expect(f.flows.map(body)).toEqual(['- tapOn:\n    text: "Name"\n- eraseText: 6\n- inputText: "Huda"']);
  });

  it("Maestro's advert box stays off, and the phone's own environment is passed on", async () => {
    await openMaestro({ device: 'emulator-5560', binary, dir: path.join(tmp, 'phones', 'maestro'), env: { ANDROID_HOME: '/sk/sdk', HOME: '/sk/phones/android' } }, fakeMaestro(f));
    expect(f.env.MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED).toBe('true');
    expect(f.env.ANDROID_HOME).toBe('/sk/sdk');
    expect(f.env.HOME).toBe('/sk/phones/android');
  });
});

describe("Maestro's own stop", () => {
  it('asks its whole group to end, kills one that stays, and ends only once it has ended', async () => {
    // A Java that ignores the request to end, like one stuck in its own shutdown.
    const child = spawn('/bin/sh', ['-c', 'trap "" TERM; while :; do sleep 0.2; done'], { detached: true, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    await stopChild(child);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2500);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(() => process.kill(child.pid!, 0)).toThrow();
    // One that has ended already: nothing to wait for.
    const t1 = Date.now();
    await stopChild(child);
    expect(Date.now() - t1).toBeLessThan(100);
  }, 15_000);
});
