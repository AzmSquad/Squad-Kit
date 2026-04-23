import { danger } from './theme.js';

export function renderError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`  ${danger('✗')} ${msg}\n`);
}
