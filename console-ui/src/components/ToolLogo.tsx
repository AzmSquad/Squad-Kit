import type { CSSProperties } from 'react';
import { Bot, Pointer } from 'lucide-react';
import { LOGOS } from '../lib/logos';

/**
 * A tool's own logo on a tile of its brand color, like an app on a phone, for the Tools page and the message of a step a
 * tool stops. A tool with no free logo (Maestro, Codex) gets a plain picture on a color of its own.
 */

const BY_ID: Record<string, string> = {
  git: 'git',
  flutter: 'flutter',
  xcode: 'xcode',
  simulator: 'apple',
  cocoapods: 'cocoapods',
  java: 'openjdk',
  android: 'android',
  'android-studio': 'androidstudio',
  docker: 'docker',
};

/** The AI tool's line carries the tool's own name: "Claude Code", "Gemini CLI". */
const AI_BY_NAME: [RegExp, string][] = [
  [/claude/i, 'claude'],
  [/gemini/i, 'googlegemini'],
  [/cursor/i, 'cursor'],
  [/copilot/i, 'githubcopilot'],
];

const OWN: Record<string, { hex: string; Icon: typeof Bot }> = {
  maestro: { hex: '7B61FF', Icon: Pointer },
  'ai-tool': { hex: '0D8A42', Icon: Bot },
};

function logoOf(id: string, name: string) {
  const key = id === 'ai-tool' ? AI_BY_NAME.find(([re]) => re.test(name))?.[1] : BY_ID[id];
  return key ? LOGOS[key] : undefined;
}

/** The tool's brand color, for its tile and its progress bar. */
export function brandOf(id: string, name: string): string {
  return `#${hexOf(id, name)}`;
}

const hexOf = (id: string, name: string) => logoOf(id, name)?.hex ?? OWN[id]?.hex ?? '536159';

/** A light brand color, like Android's green, carries a dark picture; every other one a white picture. */
function light(hex: string): boolean {
  const n = parseInt(hex, 16);
  return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114 > 150;
}

export function ToolLogo({ id, name, size = 42 }: { id: string; name: string; size?: number }) {
  const logo = logoOf(id, name);
  const own = OWN[id];
  const style = { '--brand': brandOf(id, name), '--size': `${size}px` } as CSSProperties;
  return (
    <span className={`tl-logo ${light(hexOf(id, name)) ? 'light' : ''}`} style={style} aria-hidden="true">
      {logo ? (
        <svg viewBox="0 0 24 24" className="tl-glyph">
          <path d={logo.path} />
        </svg>
      ) : own ? (
        <own.Icon strokeWidth={2.2} />
      ) : (
        <b>{name.slice(0, 2)}</b>
      )}
    </span>
  );
}
