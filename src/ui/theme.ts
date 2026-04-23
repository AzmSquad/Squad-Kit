import kleur from 'kleur';

export const BRAND = {
  primaryHex: '#7cffa0',
  accentHex: '#a393eb',
} as const;

export const PREFIX = {
  running: '◆',
  success: '✓',
  failure: '✗',
  step: '▸',
  warn: '!',
  muted: '·',
} as const;

export const SPINNER_FRAMES = ['◐', '◓', '◑', '◒'] as const;

export const primary = (s: string) => kleur.green(s);
export const accent = (s: string) => kleur.magenta(s);
export const muted = (s: string) => kleur.gray(s);
export const danger = (s: string) => kleur.red(s);
export const warn = (s: string) => kleur.yellow(s);
export const bold = (s: string) => kleur.bold(s);
export const dim = (s: string) => kleur.dim(s);
