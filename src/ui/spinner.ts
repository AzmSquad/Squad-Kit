import ora, { type Ora } from 'ora';
import { SPINNER_FRAMES } from './theme.js';
import { isInteractive } from './tty.js';

export interface SquadSpinner {
  update(text: string): void;
  succeed(text?: string): void;
  fail(text?: string): void;
  stop(): void;
}

export function spinner(text: string): SquadSpinner {
  if (!isInteractive()) {
    return {
      update: (t) => process.stderr.write(`  ◆ ${t}\n`),
      succeed: (t) => process.stderr.write(`  ✓ ${t ?? text}\n`),
      fail: (t) => process.stderr.write(`  ✗ ${t ?? text}\n`),
      stop: () => {},
    };
  }
  const instance: Ora = ora({
    text,
    stream: process.stderr,
    spinner: { interval: 120, frames: [...SPINNER_FRAMES] },
    color: 'green',
    prefixText: ' ',
  }).start();
  return {
    update: (t) => {
      instance.text = t;
    },
    succeed: (t) => instance.succeed(t),
    fail: (t) => instance.fail(t),
    stop: () => instance.stop(),
  };
}
