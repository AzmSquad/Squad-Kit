import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDoctor } from '../src/commands/doctor.js';
import { saveConfig, DEFAULT_CONFIG, type SquadConfig } from '../src/core/config.js';
import { SQUAD_DIR } from '../src/core/paths.js';
import { ensureGitignore } from '../src/core/gitignore.js';
import { PLANNER_MODEL_MAP } from '../src/core/planner-models.js';

type FetchInput = Parameters<typeof globalThis.fetch>[0];

let tmp: string;
let previousCwd: string;
let exitMock: MockInstance<typeof process.exit>;

function installWorkspace(cfg: SquadConfig = DEFAULT_CONFIG): void {
  fs.mkdirSync(path.join(tmp, SQUAD_DIR, 'stories'), { recursive: true });
  fs.mkdirSync(path.join(tmp, SQUAD_DIR, 'plans'), { recursive: true });
  saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), cfg);
}

function captureStdout(): { text(): string; restore(): void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  });
  return {
    text: () => chunks.join(''),
    restore: () => spy.mockRestore(),
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-doctor-'));
  previousCwd = process.cwd();
  process.chdir(tmp);
  exitMock = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
});

afterEach(() => {
  process.chdir(previousCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('runDoctor', () => {
  it('exits 1 when no .squad/config.yaml is found', async () => {
    exitMock.mockRestore();
    exitMock = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`EXIT:${code ?? ''}`);
    });
    await expect(runDoctor({})).rejects.toThrow('EXIT:1');
  });

  it('happy path: ok/skip only, exit 0', async () => {
    installWorkspace();
    ensureGitignore(tmp);
    await runDoctor({});
    expect(exitMock).not.toHaveBeenCalled();
  });

  it('warns when .gitignore managed block is missing; --fix repairs', async () => {
    installWorkspace();
    const capWarn = captureStdout();
    try {
      await runDoctor({ json: true });
      const j = JSON.parse(capWarn.text()) as { checks: { id: string; status: string }[] };
      const g = j.checks.find((c) => c.id === 'gitignore');
      expect(g?.status).toBe('warn');
    } finally {
      capWarn.restore();
    }
    expect(exitMock).not.toHaveBeenCalled();

    await runDoctor({ fix: true });
    const capOk = captureStdout();
    try {
      await runDoctor({ json: true });
      const j2 = JSON.parse(capOk.text()) as { checks: { id: string; status: string }[] };
      const g2 = j2.checks.find((c) => c.id === 'gitignore');
      expect(g2?.status).toBe('ok');
    } finally {
      capOk.restore();
    }
    expect(fs.readFileSync(path.join(tmp, '.gitignore'), 'utf8')).toContain('.squad/secrets.yaml');
  });

  it('legacy .squad/prompts/ warns with migrate hint; --fix does not remove it', async () => {
    installWorkspace();
    ensureGitignore(tmp);
    const legacyDir = path.join(tmp, SQUAD_DIR, 'prompts');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'generate-plan.md'), 'x', 'utf8');

    const cap = captureStdout();
    try {
      await runDoctor({ json: true });
      const j = JSON.parse(cap.text()) as { checks: { id: string; status: string; fixHint?: string }[] };
      const row = j.checks.find((c) => c.id === 'legacy-prompts');
      expect(row?.status).toBe('warn');
      expect(row?.fixHint).toContain('migrate');
    } finally {
      cap.restore();
    }

    await runDoctor({ fix: true });
    expect(fs.existsSync(path.join(legacyDir, 'generate-plan.md'))).toBe(true);
  });

  it('malformed secrets.yaml fails parse check', async () => {
    installWorkspace();
    ensureGitignore(tmp);
    fs.writeFileSync(path.join(tmp, SQUAD_DIR, 'secrets.yaml'), 'foo: [', 'utf8');

    exitMock.mockRestore();
    exitMock = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`EXIT:${code ?? ''}`);
    });
    await expect(runDoctor({ json: true })).rejects.toThrow('EXIT:1');
  });

  it('planner enabled without API key fails credential check', async () => {
    const prevAnthropic = process.env.ANTHROPIC_API_KEY;
    const prevFallback = process.env.SQUAD_PLANNER_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.SQUAD_PLANNER_API_KEY;
    try {
      installWorkspace({
        ...DEFAULT_CONFIG,
        planner: {
          enabled: true,
          provider: 'anthropic',
          mode: 'auto',
          budget: {
            maxFileReads: 10,
            maxContextBytes: 20_000,
            maxDurationSeconds: 60,
          },
        },
      });
      ensureGitignore(tmp);

      exitMock.mockRestore();
      exitMock = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`EXIT:${code ?? ''}`);
      });
      await expect(runDoctor({ json: true })).rejects.toThrow('EXIT:1');
    } finally {
      if (prevAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = prevAnthropic;
      else delete process.env.ANTHROPIC_API_KEY;
      if (prevFallback !== undefined) process.env.SQUAD_PLANNER_API_KEY = prevFallback;
      else delete process.env.SQUAD_PLANNER_API_KEY;
    }
  });

  it('planner model probe succeeds when /v1/models lists pinned id', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ id: PLANNER_MODEL_MAP.anthropic.plan }, { id: 'other' }],
          }),
          { status: 200 },
        ),
      ),
    );
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    try {
      installWorkspace({
        ...DEFAULT_CONFIG,
        planner: {
          enabled: true,
          provider: 'anthropic',
          mode: 'auto',
          budget: {
            maxFileReads: 10,
            maxContextBytes: 20_000,
            maxDurationSeconds: 60,
          },
        },
      });
      ensureGitignore(tmp);

      const cap = captureStdout();
      try {
        await runDoctor({ json: true });
        const j = JSON.parse(cap.text()) as { checks: { id: string; status: string }[] };
        const row = j.checks.find((c) => c.id === 'planner-model');
        expect(row?.status).toBe('ok');
      } finally {
        cap.restore();
      }
      expect(exitMock).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('planner model probe fails when pinned id is missing from provider list', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ data: [{ id: 'some-other-model' }] }), { status: 200 })),
    );
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    try {
      installWorkspace({
        ...DEFAULT_CONFIG,
        planner: {
          enabled: true,
          provider: 'anthropic',
          mode: 'auto',
          budget: {
            maxFileReads: 10,
            maxContextBytes: 20_000,
            maxDurationSeconds: 60,
          },
        },
      });
      ensureGitignore(tmp);

      const cap = captureStdout();
      exitMock.mockRestore();
      exitMock = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`EXIT:${code ?? ''}`);
      });
      try {
        await expect(runDoctor({ json: true })).rejects.toThrow('EXIT:1');
        const j = JSON.parse(cap.text()) as {
          checks: { id: string; status: string; fixHint?: string }[];
        };
        const row = j.checks.find((c) => c.id === 'planner-model');
        expect(row?.status).toBe('fail');
        expect(row?.fixHint).toBeTruthy();
      } finally {
        cap.restore();
      }
    } finally {
      fetchSpy.mockRestore();
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('planner model probe warns when fetch throws', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ENOTFOUND'));
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    try {
      installWorkspace({
        ...DEFAULT_CONFIG,
        planner: {
          enabled: true,
          provider: 'anthropic',
          mode: 'auto',
          budget: {
            maxFileReads: 10,
            maxContextBytes: 20_000,
            maxDurationSeconds: 60,
          },
        },
      });
      ensureGitignore(tmp);

      const cap = captureStdout();
      try {
        await runDoctor({ json: true });
        const j = JSON.parse(cap.text()) as { checks: { id: string; status: string }[] };
        const row = j.checks.find((c) => c.id === 'planner-model');
        expect(row?.status).toBe('warn');
      } finally {
        cap.restore();
      }
      expect(exitMock).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('tracker none skips tracker checks', async () => {
    installWorkspace({ ...DEFAULT_CONFIG, tracker: { type: 'none' } });
    ensureGitignore(tmp);
    const cap = captureStdout();
    try {
      await runDoctor({ json: true });
      const j = JSON.parse(cap.text()) as { checks: { id: string; status: string }[] };
      for (const id of ['tracker-config', 'tracker-cred', 'tracker-live']) {
        const row = j.checks.find((c) => c.id === id);
        expect(row?.status).toBe('skip');
      }
    } finally {
      cap.restore();
    }
  });

  it('tracker jira configured without credentials fails credential check', async () => {
    installWorkspace({
      ...DEFAULT_CONFIG,
      tracker: { type: 'jira', workspace: 'example.atlassian.net' },
    });
    ensureGitignore(tmp);

    exitMock.mockRestore();
    exitMock = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`EXIT:${code ?? ''}`);
    });
    await expect(runDoctor({ json: true })).rejects.toThrow('EXIT:1');
  });

  it('tracker jira connectivity ok on 200 /myself', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input: FetchInput) => {
      const u = String(input);
      if (u.includes('/rest/api/3/myself')) {
        return Promise.resolve(new Response(JSON.stringify({ name: 'me' }), { status: 200 }));
      }
      return Promise.resolve(new Response('noop', { status: 500 }));
    });
    installWorkspace({
      ...DEFAULT_CONFIG,
      tracker: { type: 'jira', workspace: 'example.atlassian.net' },
    });
    ensureGitignore(tmp);
    fs.writeFileSync(
      path.join(tmp, SQUAD_DIR, 'secrets.yaml'),
      [
        'tracker:',
        '  jira:',
        '    host: example.atlassian.net',
        '    email: a@b.co',
        '    token: tok',
      ].join('\n'),
      'utf8',
    );

    const cap = captureStdout();
    try {
      await runDoctor({ json: true });
      const j = JSON.parse(cap.text()) as { checks: { id: string; status: string }[] };
      const row = j.checks.find((c) => c.id === 'tracker-live');
      expect(row?.status).toBe('ok');
    } finally {
      cap.restore();
    }
    fetchSpy.mockRestore();
  });

  it('tracker jira connectivity fails on 401', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input: FetchInput) => {
      const u = String(input);
      if (u.includes('/rest/api/3/myself')) {
        return Promise.resolve(new Response('unauth', { status: 401 }));
      }
      return Promise.resolve(new Response('noop', { status: 500 }));
    });
    installWorkspace({
      ...DEFAULT_CONFIG,
      tracker: { type: 'jira', workspace: 'example.atlassian.net' },
    });
    ensureGitignore(tmp);
    fs.writeFileSync(
      path.join(tmp, SQUAD_DIR, 'secrets.yaml'),
      [
        'tracker:',
        '  jira:',
        '    host: example.atlassian.net',
        '    email: a@b.co',
        '    token: tok',
      ].join('\n'),
      'utf8',
    );

    exitMock.mockRestore();
    exitMock = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`EXIT:${code ?? ''}`);
    });
    await expect(runDoctor({ json: true })).rejects.toThrow('EXIT:1');
    fetchSpy.mockRestore();
  });

  it('--json writes valid JSON with root and checks to stdout', async () => {
    installWorkspace();
    ensureGitignore(tmp);
    const cap = captureStdout();
    try {
      await runDoctor({ json: true });
      const j = JSON.parse(cap.text()) as { root: string; checks: unknown[] };
      expect(fs.realpathSync(j.root)).toBe(fs.realpathSync(tmp));
      expect(Array.isArray(j.checks)).toBe(true);
      expect(j.checks.length).toBeGreaterThan(0);
      const first = j.checks[0] as { id: string; name: string; status: string };
      expect(first.id).toBeTruthy();
      expect(first.name).toBeTruthy();
      expect(first.status).toMatch(/ok|warn|fail|skip/);
    } finally {
      cap.restore();
    }
  });
});

const posixDescribe = process.platform === 'win32' ? describe.skip : describe;
posixDescribe('runDoctor POSIX', () => {
  let tmpPosix: string;
  let prevCwd: string;
  let exitMockPosix: MockInstance<typeof process.exit>;

  beforeEach(() => {
    tmpPosix = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-doctor-posix-'));
    prevCwd = process.cwd();
    process.chdir(tmpPosix);
    exitMockPosix = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpPosix, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('secrets.yaml mode 0644 warns; --fix chmods to 0600', async () => {
    fs.mkdirSync(path.join(tmpPosix, SQUAD_DIR, 'stories'), { recursive: true });
    fs.mkdirSync(path.join(tmpPosix, SQUAD_DIR, 'plans'), { recursive: true });
    saveConfig(path.join(tmpPosix, SQUAD_DIR, 'config.yaml'), DEFAULT_CONFIG);
    ensureGitignore(tmpPosix);
    const sec = path.join(tmpPosix, SQUAD_DIR, 'secrets.yaml');
    fs.writeFileSync(sec, 'planner: {}\n', 'utf8');
    fs.chmodSync(sec, 0o644);

    const cap1 = captureStdout();
    try {
      await runDoctor({ json: true });
      const j = JSON.parse(cap1.text()) as { checks: { id: string; status: string }[] };
      const row = j.checks.find((c) => c.id === 'secrets-perms');
      expect(row?.status).toBe('warn');
    } finally {
      cap1.restore();
    }

    await runDoctor({ fix: true });

    const mode = fs.statSync(sec).mode & 0o777;
    expect(mode).toBe(0o600);

    const cap2 = captureStdout();
    try {
      await runDoctor({ json: true });
      const j2 = JSON.parse(cap2.text()) as { checks: { id: string; status: string }[] };
      const row2 = j2.checks.find((c) => c.id === 'secrets-perms');
      expect(row2?.status).toBe('ok');
    } finally {
      cap2.restore();
    }
    expect(exitMockPosix).not.toHaveBeenCalled();
  });
});
