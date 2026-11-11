import fs from 'node:fs';
import path from 'node:path';
import { buildPaths } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import type { BoardPaths } from '../board/store.js';
import type { Tracker, TrackerModule } from './tracker/types.js';
import type { CodeHostModule, RepoHost } from './code-host/types.js';
import { azureTracker } from './azure/tracker.js';
import { azureCodeHost } from './azure/code-host.js';
import type { Speech, SpeechModule } from './speech/types.js';
import { munsitSpeech } from './munsit/speech.js';
import type { AiTool, ToolEvent } from './ai-tool/types.js';
import { claudeTool } from './claude/index.js';
import { codexTool } from './codex/index.js';
import type { BrowserModule } from './browser/types.js';
import { playwrightBrowser } from './playwright/index.js';
import type { PhoneModule } from './phone/types.js';
import { iosSimulator } from './ios-simulator/index.js';
import { androidEmulator } from './android-emulator/index.js';
import type { PhoneDriverModule } from './phone-driver/types.js';
import { maestroDriver } from './maestro/index.js';

/**
 * The one place that knows which products squad-kit has modules for (ADR-002). The engine asks here for "this
 * project's tracker" or "the code host of this repo" and never names a product.
 */

export const TRACKERS: TrackerModule[] = [azureTracker];
export const CODE_HOSTS: CodeHostModule[] = [azureCodeHost];
export const SPEECH: SpeechModule[] = [munsitSpeech];
export const AI_TOOLS: AiTool[] = [claudeTool, codexTool];
export const BROWSERS: BrowserModule[] = [playwrightBrowser];
export const PHONES: PhoneModule[] = [iosSimulator, androidEmulator];
export const PHONE_DRIVERS: PhoneDriverModule[] = [maestroDriver];

function rootOf(bp: BoardPaths): string {
  return bp.root;
}

export function trackerModule(name: string | undefined): TrackerModule | undefined {
  return TRACKERS.find((m) => m.name === name);
}

/** The tracker set up for the project, when it has a module and a saved sign-in. */
export function trackerFor(bp: BoardPaths): Tracker | null {
  const root = rootOf(bp);
  const configFile = buildPaths(root).configFile;
  if (!fs.existsSync(configFile)) return null;
  return trackerModule(loadConfig(configFile).tracker.type)?.open(root) ?? null;
}

/** The code host behind a repo's git remote, when it has a module and a saved sign-in. */
export function repoHostFor(bp: BoardPaths, remoteUrl: string): RepoHost | null {
  const root = rootOf(bp);
  for (const m of CODE_HOSTS) {
    const host = m.repoFor(root, remoteUrl);
    if (host) return host;
  }
  return null;
}

/** The tracker a git remote points to, with the settings read from it, for a project not set up yet. */
export function guessTracker(remoteUrls: string[]): { module: TrackerModule; values: Record<string, string> } | null {
  for (const url of remoteUrls) {
    for (const m of TRACKERS) {
      const values = m.guess(url);
      if (values) return { module: m, values };
    }
  }
  return null;
}

/** The speech to text service set up for the project, when a key is saved. A given key or fetch is used instead. */
export function speechFor(bp: BoardPaths, opts: { key?: string; fetch?: typeof fetch } = {}): Speech | null {
  const root = rootOf(bp);
  for (const m of SPEECH) {
    const s = m.open(root, opts);
    if (s) return s;
  }
  return null;
}

/** The speech service people set a key for in Settings. */
export function speechModule(): SpeechModule {
  return SPEECH[0]!;
}

/** The browser squad-kit drives itself, for the screenshots and the pages agents ask to see. */
export function shotBrowser(): BrowserModule {
  return BROWSERS[0]!;
}

/** The phone squad-kit runs itself for an app's pictures, Start and Try it yourself: the iPhone's, or Android's. */
export function shotPhone(system: 'ios' | 'android' = 'ios'): PhoneModule {
  return system === 'android' ? PHONES[1]! : PHONES[0]!;
}

/** The tool that taps through the app on squad-kit's phone. */
export function phoneDriver(): PhoneDriverModule {
  return PHONE_DRIVERS[0]!;
}

/** The AI tool an agent file names. */
export function aiTool(name: string): AiTool | undefined {
  return AI_TOOLS.find((t) => t.name === name);
}

/** One plain-words line for a tool call, from whichever AI tool knows its name. */
export function describeToolEvent(e: ToolEvent, cwd: string): string | null {
  for (const t of AI_TOOLS) {
    const line = t.describe(e, cwd);
    if (line) return line;
  }
  return null;
}
