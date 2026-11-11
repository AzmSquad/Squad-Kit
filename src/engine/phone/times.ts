import { squadHome } from '../../core/home.js';
import type { PhoneModule, PhoneStep } from '../../modules/phone/types.js';
import { measured, noteTime } from '../tools/get.js';

/**
 * How long the phone's long steps take on this computer: the first guess is the phone's own fixed number, then the time
 * squad-kit measured here last time, kept with the tools' own times (tools/times.json), each phone under its own key.
 * Every long step says what it does and about how long it takes.
 */

export type { PhoneStep };

/** The key in times.json, and the first guess in seconds: the iPhone's, for a phone that gives none of its own. */
const STEPS: Record<PhoneStep, { key: string; guess: number }> = {
  build: { key: 'iphone-build', guess: 300 },
  boot: { key: 'iphone-boot', guess: 60 },
  install: { key: 'iphone-install', guess: 15 },
  'first-run': { key: 'maestro-first', guess: 60 },
};

const stepOf = (step: PhoneStep, phone?: PhoneModule) => phone?.times?.[step] ?? STEPS[step];

/** How long a step takes here on a phone: measured last time, else the first guess. */
export function stepSeconds(step: PhoneStep, home = squadHome(), phone?: PhoneModule): number {
  const s = stepOf(step, phone);
  return measured(s.key, home) ?? s.guess;
}

/** Keeps how long a step took on a phone, for the next guess. */
export function noteStep(step: PhoneStep, seconds: number, home = squadHome(), phone?: PhoneModule): void {
  noteTime(stepOf(step, phone).key, seconds, home);
}

/** "about 15 seconds", "about a minute", "about 5 minutes". */
export function aboutWords(seconds: number): string {
  if (seconds < 50) return `about ${Math.max(5, Math.round(seconds / 5) * 5)} seconds`;
  if (seconds < 90) return 'about a minute';
  return `about ${Math.round(seconds / 60)} minutes`;
}

/** Every step's time on this computer for a phone, for `squad phone status`. */
export function stepTimes(home = squadHome(), phone?: PhoneModule): Record<PhoneStep, number> {
  return Object.fromEntries((Object.keys(STEPS) as PhoneStep[]).map((s) => [s, stepSeconds(s, home, phone)])) as Record<PhoneStep, number>;
}
