import { squadHome } from '../../core/home.js';
import { measured, noteTime } from '../tools/get.js';

/**
 * How long the phone's long steps take on this computer: the first guess is a fixed number, then the time squad-kit
 * measured here last time, kept with the tools' own times (tools/times.json). Every long step says what it does and
 * about how long it takes.
 */

export type PhoneStep = 'build' | 'boot' | 'install' | 'first-run';

/** The key in times.json, and the first guess in seconds. */
const STEPS: Record<PhoneStep, { key: string; guess: number }> = {
  build: { key: 'iphone-build', guess: 300 },
  boot: { key: 'iphone-boot', guess: 60 },
  install: { key: 'iphone-install', guess: 15 },
  'first-run': { key: 'maestro-first', guess: 60 },
};

/** How long a step takes here: measured last time, else the first guess. */
export function stepSeconds(step: PhoneStep, home = squadHome()): number {
  return measured(STEPS[step].key, home) ?? STEPS[step].guess;
}

/** Keeps how long a step took, for the next guess. */
export function noteStep(step: PhoneStep, seconds: number, home = squadHome()): void {
  noteTime(STEPS[step].key, seconds, home);
}

/** "about 15 seconds", "about a minute", "about 5 minutes". */
export function aboutWords(seconds: number): string {
  if (seconds < 50) return `about ${Math.max(5, Math.round(seconds / 5) * 5)} seconds`;
  if (seconds < 90) return 'about a minute';
  return `about ${Math.round(seconds / 60)} minutes`;
}

/** Every step's time on this computer, for `squad phone status`. */
export function stepTimes(home = squadHome()): Record<PhoneStep, number> {
  return Object.fromEntries((Object.keys(STEPS) as PhoneStep[]).map((s) => [s, stepSeconds(s, home)])) as Record<PhoneStep, number>;
}
