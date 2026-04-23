import { PREFIX } from './theme.js';
import { accent, danger, dim, primary, warn } from './theme.js';

export const step = (msg: string) => process.stderr.write(`  ${primary(PREFIX.step)} ${msg}\n`);
export const success = (msg: string) => process.stderr.write(`  ${primary(PREFIX.success)} ${msg}\n`);
export const failure = (msg: string) => process.stderr.write(`  ${danger(PREFIX.failure)} ${msg}\n`);
export const warning = (msg: string) => process.stderr.write(`  ${warn(PREFIX.warn)} ${msg}\n`);
export const info = (msg: string) => process.stderr.write(`  ${accent(PREFIX.muted)} ${dim(msg)}\n`);
export const blank = () => process.stderr.write('\n');

/** Single line to stderr (for tables / doctor output). */
export function line(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

export function kv(key: string, value: string, keyWidth = 10): void {
  process.stderr.write(`    ${dim(key.padEnd(keyWidth))} ${value}\n`);
}
