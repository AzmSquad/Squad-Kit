import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import type { AiTool, Billing } from '../src/modules/ai-tool/types.js';

/**
 * The Cost tab, the way the person pays (phase 12): squad-kit finds how Claude is paid through the Claude module and
 * the person can change it; a subscription shows the value of the work, an API key real dollars with budgets, a
 * warning at 80% and a stop between two steps at 100%; and the average cost and time per accepted ticket for each
 * Quality setting.
 */

let fakeBin = '/no/such/claude';
const runs: RunOptions[] = [];
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  claudeBinary: () => fakeBin,
  toolVersion: () => '2.1.0',
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    runs.push(opts);
    return { ok: true, structured: { approved: true, summary: 'Fine', comments: [] }, sessionId: opts.resume ?? opts.sessionId ?? 's', text: '' };
  },
}));

const { billingFrom, claudeBilling, claudeResume } = await import('../src/modules/claude/billing.js');
const { claudeTool } = await import('../src/modules/claude/index.js');
const { forgetPayment, howPaid } = await import('../src/board/payment.js');
const { budgetState, budgetStop, parseUsd, setBudget } = await import('../src/board/budget.js');
const { costOverview, partWords, qualityStats, sizeOfWork, ticketCost, whereItWent } = await import('../src/board/cost.js');
const { addToMonth, monthKey, readMonths, recordUsage } = await import('../src/board/usage.js');
const { setPaymentChoice } = await import('../src/core/settings.js');
const { boardPaths, listTickets, readMeta, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { mountBoardApi } = await import('../src/console/api/board.js');
const { buildPaths } = await import('../src/core/paths.js');
type Ticket = import('../src/board/types.js').Ticket;

let tmp: string;
let bp: ReturnType<typeof boardPaths>;

beforeEach(() => {
  runs.length = 0;
  fakeBin = '/no/such/claude';
  forgetPayment();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-cost-')));
  vi.stubEnv('SQUAD_KIT_HOME', path.join(tmp, 'home'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** An AI tool that says how it is paid, and counts how often it was asked. */
function toolPaid(billing: Billing | null): AiTool & { asked: number } {
  const t = { ...claudeTool, asked: 0, billing: async () => (t.asked++, billing) };
  return t;
}

const line = (step: string, costUsd: number, role: 'analyst' | 'architect' | 'builder' | 'reviewer' | 'tester' = 'builder') => ({ role, step, level: 'strongest' as const, model: 'Opus', runs: 1, costUsd, inputTokens: 1000, outputTokens: 100 });

describe('how Claude is paid', () => {
  it("reads Claude Code's auth status: a claude.ai login is a subscription, a key or a cloud account pays per use", () => {
    expect(billingFrom(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'pro' }))).toEqual({ kind: 'subscription', label: 'Claude Pro' });
    expect(billingFrom(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'Claude Max' }))).toEqual({ kind: 'subscription', label: 'Claude Max' });
    expect(billingFrom(JSON.stringify({ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' }))).toEqual({ kind: 'subscription', label: 'Claude plan' });
    expect(billingFrom(JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', apiKeySource: '/login managed key' }))).toEqual({ kind: 'api-key', label: 'Anthropic API key' });
    // An API key wins over a stored subscription login: Claude Code uses it first.
    expect(billingFrom(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', apiKeySource: 'apiKeyHelper' }))!.kind).toBe('api-key');
    expect(billingFrom(JSON.stringify({ loggedIn: false, authMethod: 'third_party', apiProvider: 'bedrock' }))).toEqual({ kind: 'api-key', label: 'AWS Bedrock' });
    expect(billingFrom(JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }))).toBeNull();
    expect(billingFrom('error: unknown command auth')).toBeNull();
  });

  it('asks the installed Claude Code without running a model, in the environment the agents get', async () => {
    const bin = path.join(tmp, 'claude');
    fs.writeFileSync(bin, `#!/usr/bin/env node\nconst key = process.env.ANTHROPIC_API_KEY;\nconsole.log(JSON.stringify({ loggedIn: true, args: process.argv.slice(2), authMethod: key ? 'api_key' : 'claude.ai', apiKeySource: key ? 'ANTHROPIC_API_KEY' : undefined, subscriptionType: 'max' }));\n`);
    fs.chmodSync(bin, 0o755);
    fakeBin = bin;
    // A key in the shell the board started from never reaches the agents, so it does not change how they are paid.
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    expect(await claudeBilling()).toEqual({ kind: 'subscription', label: 'Claude Max' });
    fakeBin = '/no/such/claude';
    expect(await claudeBilling()).toBeNull();
  });

  it("the person's own answer in Settings wins, auto goes back to finding out, and a finding is kept for a while", async () => {
    const tool = toolPaid({ kind: 'api-key', label: 'Anthropic API key' });
    const now = Date.now();
    expect(await howPaid(bp, { tool, now })).toMatchObject({ payment: 'api-key', from: 'found', found: { label: 'Anthropic API key' }, tool: 'Claude Code', name: 'Claude' });
    expect(await howPaid(bp, { tool, now: now + 60_000 })).toMatchObject({ payment: 'api-key' });
    expect(tool.asked).toBe(1);
    setPaymentChoice('subscription');
    expect(await howPaid(bp, { tool, now })).toMatchObject({ payment: 'subscription', from: 'you' });
    setPaymentChoice('auto');
    expect(await howPaid(bp, { tool, now })).toMatchObject({ payment: 'api-key', from: 'found' });
    expect(fs.readFileSync(path.join(tmp, 'home', 'settings.yaml'), 'utf8')).not.toContain('payment');
    // Nothing found: a subscription is assumed, and the page says so.
    forgetPayment();
    expect(await howPaid(bp, { tool: toolPaid(null), now })).toMatchObject({ payment: 'subscription', from: 'guess', found: null });
  });

  it('the AI tool module says how to open a session in a terminal, so the board never names the tool', () => {
    expect(claudeResume('abc-123', '/Users/me/my project')).toBe("cd '/Users/me/my project' && claude --resume abc-123");
    expect(claudeTool.resumeCommand!('abc-123', '/tmp/work')).toBe('cd /tmp/work && claude --resume abc-123');
  });
});

describe('the Cost tab on a subscription', () => {
  const pay = { payment: 'subscription' as const, from: 'found' as const, found: { kind: 'subscription' as const, label: 'Claude Pro' }, tool: 'Claude Code', name: 'Claude' };

  it('shows the size of the work against the usual ticket, where it went, the value and the month', () => {
    const c = ticketCost(bp, readTicket(bp, 'SK-139')!, pay);
    expect(c.payment.payment).toBe('subscription');
    expect(c.budget).toBeUndefined();
    expect(c.size).toMatchObject({ size: 'medium', from: 4 });
    expect(c.why).toBe('It had 2 questions and a design.');
    expect(c.where.by).toBe('cost');
    // Largest first: the build is the most work.
    expect(c.where.parts[0]!.name).toBe('Build');
    expect(c.where.parts.map((p) => p.name).sort()).toEqual(['Build', 'Design', 'Questions and spec', 'Review', 'Screenshots']);
    expect(c.where.parts.map((p) => p.share)).toEqual([...c.where.parts.map((p) => p.share)].sort((x, y) => y - x));
    expect(c.where.parts.reduce((s, p) => s + p.share, 0)).toBeCloseTo(1);
    // The month counts every step the squad took this month, from the sample board's seeded steps.
    expect(c.month.month).toBe(monthKey());
    expect(c.month.total.costUsd).toBeGreaterThan(c.total.costUsd!);
    expect(c.details.models).toBe('Opus for questions, spec, design, the build and review · Sonnet for screenshots');
    expect(c.details.tokens).toMatch(/^[\d.]+M tokens read \(\d+% from cache\), [\d.]+k written$/);
    expect(c.seconds).toBeGreaterThan(0);
  });

  it('says what an Express ticket used for a small change, before the next one', () => {
    const c = ticketCost(bp, readTicket(bp, 'SK-139')!, pay);
    expect(c.tip).toMatch(/^The Express track used about (a third|a quarter|half) of this for Fix: logout button on small screens \(SK-141\)\./);
    expect(ticketCost(bp, readTicket(bp, 'SK-141')!, pay).tip).toBeNull();
    expect(partWords(0.34)).toBe('about a third of');
    expect(partWords(0.05)).toBe('less than a tenth of');
  });

  it('a size needs two accepted tickets to compare with', () => {
    const all = listTickets(bp);
    const mine = { ...readTicket(bp, 'SK-139')!, usage: [line('build', 9)] } as Ticket;
    expect(sizeOfWork(mine, all, 'Case portal')).toMatchObject({ size: 'large' });
    expect(sizeOfWork(mine, all, 'Case portal')!.words).toMatch(/^About \d times a usual ticket in Case portal\.$/);
    expect(sizeOfWork(mine, [mine], 'Case portal')).toBeNull();
    // Without a cost from every run, the share is by tokens.
    expect(whereItWent([{ ...line('build', 1), costUsd: undefined, costUnknown: 1 }, line('review', 1)]).by).toBe('tokens');
  });
});

describe('budgets on an API key', () => {
  it('reads amounts in plain words and keeps the budgets for the project on this computer', () => {
    expect(parseUsd('$5')).toBe(5);
    expect(parseUsd('2.505')).toBe(2.51);
    expect(parseUsd('off')).toBeNull();
    expect(parseUsd(0)).toBeNull();
    expect(() => parseUsd('five')).toThrow(/not an amount/);
    expect(setBudget(bp, { ticketUsd: 5, monthUsd: 50 })).toEqual({ ticketUsd: 5, monthUsd: 50 });
    expect(setBudget(bp, { monthUsd: null })).toEqual({ ticketUsd: 5 });
    expect(readMeta(bp).budget).toEqual({ ticketUsd: 5 });
    // This computer's board file, not the project's settings.
    expect(fs.readFileSync(bp.configFile, 'utf8')).not.toContain('ticketUsd');
  });

  it('warns at 80% of a budget, and says when it is over', () => {
    const t = { ...readTicket(bp, 'SK-150')!, usage: [line('build', 4.1)] };
    expect(budgetState(bp, t, { ticketUsd: 5 })).toMatchObject({ ticketSpent: 4.1, ticketShare: 0.82, warn: ['ticket'], over: [] });
    expect(budgetState(bp, t, { ticketUsd: 4 })).toMatchObject({ warn: [], over: ['ticket'] });
    expect(budgetState(bp, t, { ticketUsd: 10 })).toMatchObject({ warn: [], over: [] });
    const spent = readMonths(bp)[monthKey()]!.costUsd!;
    expect(budgetState(bp, null, { monthUsd: spent / 0.9 })).toMatchObject({ warn: ['month'], over: [] });
  });

  it('the board lists the tickets near their budget and the month, only on an API key', () => {
    updateTicket(bp, 'SK-150', (t) => (t.usage = [line('build', 4.2)]));
    updateTicket(bp, 'SK-153', (t) => (t.usage = [line('build', 6)]));
    setBudget(bp, { ticketUsd: 5 });
    const key = { payment: 'api-key' as const, from: 'you' as const, found: null, tool: 'Claude Code', name: 'Claude' };
    const o = costOverview(bp, key);
    expect(o.warnings.map((w) => [w.id, w.over])).toEqual([
      ['SK-150', false],
      ['SK-153', true],
    ]);
    expect(costOverview(bp, { ...key, payment: 'subscription' }).warnings).toEqual([]);
    const c = ticketCost(bp, readTicket(bp, 'SK-150')!, key);
    expect(c.budget).toMatchObject({ ticketUsd: 5, warn: ['ticket'] });
  });

  it('at 100% the ticket waits for the person before its next step, never in the middle of one', async () => {
    updateTicket(bp, 'SK-150', (t) => (t.usage = [line('build', 5.4)]));
    setBudget(bp, { ticketUsd: 5 });
    const apiKey = async () => 'api-key' as const;
    // Steps that run no AI go on.
    expect(await budgetStop(bp, 'SK-150', 'test', apiKey)).toBe(false);
    // On a subscription the budget does not count.
    expect(await budgetStop(bp, 'SK-150', 'review', async () => 'subscription' as const)).toBe(false);
    expect(await budgetStop(bp, 'SK-150', 'review', apiKey)).toBe(true);
    const t = readTicket(bp, 'SK-150')!;
    expect(t).toMatchObject({ live: false, squad: null, retryPhase: 'review', waiting: { kind: 'stuck', summary: 'Reached its budget and waits for you' } });
    expect(t.stuck!.budget).toBe('ticket');
    expect(t.stuck!.question).toBe('SK-150 used $5.40 of its $5.00 budget. squad-kit paused it before the next step, so no step was cut in half. Carry on, or raise the budget in Settings first.');
    expect(t.stuck!.options.map((o) => o.do)).toEqual(['retry', 'plan']);
    expect(t.activity[0]!.text).toBe('Paused before the next step: SK-150 used $5.40 of its $5.00 budget.');
    // Carry on: from then on the ticket's own budget does not stop it again.
    actions.decideStuck(bp, 'SK-150', 0);
    expect(await budgetStop(bp, 'SK-150', 'review', apiKey)).toBe(false);
    expect(readTicket(bp, 'SK-150')!.budgetOk).toEqual({ ticket: true });
  });

  it("the month's budget stops each ticket at its next step, until the person says carry on for it", async () => {
    setBudget(bp, { monthUsd: 1 });
    const apiKey = async () => 'api-key' as const;
    expect(await budgetStop(bp, 'SK-153', 'build', apiKey)).toBe(true);
    expect(readTicket(bp, 'SK-153')!.stuck!.budget).toBe('month');
    actions.decideStuck(bp, 'SK-153', 0);
    expect(await budgetStop(bp, 'SK-153', 'build', apiKey)).toBe(false);
    expect(readTicket(bp, 'SK-153')!.budgetOk).toEqual({ month: monthKey() });
  });

  it('the live squad checks the budget before it starts an agent', async () => {
    writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct' });
    setPaymentChoice('api-key');
    setBudget(bp, { ticketUsd: 1 });
    updateTicket(bp, 'SK-145', (t) => {
      t.usage = [line('build', 1.2)];
      t.squad = null;
    });
    await (new LiveSquad(bp) as unknown as { step(id: string, phase: string): Promise<void> }).step('SK-145', 'review');
    expect(runs).toEqual([]);
    expect(readTicket(bp, 'SK-145')!).toMatchObject({ status: 'Paused at its budget', waiting: { kind: 'stuck' } });
  });
});

describe('what each run adds up to', () => {
  it('counts every run in its month, and the ticket keeps the Quality setting it ran on', () => {
    writeMeta(bp, { ...readMeta(bp), quality: 'thrifty' });
    const before = readMonths(bp)[monthKey()]?.costUsd ?? 0;
    recordUsage(bp, 'SK-151', { role: 'analyst', step: 'questions', level: 'strongest', model: 'Opus' }, { costUsd: 0.25, inputTokens: 10, outputTokens: 2 });
    expect(readMonths(bp)[monthKey()]!.costUsd).toBeCloseTo(before + 0.25);
    expect(readTicket(bp, 'SK-151')!.quality).toBe('thrifty');
    addToMonth(bp, { costUsd: 1 }, Date.parse('2026-01-15T12:00:00'));
    expect(readMonths(bp)['2026-01']).toEqual({ runs: 1, costUsd: 1, tokensUnknown: 1 });
  });
});

describe('cost and time per Quality setting', () => {
  it('averages the accepted tickets of each setting on this project', () => {
    const stats = qualityStats(bp);
    // The sample board has 4 accepted tickets, all on Best.
    expect(stats.map((s) => [s.quality, s.tickets])).toEqual([
      ['best', 4],
      ['balanced', 0],
      ['thrifty', 0],
    ]);
    const best = stats[0]!;
    const accepted = ['SK-138', 'SK-141', 'SK-143', 'SK-147'].map((id) => readTicket(bp, id)!);
    const cost = accepted.reduce((s, t) => s + t.usage!.reduce((a, l) => a + (l.costUsd ?? 0), 0), 0) / 4;
    expect(best.costUsd).toBeCloseTo(cost);
    const secs = accepted.reduce((s, t) => s + t.history!.reduce((a, h) => a + (Date.parse(h.to) - Date.parse(h.from)) / 1000, 0), 0) / 4;
    expect(best.seconds).toBeCloseTo(secs);
    // A ticket accepted on another setting joins its own average; one still open does not count.
    updateTicket(bp, 'SK-139', (t) => {
      t.quality = 'thrifty';
      t.stage = 'release';
    });
    updateTicket(bp, 'SK-150', (t) => (t.quality = 'thrifty'));
    expect(qualityStats(bp).find((s) => s.quality === 'thrifty')).toMatchObject({ tickets: 1 });
    expect(costOverview(bp, { payment: 'subscription', from: 'guess', found: null, tool: 'Claude Code', name: 'Claude' }).qualityAfter).toBe(3);
  });
});

describe('the cost REST calls', () => {
  const app = () => {
    const a = new Hono();
    mountBoardApi(a, { paths: buildPaths(tmp) });
    return a;
  };
  const put = (a: Hono, url: string, body: unknown) => a.request(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('one call each: what happened, the ticket cost, the overview, how you pay and the budgets', async () => {
    const a = app();
    const happened = (await (await a.request('/api/v1/tickets/SK-139/happened')).json()) as { steps: { name: string }[] };
    expect(happened.steps).toHaveLength(7);
    // No Claude Code here, so squad-kit cannot tell: it shows a subscription and says so.
    const cost = (await (await a.request('/api/v1/tickets/SK-139/cost')).json()) as { payment: { payment: string; from: string } };
    expect(cost.payment).toMatchObject({ payment: 'subscription', from: 'guess' });
    expect((await put(a, '/api/v1/cost/payment', { payment: 'card' })).status).toBe(400);
    const paid = (await (await put(a, '/api/v1/cost/payment', { payment: 'api-key' })).json()) as { payment: { payment: string; from: string } };
    expect(paid.payment).toMatchObject({ payment: 'api-key', from: 'you' });
    expect((await put(a, '/api/v1/cost/budget', { ticketUsd: 'lots' })).status).toBe(400);
    const set = (await (await put(a, '/api/v1/cost/budget', { ticketUsd: '5', monthUsd: 50 })).json()) as { budget: object };
    expect(set.budget).toEqual({ ticketUsd: 5, monthUsd: 50 });
    const off = (await (await put(a, '/api/v1/cost/budget', { monthUsd: null })).json()) as { budget: object };
    expect(off.budget).toEqual({ ticketUsd: 5 });
    const o = (await (await a.request('/api/v1/cost')).json()) as { quality: { quality: string; tickets: number }[] };
    expect(o.quality[0]).toMatchObject({ quality: 'best', tickets: 4 });
  });
});
