import fs from 'node:fs';
import path from 'node:path';
import type { PhoneKind } from './build.js';

/**
 * The languages a phone app comes in, read from its own files only: a Flutter app's translation files (lib/l10n/*.arb,
 * or the folder its l10n.yaml names), an iPhone app's *.lproj folders, an Android app's res/values-* folders. English first, then the others. Empty when it
 * has one language, or when squad-kit cannot tell (React Native keeps them in code): then there is nothing to pick.
 */

const list = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

/** "app_en.arb", "intl_ar.arb", "app_en_US.arb": the language, "en". */
export function arbLanguage(file: string): string | null {
  // The region or script after it is in capitals ("en_US", "zh_Hant"), so "app" in "app_ar.arb" is never taken for one.
  const m = /(?:^|_)([a-z]{2,3})(?:[_-](?:[A-Z]{2}|[A-Z][a-z]{3}))?\.arb$/.exec(file);
  return m ? m[1]! : null;
}

/** The folder a Flutter app keeps its translations in: what l10n.yaml says, else lib/l10n. */
function arbDir(dir: string): string {
  try {
    const yaml = fs.readFileSync(path.join(dir, 'l10n.yaml'), 'utf8');
    const named = /^arb-dir:\s*["']?([^"'\n#]+?)["']?\s*$/m.exec(yaml)?.[1];
    if (named) return path.join(dir, named);
  } catch {
    // No l10n.yaml: Flutter's own default.
  }
  return path.join(dir, 'lib', 'l10n');
}

/** The *.lproj folders a few levels down an iPhone project, never into packages or build folders. */
function lprojLanguages(dir: string, depth = 3): string[] {
  const out: string[] = [];
  for (const name of list(dir)) {
    const m = /^([a-z]{2,3})(?:[-_][A-Za-z]{2,4})?\.lproj$/.exec(name);
    if (m) out.push(m[1]!);
    else if (depth > 0 && !name.startsWith('.') && !/^(node_modules|Pods|build|DerivedData|Carthage)$/.test(name) && isDir(path.join(dir, name))) out.push(...lprojLanguages(path.join(dir, name), depth - 1));
  }
  return out;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** A native Android app's res/values-<lang> folders, a few levels down, never into build folders. */
function valuesLanguages(dir: string, depth = 4): string[] {
  const out: string[] = [];
  for (const name of list(dir)) {
    const m = /^values-([a-z]{2,3})(?:-r[A-Z]{2})?$/.exec(name);
    if (m && path.basename(dir) === 'res') out.push(m[1]!);
    else if (depth > 0 && !name.startsWith('.') && !/^(build|node_modules|\.gradle)$/.test(name) && isDir(path.join(dir, name))) out.push(...valuesLanguages(path.join(dir, name), depth - 1));
  }
  return out;
}

export function appLanguages(dir: string, kind: PhoneKind): string[] {
  if (kind === 'react-native') return [];
  // A native Android app's default language is its plain values folder: English, for squad-kit's choice.
  const found = kind === 'flutter' ? list(arbDir(dir)).map(arbLanguage).filter((l): l is string => Boolean(l)) : kind === 'android' ? ['en', ...valuesLanguages(dir)] : lprojLanguages(dir);
  const all = [...new Set(found)].sort((a, b) => (a === 'en' ? -1 : b === 'en' ? 1 : a.localeCompare(b)));
  return all.length > 1 ? all : [];
}
