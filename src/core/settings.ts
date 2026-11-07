import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { squadHome } from './home.js';

/**
 * This person's settings on this computer, in ~/.squad-kit/settings.yaml (ADR-001). Each part reads and writes only its
 * own keys and keeps the rest, so the model levels and the app's settings share one file.
 */

function settingsFile(): string {
  return path.join(squadHome(), 'settings.yaml');
}

export function readSettings(): Record<string, unknown> {
  try {
    const raw = yaml.load(fs.readFileSync(settingsFile(), 'utf8'));
    return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeSettings(patch: Record<string, unknown>): void {
  fs.mkdirSync(squadHome(), { recursive: true });
  fs.writeFileSync(settingsFile(), yaml.dump({ ...readSettings(), ...patch }), 'utf8');
}

/** The person went past the first start's Welcome, on this computer. */
export function welcomed(): boolean {
  return readSettings().welcomed === true;
}

export function setWelcomed(): void {
  writeSettings({ welcomed: true });
}

/** How many tickets the squads may work on at once when nobody chose. */
export const DEFAULT_PARALLEL = 2;
export const MAX_PARALLEL = 5;

/**
 * How many tickets run at once, across every project in the app: they all use this person's AI accounts. A board from
 * before the one app kept its own number; it counts until the person sets one here.
 */
export function parallelLimit(boardOwn?: number): number {
  const mine = Number(readSettings().parallel);
  const n = Number.isFinite(mine) && mine >= 1 ? mine : (boardOwn ?? DEFAULT_PARALLEL);
  return Math.min(MAX_PARALLEL, Math.max(1, Math.round(n)));
}

export function setParallelLimit(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > MAX_PARALLEL) throw new Error(`Pick a number from 1 to ${MAX_PARALLEL}.`);
  writeSettings({ parallel: n });
  return n;
}

/** The app looks for a new squad-kit on start and once a day. On unless the person turned it off (offline networks). */
export function checkForUpdates(): boolean {
  return readSettings().checkForUpdates !== false;
}

export function setCheckForUpdates(on: boolean): boolean {
  writeSettings({ checkForUpdates: on });
  return on;
}

/**
 * How this person pays for the AI, when they said so themselves: it wins over what the AI tool module finds. One
 * answer for every project, since they all use the same AI login. Undefined: squad-kit finds out.
 */
export function paymentChoice(): 'subscription' | 'api-key' | undefined {
  const p = readSettings().payment;
  return p === 'subscription' || p === 'api-key' ? p : undefined;
}

/** Sets it, or with "auto" goes back to finding out. */
export function setPaymentChoice(p: 'subscription' | 'api-key' | 'auto'): void {
  const all = readSettings();
  delete all.payment;
  if (p !== 'auto') all.payment = p;
  fs.mkdirSync(squadHome(), { recursive: true });
  fs.writeFileSync(settingsFile(), yaml.dump(all), 'utf8');
}
