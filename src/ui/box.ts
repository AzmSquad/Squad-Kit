import boxen from 'boxen';
import { dim } from './theme.js';
import { isInteractive } from './tty.js';

export interface SummaryRow {
  key: string;
  value: string;
}

export function summaryBox(title: string, rows: SummaryRow[]): void {
  const keyWidth = Math.max(...rows.map((r) => r.key.length));
  const body = rows.map((r) => `${dim(r.key.padEnd(keyWidth))}  ${r.value}`).join('\n');

  if (!isInteractive()) {
    process.stderr.write(`\n${title}\n${body}\n`);
    return;
  }

  const out = boxen(body, {
    title,
    titleAlignment: 'left',
    padding: { top: 0, bottom: 0, left: 1, right: 1 },
    margin: { top: 1, bottom: 0, left: 2, right: 0 },
    borderStyle: 'round',
    borderColor: 'green',
  });
  process.stderr.write(out + '\n');
}
