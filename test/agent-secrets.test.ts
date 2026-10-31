import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/engine/claude.js';

const calls: RunOptions[] = [];
const answers: unknown[] = [];
vi.mock('../src/engine/claude.js', async (orig) => ({
  ...(await orig<typeof import('../src/engine/claude.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    return { ok: true, structured: answers.shift(), sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

const { childEnv, deniedTools } = await import('../src/engine/claude.js');
const { boardPaths, readMeta, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { draftTicket } = await import('../src/engine/draft.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;

beforeEach(() => {
  calls.length = 0;
  answers.length = 0;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-secrets-')));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct' });
  fs.writeFileSync(path.join(tmp, '.squad', 'secrets.yaml'), 'tracker:\n  azure:\n    pat: secret\n');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('agents never see squad-kit secrets', () => {
  it('denies reading and changing each secret file by its absolute path', () => {
    const denied = deniedTools({ cwd: tmp, prompt: '', disallowedTools: ['Bash(git push:*)'], secretFiles: ['/app/.squad/secrets.yaml'] });
    expect(denied).toEqual(['Bash(git push:*)', 'Read(//app/.squad/secrets.yaml)', 'Edit(//app/.squad/secrets.yaml)']);
  });

  it('denies the real path too when the folder is a link', () => {
    const link = path.join(os.tmpdir(), `squad-link-${process.pid}`);
    fs.symlinkSync(tmp, link);
    try {
      const denied = deniedTools({ cwd: tmp, prompt: '', secretFiles: [path.join(link, '.squad', 'secrets.yaml')] });
      expect(denied).toContain(`Read(/${path.join(link, '.squad', 'secrets.yaml')})`);
      expect(denied).toContain(`Read(/${path.join(tmp, '.squad', 'secrets.yaml')})`);
    } finally {
      fs.rmSync(link);
    }
  });

  it('keeps the tracker and speech keys out of the agent process', () => {
    const before = { ...process.env };
    Object.assign(process.env, { AZURE_DEVOPS_PAT: 'pat', SQUAD_TRACKER_API_KEY: 'k', JIRA_API_TOKEN: 'j', MUNSIT_API_KEY: 'm' });
    try {
      const env = childEnv();
      expect([env.AZURE_DEVOPS_PAT, env.SQUAD_TRACKER_API_KEY, env.JIRA_API_TOKEN, env.MUNSIT_API_KEY]).toEqual([undefined, undefined, undefined, undefined]);
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      process.env = before;
    }
  });

  it('every squad step carries the board secrets file', async () => {
    const t = actions.createTicket(bp, { title: 'Opening hours' });
    updateTicket(bp, t.id, (x) => (x.squad = null));
    answers.push({ questions: [] });
    await (new LiveSquad(bp) as unknown as { step(id: string, phase: string): Promise<void> }).step(t.id, 'analyst-read');
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(deniedTools(c)).toContain(`Read(/${path.join(tmp, '.squad', 'secrets.yaml')})`);
  });

  it('the Analyst filling in a new ticket carries it too', async () => {
    answers.push({ title: 'Opening hours', ask: 'Set hours', kind: 'feature' });
    await draftTicket(bp, { text: 'owners want to set opening hours' });
    expect(calls).toHaveLength(1);
    expect(deniedTools(calls[0]!)).toContain(`Read(/${path.join(tmp, '.squad', 'secrets.yaml')})`);
  });
});
