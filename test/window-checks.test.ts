import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserModule } from '../src/modules/browser/types.js';
import { fakeBrowser } from './fakes/browser.js';
import { callTool, rpc, textOf } from './support/window.js';

/**
 * run_checks: the Builder and the Tester ask squad-kit to run the project's own saved tests, lint or build in the
 * story's copy, inside its guard, as a browser cannot start in their own shell. It takes no command: one sent is a
 * safety refusal. Real commands run here; no agent does.
 */

const h = vi.hoisted(() => ({ browser: null as BrowserModule | null }));
vi.mock('../src/modules/registry.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/registry.js')>()),
  shotBrowser: () => h.browser!,
}));

const { AgentWindow, ALL_TOOLS, toolsFor } = await import('../src/engine/window.js');
const { openWindow, closeWindow, windowAccess } = await import('../src/engine/window-server.js');
const P = await import('../src/engine/prompts.js');

type Setup = ConstructorParameters<typeof AgentWindow>[0];

let tmp: string;
let lines: string[];
let logged: string[];
const opened: InstanceType<typeof AgentWindow>[] = [];

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-run-checks-')));
  lines = [];
  logged = [];
  h.browser = fakeBrowser({ '/': { has: [] } }).module;
});

afterEach(async () => {
  for (const w of opened.splice(0)) await closeWindow(w);
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function builder(commands: Partial<Record<'test' | 'lint' | 'build', string>> | (() => Partial<Record<'test' | 'lint' | 'build', string>>), more: Partial<Setup> = {}) {
  const w = new AgentWindow({
    ticket: 'CN-1',
    step: 'build',
    who: 'Builder',
    tools: toolsFor({ app: false, checks: true }),
    checks: { cwd: tmp, commands: typeof commands === 'function' ? commands : () => commands },
    proofDir: path.join(tmp, 'proof'),
    prefix: 'cn-1-builder',
    say: (t) => lines.push(t),
    log: (t) => logged.push(t),
    ...more,
  });
  openWindow(w);
  opened.push(w);
  return { w, access: await windowAccess(w) };
}

describe('the tool', () => {
  it('the Builder and the Tester have it; the Reviewer does not', async () => {
    expect(toolsFor({ app: false, checks: true })).toEqual(['run_checks', 'i_am_stuck']);
    expect(toolsFor({ app: true })).toEqual(ALL_TOOLS);
    expect(ALL_TOOLS).toContain('run_checks');
    expect(toolsFor({ app: false, look: true })).toEqual(['look_at_page', 'i_am_stuck']);
    const { access } = await builder({ test: 'echo ok' });
    const list = await rpc(access, 'tools/list');
    const tool = list.body.result.tools.find((t: { name: string }) => t.name === 'run_checks');
    expect(tool.inputSchema.properties).toEqual({ which: expect.objectContaining({ enum: ['test', 'lint', 'build'] }) });
    expect(tool.description).toContain('takes no command');
  });

  it('runs the saved test command in the copy and gives back pass, with the last lines', async () => {
    fs.writeFileSync(path.join(tmp, 'marker.txt'), 'from the copy\n');
    const { access, w } = await builder({ test: 'cat marker.txt && echo "Tests  2 passed"' });
    const a = await callTool(access, 'run_checks', { which: 'test' });
    expect(a.isError).toBeFalsy();
    expect(textOf(a)).toMatch(/^test: passed in \d+ seconds \(cat marker\.txt && echo "Tests {2}2 passed"\)\./);
    expect(textOf(a)).toContain('from the copy');
    expect(textOf(a)).toContain('Tests  2 passed');
    expect(lines).toEqual(['squad-kit ran the tests for the Builder: passed']);
    // The exact command is for engineers.
    expect(logged.some((l) => l.includes('cat marker.txt'))).toBe(true);
    expect(w.refusals).toEqual([]);
  });

  it('gives back fail with the last lines, as an answer the agent reads, and says so on the story', async () => {
    const { access } = await builder({ test: 'echo "1 failed: sign-up.spec.ts" && exit 1' });
    const a = await callTool(access, 'run_checks', { which: 'test' });
    expect(a.isError).toBeFalsy();
    expect(textOf(a)).toContain('test: failed');
    expect(textOf(a)).toContain('1 failed: sign-up.spec.ts');
    expect(lines).toEqual(['squad-kit ran the tests for the Builder: did not pass']);
  });

  it('with no field it runs every saved check, one after another, and says when tests found nothing', async () => {
    const { access } = await builder({ test: 'echo "0 passing"', lint: 'echo tidy', build: 'exit 2' });
    const said = textOf(await callTool(access, 'run_checks', {}));
    expect(said).toContain('test: passed, but it found no tests');
    expect(said).toContain('lint: passed');
    expect(said).toContain('build: failed');
    expect(lines).toHaveLength(3);
  });

  it('has nothing to run yet: it says how the Builder gets there', async () => {
    const { access } = await builder({});
    const said = textOf(await callTool(access, 'run_checks', { which: 'test' }));
    expect(said).toContain('The project has no saved test command yet');
    expect(said).toContain('squad-kit finds it there');
    const none = await builder(() => ({ lint: 'echo tidy' }));
    expect(textOf(await callTool(none.access, 'run_checks', { which: 'build' }))).toContain('no saved build command');
  });

  it('reads the saved commands at each call: never one sent by the agent', async () => {
    let saved: Record<string, string> = {};
    const { access } = await builder(() => saved);
    expect(textOf(await callTool(access, 'run_checks', {}))).toContain('no saved');
    saved = { test: 'echo "Tests  1 passed"' };
    expect(textOf(await callTool(access, 'run_checks', {}))).toContain('test: passed');
  });

  it('a slow run goes on in the background: the call answers in time, and the next one gets the result without starting it twice', async () => {
    const count = path.join(tmp, 'count');
    const { access } = await builder({ test: `echo run >> "${count}"; sleep 1; echo "Tests  3 passed"` }, { limits: { callMs: 200 } });
    const first = textOf(await callTool(access, 'run_checks', { which: 'test' }));
    expect(first).toContain('still running');
    await new Promise((r) => setTimeout(r, 1500));
    const second = textOf(await callTool(access, 'run_checks', { which: 'test' }));
    expect(second).toContain('test: passed');
    expect(fs.readFileSync(count, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('a Stop ends what runs', async () => {
    const stop = new AbortController();
    const { access } = await builder({ test: 'sleep 30' }, { signal: stop.signal });
    const call = callTool(access, 'run_checks', { which: 'test' });
    await new Promise((r) => setTimeout(r, 300));
    stop.abort();
    const a = await call;
    expect(a.isError).toBe(true);
    expect(textOf(a)).toContain('You were stopped');
  });
});

describe('it takes no command', () => {
  for (const field of ['command', 'cmd', 'script', 'shell', 'exec', 'bash']) {
    it(`"${field}" is a safety refusal, says so plainly, and runs nothing`, async () => {
      const marker = path.join(tmp, 'ran');
      const { access, w } = await builder({ test: `touch "${marker}"` });
      const a = await callTool(access, 'run_checks', { [field]: `touch "${marker}"` });
      expect(a.isError).toBe(true);
      expect(textOf(a)).toContain('squad-kit refused this');
      expect(w.refusals).toHaveLength(1);
      expect(lines).toContain('The Builder asked squad-kit to run a command. squad-kit refused.');
      expect(fs.existsSync(marker)).toBe(false);
    });
  }

  it('three refusals stop the agent, as for every other tool', async () => {
    const { access, w } = await builder({ test: 'echo ok' });
    for (let i = 0; i < 3; i += 1) await callTool(access, 'run_checks', { command: 'npm test' });
    expect(w.tooMany).toBe(true);
    expect(textOf(await callTool(access, 'run_checks', {}))).toContain('stopped you after 3 refused requests');
  });

  it('another field, or a wrong "which", is a mistake in the shape, not a refusal', async () => {
    const { access, w } = await builder({ test: 'echo ok' });
    expect(textOf(await callTool(access, 'run_checks', { which: 'e2e' }))).toContain('which is "test", "lint" or "build"');
    expect(textOf(await callTool(access, 'run_checks', { only: 'test' }))).toContain('run_checks takes only "which"');
    expect(w.refusals).toEqual([]);
    expect(w.mistakes).toHaveLength(2);
  });
});

describe('what the agents are told', () => {
  const t = { id: 'CN-1', title: 'x', story: 'As staff, I want x.', criteria: [], steps: [] } as never;
  const meta = { project: 'x', map: [], lessons: [], commands: {} } as never;

  it('the Builder uses it for browser tests, instead of running them itself', () => {
    const build = P.buildPrompt(meta, [], t);
    expect(build).toContain("run tests that open a browser with squad-kit's run_checks tool, never yourself");
    const rule = P.windowRule(toolsFor({ app: false, checks: true }));
    expect(rule).toContain("run_checks (the project's own saved tests, lint and build");
    expect(rule).toContain('A browser cannot start in your shell');
    expect(P.windowRule(ALL_TOOLS)).toContain('run_checks');
    expect(P.windowRule(['look_at_page', 'i_am_stuck'])).not.toContain('run_checks');
    expect(P.windowRule(['i_am_stuck'])).toContain('squad-kit gives you tools of its own in this step: i_am_stuck.');
  });

  it('the Tester knows it is there', () => {
    expect(P.proofPrompt(meta, { ...(t as object), proof: [] } as never, 'after', undefined, 'http://localhost:3000')).toContain('run_checks');
  });
});
