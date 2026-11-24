import type { BoardPaths } from '../../board/store.js';
import type { Ticket } from '../../board/types.js';
import path from 'node:path';
import { androidChecks, androidSkip, canSkipAndroid, SKIP_ANDROID } from './android-builds.js';
import { piecesWords, sdkLacksHere, studioStepsFor } from './flutter-android.js';
import { ACTION_DOING } from './catalog.js';
import { androidLines, blockedBy, blockOf, checkSoon, foundNow, LOOK_AGAIN_MS, metaOf, placesFor, waitsForTools, type ToolAction, type ToolBlock } from './index.js';

/**
 * What a story waits for before a step, for the live squad and for the board: a Required tool missing or too old for
 * the step (index.ts blockedBy), or the tools a check's own command needs to build the Android app. Both say the same on
 * the story card, with the link to the Tools page, and squad-kit looks again by itself now and then.
 */

/** The action a squad step needs its tools for. */
const ACTION_OF: Record<string, ToolAction> = { build: 'build', unstick: 'build', test: 'checks' };

/** What a story about to take a step waits for, if anything: the live squad holds it with this. */
export function toolsHold(bp: BoardPaths, t: Ticket, phase: string): ToolBlock | null {
  const action = ACTION_OF[phase];
  return action ? (blockedBy(bp, action, t) ?? commandsBlock(bp, t, action)) : null;
}

/**
 * A build or a check whose own command builds an Android app (`flutter build apk`, `./gradlew assembleDebug`) needs
 * Android's build tools and Java 17 or newer, whatever kind of app the project is: it waits for them with the Tools
 * page's line while they are missing or too old. A person's own SDK that builds apps is enough; and a person who skips
 * Android builds here never waits for them. The block offers that skip.
 */
export function commandsBlock(bp: BoardPaths, t: Pick<Ticket, 'repo' | 'parts' | 'worktree' | 'copies'>, action: ToolAction): ToolBlock | null {
  if (action !== 'build' && action !== 'checks') return null;
  const meta = metaOf(bp);
  const checks = meta ? androidChecks(meta, t.repo) : [];
  // Skipped: the Android builds are taken out of the checks, unless one of them can't be (it waits as before).
  if (!meta || !checks.length || (androidSkip(bp) && canSkipAndroid(checks))) return null;
  const book = foundNow();
  if (!book) return null;
  const builds = Boolean(book.tools.android?.builds);
  const lines = androidLines(placesFor(bp, () => meta, t), book).filter((l) => l.state !== 'ready' && !(l.id === 'android' && builds));
  const skip = canSkipAndroid(checks) && !androidSkip(bp) ? { skip: { label: SKIP_ANDROID.label, note: SKIP_ANDROID.note, command: SKIP_ANDROID.command } } : {};
  // While a story waits, squad-kit looks again by itself now and then, so it goes on once the tool is there.
  if (lines.length) {
    checkSoon(LOOK_AGAIN_MS);
    return { ...blockOf(action, lines), ...skip };
  }
  // The SDK is here, and lacks a piece the project's Flutter builds with: named, with Android Studio's steps.
  const here = sdkLacksHere(t.worktree ?? path.join(bp.root, t.repo ?? '.'));
  if (!here) return null;
  checkSoon(LOOK_AGAIN_MS);
  const what = piecesWords(here.lacks);
  return {
    action,
    tools: [{ id: 'android', name: 'Android SDK', state: 'missing' }],
    text: `squad-kit can't ${ACTION_DOING[action]} yet: your Android SDK lacks ${what}, which Flutter needs to build the app.`,
    status: `Waits for ${what} in the Android SDK. Goes on by itself once ${here.lacks.length === 1 ? "it's" : "they're"} there`,
    link: '/tools#android',
    ...(here.own ? {} : { steps: studioStepsFor(here.lacks) }),
    ...skip,
  };
}

/**
 * A story read for the board: when it waits for a tool, what it waits for, with the link (never saved). Looking at
 * the story checks the computer again beside, so it goes on soon after the tool is installed.
 */
export function toolWaitOf(bp: BoardPaths, t: Ticket, lookedAt = false): { toolWait?: ToolBlock } {
  if (!waitsForTools(t.status)) return {};
  if (lookedAt) checkSoon();
  // A phone app's pictures wait for its phone tools at the proof (engine/phone/plan.ts).
  const action = t.squad?.phase === 'proof' ? 'pictures' : (ACTION_OF[t.squad?.phase ?? ''] ?? 'build');
  const b = blockedBy(bp, action, t) ?? commandsBlock(bp, t, action);
  return b ? { toolWait: b } : {};
}
