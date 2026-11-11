import type { ToolAction, ToolId } from './catalog.js';
import type { Platform } from './kinds.js';

/**
 * Whether the version found is new enough: the tool's own oldest version, and the pairs of tools that must fit
 * together. A pair rule can make a tool too old for some actions only (Flutter for the iPhone), so the others go on.
 */

/** Compares "3.27.3" with "3.44.8" number by number: below zero when a is older. Anything after the numbers is left out. */
export function compareVersions(a: string, b: string): number {
  const nums = (v: string) => (/^\d+(?:\.\d+)*/.exec(v.trim())?.[0] ?? '0').split('.').map(Number);
  const x = nums(a);
  const y = nums(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export const atLeast = (found: string, min: string): boolean => compareVersions(found, min) >= 0;

export interface TooOld {
  /** The oldest version that works. */
  needs: string;
  /** Why, in plain words, when it is a pair rule: "Xcode 27 needs Flutter 3.44.8 or newer for iPhone builds". */
  why?: string;
  /** The actions it is too old for. Missing: everything it is used for. */
  for?: ToolAction[];
}

export interface PairRule {
  tool: ToolId;
  /** The rule counts only for a project that builds for this phone. */
  platform?: Platform;
  applies(versions: Partial<Record<ToolId, string>>): boolean;
  needs: string;
  why: string;
  for: ToolAction[];
}

export const PAIR_RULES: PairRule[] = [
  {
    // With Xcode 27, iPhone builds need Flutter 3.44.8 or newer, for two reasons, both from Flutter itself:
    // - Flutter's changelog, 3.44.8: "When building on macOS or iOS using the Xcode 27 toolchain, the build will fail
    //   due to a lipo verification error." (https://github.com/flutter/flutter/blob/main/CHANGELOG.md)
    // - Apple requires the UIScene lifecycle for apps built with Xcode 27, and apps without it fail to launch; Flutter
    //   makes it the default from 3.41 (https://docs.flutter.dev/release/breaking-changes/uiscenedelegate).
    // Checked on 2026-11-10. Seen on this team's own Mac too: Flutter 3.27.3 with Xcode 27.2 failed both ways.
    tool: 'flutter',
    platform: 'ios',
    applies: (v) => Boolean(v.flutter && v.xcode && compareVersions(v.xcode, '27') >= 0 && compareVersions(v.flutter, '3.44.8') < 0),
    needs: '3.44.8',
    why: 'Xcode 27 needs it for iPhone builds',
    for: ['pictures', 'start-app', 'try-it'],
  },
];

/**
 * Whether a tool's version found is too old: below its own oldest version, or by a pair rule for the tools found
 * beside it. Null when it fits, or when its version is not known (an unknown version never stops anyone).
 */
export function tooOld(id: ToolId, min: string | undefined, versions: Partial<Record<ToolId, string>>, platforms: Set<Platform>): TooOld | null {
  const v = versions[id];
  if (!v) return null;
  if (min && !atLeast(v, min)) return { needs: min };
  const rule = PAIR_RULES.find((r) => r.tool === id && (!r.platform || platforms.has(r.platform)) && r.applies(versions));
  return rule ? { needs: rule.needs, why: rule.why, for: rule.for } : null;
}
