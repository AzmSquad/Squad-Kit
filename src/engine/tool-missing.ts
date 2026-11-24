/**
 * A failed check that only lacks a tool says nothing about the story's code: no Builder could fix it. Its output is read
 * for the few things a missing tool prints, by name. On a match squad-kit checks this computer's tools again and runs
 * the checks once more, with no try counted; when the tool is still missing, the story waits for it with the Tools
 * page's plain line, or stops with a card. The Builder is never asked.
 */

/** What a missing tool prints, by what is missing. Kept small: each one is a tool's own words, never a test's. */
export const TOOL_MISSING: { what: string; says: RegExp }[] = [
  { what: 'the Android SDK', says: /No Android SDK found|SDK location not found|ANDROID_HOME (?:is not set|environment variable)|ANDROID_SDK_ROOT (?:is not set|environment variable)/ },
  // An SDK that builds apps but lacks the version a project's Gradle asks for, and may not download it (a person's own,
  // like Android Studio's): Android's own Gradle plugin says so in these words.
  { what: 'a part of the Android SDK', says: /Failed to find Build Tool revision|Failed to find target with hash string|No installed build tools found|failed to find target android-\d|licen[cs]es? for (?:package|the following SDK components)[^\n]*not accepted|NDK not configured|No NDK was found|NDK at \S+ did not have a source\.properties|NDK is not installed/i },
  // FVM inside the guard when squad-kit could not get the pinned Flutter first (fvm-sdk.ts): no code change brings it.
  { what: 'the Flutter version this project pins', says: /Flutter SDK: SDK Version : \S+ is not installed|Failed to install Flutter SDK|Failed to retrieve Flutter SDK releases/ },
  { what: 'Java', says: /JAVA_HOME is not set|Unable to locate a Java Runtime|No Java runtime present/ },
  { what: 'Xcode', says: /xcrun: error:/ },
  // A shell that finds no such program: "zsh: command not found: flutter", "sh: 1: flutter: not found".
  { what: 'a program the command runs', says: /command not found|(?:^|\n)(?:\/bin\/)?(?:sh|bash|dash)(?::\s*(?:line\s+)?\d+)?:\s*[\w.+-]+: not found/ },
];

/** What a failed check's output says is missing, or null when it failed for any other reason. */
export function toolMissing(output: string): { what: string; line: string } | null {
  for (const t of TOOL_MISSING) {
    const m = t.says.exec(output);
    if (!m) continue;
    const at = output.lastIndexOf('\n', m.index) + 1;
    const end = output.indexOf('\n', m.index + m[0].length);
    return { what: t.what, line: output.slice(at, end < 0 ? undefined : end).trim().slice(0, 240) };
  }
  return null;
}

/** How many times squad-kit runs the checks again by itself for a missing tool, before the story waits or stops. */
export const TOOL_RERUNS = 1;

/**
 * What squad-kit does after checks that failed only for a missing tool: run them once more (`again`) when it has not
 * yet; else wait for the tool with the Tools page's line (`wait`) when the Tools page knows it; else a card (`stop`).
 */
export function afterToolMissing(reruns: number, block: unknown | null): 'again' | 'wait' | 'stop' {
  if (reruns < TOOL_RERUNS) return 'again';
  return block ? 'wait' : 'stop';
}
