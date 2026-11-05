import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, gitEnv } from '../src/engine/git.js';
import { runCommand } from '../src/engine/checks.js';

/**
 * squad-kit's own git calls answer in English, and fast, even with no language set (the app opened from the Dock):
 * each one sets the language itself. The project's own commands keep the person's language.
 */

const english = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C';

describe.skipIf(process.platform === 'win32')("squad-kit's own git", () => {
  it('runs with the language set, without LANGUAGE, and keeps the rest of the environment', () => {
    const env = gitEnv({ GIT_TERMINAL_PROMPT: '0' });
    expect(env.LC_ALL).toBe(english);
    expect(env.LANGUAGE).toBeUndefined();
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.PATH).toBe(process.env.PATH);
  });

  it('every git call gets it, even when the app started with no language or another one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-git-env-'));
    const was = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LANGUAGE: process.env.LANGUAGE };
    try {
      delete process.env.LANG;
      process.env.LC_ALL = 'ar_EG.UTF-8';
      process.env.LANGUAGE = 'ar';
      git(dir, ['init', '-q']);
      // A git alias that prints its own environment shows what git ran with.
      const seen = git(dir, ['-c', 'alias.lang=!printf "%s|%s" "$LC_ALL" "${LANGUAGE:-none}"', 'lang']);
      expect(seen).toBe(`${english}|none`);
      // squad-kit's own process is never changed.
      expect(process.env.LC_ALL).toBe('ar_EG.UTF-8');
    } finally {
      for (const [k, v] of Object.entries(was)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the project's own commands in the person's language", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-git-env-'));
    const was = process.env.LC_ALL;
    try {
      process.env.LC_ALL = 'fr_FR.UTF-8';
      const r = await runCommand(dir, 'printf "%s" "$LC_ALL"', 10_000);
      expect(r.output.trim()).toBe('fr_FR.UTF-8');
    } finally {
      if (was === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = was;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
