import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import type { BrowserModule } from '../src/modules/browser/types.js';
import { tinyApp } from './support/tiny-app.js';
import { fakeBrowser } from './fakes/browser.js';
import { callTool, rpc, textOf } from './support/window.js';

/**
 * The Reviewer can look at the story's pages (RO-15: "I could not open the page at 390 wide"): read only, through
 * squad-kit's own browser. squad-kit starts the app for it and stops it after. It takes no pictures and cannot start or
 * stop the app itself, and the window's checks hold. What the app changes in the story's copy goes back.
 */

let reviewer: (opts: RunOptions) => Promise<unknown> = async () => ({ approved: true, summary: 'Fine', comments: [] });
let appTouches = '';
const seen: RunOptions[] = [];
const h = vi.hoisted(() => ({ browser: null as BrowserModule | null }));

vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    seen.push(opts);
    return { ok: true, structured: await reviewer(opts), text: '', sessionId: opts.resume ?? opts.sessionId ?? 's-1' } as RunResult;
  },
}));
vi.mock('../src/modules/registry.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/registry.js')>()),
  shotBrowser: () => h.browser!,
}));

const { boardPaths, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { addWorktree } = await import('../src/engine/git.js');
const { openWindows } = await import('../src/engine/window-server.js');
const P = await import('../src/engine/prompts.js');

type Squad = { review(id: string): Promise<void> };

let tmp: string;
let project: string;
let bp: ReturnType<typeof boardPaths>;

beforeEach(async () => {
  seen.length = 0;
  appTouches = '';
  reviewer = async () => ({ approved: true, summary: 'Fine', comments: [] });
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-look-')));
  project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'data.txt'), 'as it was\n');
  execSync('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm start', { cwd: project });
  bp = boardPaths(path.join(project, '.squad'));
  const app = await tinyApp();
  writeMeta(bp, {
    project: 'App',
    key: 'RO',
    nextNumber: 15,
    engine: 'live',
    runner: 'direct',
    user: { name: 'Momen', role: 'Project manager' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
    commands: { start: app.start, url: app.url },
    git: { base: 'main', remote: 'origin' },
    scan: { status: 'done', empty: false },
  });
  h.browser = fakeBrowser({ '/rooms': { has: ['button:Book'], snapshot: '- heading "Rooms"\n- button "Book"' } }).module;
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function story(): string {
  const t0 = actions.createTicket(bp, { title: 'Rooms on a phone' });
  const wt = addWorktree(project, t0.id, 'main');
  updateTicket(bp, t0.id, (x) => {
    x.worktree = wt.dir;
    x.branch = wt.branch;
    x.baseCommit = wt.baseCommit;
    x.stage = 'review';
    x.live = true;
    x.squad = null;
    x.story = 'As a clerk, I want rooms on my phone.';
    x.criteria = [{ given: 'a phone', when: 'I open rooms', then: 'it fits' }];
    x.gates = { checks: 'pass', review: 'pending', proof: 'pending' };
  });
  return t0.id;
}

describe('the Reviewer looks at pages', () => {
  it('can call look_at_page, squad-kit starting the app; it cannot take pictures or start or stop the app', async () => {
    const id = story();
    const said: Record<string, string> = {};
    reviewer = async (opts) => {
      const w = opts.window!;
      expect(w.tools).toEqual(['look_at_page', 'i_am_stuck']);
      const list = (await rpc(w, 'tools/list')).body.result.tools as { name: string }[];
      expect(list.map((t) => t.name)).toEqual(['look_at_page', 'i_am_stuck']);
      said.look = textOf(await callTool(w, 'look_at_page', { page: '/rooms', size: 'phone' }));
      said.shots = textOf(await callTool(w, 'take_screenshots', { shots: [{ page: '/rooms' }] }));
      said.start = textOf(await callTool(w, 'start_app'));
      said.stop = textOf(await callTool(w, 'stop_app'));
      return { approved: true, summary: 'It fits a phone.', comments: [] };
    };
    await (new LiveSquad(bp) as unknown as Squad).review(id);
    const t = readTicket(bp, id)!;
    expect(said.look).toContain('The page is at /rooms.');
    expect(said.look).toContain('button "Book"');
    for (const k of ['shots', 'start', 'stop']) expect(said[k], k).toContain('there is no tool');
    expect(t.gates?.review).toBe('pass');
    // Nothing was saved, and the app squad-kit started stopped with the run.
    expect(fs.existsSync(bp.proofDir) ? fs.readdirSync(bp.proofDir) : []).toEqual([]);
    expect(openWindows()).toBe(0);
    expect(t.activity.map((a) => a.text).some((l) => l.includes('squad-kit started the app') && l.includes('for the Reviewer'))).toBe(true);
    // Claude Code may press only these two.
    const run = seen[0]!;
    expect(run.allowedTools).toEqual(expect.arrayContaining(['mcp__squad__look_at_page', 'mcp__squad__i_am_stuck']));
    expect(run.allowedTools).not.toContain('mcp__squad__take_screenshots');
    expect(run.allowedTools).not.toContain('mcp__squad__start_app');
    expect(run.allowedTools).not.toContain('mcp__squad__stop_app');
  });

  it('is told it can, in its prompt and its rule', async () => {
    const id = story();
    await (new LiveSquad(bp) as unknown as Squad).review(id);
    expect(seen[0]!.prompt).toContain('call look_at_page, at the size you need (phone or desktop)');
    expect(seen[0]!.appendSystemPrompt).toContain("look_at_page (its own browser on this story's app, which it starts for you when needed) and i_am_stuck");
    expect(seen[0]!.appendSystemPrompt).toContain('For pages of the app, use look_at_page');
    expect(seen[0]!.appendSystemPrompt).not.toContain('take_screenshots');
  });

  it('keeps the safety checks: another website is refused, and said on the story', async () => {
    const id = story();
    let answer = '';
    reviewer = async (opts) => {
      answer = textOf(await callTool(opts.window!, 'look_at_page', { page: 'https://evil.example.com/' }));
      return { approved: true, summary: 'Fine', comments: [] };
    };
    await (new LiveSquad(bp) as unknown as Squad).review(id);
    expect(answer).toContain('squad-kit refused this');
    expect(readTicket(bp, id)!.activity.map((a) => a.text)).toContain('The Reviewer asked to open another website. squad-kit refused.');
  });

  it('with no app in the project it gets only i_am_stuck, and is not told about pages', async () => {
    writeMeta(bp, { ...(await import('../src/board/store.js')).readMeta(bp), commands: {} });
    const id = story();
    await (new LiveSquad(bp) as unknown as Squad).review(id);
    expect(seen[0]!.window!.tools).toEqual(['i_am_stuck']);
    expect(seen[0]!.prompt).not.toContain('look_at_page');
  });

  it("squad-kit's own check of the screenshots gets no page tools: it judges from the pictures", () => {
    expect(P.windowRule(['i_am_stuck'])).not.toContain('look_at_page');
  });

  it('a look that comes while the app still starts is told to call again, not to call a tool it does not have', async () => {
    const { AgentWindow, toolsFor } = await import('../src/engine/window.js');
    const win = new AgentWindow({
      ticket: 'RO-15',
      step: 'review',
      who: 'Reviewer',
      tools: toolsFor({ app: false, look: true }),
      // An app that takes far longer to answer than the call may wait.
      app: { cwd: tmp, start: 'node -e "setTimeout(() => {}, 60000)"', url: 'http://127.0.0.1:47399' },
      proofDir: path.join(tmp, 'proof'),
      prefix: 'ro-15-reviewer',
      say: () => undefined,
      limits: { callMs: 300, appWaitMs: 60_000 },
    });
    const r = await win.call('look_at_page', { page: '/rooms' });
    await win.close();
    expect(r.content[0]).toMatchObject({ text: 'The app is still starting. Call this again in a moment.' });
  });

  it('what the app changes in the story\'s copy while the Reviewer looks goes back', async () => {
    const id = story();
    reviewer = async (opts) => {
      await callTool(opts.window!, 'look_at_page', { page: '/rooms' });
      // The app writes to a tracked file as it runs.
      fs.writeFileSync(path.join(opts.cwd!, 'data.txt'), 'changed by the running app\n');
      appTouches = 'done';
      return { approved: true, summary: 'Fine', comments: [] };
    };
    await (new LiveSquad(bp) as unknown as Squad).review(id);
    expect(appTouches).toBe('done');
    const t = readTicket(bp, id)!;
    expect(fs.readFileSync(path.join(t.worktree!, 'data.txt'), 'utf8')).toBe('as it was\n');
    expect(t.activity.map((a) => a.text).some((l) => l.includes('squad-kit put them back'))).toBe(true);
  });
});
