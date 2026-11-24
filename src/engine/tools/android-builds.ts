import fs from 'node:fs';
import path from 'node:path';
import { readMeta, type BoardPaths } from '../../board/store.js';
import type { BoardMeta, ProjectCommands } from '../../board/types.js';
import { usesAndroid } from '../android-env.js';
import { reposOf } from '../repos.js';
import { ACTION_WORDS, type ToolAction } from './catalog.js';
import type { FoundBook } from './detect.js';
import type { ToolLine } from './index.js';
import { piecesWords, studioStepsFor, type SdkPiece } from './flutter-android.js';

/**
 * A project's own checks that build its Android app (`flutter build apk`, `./gradlew assembleDebug`) need Android's
 * build tools on this computer, whatever kind of app the project is. A person who doesn't build for Android here can
 * skip them: they choose it on the story or the Tools page, for this project on this computer only, and it stays on
 * the record. The tests and the code check still run. A person's own Android SDK that builds apps (Android Studio's)
 * is enough for these checks: the phone pieces are only for pictures and Try it yourself.
 */

/** A part of a command that only builds the Android app: `flutter build apk`, `./gradlew assembleDebug`. */
const ANDROID_BUILD = /^(?:\w+=\S*\s+)*(?:(?:fvm\s+)?flutter\s+build\s+(?:apk|appbundle)\b|(?:\S*\/)?gradlew(?:\.bat)?\s+(?::?[\w:-]*:)?(?:assemble|bundle)\w*\b|gradle\s+(?:assemble|bundle)\w*\b)[^;&|]*$/;
const CD = /^cd\s+\S+$/;

/**
 * A command with its Android builds taken out, for Skip Android builds: null when nothing of it is left to run (it only
 * built the Android app), the command as it is when it builds nothing for Android, and undefined when it can't be taken
 * apart, as when it runs Android for more than a build (`./gradlew test`), or chains with `;`, `||` or a pipe.
 */
export function withoutAndroidBuild(command: string): string | null | undefined {
  const c = command.trim();
  if (!usesAndroid(c)) return c;
  if (ANDROID_BUILD.test(c)) return null;
  if (/;|\|/.test(c)) return undefined;
  const parts = c.split('&&').map((x) => x.trim());
  const kept: string[] = [];
  for (const p of parts) {
    if (!usesAndroid(p)) kept.push(p);
    else if (!ANDROID_BUILD.test(p)) return undefined;
  }
  return kept.some((p) => !CD.test(p)) ? kept.join(' && ') : null;
}

/** A command that only builds the Android app, with nothing else in it: squad-kit runs that check outside its guard (checks.ts). */
export function onlyAndroidBuild(command: string): boolean {
  return usesAndroid(command) && withoutAndroidBuild(command) === null;
}

/**
 * The checks of the project, or of one story's repo, whose command builds an Android app, and whether Skip Android
 * builds can take that build out and leave the rest of the check (its tests, its code check) as it is.
 */
export function androidChecks(meta: BoardMeta, repo?: string): { name: 'test' | 'lint' | 'build'; command: string; skippable: boolean }[] {
  return reposOf(meta)
    .filter((r) => !repo || r.path === repo)
    .flatMap((r) => (['test', 'lint', 'build'] as const).map((name) => ({ name, command: r.commands[name]?.trim() ?? '' })))
    .filter((c) => usesAndroid(c.command))
    .map((c) => ({ ...c, skippable: withoutAndroidBuild(c.command) !== undefined }));
}

/** The folder of the first repo whose checks build the Android app: where its Flutter is pinned. */
export function androidRepoDir(bp: BoardPaths, meta: BoardMeta): string {
  const r = reposOf(meta).find((x) => ['test', 'lint', 'build'].some((n) => usesAndroid(x.commands[n as 'test'])));
  return path.join(bp.root, r?.path ?? '.');
}

/** Skip Android builds is offered only when it takes out the Android builds alone: every such check can lose them. */
export const canSkipAndroid = (checks: { skippable: boolean }[]) => checks.length > 0 && checks.every((c) => c.skippable);

export interface AndroidSkip {
  by: string;
  at: string;
}

/** Where the choice is kept: this project's own folder on this computer, never the project's files. */
const skipFile = (bp: BoardPaths) => path.join(bp.localDir, 'skip-android.json');

/** Who chose to skip Android builds for this project on this computer, and when; null when they are not skipped. */
export function androidSkip(bp: BoardPaths): AndroidSkip | null {
  try {
    const j = JSON.parse(fs.readFileSync(skipFile(bp), 'utf8')) as Partial<AndroidSkip>;
    return typeof j.by === 'string' && typeof j.at === 'string' ? { by: j.by, at: j.at } : null;
  } catch {
    return null;
  }
}

/**
 * The checks to run in a copy: the saved ones, with their Android builds taken out when the person skips them. A check
 * that can't be taken apart runs as it is (and waits for Android's tools, hold.ts).
 */
export function checksToRunHere(bp: BoardPaths, commands: ProjectCommands): { commands: ProjectCommands; skipped: string[] } {
  if (!androidSkip(bp)) return { commands, skipped: [] };
  const out = { ...commands };
  const skipped: string[] = [];
  for (const name of ['test', 'lint', 'build'] as const) {
    const was = out[name]?.trim();
    if (!was || !usesAndroid(was)) continue;
    const kept = withoutAndroidBuild(was);
    if (kept === undefined) continue;
    skipped.push(was);
    if (kept === null) delete out[name];
    else out[name] = kept;
  }
  return { commands: out, skipped };
}

/** One line for the story when a check that builds for Android did not run, as the person chose. */
export function skippedWords(skipped: string[]): string {
  return `Android builds are skipped on this computer, as you chose, so the Android build did not run in ${skipped.length === 1 ? 'this check' : `${skipped.length} checks`} (${skipped.join('; ')}). The tests and the code check still run. Turn it back on from the Tools page`;
}

/** What the story card and the Tools page offer while an Android build check waits for its tools. */
export const SKIP_ANDROID = {
  label: 'Skip Android builds',
  note: "The checks that build the Android app don't run on this computer. The tests and the code check still run. Turn it back on from the Tools page.",
  command: 'squad tools skip android',
  path: '/api/v1/tools/android/skip',
} as const;

export const UNSKIP_ANDROID = { label: 'Build for Android again', command: 'squad tools unskip android' } as const;

/** `squad tools skip <tool>` and the board's button: only Android builds can be skipped. */
export function skipToolNow(bp: BoardPaths, tool: string, skip: boolean): AndroidSkip | null {
  if (tool.trim().toLowerCase() !== 'android') throw new Error(`Only Android builds can be skipped here, not "${tool}". Use: ${SKIP_ANDROID.command}`);
  return setSkipAndroid(bp, skip);
}

/** Skip Android builds for this project on this computer, or build for Android again. */
export function setSkipAndroid(bp: BoardPaths, skip: boolean): AndroidSkip | null {
  const file = skipFile(bp);
  if (!skip) {
    fs.rmSync(file, { force: true });
    return null;
  }
  let by = 'You';
  try {
    by = readMeta(bp).user?.name || by;
  } catch {
    // No name kept: "You".
  }
  const s: AndroidSkip = { by, at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`);
  return s;
}

const inOrder = (xs: ToolAction[]) => (Object.keys(ACTION_WORDS) as ToolAction[]).filter((a) => xs.includes(a));

/**
 * The Tools page's Android and Java lines for a project whose own checks build its Android app: Required for the
 * checks, and stopping them while they are missing, unless a person's own SDK builds apps already, or Android builds
 * are skipped here. `extra`: those two lines as an Android project needs them, for a project whose phone is not Android.
 */
export function withAndroidChecks(lines: ToolLine[], extra: ToolLine[], o: { meta: BoardMeta | null; book: FoundBook | null; skip: AndroidSkip | null; lacks?: { lacks: SdkPiece[]; own: boolean } | null }): ToolLine[] {
  const checks = o.meta ? androidChecks(o.meta) : [];
  if (!checks.length) return lines;
  // A skip that can't take every Android build out leaves those checks waiting for the tools as before.
  const skip = o.skip && canSkipAndroid(checks) ? o.skip : null;
  const offer = canSkipAndroid(checks);
  const builds = Boolean(o.book?.tools.android?.builds);
  const out = [...lines];
  for (const id of ['android', 'java'] as const) {
    const at = out.findIndex((l) => l.id === id);
    const base = at >= 0 ? out[at]! : extra.find((l) => l.id === id);
    if (!base) continue;
    // The SDK is here, but lacks a piece the project's Flutter builds with (flutter-android.ts): said, with the steps.
    const lacks = id === 'android' && (base.state === 'ready' || builds) ? o.lacks : null;
    const enough = (base.state === 'ready' || (id === 'android' && builds)) && !lacks;
    const line: ToolLine = {
      ...base,
      priority: skip ? base.priority : 'required',
      actions: inOrder([...base.actions, 'checks']),
      blocks: inOrder([...base.blocks.filter((a) => a !== 'checks'), ...(!skip && !enough ? (['checks'] as const) : [])]),
      ...(lacks ? { note: [`Your Android SDK lacks ${piecesWords(lacks.lacks)}, which Flutter needs to build the app.`, base.note].filter(Boolean).join(' ') } : {}),
      ...(lacks && !lacks.own ? { studioSteps: studioStepsFor(lacks.lacks) } : {}),
      ...(id === 'android' && o.skip ? { skipped: { by: o.skip.by, at: o.skip.at, command: UNSKIP_ANDROID.command } } : {}),
      // Offered whenever it can take the Android builds out: also when the tools are here and the build still can't run.
      ...(id === 'android' && !o.skip && offer ? { skip: { command: SKIP_ANDROID.command } } : {}),
    };
    if (at >= 0) out[at] = line;
    else out.push(line);
  }
  return out;
}
