import * as ui from '../ui/index.js';
import { isSquadExit } from '../core/cli-exit.js';

/**
 * How every terminal command ends on an error: a planned exit says its words and leaves with its code, anything else is
 * shown in plain words and leaves with 1. `wrap` is for a command that takes options only, `wrapArgs` for one with
 * arguments.
 */

export function wrap<T>(fn: (opts: T) => Promise<void>) {
  return async (opts: T) => {
    try {
      await fn(opts);
    } catch (err) {
      if (isSquadExit(err)) {
        if (err.message.trim()) ui.info(err.message);
        process.exit(err.exitCode);
      }
      ui.renderError(err);
      process.exit(1);
    }
  };
}

export function wrapArgs<A extends unknown[]>(fn: (...args: A) => Promise<void>) {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      if (isSquadExit(err)) {
        if (err.message.trim()) ui.info(err.message);
        process.exit(err.exitCode);
      }
      ui.renderError(err);
      process.exit(1);
    }
  };
}
