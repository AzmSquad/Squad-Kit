import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAllChecks, gatherContext, summarise, type CheckResult } from '../src/commands/doctor-engine.js';
import { buildPaths, SQUAD_DIR } from '../src/core/paths.js';
import { saveConfig, DEFAULT_CONFIG } from '../src/core/config.js';

let tmp: string;
let previousCwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-doc-eng-'));
  previousCwd = process.cwd();
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(previousCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('doctor-engine', () => {
  it('exports runAllChecks; fix=false does not create .squad when missing (dirs check stays warn, no mkdir side effect in engine beyond checks)', async () => {
    const paths = buildPaths(tmp);
    const ctx = await gatherContext(paths);
    const before = fs.existsSync(paths.squadDir);
    const checks = await runAllChecks(paths, ctx, false);
    const after = fs.existsSync(paths.squadDir);
    expect(before).toBe(false);
    expect(after).toBe(false);
    const d = checks.find((c) => c.id === 'dirs');
    expect(d?.status).toBe('warn');
  });

  it('runAllChecks with fix=true can create .squad (dirs check repairs)', async () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), '{}', 'utf8');
    const paths = buildPaths(tmp);
    const ctx = await gatherContext(paths);
    const checks = await runAllChecks(paths, ctx, true);
    expect(fs.existsSync(paths.squadDir)).toBe(true);
    const d = checks.find((c) => c.id === 'dirs');
    expect(d?.status).toBe('ok');
  });

  it('summarise counts statuses', () => {
    const checks: CheckResult[] = [
      { id: 'a', name: 'a', status: 'ok' },
      { id: 'b', name: 'b', status: 'warn' },
      { id: 'c', name: 'c', status: 'fail' },
      { id: 'd', name: 'd', status: 'skip' },
    ];
    expect(summarise(checks)).toEqual({ ok: 1, warn: 1, fail: 1, skip: 1 });
  });
});

describe('doctor-engine (minimal workspace)', () => {
  it('loads and runs checks on default config', async () => {
    fs.mkdirSync(path.join(tmp, SQUAD_DIR, 'stories'), { recursive: true });
    fs.mkdirSync(path.join(tmp, SQUAD_DIR, 'plans'), { recursive: true });
    saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), DEFAULT_CONFIG);
    const paths = buildPaths(tmp);
    const ctx = await gatherContext(paths);
    const checks = await runAllChecks(paths, ctx, false);
    expect(checks.length).toBeGreaterThan(5);
  });
});
