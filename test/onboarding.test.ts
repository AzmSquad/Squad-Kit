import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Ticket } from '../console-ui/src/api/types.js';
import { arabicCount, firstWinOf, guideHint, guideStep, readLang, storyToGuide, winStats } from '../console-ui/src/lib/first-story.js';

const seen = vi.hoisted(() => ({ git: '2.45.0' as string | null, tools: [] as { name: string; label: string; ready: () => boolean }[], login: true }));

vi.mock('../src/engine/git.js', async (real) => ({ ...(await real<typeof import('../src/engine/git.js')>()), gitVersion: () => seen.git }));
vi.mock('../src/core/planner-auth.js', async (real) => ({ ...(await real<typeof import('../src/core/planner-auth.js')>()), detectClaudeLogin: () => ({ present: seen.login, hint: 'none', detail: '' }) }));
vi.mock('../src/modules/registry.js', async (real) => {
  const mod = await real<typeof import('../src/modules/registry.js')>();
  return new Proxy(mod, { get: (t, k) => (k === 'AI_TOOLS' && seen.tools.length ? seen.tools : (t as Record<string | symbol, unknown>)[k]) });
});

const { computerReady } = await import('../src/engine/computer-ready.js');
const { mountAppApi } = await import('../src/console/api/app.js');
const { readSettings, setWelcomed, welcomed } = await import('../src/core/settings.js');
const { OpenProjects } = await import('../src/console/open-projects.js');
const { boardPaths, readMeta, listTickets } = await import('../src/board/store.js');
const { demoFolder } = await import('../src/board/demo.js');

const claude = (ready = true) => ({ name: 'claude', label: 'Claude Code', ready: () => ready });
const codex = (ready = true) => ({ name: 'codex', label: 'Codex', ready: () => ready });

describe('Is your computer ready?', () => {
  beforeEach(() => {
    seen.git = '2.45.0';
    seen.login = true;
    seen.tools = [claude(), codex(false)];
  });

  it('all ready: nothing to do', () => {
    expect(computerReady()).toEqual({ git: { ok: true }, tool: { ok: true, label: 'Claude Code' } });
  });

  it('git missing, and git too old, each has its one step', () => {
    seen.git = null;
    expect(computerReady().git).toEqual({ ok: false, step: 'install-git' });
    seen.git = '2.30.1';
    expect(computerReady().git).toEqual({ ok: false, step: 'update-git' });
  });

  it('no AI tool: install one', () => {
    seen.tools = [claude(false), codex(false)];
    expect(computerReady().tool).toEqual({ ok: false, step: 'install-tool' });
  });

  it('Claude Code with no sign-in: sign in', () => {
    seen.login = false;
    expect(computerReady().tool).toEqual({ ok: false, label: 'Claude Code', step: 'sign-in' });
  });

  it('an API key counts as signed in', () => {
    seen.login = false;
    vi.stubEnv('ANTHROPIC_API_KEY', 'made-up');
    expect(computerReady().tool.ok).toBe(true);
    vi.unstubAllEnvs();
  });

  it('another AI tool is enough: its sign-in cannot be seen from here', () => {
    seen.login = false;
    seen.tools = [claude(false), codex()];
    expect(computerReady().tool).toEqual({ ok: true, label: 'Codex' });
  });
});

describe('the first start, on the server', () => {
  let tmp: string;
  let home: string;
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-onboard-')));
    home = path.join(tmp, 'home');
    vi.stubEnv('SQUAD_KIT_HOME', home);
    seen.tools = [];
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('Welcome is remembered on this computer, beside the other settings', () => {
    expect(welcomed()).toBe(false);
    setWelcomed();
    expect(welcomed()).toBe(true);
    expect(readSettings().welcomed).toBe(true);
  });

  it('the settings say it, and it can only be said once and for good', async () => {
    const app = new Hono();
    mountAppApi(app, { projects: { summaries: () => [] } as never });
    const read = async () => (await (await app.request('/api/v1/app/settings')).json()) as { welcomed?: boolean; parallel: number };
    expect((await read()).welcomed).toBe(false);
    const put = (body: object) => app.request('/api/v1/app/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await put({ welcomed: false })).status).toBe(200);
    expect((await read()).welcomed).toBe(false);
    expect((await put({ welcomed: true })).status).toBe(200);
    expect((await read()).welcomed).toBe(true);
  });

  it('Just show me opens the sample project from its own folder, and a second press keeps it', async () => {
    const projects = new OpenProjects({ token: 'made-up', info: () => ({ pid: process.pid, port: 1, token: 'made-up', startedAt: new Date().toISOString() }) } as never);
    try {
      const first = projects.openSample();
      expect(first.root).toBe(demoFolder());
      const bp = boardPaths(path.join(demoFolder(), '.squad'));
      expect(readMeta(bp).engine).toBe('demo');
      const count = listTickets(bp).length;
      expect(count).toBeGreaterThan(3);
      fs.writeFileSync(path.join(bp.ticketsDir, 'marker.txt'), 'still here');
      const again = projects.openSample();
      expect(again.id).toBe(first.id);
      expect(fs.existsSync(path.join(bp.ticketsDir, 'marker.txt'))).toBe(true);
      expect(projects.summaries().filter((p) => p.id === first.id)).toHaveLength(1);
    } finally {
      projects.closeAll?.();
    }
  });
});

const story = (over: Partial<Ticket> = {}): Ticket => ({ id: 'A-1', title: 'A story', ask: '', kind: 'feature', source: { type: 'manual' }, priority: 'normal', stage: 'tickets', status: '', waiting: null, createdAt: '2026-11-07T10:00:00.000Z', createdBy: 'Me', activity: [], ...over }) as Ticket;

describe('the first story checklist', () => {
  it('follows the first story a person walks through, until a story is in', () => {
    expect(storyToGuide([], [])).toBeNull();
    const a = story();
    expect(storyToGuide([a], [])).toBe(a);
    expect(storyToGuide([story({ track: 'auto' }), a], [])).toBe(a);
    expect(storyToGuide([story({ takenOver: { by: 'm', at: 'n', session: '', cwd: '', free: {} } }), a], [])).toBe(a);
    expect(storyToGuide([a, story({ id: 'A-2', mergedAt: 'x' })], [])).toBeNull();
    expect(storyToGuide([a, story({ id: 'A-2', stage: 'release' })], [])).toBeNull();
    expect(storyToGuide([a], [story({ id: 'A-3', stage: 'done' })])).toBeNull();
  });

  it.each([
    [{ stage: 'tickets', waiting: null }, 0, 'working'],
    [{ stage: 'specs', waiting: { kind: 'questions', summary: '' } }, 0, 'questions'],
    [{ stage: 'specs', waiting: { kind: 'spec', summary: '' } }, 1, 'spec'],
    [{ stage: 'specs', waiting: { kind: 'plan', summary: '' } }, 1, 'plan'],
    [{ stage: 'specs', waiting: null }, 1, 'working'],
    [{ stage: 'implement', waiting: null }, 2, 'working'],
    [{ stage: 'test', waiting: { kind: 'stuck', summary: '' } }, 2, 'other'],
    [{ stage: 'review', waiting: null }, 2, 'working'],
    [{ stage: 'review', waiting: { kind: 'proof', summary: '' } }, 3, 'proof'],
  ] as const)('%j is at step %i, with the %s hint', (t, step, hint) => {
    expect(guideStep(t as never)).toBe(step);
    expect(guideHint(t as never)).toBe(hint);
  });
});

describe('the first win', () => {
  const now = Date.parse('2026-11-07T12:00:00.000Z');
  const inn = story({ mergedAt: '2026-11-07T11:00:00.000Z', stage: 'release' });

  it('is the only story in, and a recent one', () => {
    expect(firstWinOf([inn], [], now)).toBe(inn);
    expect(firstWinOf([story()], [], now)).toBeNull();
    expect(firstWinOf([inn, story({ id: 'A-2', mergedAt: '2026-11-07T11:30:00.000Z' })], [], now)).toBeNull();
    expect(firstWinOf([inn], [story({ id: 'A-3', stage: 'done', mergedAt: '2026-10-01T10:00:00.000Z' })], now)).toBeNull();
    expect(firstWinOf([story({ mergedAt: '2026-11-01T11:00:00.000Z' })], [], now)).toBeNull();
    expect(firstWinOf([story({ stage: 'release' })], [], now)).toBeNull();
  });

  it('says only what really happened', () => {
    const s = winStats(story({
      mergedAt: '2026-11-07T10:10:30.000Z',
      criteria: [{ given: 'a', when: 'b', then: 'c' }, { given: 'd', when: 'e', then: 'f' }],
      gates: { checks: 'pass', review: 'pass', proof: 'pass', ran: [{ name: 'test', command: 'x', ok: true, tests: 18 }, { name: 'lint', command: 'y', ok: true }] },
      usage: [{ costUsd: 1.5 }, { costUsd: 0.25 }] as never,
    }));
    expect(s).toEqual({ minutes: 11, doneWhen: 2, tests: 18, costUsd: 1.75 });
  });

  it('a story built outside, with no check: no numbers it does not have', () => {
    const s = winStats(story({ mergedAt: '2026-11-07T10:00:10.000Z', criteria: [{ given: 'a', when: 'b', then: 'c' }], gates: { checks: 'pending', review: 'pending', proof: 'pending' } }));
    expect(s).toEqual({ minutes: 1 });
  });
});

describe('the language of the first start', () => {
  it('counts the way Arabic counts', () => {
    const minutes = (n: number) => arabicCount(n, 'دقيقة', 'دقيقتان', 'دقائق');
    expect(minutes(1)).toBe('دقيقة');
    expect(minutes(2)).toBe('دقيقتان');
    expect(minutes(4)).toBe('4 دقائق');
    expect(minutes(10)).toBe('10 دقائق');
    expect(minutes(11)).toBe('11 دقيقة');
  });

  it('with no storage and no browser, English', () => {
    expect(readLang()).toBe('en');
  });
});
