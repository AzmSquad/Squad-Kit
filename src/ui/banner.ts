import boxen from 'boxen';
import { accent, dim, primary } from './theme.js';
import { isInteractive } from './tty.js';

export function banner(): void {
  if (!isInteractive()) return;
  const title = primary('squad');
  const tagline = dim('You write the ticket. Your squad does the rest.');
  const body = `${title}  ${accent('·')}  ${tagline}`;
  const boxed = boxen(body, {
    padding: { top: 0, bottom: 0, left: 2, right: 2 },
    margin: { top: 1, bottom: 1, left: 0, right: 0 },
    borderStyle: 'round',
    borderColor: 'green',
  });
  process.stderr.write(boxed + '\n');
}

export function bannerMinimal(): void {
  if (!isInteractive()) return;
  const line = `  ${primary('▸')} ${primary('squad')} ${dim('· You write the ticket. Your squad does the rest.')}`;
  process.stderr.write(line + '\n');
  process.stderr.write('  ' + dim('─'.repeat(58)) + '\n\n');
}
