import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserModule } from '../src/modules/browser/types.js';
import { fakeBrowser, type FakeBrowser } from './fakes/browser.js';
import { tinyApp } from './support/tiny-app.js';
import { callTool, rpc, savedFiles, textOf } from './support/window.js';

/**
 * Two kinds of refusal in the window (RO-8, RO-12 and RO-13, 2026-11-04): those stories stopped with "The Tester kept
 * asking for things it may not do" for harmless shape mistakes by a fast model. A call in the wrong shape is put right
 * where that is safe ("path" for "page", a step's own role and name moved into its target), or answered with the right
 * shape; it never counts toward the stop, and only far too many end the step, in plain words. Safety refusals still
 * stop the agent after three. The calls below are the exact ones from that day's app log.
 */

const h = vi.hoisted(() => ({ browser: null as BrowserModule | null }));
vi.mock('../src/modules/registry.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/registry.js')>()),
  shotBrowser: () => h.browser!,
}));

const { AgentWindow, ALL_TOOLS, MISTAKES_TO_STOP, tooManyMistakesWords, tooManyWords } = await import('../src/engine/window.js');
const { openWindow, closeWindow, windowAccess } = await import('../src/engine/window-server.js');

let tmp: string;
let fake: FakeBrowser;
let lines: string[];
const opened: InstanceType<typeof AgentWindow>[] = [];

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-shapes-')));
  lines = [];
  fake = fakeBrowser({
    '/': { has: ['combobox:People', 'checkbox:Screen', 'textbox:Show availability for date', 'heading:Rooms'] },
    '/app': { has: ['combobox:Booking as', 'combobox:Start', 'combobox:End', 'textbox:Date', 'textbox:Title', 'button:Book'] },
    '/rooms': { has: [] },
  });
  h.browser = fake.module;
});
afterEach(async () => {
  for (const w of opened.splice(0)) await closeWindow(w);
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function tester() {
  const app = await tinyApp();
  const cwd = path.join(tmp, 'copy');
  fs.mkdirSync(cwd, { recursive: true });
  let stopped = 0;
  const w = new AgentWindow({
    ticket: 'RO-12',
    step: 'proof',
    who: 'Tester',
    tools: ALL_TOOLS,
    app: { cwd, start: app.start, url: app.url },
    proofDir: path.join(tmp, 'proof'),
    prefix: 'ro-12-after',
    say: (t) => lines.push(t),
    limits: { appWaitMs: 15_000 },
  });
  w.whenTooMany(() => (stopped += 1));
  openWindow(w);
  opened.push(w);
  return { w, access: await windowAccess(w), stopped: () => stopped };
}

const refused = (a: { isError?: boolean; content: unknown[] }) => a.isError === true && textOf(a as never).startsWith('squad-kit refused this');
const wrongShape = (a: { isError?: boolean; content: unknown[] }) => a.isError === true && textOf(a as never).startsWith('This call is in the wrong shape, so squad-kit did nothing');

describe('a page of a product', () => {
  it('may call the other parts of the product, and only when there are any', async () => {
    const app = await tinyApp();
    const cwd = path.join(tmp, 'copy');
    fs.mkdirSync(cwd, { recursive: true });
    const w = new AgentWindow({
      ticket: 'RO-12',
      step: 'proof',
      who: 'Tester',
      tools: ALL_TOOLS,
      app: { cwd, start: app.start, url: app.url, reach: () => [app.url, 'http://localhost:5180/api', 'https://example.com/'] },
      proofDir: path.join(tmp, 'proof'),
      prefix: 'ro-12-after',
      say: (t) => lines.push(t),
      limits: { appWaitMs: 15_000 },
    });
    openWindow(w);
    opened.push(w);
    const access = await windowAccess(w);
    expect((await callTool(access, 'take_screenshots', { shots: [{ page: '/' }] })).isError).toBeUndefined();
    expect((await callTool(access, 'look_at_page', { page: '/' })).isError).toBeUndefined();
    const own = new URL(app.url).origin;
    expect(fake.also).toEqual([[own, 'http://localhost:5180'], [own, 'http://localhost:5180']]);

    const { access: alone } = await tester();
    await callTool(alone, 'look_at_page', { page: '/' });
    expect(fake.also.at(-1)).toBeUndefined();
  });
});

describe("the exact calls from RO-8, RO-12 and RO-13's log", () => {
  it('look_at_page with "path" instead of "page" is taken as the page, with the same checks', async () => {
    const { w, access } = await tester();
    for (const page of ['/app', '/']) {
      const a = await callTool(access, 'look_at_page', { path: page });
      expect(a.isError, textOf(a)).toBeUndefined();
      expect(textOf(a)).toContain(`The page is at ${page}.`);
    }
    // "url" too, and a page outside the app through it is still refused.
    expect(textOf(await callTool(access, 'look_at_page', { url: '/rooms' }))).toContain('The page is at /rooms.');
    expect(refused(await callTool(access, 'look_at_page', { url: 'https://evil.example.com/' }))).toBe(true);
    expect(w.refusals).toHaveLength(1);
    expect(w.mistakes).toEqual([]);
  });

  it("a step's own role and name go into its target, and the picture is taken", async () => {
    const { w, access } = await tester();
    const a = await callTool(access, 'take_screenshots', {
      shots: [
        {
          page: '/app',
          steps: [
            { action: 'fill', role: 'textbox', name: 'Date', value: '2026-11-16' },
            { action: 'select', role: 'combobox', name: 'Start', value: '10:00' },
            { action: 'select', role: 'combobox', name: 'End', value: '11:00' },
            { action: 'fill', role: 'textbox', name: 'Title', value: 'Sprint review' },
            { action: 'click', role: 'button', name: 'Book' },
            { action: 'wait', ms: 1000 },
          ],
        },
      ],
    });
    expect(a.isError, textOf(a)).toBeUndefined();
    expect(savedFiles(a)).toEqual(['ro-12-after-1.png']);
    expect(fake.log).toEqual(['goto /app', 'fill textbox:Date', 'select combobox:Start', 'select combobox:End', 'fill textbox:Title', 'click button:Book', 'wait']);
    // label, text, placeholder, testId and css on the step go there too.
    const b = await callTool(access, 'take_screenshots', { shots: [{ page: '/', steps: [{ action: 'check', role: 'checkbox', name: 'Screen' }, { action: 'wait', text: 'Rooms' }] }] });
    expect(textOf(b)).toContain('did not work at step 2');
    expect(w.refusals).toEqual([]);
    expect(w.mistakes).toEqual([]);
  });

  it('a shape squad-kit does not guess gets the right shape back, with an example, and is never counted', async () => {
    const { w, access, stopped } = await tester();
    const fill = await callTool(access, 'take_screenshots', { shots: [{ page: '/app', steps: [{ fill: { role: 'textbox', name: 'Title' }, value: 'Sprint review' }] }] });
    expect(wrongShape(fill)).toBe(true);
    expect(textOf(fill)).toContain('step 1 names its action as a field ("fill")');
    expect(textOf(fill)).toContain('{ "action": "fill", "target": { "role": "textbox", "name": "Title" }, "value": "Sprint review" }');
    const waitFor = await callTool(access, 'take_screenshots', { shots: [{ page: '/', steps: [{ action: 'wait', for: 'Rooms' }] }] });
    expect(textOf(waitFor)).toContain('step 1 takes action, target, value, path, key and ms, and got "for"');
    expect(textOf(waitFor)).toContain('Name what to wait for or act on inside "target": { "action": "wait", "target": { "text": "Booked" } }.');
    const reload = await callTool(access, 'take_screenshots', { shots: [{ page: '/', steps: [{ action: 'reload' }] }] });
    expect(wrongShape(reload)).toBe(true);
    const both = await callTool(access, 'look_at_page', { page: '/app', path: '/rooms' });
    expect(textOf(both)).toContain('it got both "page" and "path"');
    const loose = await callTool(access, 'take_screenshots', { shots: [{ page: '/app', steps: [{ action: 'click', target: { role: 'button' }, name: 'Book' }] }] });
    expect(textOf(loose)).toContain('step 1 has a target and also "name" on the step itself');
    const bare = await callTool(access, 'take_screenshots', { page: '/app' });
    expect(textOf(bare)).toContain('it takes only "shots", and got "page"');
    // None of it was done, none of it is a refusal, and the story has no line about it.
    expect(fake.log).toEqual([]);
    expect(w.refusals).toEqual([]);
    expect(w.mistakes).toHaveLength(6);
    expect(stopped()).toBe(0);
    expect(lines.filter((l) => l.includes('refused'))).toEqual([]);
    // Then it gets it right.
    const right = await callTool(access, 'take_screenshots', { shots: [{ page: '/app', steps: [{ action: 'fill', target: { role: 'textbox', name: 'Title' }, value: 'Sprint review' }] }] });
    expect(savedFiles(right)).toHaveLength(1);
  });

  it(`never stops for shape mistakes until more than ${MISTAKES_TO_STOP}, and then ends the step plainly, not with "may not do"`, async () => {
    const { w, access, stopped } = await tester();
    for (let i = 0; i < MISTAKES_TO_STOP; i += 1) expect(wrongShape(await callTool(access, 'look_at_page', { page: '/app', steps: [{ fill: {} }] }))).toBe(true);
    expect(stopped()).toBe(0);
    expect(w.tooManyMistakes).toBe(false);
    const last = await callTool(access, 'look_at_page', { page: '/app', steps: [{ fill: {} }] });
    expect(textOf(last)).toContain(`more than ${MISTAKES_TO_STOP} calls in the wrong shape in this step, so squad-kit ends it now`);
    expect(stopped()).toBe(1);
    expect(w.tooManyMistakes).toBe(true);
    expect(w.tooMany).toBe(false);
    expect(tooManyMistakesWords('Tester')).toBe("The Tester kept using squad-kit's tools the wrong way, so squad-kit ended this step. Press Try again to try once more.");
    expect(lines).toEqual(["The Tester kept calling squad-kit's tools in the wrong shape, so squad-kit ended the step."]);
    expect(w.mistakeDetail().split('\n')).toHaveLength(MISTAKES_TO_STOP + 1);
  });
});

describe('safety refusals still stop the agent after three', () => {
  it('another website, a command, stopping a program squad-kit did not start: counted, with shape mistakes in between not', async () => {
    const { w, access, stopped } = await tester();
    expect(refused(await callTool(access, 'look_at_page', { path: 'https://evil.example.com' }))).toBe(true);
    expect(wrongShape(await callTool(access, 'take_screenshots', { shots: [{ page: '/', steps: [{ action: 'wait', for: 'Rooms' }] }] }))).toBe(true);
    expect(refused(await callTool(access, 'take_screenshots', { shots: [{ page: '/', steps: [{ action: 'click', role: 'button', name: 'Book', script: 'fetch("/x")' }] }] }))).toBe(true);
    expect(wrongShape(await callTool(access, 'look_at_page', { page: '/', foo: 1 }))).toBe(true);
    expect(stopped()).toBe(0);
    const third = await callTool(access, 'stop_app', { pid: 1 });
    expect(textOf(third)).toContain('squad-kit stops you now');
    expect(stopped()).toBe(1);
    expect(w.tooMany).toBe(true);
    expect(tooManyWords('Tester')).toBe('The Tester kept asking for things it may not do, so squad-kit stopped it.');
    expect(w.refusals.map((r) => r.tool)).toEqual(['look_at_page', 'take_screenshots', 'stop_app']);
    expect(lines).toEqual([
      'The Tester asked to open another website. squad-kit refused.',
      'The Tester asked squad-kit to run a command. squad-kit refused.',
      'The Tester asked to stop a program squad-kit did not start. squad-kit refused.',
    ]);
  });

  it('too many pictures is still a refusal', async () => {
    const { w, access } = await tester();
    expect(refused(await callTool(access, 'take_screenshots', { shots: Array.from({ length: 11 }, () => ({ path: '/' })) }))).toBe(true);
    expect(w.refusals).toHaveLength(1);
  });
});

describe('the tools say how to call them', () => {
  it('each description has one example call, and the page field says it is "page"', async () => {
    const { access } = await tester();
    const list = (await rpc(access, 'tools/list')).body.result.tools as { name: string; description: string; inputSchema: { properties?: Record<string, { description?: string; items?: unknown }> } }[];
    for (const t of list) expect(t.description, t.name).toContain('Example: ');
    const look = list.find((t) => t.name === 'look_at_page')!;
    expect(look.inputSchema.properties!.page!.description).toContain('The field is "page" (not "path" or "url")');
    expect(JSON.stringify(look.inputSchema)).toContain('never on the step itself');
    // Every example is a call squad-kit takes as it is.
    const shots = list.find((t) => t.name === 'take_screenshots')!.description.split('Example: ')[1]!;
    expect(JSON.parse(shots)).toMatchObject({ shots: [{ page: '/book', size: 'phone' }] });
  });
});
