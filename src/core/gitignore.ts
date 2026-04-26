import fs from 'node:fs';
import path from 'node:path';

export const SQUAD_SECRETS_PATTERN = '.squad/secrets.yaml';
export const SQUAD_ATTACHMENTS_PATTERN = '.squad/stories/**/attachments/';
export const SQUAD_TRASH_PATTERN = '.squad/.trash/';
export const SQUAD_LAST_RUN_PATTERN = '.squad/.last-run.json';
export const SQUAD_LAST_COPY_PROMPT_PATTERN = '.squad/.last-copy-prompt.md';
export const SQUAD_RUNS_PATTERN = '.squad/runs/';

const MANAGED_BLOCK_HEADER = '# Managed by squad-kit — do not edit this block';
const MANAGED_BLOCK_FOOTER = '# End squad-kit block';

/**
 * Ensure the repo-root `.gitignore` contains the managed squad-kit block.
 * Idempotent: safe to call on every `squad init`. Does not remove prior user-added
 * patterns; only appends its own managed block if missing, or appends the trash
 * line to an existing block that predates it.
 *
 * Returns true if the file was created or modified, false if no change was needed.
 */
export function ensureGitignore(repoRoot: string): boolean {
  const file = path.join(repoRoot, '.gitignore');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

  const requiredPatterns = [
    SQUAD_SECRETS_PATTERN,
    SQUAD_ATTACHMENTS_PATTERN,
    SQUAD_TRASH_PATTERN,
    SQUAD_LAST_RUN_PATTERN,
    SQUAD_LAST_COPY_PROMPT_PATTERN,
    SQUAD_RUNS_PATTERN,
  ];

  const allPresent = requiredPatterns.every((p) => text.includes(p));
  if (allPresent) return false;

  if (!text.includes(SQUAD_SECRETS_PATTERN)) {
    const block = ['', MANAGED_BLOCK_HEADER, ...requiredPatterns, MANAGED_BLOCK_FOOTER, ''].join('\n');
    const next =
      text.length === 0
        ? block.trimStart()
        : text.endsWith('\n')
          ? text + block
          : text + '\n' + block;
    fs.writeFileSync(file, next, 'utf8');
    return true;
  }

  let next = text;
  for (const pattern of requiredPatterns) {
    if (next.includes(pattern)) continue;
    if (next.includes(MANAGED_BLOCK_FOOTER)) {
      next = next.replace(MANAGED_BLOCK_FOOTER, pattern + '\n' + MANAGED_BLOCK_FOOTER);
    } else {
      next = next.replace(/\n?$/, (m) => m + pattern + '\n');
    }
  }
  if (next !== text) {
    fs.writeFileSync(file, next, 'utf8');
    return true;
  }
  return false;
}
