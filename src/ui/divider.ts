import { dim } from './theme.js';
import { stderrCols } from './tty.js';

export function divider(label?: string): void {
  const cols = Math.max(30, Math.min(stderrCols() - 4, 80));
  if (!label) {
    process.stderr.write('  ' + dim('─'.repeat(cols)) + '\n');
    return;
  }
  const labelPart = `  ${label}  `;
  const remaining = cols - labelPart.length - 2;
  const left = 2;
  const right = Math.max(2, remaining - left);
  process.stderr.write('  ' + dim('─'.repeat(left)) + labelPart + dim('─'.repeat(right)) + '\n');
}
