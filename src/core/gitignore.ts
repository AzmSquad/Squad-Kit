import fs from 'node:fs';
import path from 'node:path';

export const SQUAD_SECRETS_PATTERN = '.squad/secrets.yaml';
export const SQUAD_ATTACHMENTS_PATTERN = '.squad/stories/**/attachments/';
export const SQUAD_TRASH_PATTERN = '.squad/.trash/';

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

  if (text.includes(SQUAD_SECRETS_PATTERN) && text.includes(SQUAD_TRASH_PATTERN)) {
    return false;
  }

  if (text.includes(SQUAD_SECRETS_PATTERN) && !text.includes(SQUAD_TRASH_PATTERN)) {
    let next = text;
    if (next.includes(SQUAD_ATTACHMENTS_PATTERN + '\n')) {
      next = next.replace(
        SQUAD_ATTACHMENTS_PATTERN + '\n',
        SQUAD_ATTACHMENTS_PATTERN + '\n' + SQUAD_TRASH_PATTERN + '\n',
      );
    } else if (next.includes(MANAGED_BLOCK_FOOTER)) {
      next = next.replace(MANAGED_BLOCK_FOOTER, SQUAD_TRASH_PATTERN + '\n' + MANAGED_BLOCK_FOOTER);
    } else {
      next = next.replace(/\n?$/, (m) => m + SQUAD_TRASH_PATTERN + '\n');
    }
    if (next !== text) {
      fs.writeFileSync(file, next, 'utf8');
      return true;
    }
  }

  if (!text.includes(SQUAD_SECRETS_PATTERN)) {
    const block = [
      '',
      MANAGED_BLOCK_HEADER,
      SQUAD_SECRETS_PATTERN,
      SQUAD_ATTACHMENTS_PATTERN,
      SQUAD_TRASH_PATTERN,
      MANAGED_BLOCK_FOOTER,
      '',
    ].join('\n');

    const next =
      text.length === 0
        ? block.trimStart()
        : text.endsWith('\n')
          ? text + block
          : text + '\n' + block;

    fs.writeFileSync(file, next, 'utf8');
    return true;
  }

  return false;
}
