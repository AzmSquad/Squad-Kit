import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import type { AgentUsage } from '../src/modules/ai-tool/types.js';

/**
 * The cost on the board: each run's usage comes from the AI tool module in one shape, is added up per ticket and per
 * role (the project's own work on its own line), and what a tool did not report stays unknown, never zero.
 */

const calls: RunOptions[] = [];
const answers: { structured: unknown; usage?: AgentUsage }[] = [];
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  claudeBinary: () => '/bin/claude',
  toolVersion: () => '2.1.0',
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    const a = answers.shift()!;
    return { ok: true, structured: a.structured, sessionId: opts.resume ?? opts.sessionId ?? 's', text: '', ...(a.usage ? { usage: a.usage } : {}) };
  },
}));

const { claudeUsage, costSoFar } = await import('../src/modules/claude/direct.js');
const { runAcp, usageFrom } = await import('../src/engine/acp-runner.js');
const { addRun, boardUsage, byRole, costWords, tokenWords, totalOf } = await import('../src/board/usage.js');
const { boardPaths, listTickets, readMeta, readTicket, updateTicket, writeMeta, splitTicket } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;

beforeEach(() => {
  calls.length = 0;
  answers.length = 0;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-usage-')));
  vi.stubEnv('SQUAD_KIT_HOME', path.join(tmp, 'home'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct' });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Squad = { step(id: string, phase: string): Promise<void>; scan(): Promise<void> };

/** A small ACP adapter that answers one prompt with its token counts and the session's cost so far. */
const adapter = (opts: { usage?: object; cost?: number }) => `
import readline from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return send({ id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === 'session/new') return send({ id: msg.id, result: { sessionId: 's1' } });
  if (msg.method === 'session/resume') return send({ id: msg.id, result: {} });
  if (msg.method === 'session/prompt') {
    const cost = ${JSON.stringify(opts.cost ?? null)};
    if (cost !== null) send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'usage_update', used: 10, size: 100, cost: { amount: cost, currency: 'USD' } } } });
    send({ id: msg.id, result: { stopReason: 'end_turn', ...(${JSON.stringify(opts.usage ?? null)} ? { usage: ${JSON.stringify(opts.usage ?? null)} } : {}) } });
  }
});
`;

function acp(script: string, resume?: { costSoFar?: number }) {
  const file = path.join(tmp, `adapter-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(file, script);
  return runAcp(
    {
      command: process.execPath,
      args: [file],
      env: process.env,
      meta: {},
      canResume: () => Boolean(resume),
      explain: (raw) => raw,
      toolName: () => undefined,
      ...(resume?.costSoFar !== undefined ? { costSoFar: () => resume.costSoFar } : {}),
    },
    { cwd: tmp, prompt: 'go', timeoutMs: 20_000, ...(resume ? { resume: 's1' } : {}) },
  );
}

describe('what a run used, from the AI tool module', () => {
  it("reads Claude Code's result: this run's tokens, cached ones included, and its cost at API prices", () => {
    // A real first run of a conversation, as Claude Code reported it.
    const first = { total_cost_usd: 0.0089656, usage: { input_tokens: 2, cache_creation_input_tokens: 44817, cache_read_input_tokens: 0, output_tokens: 4 } };
    expect(claudeUsage(first, 0)).toEqual({ inputTokens: 44819, cachedTokens: 0, outputTokens: 4, costUsd: 0.0089656 });
    // Going on with it, Claude Code reports the conversation's cost from its start: the run costs the difference.
    const next = { total_cost_usd: 0.01350784, usage: { input_tokens: 2, cache_creation_input_tokens: 21534, cache_read_input_tokens: 23324, output_tokens: 4 } };
    const u = claudeUsage(next, 0.0089656)!;
    expect(u).toMatchObject({ inputTokens: 44860, cachedTokens: 23324, outputTokens: 4 });
    expect(u.costUsd).toBeCloseTo(0.00454224, 8);
  });

  it("finds what a saved conversation cost so far in Claude Code's own record of it", () => {
    vi.stubEnv('HOME', tmp);
    const dir = path.join(tmp, '.claude', 'projects', '-app');
    fs.mkdirSync(dir, { recursive: true });
    const line = (o: object) => `${JSON.stringify(o)}\n`;
    fs.writeFileSync(
      path.join(dir, 'abc.jsonl'),
      line({ type: 'user', sessionId: 'abc' }) + line({ type: 'cost-state', sessionId: 'abc', totalCostUSD: 0.12 }) + line({ type: 'assistant' }) + line({ type: 'cost-state', sessionId: 'abc', totalCostUSD: 0.31 }),
    );
    expect(costSoFar('abc')).toBe(0.31);
    // A conversation it never saw costs nothing so far.
    expect(costSoFar('new-one')).toBe(0);
  });

  it('reads ACP: the turn tokens from the answer, the cost from the session cost, minus its cost before a resumed run', async () => {
    const usage = { totalTokens: 1530, inputTokens: 10, outputTokens: 20, cachedReadTokens: 1000, cachedWriteTokens: 500 };
    const fresh = await acp(adapter({ usage, cost: 0.4 }));
    expect(fresh.usage).toEqual({ inputTokens: 1510, cachedTokens: 1000, outputTokens: 20, costUsd: 0.4 });
    const resumed = await acp(adapter({ usage, cost: 0.4 }), { costSoFar: 0.25 });
    expect(resumed.usage?.costUsd).toBeCloseTo(0.15, 10);
  });

  it('leaves out what the agent did not say, and a resumed cost it cannot split', async () => {
    expect((await acp(adapter({}))).usage).toBeUndefined();
    // A resumed session's cost counts earlier runs; without the tool's own record, this run's share is unknown.
    const r = await acp(adapter({ usage: { totalTokens: 30, inputTokens: 10, outputTokens: 20 }, cost: 0.4 }), {});
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
    expect(usageFrom(undefined, undefined, 0)).toBeUndefined();
  });
});

describe('added up per ticket and per role', () => {
  it('adds runs per role, step and model level, and the role across its levels', () => {
    const analyst = { role: 'analyst' as const, level: 'strongest' as const, model: 'Opus' };
    let lines = addRun(undefined, { ...analyst, step: 'questions' }, { inputTokens: 1000, cachedTokens: 800, outputTokens: 50, costUsd: 0.2 });
    lines = addRun(lines, { ...analyst, step: 'questions' }, { inputTokens: 500, outputTokens: 10, costUsd: 0.05 });
    lines = addRun(lines, { ...analyst, step: 'spec' }, { inputTokens: 2000, outputTokens: 300, costUsd: 0.5 });
    lines = addRun(lines, { role: 'builder', step: 'fix', level: 'balanced', model: 'Sonnet' }, { inputTokens: 9000, outputTokens: 900, costUsd: 0.3 });
    lines = addRun(lines, { role: 'builder', step: 'fix', level: 'strongest', model: 'Opus' }, { inputTokens: 9000, outputTokens: 900, costUsd: 0.9 });
    expect(lines).toHaveLength(4);
    expect(lines[0]).toEqual({ ...analyst, step: 'questions', runs: 2, inputTokens: 1500, cachedTokens: 800, outputTokens: 60, costUsd: 0.25 });

    const roles = byRole(lines);
    expect(roles.map((r) => r.role)).toEqual(['analyst', 'builder']);
    expect(roles[0]!.levels).toEqual([{ level: 'strongest', model: 'Opus', steps: ['questions', 'spec'], total: { runs: 3, inputTokens: 3500, cachedTokens: 800, outputTokens: 360, costUsd: 0.75 } }]);
    // The Builder's fixes stepped up to the strongest level: it shows on two rows, one per level.
    expect(roles[1]!.levels.map((l) => [l.model, l.total.costUsd])).toEqual([['Sonnet', 0.3], ['Opus', 0.9]]);
    expect(roles[1]!.total.runs).toBe(2);

    const total = totalOf(lines);
    expect(total.runs).toBe(5);
    expect(total.costUsd).toBeCloseTo(1.95, 10);
    expect(costWords(total)).toBe('$1.95');
    expect(tokenWords(total)).toBe('read 22k tokens, wrote 2.2k');
  });

  it('counts each step of a ticket on the ticket, at the level it ran on, and keeps it on this computer', async () => {
    const t = actions.createTicket(bp, { title: 'Opening hours' });
    updateTicket(bp, t.id, (x) => (x.squad = null));
    answers.push({ structured: { summary: 'Clear', questions: [] }, usage: { inputTokens: 1200, cachedTokens: 900, outputTokens: 80, costUsd: 0.12 } });
    await (new LiveSquad(bp) as unknown as Squad).step(t.id, 'analyst-read');
    const after = readTicket(bp, t.id)!;
    expect(after.usage).toEqual([{ role: 'analyst', step: 'questions', level: 'strongest', model: 'Opus', runs: 1, inputTokens: 1200, cachedTokens: 900, outputTokens: 80, costUsd: 0.12 }]);
    // Live state: in this computer's file for the ticket, never in the project's documents.
    const { docs, state } = splitTicket(bp, after);
    expect(state.usage).toHaveLength(1);
    expect(Object.values(docs).join('\n')).not.toContain('costUsd');
  });

  it("counts the project's first read, which has no ticket, on the project's own line, and in the board's total", async () => {
    // The sample board's own sample cost is set aside, so only these runs count.
    for (const x of listTickets(bp)) updateTicket(bp, x.id, (y) => delete y.usage);
    answers.push({ structured: { empty: true, summary: 'An empty folder', map: [], decisions: [], commands: {} }, usage: { inputTokens: 3000, outputTokens: 200, costUsd: 0.3 } });
    await (new LiveSquad(bp) as unknown as Squad).scan();
    expect(readMeta(bp).scan?.status).toBe('done');
    expect(readMeta(bp).usage).toEqual([{ role: 'architect', step: 'scan', level: 'balanced', model: 'Sonnet', runs: 1, inputTokens: 3000, outputTokens: 200, costUsd: 0.3 }]);

    const t = actions.createTicket(bp, { title: 'Opening hours' });
    updateTicket(bp, t.id, (x) => (x.squad = null));
    answers.push({ structured: { summary: 'Clear', questions: [] }, usage: { costUsd: 0.2 } });
    await (new LiveSquad(bp) as unknown as Squad).step(t.id, 'analyst-read');
    const board = boardUsage(bp);
    expect(board).toMatchObject({ tickets: 1, project: { runs: 1, costUsd: 0.3 }, total: { runs: 2, costUsd: 0.5 } });
    expect(board.roles.map((r) => r.role)).toEqual(['analyst', 'architect']);
  });
});

describe('a run with unknown usage', () => {
  it('counts the run, but not as zero: its cost and tokens stay unknown', async () => {
    const t = actions.createTicket(bp, { title: 'Opening hours' });
    updateTicket(bp, t.id, (x) => (x.squad = null));
    answers.push({ structured: { summary: 'Clear', questions: [] } });
    await (new LiveSquad(bp) as unknown as Squad).step(t.id, 'analyst-read');
    const [line] = readTicket(bp, t.id)!.usage!;
    expect(line).toEqual({ role: 'analyst', step: 'questions', level: 'strongest', model: 'Opus', runs: 1, tokensUnknown: 1, costUnknown: 1 });
    expect(line).not.toHaveProperty('costUsd');
    expect(costWords(totalOf([line!]))).toBeNull();
    expect(tokenWords(totalOf([line!]))).toBeNull();
  });

  it('adds up what was reported and says how many runs are missing', () => {
    const key = { role: 'tester' as const, step: 'proof', level: 'fast' as const, model: 'Haiku' };
    const lines = addRun(addRun(undefined, key, { costUsd: 0.5 }), key, undefined);
    const total = totalOf(lines);
    expect(total).toEqual({ runs: 2, costUsd: 0.5, tokensUnknown: 2, costUnknown: 1 });
    expect(costWords(total)).toBe('$0.50, 1 run not reported');
  });
});
