import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAcp } from '../src/engine/acp-runner.js';
import { claudeLaunch, claudeRunOptions, claudeTool } from '../src/modules/claude/index.js';
import { claudeBinary, runClaude } from '../src/modules/claude/direct.js';
import { claudeBlocked, claudeSandbox, sandboxSupportOn, withCap, type SandboxHost } from '../src/modules/claude/sandbox.js';
import { PACKAGE_HOSTS, blockedLine, packageCacheEnv, parseHosts, sandboxAsk } from '../src/engine/sandbox.js';
import { readConversation } from '../src/engine/conversations.js';
import { checkAgentSandbox } from '../src/commands/doctor-engine.js';
import { squadHome } from '../src/core/home.js';
import { stepCaps } from '../src/engine/levels.js';
import type { BlockedAction, SandboxAsk } from '../src/modules/ai-tool/types.js';

/**
 * The Builder's and Tester's commands in Claude Code's sandbox, and the caps on every run: the settings squad-kit
 * sends over ACP and to `claude -p`, a computer without the sandbox, the plain words for what it refused, and a run
 * that reaches a cap. Every Claude Code and ACP adapter here is a stand-in; no model runs.
 */

const VIOLATIONS = [
  'npm ERR! request to https://example.com/pkg failed',
  '<sandbox_violations>',
  'deny network-outbound example.com:443 (not_allowlisted)',
  'bash(4242) deny(1) file-read-data /Users/me/.ssh/id_rsa',
  'node(77) deny(1) file-write-create /Users/me/Documents/notes.txt',
  'deny network-outbound example.com:80 (not_allowlisted)',
  '</sandbox_violations>',
].join('\n');

/**
 * A stand-in for the Claude ACP adapter. On session/new it keeps the options squad-kit sent; the prompt picks what it
 * does: "options" answers with them, "blocked" reports a command the sandbox refused, "cap" ends on a cap.
 */
const ADAPTER = `
import readline from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
const update = (u) => send({ method: 'session/update', params: { sessionId: 's1', update: u } });
let options = null;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return send({ id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === 'session/new') {
    options = msg.params._meta?.claudeCode?.options ?? null;
    return send({ id: msg.id, result: { sessionId: 's1' } });
  }
  if (msg.method === 'session/set_mode') return send({ id: msg.id, result: {} });
  if (msg.method === 'session/prompt') {
    const p = msg.params.prompt[0].text;
    if (p === 'blocked') {
      update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'npm install', rawInput: { command: 'npm install' }, _meta: { claudeCode: { toolName: 'Bash' } } });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: '\`\`\`console\\n' + ${JSON.stringify(VIOLATIONS)} + '\\n\`\`\`' } }], _meta: { claudeCode: { toolName: 'Bash' } } });
    }
    if (p === 'cap') {
      update({ sessionUpdate: 'usage_update', used: 1, size: 2, cost: { amount: 59.5, currency: 'USD' } });
      return send({ id: msg.id, result: { stopReason: 'max_turn_requests' } });
    }
    const env = { GEM_HOME: process.env.GEM_HOME, MAVEN_OPTS: process.env.MAVEN_OPTS };
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: p === 'options' ? JSON.stringify(options) : p === 'env' ? JSON.stringify(env) : 'done' } });
    return send({ id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`;

/** A stand-in for Claude Code's headless mode: the prompt picks what it does, like the adapter above. */
const CLAUDE = `#!/usr/bin/env node
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1];
const out = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
if (prompt === 'turns') out({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum number of turns (300)'], session_id: 's' });
else if (prompt === 'spend') out({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, errors: ['Reached maximum budget ($60)'], total_cost_usd: 60.2, session_id: 's' });
else {
  if (prompt === 'blocked') {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm install' } }] } });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: [{ type: 'text', text: ${JSON.stringify(VIOLATIONS)} }] }] } });
  }
  const env = { GEM_HOME: process.env.GEM_HOME, MAVEN_OPTS: process.env.MAVEN_OPTS };
  out({ type: 'result', subtype: 'success', result: JSON.stringify(prompt === 'env' ? env : args), session_id: 's' });
}
`;

let dir: string;
let adapter: string;
let bin: string;
let tmp: string;

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-sandbox-')));
  adapter = path.join(dir, 'adapter.mjs');
  fs.writeFileSync(adapter, ADAPTER);
  bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), CLAUDE, { mode: 0o755 });
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-sandbox-run-')));
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
  vi.stubEnv('HOME', tmp);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ask: SandboxAsk = {
  write: ['/w/proof', '/tmp'],
  noRead: ['/home/me/.ssh', '/home/me/.squad-kit'],
  read: ['/home/me/.squad-kit/worktrees/app-1/ap-1'],
  hosts: ['registry.npmjs.org', 'nexus.example.com'],
  outside: ['npx playwright screenshot'],
};

const optionsOf = (launch: ReturnType<typeof claudeLaunch>) => (launch.meta as { claudeCode: { options: Record<string, unknown> } }).claudeCode.options;

describe("Claude Code's sandbox settings", () => {
  it('turn the folders and hosts squad-kit asks for into the sandbox block, with no way out of it', () => {
    expect(claudeSandbox(ask, 'darwin', '/home/me')).toEqual({
      enabled: true,
      failIfUnavailable: false,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: ['registry.npmjs.org', 'nexus.example.com'], strictAllowlist: true, allowLocalBinding: true },
      filesystem: {
        allowWrite: ['/w/proof', '/tmp'],
        denyRead: ['/home/me/.ssh', '/home/me/.squad-kit', '/home/me/.claude/.credentials.json', '/home/me/.claude/projects', '/home/me/.claude.json'],
        allowRead: ['/home/me/.squad-kit/worktrees/app-1/ap-1'],
      },
      excludedCommands: ['npx playwright screenshot:*'],
    });
    // Listening on local ports is a macOS setting; a Linux sandbox has its own network.
    expect(claudeSandbox(ask, 'linux', '/home/me').network).toEqual({ allowedDomains: ask.hosts, strictAllowlist: true });
    expect(claudeSandbox({ ...ask, outside: [] }, 'linux', '/home/me')).not.toHaveProperty('excludedCommands');
  });

  it('go over ACP as the Agent SDK options, with the caps, and only when a step asks', () => {
    const options = optionsOf(claudeLaunch(claudeRunOptions({ cwd: tmp, prompt: 'x', permissions: ['edit'], sandbox: ask, caps: { turns: 300, spendUsd: 60 } }), '/adapter.js', '/bin/claude'));
    expect(options.sandbox).toEqual(claudeSandbox(ask));
    expect(options).toMatchObject({ maxTurns: 300, maxBudgetUsd: 60, allowDangerouslySkipPermissions: false });
    const plain = optionsOf(claudeLaunch(claudeRunOptions({ cwd: tmp, prompt: 'x', permissions: ['read'] }), '/adapter.js', '/bin/claude'));
    for (const key of ['sandbox', 'maxTurns', 'maxBudgetUsd']) expect(plain).not.toHaveProperty(key);
  });

  it('reach the adapter on session/new', async () => {
    const opts = claudeRunOptions({ cwd: tmp, prompt: 'options', permissions: ['edit'], sandbox: ask, caps: { turns: 300, spendUsd: 60 } });
    const r = await runAcp(claudeLaunch(opts, adapter, '/bin/claude'), { ...opts, timeoutMs: 20_000 });
    expect(r.ok).toBe(true);
    const got = JSON.parse(r.text) as Record<string, unknown>;
    expect(got).toMatchObject({ maxTurns: 300, maxBudgetUsd: 60, sandbox: claudeSandbox(ask) });
  });

  it('go to claude -p as the run\'s own settings, with the caps on the command line', async () => {
    // Only ever the stand-in: the real Claude Code is never started here.
    expect(claudeBinary()).toBe(path.join(bin, 'claude'));
    const args = JSON.parse((await runClaude({ ...claudeRunOptions({ cwd: tmp, prompt: 'x', permissions: ['edit'], sandbox: ask, caps: { turns: 300, spendUsd: 60 } }), timeoutMs: 20_000 })).text) as string[];
    expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toEqual({ sandbox: claudeSandbox(ask) });
    expect(args[args.indexOf('--max-turns') + 1]).toBe('300');
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('60');
    const plain = JSON.parse((await runClaude({ ...claudeRunOptions({ cwd: tmp, prompt: 'x', permissions: ['read'] }), timeoutMs: 20_000 })).text) as string[];
    for (const flag of ['--settings', '--max-turns', '--max-budget-usd']) expect(plain).not.toContain(flag);
  });
});

describe("a ticket's own package cache", () => {
  it('points NuGet, Maven, Gradle, RubyGems and Bundler at it, keeping the Maven options and gems already set', () => {
    const at = (...p: string[]) => path.join('/c/ap-1', ...p);
    expect(packageCacheEnv('/c/ap-1', { MAVEN_OPTS: ' -Xmx2g ', GEM_HOME: '/rvm/gems/ruby-3.1.0', GEM_PATH: `/rvm/gems/ruby-3.1.0${path.delimiter}/rvm/gems/ruby-3.1.0@global` })).toEqual({
      NUGET_PACKAGES: at('nuget', 'packages'),
      NUGET_HTTP_CACHE_PATH: at('nuget', 'http-cache'),
      NUGET_PLUGINS_CACHE_PATH: at('nuget', 'plugins-cache'),
      MAVEN_OPTS: `-Xmx2g -Dmaven.repo.local=${at('maven', 'repository')}`,
      GRADLE_USER_HOME: at('gradle'),
      GEM_HOME: at('ruby', 'gems'),
      // The gems already there stay usable, and the separator at the end adds Ruby's own.
      GEM_PATH: `/rvm/gems/ruby-3.1.0${path.delimiter}/rvm/gems/ruby-3.1.0@global${path.delimiter}`,
      GEM_SPEC_CACHE: at('ruby', 'specs'),
      BUNDLE_PATH: at('ruby', 'bundle'),
      BUNDLE_USER_CACHE: at('ruby', 'bundle-cache'),
    });
    // Nothing set before: Maven gets only its repository, RubyGems Ruby's own gems.
    expect(packageCacheEnv('/c/ap-1', {})).toMatchObject({ MAVEN_OPTS: `-Dmaven.repo.local=${at('maven', 'repository')}`, GEM_PATH: path.delimiter });
  });

  it('is writable and readable in the sandbox, though it sits inside squad-kit\'s own folder', () => {
    const cache = path.join(squadHome(), 'projects', 'app-1', 'caches', 'ap-1');
    fs.mkdirSync(cache, { recursive: true });
    const a = sandboxAsk({ cwd: '/copy', root: '/work/app', read: [], proof: '/proof', secrets: [], cache, home: tmp });
    expect(a.write).toContain(cache);
    expect(a.read).toContain(cache);
    expect(sandboxAsk({ cwd: '/copy', root: '/work/app', read: [], proof: '/proof', secrets: [], home: tmp }).write).not.toContain(cache);
  });

  it("reaches the commands' environment over ACP and directly", async () => {
    const env = packageCacheEnv('/c/ap-1', { MAVEN_OPTS: '-Xmx2g' });
    const want = { GEM_HOME: env.GEM_HOME, MAVEN_OPTS: env.MAVEN_OPTS };
    const opts = claudeRunOptions({ cwd: tmp, prompt: 'env', permissions: ['edit'], sandbox: ask, env });
    expect(claudeLaunch(opts, adapter, '/bin/claude').env).toMatchObject({ ...env, CLAUDE_CODE_EXECUTABLE: '/bin/claude' });
    expect(JSON.parse((await runAcp(claudeLaunch(opts, adapter, '/bin/claude'), { ...opts, timeoutMs: 20_000 })).text)).toEqual(want);
    expect(JSON.parse((await runClaude({ ...opts, timeoutMs: 20_000 })).text)).toEqual(want);
    // A step that asked for none changes nothing.
    expect(claudeLaunch(claudeRunOptions({ cwd: tmp, prompt: 'env', permissions: ['read'] }), adapter, '/bin/claude').env.GRADLE_USER_HOME).toBe(process.env.GRADLE_USER_HOME);
  });
});

describe("a step's sandbox", () => {
  it('writes only in its copy, the proof folder and temp folders, reads none of the keys, and reaches the registries and the project\'s hosts', () => {
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, '.npm', '_cacache'), { recursive: true });
    fs.mkdirSync(path.join(home, '.m2', 'repository'), { recursive: true });
    const cwd = path.join(squadHome(), 'worktrees', 'app-1', 'ap-1');
    const proof = path.join(squadHome(), 'projects', 'app-1', 'proof');
    const a = sandboxAsk({ cwd, root: '/work/app', read: ['/files'], proof, secrets: ['/work/app/.squad/secrets.yaml'], hosts: ['nexus.example.com'], home });
    expect(a.write).toEqual(expect.arrayContaining([proof, os.tmpdir(), path.join(home, '.npm', '_cacache')]));
    // A cache whose packages run unchecked stays read only.
    expect(a.write).not.toContain(path.join(home, '.m2', 'repository'));
    expect(a.write).not.toContain(cwd);
    expect(a.noRead).toEqual(
      expect.arrayContaining([
        ...['.ssh', '.aws', '.gnupg', '.config/gh'].map((p) => path.join(home, p)),
        fs.realpathSync(squadHome()),
        '/work/app/.squad/secrets.yaml',
        '/work/app/.env',
        '/work/app/**/.env',
        '/work/app/**/.env.*',
      ]),
    );
    // Inside squad-kit's folder, only what the step needs.
    expect(a.read).toEqual(expect.arrayContaining([cwd, proof, '/files']));
    expect(a.hosts).toEqual([...PACKAGE_HOSTS, 'nexus.example.com']);
    expect(a.hosts).toEqual(expect.arrayContaining(['registry.npmjs.org', 'pypi.org', 'repo1.maven.org', 'api.nuget.org', 'rubygems.org', 'crates.io', 'proxy.golang.org', 'objects.githubusercontent.com']));
    expect(a.outside).toBeUndefined();
    // The Tester's browser runs outside it, for its screenshot and install commands only.
    expect(sandboxAsk({ cwd, root: '/work/app', read: [], proof, secrets: [], browser: true, home }).outside).toEqual([
      'npx playwright screenshot',
      'npx -y playwright screenshot',
      'npx playwright install',
      'npx -y playwright install',
    ]);
  });

  it("takes host names only for the project's own list", () => {
    expect(parseHosts(['https://Nexus.Example.com/repo/', '*.corp.example.com', 'api.example.com:8443, pypi.example.org', 'nexus'])).toEqual({
      hosts: ['nexus.example.com', '*.corp.example.com', 'api.example.com', 'pypi.example.org', 'nexus'],
      bad: [],
    });
    // A lone "*" would open every host.
    expect(parseHosts(['*', 'exa_mple.com', '-bad.com']).bad).toEqual(['*', 'exa_mple.com', '-bad.com']);
  });
});

describe('a computer without the sandbox', () => {
  const host = (o: Partial<SandboxHost>): SandboxHost => ({ platform: 'linux', release: '6.8.0-45-generic', has: () => true, bwrapWorks: () => true, ...o });

  it('is found the way Claude Code checks, and says why and what to do', () => {
    expect(sandboxSupportOn(host({ platform: 'darwin' }))).toEqual({ available: true, why: "Claude Code's sandbox (macOS Seatbelt)" });
    expect(sandboxSupportOn(host({}))).toEqual({ available: true, why: "Claude Code's sandbox (bubblewrap)" });
    expect(sandboxSupportOn(host({ release: '5.15.153.1-microsoft-standard-WSL2' })).available).toBe(true);
    expect(sandboxSupportOn(host({ platform: 'win32' }))).toEqual({ available: false, why: "Claude Code's sandbox does not run on Windows yet" });
    expect(sandboxSupportOn(host({ release: '4.4.0-19041-Microsoft' }))).toMatchObject({ available: false, why: 'WSL 1 has no sandbox' });
    expect(sandboxSupportOn(host({ has: (p) => p !== 'socat' }))).toEqual({ available: false, why: 'socat is not installed', fix: 'Install it, for example: sudo apt install socat' });
    expect(sandboxSupportOn(host({ has: () => false }))).toEqual({
      available: false,
      why: 'bubblewrap and socat are not installed',
      fix: 'Install them, for example: sudo apt install bubblewrap socat',
    });
    // Installed, but this Linux does not let programs make their own sandbox.
    expect(sandboxSupportOn(host({ bwrapWorks: () => false }))).toMatchObject({ available: false, why: 'bubblewrap cannot make a sandbox on this Linux' });
  });

  it('has a row in squad doctor', () => {
    expect(checkAgentSandbox([{ tool: 'Claude Code', available: true, why: "Claude Code's sandbox (macOS Seatbelt)" }])).toEqual({
      id: 'agent-sandbox',
      name: 'sandbox for the Builder and Tester',
      status: 'ok',
      detail: "Claude Code's sandbox (macOS Seatbelt)",
    });
    expect(checkAgentSandbox([{ tool: 'Claude Code', available: false, why: 'socat is not installed', fix: 'Install it, for example: sudo apt install socat' }])).toEqual({
      id: 'agent-sandbox',
      name: 'sandbox for the Builder and Tester',
      status: 'warn',
      detail: 'Claude Code: socat is not installed. Steps run without it, as before',
      fixHint: 'Install it, for example: sudo apt install socat',
    });
  });

  it('is what Claude Code says on this computer', () => {
    const s = claudeTool.sandbox!();
    expect(typeof s.available).toBe('boolean');
    expect(s.why).toBeTruthy();
  });
});

describe('what the sandbox refused', () => {
  it("is read from Claude Code's report in a command's output, each thing once", () => {
    expect(claudeBlocked(VIOLATIONS)).toEqual([
      { kind: 'host', target: 'example.com' },
      { kind: 'read', target: '/Users/me/.ssh/id_rsa' },
      { kind: 'write', target: '/Users/me/Documents/notes.txt' },
    ]);
    expect(claudeBlocked('npm ERR! 404 Not Found')).toEqual([]);
    expect(claudeBlocked('<sandbox_violations>\ndeny network-outbound [2001:db8::1]:443 (not_allowlisted)\n</sandbox_violations>')).toEqual([{ kind: 'host', target: '2001:db8::1' }]);
  });

  it('is said in plain words, with the way to allow a host', () => {
    expect(blockedLine({ kind: 'host', target: 'example.com' })).toBe('Reaching example.com was blocked: not a package registry. Allow it in Settings.');
    expect(blockedLine({ kind: 'read', target: '/Users/me/.ssh/id_rsa' }, '/Users/me')).toBe('Reading ~/.ssh/id_rsa was blocked: keys and sign-ins stay private.');
    expect(blockedLine({ kind: 'read', target: '/Users/me/app/.env.local' }, '/Users/me')).toBe("Reading ~/app/.env.local was blocked: the project's .env files stay private.");
    expect(blockedLine({ kind: 'read', target: path.join(squadHome(), 'projects', 'x', 'secrets.yaml') }, '/nowhere')).toMatch(/was blocked: squad-kit's own files stay private\.$/);
    expect(blockedLine({ kind: 'write', target: '/Users/me/Documents/notes.txt' }, '/Users/me')).toBe(
      "Writing ~/Documents/notes.txt was blocked: the squad writes only in the ticket's copy, the proof folder and temp folders.",
    );
  });

  it('reaches the step as it happens, over ACP and directly', async () => {
    const acp: BlockedAction[] = [];
    const opts = claudeRunOptions({ cwd: tmp, prompt: 'blocked', permissions: ['edit'], sandbox: ask, onBlocked: (b) => acp.push(b) });
    await runAcp(claudeLaunch(opts, adapter, '/bin/claude'), { ...opts, timeoutMs: 20_000 });
    expect(acp.map((b) => b.target)).toEqual(['example.com', '/Users/me/.ssh/id_rsa', '/Users/me/Documents/notes.txt']);
    const direct: BlockedAction[] = [];
    await runClaude({ ...claudeRunOptions({ cwd: tmp, prompt: 'blocked', permissions: ['edit'], sandbox: ask, onBlocked: (b) => direct.push(b) }), timeoutMs: 20_000 });
    expect(direct).toEqual(acp);
  });

  it('shows on the command in the Conversation tab, from an ACP log and from a Claude Code session file', () => {
    const id = 'aaaaaaaa-1111-2222-3333-444444444444';
    const chats = path.join(tmp, 'chats');
    fs.mkdirSync(chats);
    const line = (update: object) => JSON.stringify({ at: '2026-11-03T10:00:00.000Z', update });
    fs.writeFileSync(
      path.join(chats, `${id}.jsonl`),
      [
        line({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'npm install', kind: 'execute', status: 'in_progress' }),
        line({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: VIOLATIONS } }] }),
        line({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'It failed.' } }),
      ].join('\n'),
    );
    const projects = path.join(tmp, 'claude-projects');
    const fromLog = readConversation(id, 400, projects, chats)!;
    const blockedOf = (c: NonNullable<ReturnType<typeof readConversation>>) =>
      c.updates.map((e) => (e.update as { _meta?: { squadKit?: { blocked?: string[] } } })._meta?.squadKit?.blocked).filter(Boolean);
    const words = ['Reaching example.com was blocked: not a package registry. Allow it in Settings.', expect.stringContaining('Reading /Users/me/.ssh/id_rsa was blocked'), expect.stringContaining('Writing /Users/me/Documents/notes.txt was blocked')];
    expect(blockedOf(fromLog)).toEqual([words]);

    // A direct run: the output is long, so what is shown is cut short, but the refusal at its end still counts.
    const other = 'bbbbbbbb-1111-2222-3333-444444444444';
    fs.mkdirSync(path.join(projects, '-work-app'), { recursive: true });
    fs.writeFileSync(
      path.join(projects, '-work-app', `${other}.jsonl`),
      [
        JSON.stringify({ type: 'assistant', cwd: '/work/app', timestamp: '2026-11-03T10:00:00.000Z', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm install' } }] } }),
        JSON.stringify({ type: 'user', timestamp: '2026-11-03T10:00:05.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: `${'npm http fetch\n'.repeat(600)}${VIOLATIONS}` }] } }),
      ].join('\n'),
    );
    expect(blockedOf(readConversation(other, 400, projects)!)).toEqual([words]);
  });
});

describe('caps', () => {
  it('come from the Quality setting, per role and step, and double with each Give it more', () => {
    expect(stepCaps({ role: 'builder', step: 'build', quality: 'best' })).toEqual({ turns: 300, spendUsd: 60 });
    expect(stepCaps({ role: 'builder', step: 'build', quality: 'balanced' })).toEqual({ turns: 240, spendUsd: 36 });
    expect(stepCaps({ role: 'builder', step: 'build', quality: 'thrifty' })).toEqual({ turns: 180, spendUsd: 18 });
    expect(stepCaps({ role: 'builder', step: 'fix' })).toEqual({ turns: 150, spendUsd: 30 });
    expect(stepCaps({ role: 'tester', step: 'proof', quality: 'thrifty' })).toEqual({ turns: 48, spendUsd: 3 });
    expect(stepCaps({ role: 'reviewer', step: 'chat' })).toEqual({ turns: 40, spendUsd: 8 });
    expect(stepCaps({ role: 'builder', step: 'build', quality: 'best' }, 2)).toEqual({ turns: 1200, spendUsd: 240 });
    // Every setting caps less than the one above it.
    for (const role of ['analyst', 'architect', 'builder', 'reviewer', 'tester']) {
      const [best, balanced, thrifty] = (['best', 'balanced', 'thrifty'] as const).map((quality) => stepCaps({ role, step: 'x', quality }));
      expect(best!.turns).toBeGreaterThan(balanced!.turns);
      expect(balanced!.turns).toBeGreaterThan(thrifty!.turns);
      expect(best!.spendUsd).toBeGreaterThan(thrifty!.spendUsd);
    }
  });

  it('stop a direct run with the work kept, on turns or on spend', async () => {
    const caps = { turns: 300, spendUsd: 60 };
    const run = (prompt: string) => claudeTool.run({ cwd: tmp, prompt, permissions: ['edit'], direct: true, caps, timeoutMs: 20_000 });
    expect(await run('turns')).toMatchObject({ ok: false, capped: { by: 'turns' }, error: 'It used the 300 turns this step may take.' });
    expect(await run('spend')).toMatchObject({ ok: false, capped: { by: 'spend' }, error: 'It reached the $60 this step may spend.' });
  });

  it('stop a run over ACP: max_turn_requests is a cap, and the spend when the run got to its spend cap', async () => {
    const opts = claudeRunOptions({ cwd: tmp, prompt: 'cap', permissions: ['edit'], caps: { turns: 300, spendUsd: 60 } });
    const r = await runAcp(claudeLaunch(opts, adapter, '/bin/claude'), { ...opts, timeoutMs: 20_000 });
    expect(r).toMatchObject({ ok: false, capped: { by: 'turns' } });
    expect(withCap(r, { turns: 300, spendUsd: 60 })).toMatchObject({ capped: { by: 'spend' }, error: 'It reached the $60 this step may spend.' });
    expect(withCap(r, { turns: 300, spendUsd: 100 })).toMatchObject({ capped: { by: 'turns' }, error: 'It used the 300 turns this step may take.' });
  });

  it("read Claude Code's own words when the adapter fails the turn instead, and nothing else", () => {
    const failed = { ok: false, sessionId: 's', text: '', error: 'Internal error', detail: 'Internal error: Reached maximum budget ($60)' };
    expect(withCap(failed, { turns: 300, spendUsd: 60 })).toMatchObject({ capped: { by: 'spend' } });
    expect(withCap({ ...failed, detail: 'Internal error: Reached maximum number of turns (300)' }, { turns: 300 })).toMatchObject({ capped: { by: 'turns' } });
    // A run that was given no caps, a real error and the usage limit stay what they are.
    expect(withCap(failed, undefined)).not.toHaveProperty('capped');
    expect(withCap({ ...failed, detail: 'API Error: 500' }, { turns: 300 })).not.toHaveProperty('capped');
    expect(withCap({ ...failed, limit: { name: 'Claude' } }, { turns: 300, spendUsd: 60 })).not.toHaveProperty('capped');
  });
});
