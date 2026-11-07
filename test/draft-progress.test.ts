import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/** The fake Analyst: it reads a file, searches, says a word, then waits until the test lets it answer or it is stopped. */
const calls: RunOptions[] = [];
let release: (r: Partial<RunResult>) => void = () => undefined;
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    opts.onActivity?.();
    opts.onTool?.({ name: 'Read', input: { file_path: path.join(opts.cwd, 'roomflow', 'app.py') } });
    opts.onTool?.({ name: 'Grep', input: { pattern: 'booking' } });
    opts.onTool?.({ name: 'Read', input: { file_path: path.join(opts.cwd, '.squad', 'decisions', 'ADR-001.md') } });
    opts.onTool?.({ name: 'Read', input: { file_path: path.join(opts.addDirs![0]!, 'chat.png') } });
    return new Promise((resolve) => {
      release = (r) => resolve({ ok: true, sessionId: 's', text: '', ...r } as RunResult);
      opts.signal?.addEventListener('abort', () => resolve({ ok: false, sessionId: 's', text: '', error: 'You stopped the squad.' }));
    });
  },
}));

const { boardPaths, readMeta, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const D = await import('../src/engine/draft.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;
const wait = () => new Promise((r) => setTimeout(r, 10));
const answer = { title: 'Login screen', ask: 'People sign in.', kind: 'feature', track: 'full', priority: 'normal', criteria: [], rules: [], edgeCases: [], gaps: [] };
const png = { name: 'chat.png', data: Buffer.from('png').toString('base64') };

beforeEach(() => {
  calls.length = 0;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-draft-job-')));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct' });
});

afterEach(() => {
  const now = D.currentDraft(bp);
  if (now) D.dismissDraft(bp, now.id);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a draft from an idea', () => {
  it('shows each step and what the Analyst looks at, then waits under New ticket until it is used', async () => {
    const started = D.startDraft(bp, { text: 'make login screen', files: [png] });
    expect(started).toMatchObject({ status: 'working', step: 'read', text: 'make login screen', files: [{ name: 'chat.png', size: 3 }] });
    await wait();
    expect(D.draftJob(bp, started.id)).toMatchObject({
      status: 'working',
      step: 'look',
      looked: ['the code', 'saved decision ADR-001', 'your file chat.png'],
    });
    calls[0]!.onText?.('I have what I need.');
    expect(D.draftJob(bp, started.id).step).toBe('write');

    release({ structured: answer });
    await wait();
    const done = D.currentDraft(bp)!;
    expect(done).toMatchObject({ id: started.id, status: 'done', draft: answer, text: 'make login screen' });
    expect(done.endedAt).toBeDefined();
    // A dialog opened again gets the files back, to create the ticket with them.
    expect(D.draftFiles(bp, started.id).files).toEqual([png]);
    D.dismissDraft(bp, started.id);
    expect(D.currentDraft(bp)).toBeNull();
    expect(() => D.draftJob(bp, started.id)).toThrow('This draft is gone');
  });

  it('Cancel stops the Analyst and keeps the text', async () => {
    const job = D.startDraft(bp, { text: 'make login screen' });
    await wait();
    expect(D.cancelDraft(bp, job.id)).toMatchObject({ status: 'cancelled', text: 'make login screen' });
    expect(calls[0]!.signal?.aborted).toBe(true);
    await wait();
    // The run ending after the stop does not turn it into an error.
    expect(D.currentDraft(bp)).toMatchObject({ status: 'cancelled', text: 'make login screen' });
    expect(D.currentDraft(bp)!.error).toBeUndefined();
  });

  it('a failed draft says why and keeps the text', async () => {
    const job = D.startDraft(bp, { text: 'make login screen' });
    await wait();
    const out = 'Claude Code is signed out on this computer. Open the Terminal app, type claude and press Enter, then sign in when it asks. Then press Try again.';
    release({ ok: false, error: out });
    await wait();
    expect(D.draftJob(bp, job.id)).toMatchObject({ status: 'failed', error: out, text: 'make login screen' });
  });

  it("a tool's raw error stays out of the failure line, and the way on is said", async () => {
    const job = D.startDraft(bp, { text: 'make login screen' });
    await wait();
    release({ ok: false, error: 'ECONNRESET at ClientRequest.socketErrorListener (node:_http_client:501:9)' });
    await wait();
    expect(D.draftJob(bp, job.id)).toMatchObject({ status: 'failed', error: 'The Analyst did not fill in the ticket. Try again, or write it yourself.', text: 'make login screen' });
  });

  it('a new draft replaces the last one and stops it; empty text is refused at once', async () => {
    const first = D.startDraft(bp, { text: 'one' });
    await wait();
    const second = D.startDraft(bp, { text: 'two' });
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(D.currentDraft(bp)).toMatchObject({ id: second.id, text: 'two' });
    expect(() => D.draftJob(bp, first.id)).toThrow('This draft is gone');
    expect(() => D.startDraft(bp, { text: '  ' })).toThrow(/Paste the idea/);
  });

  it('on the demo board the draft is ready at once', async () => {
    writeMeta(bp, { ...readMeta(bp), engine: 'demo' });
    const job = D.startDraft(bp, { text: 'Urgent: booking page crashes' });
    await wait();
    expect(D.draftJob(bp, job.id)).toMatchObject({ status: 'done', draft: { title: 'Urgent: booking page crashes', priority: 'high' } });
    expect(calls).toHaveLength(0);
  });
});
