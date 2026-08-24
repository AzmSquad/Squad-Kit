import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDoctor } from '../src/commands/doctor.js';
import { buildPaths, SQUAD_DIR } from '../src/core/paths.js';
import { saveConfig, loadConfig, DEFAULT_CONFIG, type SquadConfig } from '../src/core/config.js';
import { ensureGitignore } from '../src/core/gitignore.js';
import { PLANNER_MODEL_MAP } from '../src/core/planner-models.js';
import { PlannerAuthRuntimeMismatchError } from '../src/planner/runtimes/index.js';
import type { CheckResult } from '../src/commands/doctor-engine.js';
import type { PlannerConfig } from '../src/planner/types.js';
import type { LoginProbe } from '../src/core/planner-auth.js';
import type { ClaudeBinary } from '../src/core/claude-binary.js';
import type { ProbeClaudeAuthResult } from '../src/planner/runtimes/auth-probe.js';

/**
 * Doctor's auth checks are the one place that touches the machine's real Claude login and can spawn
 * an Agent SDK subprocess. Both are stubbed here so the suite asserts the same thing on a laptop
 * with a live login and on a CI box with none.
 */
const h = vi.hoisted(() => ({
  state: {
    login: undefined as unknown,
    binary: undefined as unknown,
  },
  probe: vi.fn(),
}));

vi.mock('../src/core/planner-auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/planner-auth.js')>();
  return { ...actual, detectClaudeLogin: () => h.state.login };
});

vi.mock('../src/planner/runtimes/auth-probe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/planner/runtimes/auth-probe.js')>();
  return { ...actual, probeClaudeAuth: h.probe };
});

vi.mock('../src/core/claude-binary.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/claude-binary.js')>();
  return { ...actual, resolveClaudeBinary: () => h.state.binary };
});

const NO_LOGIN: LoginProbe = { present: false, hint: 'none', detail: 'no Claude login detected' };
const KEYCHAIN_LOGIN: LoginProbe = { present: true, hint: 'credential-store', detail: 'macOS Keychain' };
const BUNDLED_BINARY: ClaudeBinary = { path: '/pkg/claude', source: 'bundled' };

function setLogin(login: LoginProbe): void {
  h.state.login = login;
}
function setBinary(binary: ClaudeBinary | undefined): void {
  h.state.binary = binary;
}
function setProbe(result: ProbeClaudeAuthResult): void {
  h.probe.mockResolvedValue(result);
}

let tmp: string;
let previousCwd: string;
let exitMock: MockInstance<typeof process.exit>;

function plannerFor(overrides: Partial<PlannerConfig> = {}): PlannerConfig {
  return {
    enabled: true,
    provider: 'anthropic',
    mode: 'auto',
    budget: { maxFileReads: 10, maxContextBytes: 20_000, maxDurationSeconds: 60 },
    ...overrides,
  } as PlannerConfig;
}

function installWorkspace(planner?: PlannerConfig): SquadConfig {
  fs.mkdirSync(path.join(tmp, SQUAD_DIR, 'stories'), { recursive: true });
  fs.mkdirSync(path.join(tmp, SQUAD_DIR, 'plans'), { recursive: true });
  const cfg: SquadConfig = { ...DEFAULT_CONFIG, planner };
  saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), cfg);
  ensureGitignore(tmp);
  return cfg;
}

async function doctorChecks(opts: { fix?: boolean } = {}): Promise<CheckResult[]> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  });
  try {
    await runDoctor({ json: true, ...opts });
    return (JSON.parse(chunks.join('')) as { checks: CheckResult[] }).checks;
  } finally {
    spy.mockRestore();
  }
}

function row(checks: CheckResult[], id: string): CheckResult {
  const found = checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check with id ${id}; got ${checks.map((c) => c.id).join(', ')}`);
  return found;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-doctor-auth-'));
  previousCwd = process.cwd();
  process.chdir(tmp);
  exitMock = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  setLogin(NO_LOGIN);
  setBinary(BUNDLED_BINARY);
  setProbe({ ok: false, kind: 'unknown', detail: 'test did not configure a probe result' });
});

afterEach(() => {
  process.chdir(previousCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── 1 / 8. subscription workspace, logged in ────────────────────────────────

describe('doctor — subscription workspace, logged in', () => {
  beforeEach(() => {
    installWorkspace(plannerFor({ auth: { anthropic: 'subscription' } }));
    setLogin(KEYCHAIN_LOGIN);
    setProbe({
      ok: true,
      apiKeySource: 'oauth',
      account: { email: 'dev@example.com', subscriptionType: 'max' },
    });
  });

  it('reports the mode, verifies the login, skips the keyed model probe, and exits 0', async () => {
    const checks = await doctorChecks();

    const mode = row(checks, 'planner-auth-mode');
    expect(mode.status).toBe('ok');
    expect(mode.detail).toContain('subscription');
    expect(mode.detail).toContain('Claude login (macOS Keychain)');

    const cred = row(checks, 'planner-cred');
    expect(cred.status).toBe('ok');
    expect(cred.detail).toContain('dev@example.com');
    expect(cred.detail).toContain('max');
    expect(cred.detail).toContain('apiKeySource=oauth');

    const model = row(checks, 'planner-model');
    expect(model.status).toBe('skip');
    expect(model.detail).toBe('model list needs an API key; skipped in subscription mode');

    expect(row(checks, 'planner-auth-runtime-fit').status).toBe('ok');
    expect(checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(exitMock).not.toHaveBeenCalled();
  });

  it('probes the login exactly once per doctor run', async () => {
    await doctorChecks();
    expect(h.probe).toHaveBeenCalledTimes(1);
  });
});

// ── 2. subscription workspace, not logged in ───────────────────────────────

describe('doctor — subscription workspace, not logged in', () => {
  it('fails planner-cred with the squad auth login hint and exits 1', async () => {
    installWorkspace(plannerFor({ auth: { anthropic: 'subscription' } }));
    setLogin(NO_LOGIN);
    setProbe({ ok: false, kind: 'not-logged-in', detail: 'No Claude credential was accepted.' });

    const checks = await doctorChecks();
    const cred = row(checks, 'planner-cred');
    expect(cred.status).toBe('fail');
    expect(cred.fixHint).toContain('squad auth login');
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it('fails from the offline signal when the live check only times out', async () => {
    installWorkspace(plannerFor({ auth: { anthropic: 'subscription' } }));
    setLogin(NO_LOGIN);
    setProbe({ ok: false, kind: 'timeout', detail: 'The Claude auth check did not answer within 10000ms.' });

    const checks = await doctorChecks();
    const cred = row(checks, 'planner-cred');
    expect(cred.status).toBe('fail');
    expect(cred.detail).toContain('no Claude login detected');
    expect(cred.fixHint).toContain('squad auth login');
  });

  it('warns rather than fails when a login exists and the live check times out', async () => {
    installWorkspace(plannerFor({ auth: { anthropic: 'subscription' } }));
    setLogin(KEYCHAIN_LOGIN);
    setProbe({ ok: false, kind: 'timeout', detail: 'The Claude auth check did not answer within 10000ms.' });

    const checks = await doctorChecks();
    expect(row(checks, 'planner-cred').status).toBe('warn');
    expect(exitMock).not.toHaveBeenCalled();
  });
});

describe('doctor — planner tier check vs auth mode', () => {
  it('skips the API rate-tier check on subscription auth', async () => {
    installWorkspace(plannerFor({ auth: { anthropic: 'subscription' } }));
    setLogin(KEYCHAIN_LOGIN);
    setProbe({ ok: true, account: { email: 'dev@example.com' } });

    const tier = row(await doctorChecks(), 'planner-tier');
    expect(tier.status).toBe('skip');
    expect(tier.detail).toContain('no API rate tier');
  });

  it('still warns about Tier 1 with Opus on api-key auth', async () => {
    installWorkspace(plannerFor({ auth: { anthropic: 'api-key' } }));
    setLogin(NO_LOGIN);
    process.env.ANTHROPIC_API_KEY = 'sk-test';

    expect(row(await doctorChecks(), 'planner-tier').status).toBe('warn');
  });
});

// ── 3 / 9. api-key workspace parity with 0.11.0 ────────────────────────────

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'doctor-api-key-checks.json',
);

interface DoctorFixture {
  note: string;
  intendedDeltas: string[];
  v0110: CheckResult[];
  current: CheckResult[];
}

describe('doctor — api-key workspace', () => {
  beforeEach(() => {
    installWorkspace(plannerFor());
    setLogin(NO_LOGIN);
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: PLANNER_MODEL_MAP.anthropic.plan }] }), { status: 200 }),
      ),
    );
  });

  it('matches the stored fixture and differs from 0.11.0 only in the intended rows', async () => {
    const checks = await doctorChecks();

    if (process.env.UPDATE_DOCTOR_FIXTURE) {
      const existing = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as DoctorFixture;
      fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify({ ...existing, current: checks }, null, 2)}\n`, 'utf8');
    }
    const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as DoctorFixture;

    // Drift in any row — new detail text, changed hint, reordered checks — fails here.
    expect(checks).toEqual(fixture.current);

    const before = new Map(fixture.v0110.map((c) => [c.id, JSON.stringify(c)]));
    const after = new Map(checks.map((c) => [c.id, JSON.stringify(c)]));
    const changed = [...new Set([...before.keys(), ...after.keys()])]
      .filter((id) => before.get(id) !== after.get(id))
      .sort();
    expect(changed).toEqual([...fixture.intendedDeltas].sort());

    // The 0.11.0 rows keep their identity and their relative order.
    expect(checks.map((c) => c.id).filter((id) => before.has(id))).toEqual(fixture.v0110.map((c) => c.id));
    expect(row(checks, 'planner-cred')).toEqual(row(fixture.v0110, 'planner-cred'));
    expect(row(checks, 'planner-model')).toEqual(row(fixture.v0110, 'planner-model'));
  });

  it('--json stays additive: every 0.11.0 id is present and no new field shapes appear', async () => {
    const checks = await doctorChecks();
    const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as DoctorFixture;
    const ids = new Set(checks.map((c) => c.id));
    for (const legacy of fixture.v0110) expect(ids.has(legacy.id)).toBe(true);
    for (const check of checks) {
      expect(typeof check.id).toBe('string');
      expect(typeof check.name).toBe('string');
      expect(check.status).toMatch(/^(ok|warn|fail|skip)$/);
      expect(Object.keys(check).sort()).toEqual(
        Object.keys(check)
          .filter((k) => ['id', 'name', 'status', 'detail', 'fixHint', 'fixable'].includes(k))
          .sort(),
      );
    }
  });

  it('never runs the live login probe when a key is what resolved', async () => {
    await doctorChecks();
    expect(h.probe).not.toHaveBeenCalled();
  });
});

// ── 4. auto with both credentials ──────────────────────────────────────────

describe('doctor — auto mode with a key and a login', () => {
  it('picks the subscription and says the API key is being ignored', async () => {
    installWorkspace(plannerFor());
    setLogin(KEYCHAIN_LOGIN);
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    setProbe({ ok: true, apiKeySource: 'oauth', account: { email: 'dev@example.com' } });

    const checks = await doctorChecks();
    const mode = row(checks, 'planner-auth-mode');
    expect(mode.status).toBe('ok');
    expect(mode.detail).toContain('subscription');
    expect(mode.detail).toContain('ignoring');
    expect(mode.detail).toContain('ANTHROPIC_API_KEY');
  });
});

// ── 5. runtime mismatch ────────────────────────────────────────────────────

describe('doctor — subscription auth with the vercel runtime', () => {
  it('fails planner-auth-runtime-fit with the same message the runtime throws', async () => {
    installWorkspace(
      plannerFor({ auth: { anthropic: 'subscription' }, runtime: { anthropic: 'vercel' } }),
    );
    setLogin(KEYCHAIN_LOGIN);
    setProbe({ ok: true, account: { email: 'dev@example.com' } });

    const checks = await doctorChecks();
    const fit = row(checks, 'planner-auth-runtime-fit');
    expect(fit.status).toBe('fail');
    expect(fit.fixHint).toBe(new PlannerAuthRuntimeMismatchError('anthropic', 'vercel').message);
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it('fails when subscription auth is configured for an api-key-only provider', async () => {
    installWorkspace(plannerFor({ provider: 'openai', auth: { anthropic: 'subscription' } }));
    process.env.OPENAI_API_KEY = 'sk-openai';
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 })),
    );

    const checks = await doctorChecks();
    const fit = row(checks, 'planner-auth-runtime-fit');
    expect(fit.status).toBe('fail');
    expect(fit.fixHint).toBe(new PlannerAuthRuntimeMismatchError('openai', 'vercel').message);
    expect(row(checks, 'planner-auth-mode').status).toBe('skip');
  });
});

// ── 6. platform binary missing ─────────────────────────────────────────────

describe('doctor — Agent SDK platform binary', () => {
  it('warns in api-key mode and fails in subscription mode', async () => {
    installWorkspace(plannerFor());
    setBinary(undefined);
    setLogin(NO_LOGIN);
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: PLANNER_MODEL_MAP.anthropic.plan }] }), { status: 200 }),
      ),
    );

    const apiKeyChecks = await doctorChecks();
    const apiKeyRow = row(apiKeyChecks, 'agent-sdk-binary-present');
    expect(apiKeyRow.status).toBe('warn');
    expect(apiKeyRow.fixHint).toContain('claude');

    delete process.env.ANTHROPIC_API_KEY;
    saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), {
      ...DEFAULT_CONFIG,
      planner: plannerFor({ auth: { anthropic: 'subscription' } }),
    });
    setLogin(KEYCHAIN_LOGIN);
    setProbe({ ok: true, account: { email: 'dev@example.com' } });

    const subscriptionChecks = await doctorChecks();
    expect(row(subscriptionChecks, 'agent-sdk-binary-present').status).toBe('fail');
  });

  it('names the binary source when both the package and the executable resolve', async () => {
    installWorkspace(plannerFor({ auth: { anthropic: 'subscription' } }));
    setLogin(KEYCHAIN_LOGIN);
    setProbe({ ok: true, account: { email: 'dev@example.com' } });

    const checks = await doctorChecks();
    expect(row(checks, 'agent-sdk-binary-present').detail).toBe('package + bundled binary');
  });
});

// ── 7. CI skips every live probe ───────────────────────────────────────────

describe('doctor — automation', () => {
  it('runs no login probe under CI and answers from the offline signal', async () => {
    process.env.CI = '1';
    installWorkspace(plannerFor({ auth: { anthropic: 'subscription' } }));
    setLogin(KEYCHAIN_LOGIN);

    const checks = await doctorChecks();
    expect(h.probe).not.toHaveBeenCalled();
    const cred = row(checks, 'planner-cred');
    expect(cred.status).toBe('ok');
    expect(cred.detail).toContain('offline check only');
    expect(exitMock).not.toHaveBeenCalled();
  });

  it('warns instead of failing under CI when nothing local says there is a login', async () => {
    process.env.CI = '1';
    installWorkspace(plannerFor({ auth: { anthropic: 'subscription' } }));
    setLogin(NO_LOGIN);

    const checks = await doctorChecks();
    expect(h.probe).not.toHaveBeenCalled();
    const cred = row(checks, 'planner-cred');
    expect(cred.status).toBe('warn');
    expect(cred.detail).toContain('offline check only');
    expect(exitMock).not.toHaveBeenCalled();
  });
});

// ── --fix stays non-destructive ────────────────────────────────────────────

describe('doctor --fix', () => {
  it('never pins an implicitly-resolved api-key mode, so a later login can still take over', async () => {
    installWorkspace(plannerFor());
    setLogin(NO_LOGIN);
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: PLANNER_MODEL_MAP.anthropic.plan }] }), { status: 200 }),
      ),
    );

    const configFile = buildPaths(tmp).configFile;
    const before = fs.readFileSync(configFile, 'utf8');
    expect(row(await doctorChecks(), 'planner-auth-mode').fixable).toBeUndefined();

    await doctorChecks({ fix: true });

    // `auto` is what lets a Claude login take over once one exists. Pinning `api-key` would quietly
    // prevent that forever, so --fix must leave the file untouched rather than "tidy" it.
    expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
    expect(loadConfig(configFile).planner?.auth?.anthropic).toBe('auto');
    expect(fs.existsSync(buildPaths(tmp).secretsFile)).toBe(false);

    const row_ = row(await doctorChecks(), 'planner-auth-mode');
    expect(row_.status).toBe('ok');
    expect(row_.fixHint).toContain('squad auth login');
  });

  it('leaves a conflicting planner.runtime.anthropic in place and only prints the hint', async () => {
    installWorkspace(
      plannerFor({ auth: { anthropic: 'subscription' }, runtime: { anthropic: 'vercel' } }),
    );
    setLogin(KEYCHAIN_LOGIN);
    setProbe({ ok: true, account: { email: 'dev@example.com' } });

    await doctorChecks({ fix: true });
    expect(loadConfig(buildPaths(tmp).configFile).planner?.runtime?.anthropic).toBe('vercel');
  });
});
