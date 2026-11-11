import type { System, ToolId } from './catalog.js';
import type { PlaceKinds, ProjectKind } from './kinds.js';

/**
 * Which phone an app's pictures, Start and Try it yourself use. An app for one phone uses that one. An app for both
 * uses what the project's setting says (Settings, `squad config set phone`); left on automatic, the iPhone on a Mac
 * when its own tools are ready, else Android. A computer that is not a Mac always uses Android: it can't run an iPhone.
 */

export type PhoneSystem = 'ios' | 'android';
/** The project's setting: the iPhone, Android, or automatic when left out. */
export type PhoneChoice = 'iphone' | 'android';

export const PHONE_CHOICES = ['iphone', 'android', 'auto'] as const;

/** What the setting is called for people. */
export const CHOICE_WORDS: Record<(typeof PHONE_CHOICES)[number], string> = {
  iphone: 'iPhone',
  android: 'Android',
  auto: 'Automatic: the iPhone on a Mac when its tools are ready, else Android',
};

/** "iphone", "Android", "auto" as the setting takes it; null for anything else. */
export function parseChoice(text: string | undefined): (typeof PHONE_CHOICES)[number] | null {
  const t = (text ?? '').trim().toLowerCase();
  if (t === 'ios' || t === 'iphone') return 'iphone';
  if (t === 'android') return 'android';
  if (t === 'auto' || t === 'automatic') return 'auto';
  return null;
}

const CROSS: ProjectKind[] = ['flutter', 'react-native'];

/** The phones one place builds for: a Flutter or React Native app by its folders, a native app by its kind. */
export function phonesOf(p: Pick<PlaceKinds, 'kinds' | 'platforms'>): PhoneSystem[] {
  const cross = p.kinds.some((k) => CROSS.includes(k));
  const out: PhoneSystem[] = [];
  if (cross ? p.platforms.includes('ios') : p.kinds.includes('ios')) out.push('ios');
  if (cross ? p.platforms.includes('android') : p.kinds.includes('android')) out.push('android');
  return out;
}

/**
 * The phone for a place that builds for phones, or null for one that doesn't. `iosReady` is asked only when it decides:
 * an app for both, on a Mac, set to automatic.
 */
export function choosePhone(p: Pick<PlaceKinds, 'kinds' | 'platforms'>, setting: PhoneChoice | undefined, computer: System, iosReady: () => boolean): PhoneSystem | null {
  const phones = phonesOf(p);
  if (!phones.length) return null;
  if (phones.length === 1) return phones[0]!;
  if (computer !== 'mac') return 'android';
  if (setting === 'iphone') return 'ios';
  if (setting === 'android') return 'android';
  return iosReady() ? 'ios' : 'android';
}

/** The tools only the iPhone needs: when one of them stops it, an app for both phones uses Android meanwhile. */
export const IPHONE_ONLY: ToolId[] = ['xcode', 'simulator', 'cocoapods'];
