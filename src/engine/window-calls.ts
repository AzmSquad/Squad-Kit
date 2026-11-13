import type { BrowserStep } from '../modules/browser/types.js';

/**
 * The window's first look at every call (engine/window.ts): fields a tool does not take, values far too long, a page
 * outside the app, and a field that asks squad-kit to run something.
 */

/** The fields of a call that a tool does not take, or null when it takes the call as it is. */
export function extraFields(args: Record<string, unknown>, allowed: string[]): string[] {
  return Object.keys(args).filter((k) => !allowed.includes(k));
}

/** The first value in a call longer than `max` characters, anywhere in it. */
export function hugeValue(v: unknown, max: number, depth = 0): boolean {
  if (typeof v === 'string') return v.length > max;
  if (depth > 6 || !v || typeof v !== 'object') return false;
  return Object.values(v as Record<string, unknown>).some((x) => hugeValue(x, max, depth + 1));
}

/** Why a page is not merely wrong but outside the app: a scheme, another host, "..". Null when it is only a mistake or fine. */
export function outsideApp(p: unknown): string | null {
  if (typeof p !== 'string') return null;
  const s = p.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('//') || s.includes('\\')) return `page "${s.slice(0, 80)}" is outside the app`;
  let decoded = s;
  try {
    decoded = decodeURIComponent(s);
  } catch {
    return `page "${s.slice(0, 80)}" is not a valid path`;
  }
  if (decoded.startsWith('//') || decoded.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(decoded) || /(^|[/\\])\.\.([/\\?#]|$)/.test(decoded)) return `page "${s.slice(0, 80)}" goes outside the app`;
  return null;
}

/** The goto paths of a call's steps, for the same check. */
export function gotoPaths(steps: unknown): unknown[] {
  return Array.isArray(steps) ? steps.filter((x) => x && typeof x === 'object' && (x as BrowserStep).action === 'goto').map((x) => (x as BrowserStep).path) : [];
}

/** A field that asks squad-kit to run something. Never a slip: always refused. */
const COMMAND_FIELD = /^(commands?|cmd|scripts?|exec|execute|shell|bash|sh|eval|javascript|program)$/i;

/** The first field anywhere in a call that asks squad-kit to run something, or null. */
export function commandField(v: unknown, depth = 0): string | null {
  if (depth > 6 || !v || typeof v !== 'object') return null;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (COMMAND_FIELD.test(k)) return k;
    const inner = commandField(x, depth + 1);
    if (inner) return inner;
  }
  return null;
}
