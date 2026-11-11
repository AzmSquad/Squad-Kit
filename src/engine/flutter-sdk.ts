import fs from 'node:fs';
import path from 'node:path';

/**
 * The person's Flutter, as the project's commands and the agents' shell find it, and the few files in its folder that
 * every run of `flutter` or `dart` writes. Flutter's folder is the person's program and stays read only in both guards,
 * so a story's code can never change what they run later. Only these stamps open, each one exactly: on a Mac in the real
 * folder, on Linux in a throwaway one that goes when the command ends.
 */

/**
 * The Flutter a command finds on its PATH, by the PATH's full folders only: a folder named from where a command runs
 * could be one a story writes in. Its own folder too, where it keeps what it downloads.
 */
export function flutterOnPath(env: NodeJS.ProcessEnv = process.env): { program: string; root: string } | null {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const program = path.join(dir, process.platform === 'win32' ? 'flutter.bat' : 'flutter');
    try {
      if (!fs.statSync(program).isFile()) continue;
      return { program, root: path.dirname(path.dirname(fs.realpathSync(program))) };
    } catch {
      // Not in this folder.
    }
  }
  return null;
}

/**
 * Flutter's own version stamps in its folder. From Flutter 3.35 on, every run of `flutter` and `dart` writes the engine's
 * version there (bin/internal/update_engine_version.sh), whatever the command. They hold only that version, which
 * Flutter writes again from its own files on the next run, so a story can leave nothing there that lasts. Nothing else
 * of Flutter's folder opens: not its Dart, its engine files, its tool or its programs.
 */
export const FLUTTER_STAMPS: { file: string; regex: string; glob: string; why: string }[] = [
  { file: 'bin/cache/engine.stamp', regex: String.raw`bin/cache/engine\.stamp`, glob: 'bin/cache/engine.stamp', why: "the engine's version, which Flutter writes on every run" },
  { file: 'bin/cache/engine.stamp.tmp.<number>', regex: String.raw`bin/cache/engine\.stamp\.tmp\.[0-9]+`, glob: 'bin/cache/engine.stamp.tmp.*', why: 'the same, first written under the number of the run, then moved onto engine.stamp' },
  { file: 'bin/cache/engine.realm', regex: String.raw`bin/cache/engine\.realm`, glob: 'bin/cache/engine.realm', why: 'where the engine comes from, which Flutter writes on every run (empty for its own)' },
];

/** The stamps of one Flutter folder, each as a whole path: a regex for squad-kit's guard. */
export function flutterStampRegexes(root: string): string[] {
  const base = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\/$/, '');
  return FLUTTER_STAMPS.map((s) => `^${base}/${s.regex}$`);
}

/** The same as paths for an AI tool's sandbox, which takes a glob for the one named by the run. */
export function flutterStampGlobs(root: string): string[] {
  return FLUTTER_STAMPS.map((s) => path.join(root, s.glob));
}

/**
 * The folders the stamps are in (bin/cache), each as a whole path. Bubblewrap opens only whole files and folders, never a
 * file named by the run, so on Linux the guard gives each command a throwaway one in its place (bubblewrapArgs in
 * engine/project-guard.ts).
 */
export function flutterStampFolders(root: string): string[] {
  return [...new Set(FLUTTER_STAMPS.map((s) => path.join(root, path.dirname(s.file))))];
}
