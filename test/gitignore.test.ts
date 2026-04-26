import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureGitignore, SQUAD_TRASH_PATTERN, SQUAD_SECRETS_PATTERN, SQUAD_ATTACHMENTS_PATTERN } from '../src/core/gitignore.js';

let tmp: string;
let previousCwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-gitig-'));
  previousCwd = process.cwd();
  process.chdir(tmp);
});
afterEach(() => {
  process.chdir(previousCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const BLOCK_LINES = [
  '# Managed by squad-kit — do not edit this block',
  '.squad/secrets.yaml',
  '.squad/stories/**/attachments/',
  '.squad/.trash/',
  '.squad/runs/',
  '# End squad-kit block',
];

function readGitignore(): string {
  return fs.readFileSync(path.join(tmp, '.gitignore'), 'utf8');
}

describe('ensureGitignore', () => {
  it('creates .gitignore when absent with both managed patterns in the block', () => {
    const changed = ensureGitignore(tmp);
    expect(changed).toBe(true);
    const s = readGitignore();
    for (const line of BLOCK_LINES) {
      expect(s).toContain(line);
    }
  });

  it('appends the managed block when an unrelated .gitignore already exists', () => {
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'node_modules/\n', 'utf8');
    const before = readGitignore();
    expect(ensureGitignore(tmp)).toBe(true);
    const after = readGitignore();
    expect(after.startsWith('node_modules/\n')).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
    expect(after).toContain('.squad/secrets.yaml');
  });

  it('returns false and makes no change when the pattern is already present', () => {
    ensureGitignore(tmp);
    const first = readGitignore();
    const changed = ensureGitignore(tmp);
    expect(changed).toBe(false);
    expect(readGitignore()).toBe(first);
  });

  it('preserves user-added content on re-runs (idempotent when block exists)', () => {
    ensureGitignore(tmp);
    const gi = path.join(tmp, '.gitignore');
    const withUser = `user-line\n${readGitignore()}`;
    fs.writeFileSync(gi, withUser, 'utf8');
    expect(ensureGitignore(tmp)).toBe(false);
    expect(fs.readFileSync(gi, 'utf8')).toBe(withUser);
  });

  it('appends .squad/.trash/ to an old managed block that had secrets+attachments only', () => {
    const gi = path.join(tmp, '.gitignore');
    const legacy = [
      '# Managed by squad-kit — do not edit this block',
      SQUAD_SECRETS_PATTERN,
      SQUAD_ATTACHMENTS_PATTERN,
      '# End squad-kit block',
      '',
    ].join('\n');
    fs.writeFileSync(gi, legacy, 'utf8');
    expect(legacy).not.toContain(SQUAD_TRASH_PATTERN);
    expect(ensureGitignore(tmp)).toBe(true);
    const after = readGitignore();
    expect(after).toContain(SQUAD_TRASH_PATTERN);
    expect((after.match(new RegExp(SQUAD_SECRETS_PATTERN, 'g')) || []).length).toBe(1);
  });
});
