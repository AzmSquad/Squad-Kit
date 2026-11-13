import fs from 'node:fs';
import path from 'node:path';
import type { BoardMeta, Ticket } from '../../board/types.js';
import { partsOf } from '../../board/parts.js';
import { copiesOf } from '../copies.js';
import { reposOf } from '../repos.js';
import { remoteKind } from '../../modules/registry.js';

/**
 * What kind of project each part is, read from its files, so the Tools page knows what this project needs. Only files
 * are read: nothing runs. A part can be more than one kind (a Flutter app with a Docker file), and a phone app says
 * which phones it builds for from its folders. Its repo's remotes say where its code is kept, for the code host's tool.
 */

export type ProjectKind = 'web' | 'flutter' | 'react-native' | 'ios' | 'android' | 'docker' | 'github';
export type Platform = 'ios' | 'android' | 'web';

export interface PlaceKinds {
  /** The folder, relative to the project ("." for its top folder). */
  place: string;
  /** The part's name, when the project has named parts. */
  part?: string;
  kinds: ProjectKind[];
  platforms: Platform[];
}

const read = (file: string): string | null => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

const has = (dir: string, ...p: string[]) => fs.existsSync(path.join(dir, ...p));

/** A package.json's dependencies, all kinds together. */
function packages(dir: string): Record<string, unknown> | null {
  const text = read(path.join(dir, 'package.json'));
  if (text === null) return null;
  try {
    const j = JSON.parse(text) as Record<string, Record<string, unknown> | undefined>;
    return { ...j.dependencies, ...j.devDependencies, ...j.peerDependencies };
  } catch {
    return {};
  }
}

/** An Xcode project or workspace right in the folder, or one level down (ios/, App/). */
function xcodeProject(dir: string): boolean {
  const here = (d: string) => {
    try {
      return fs.readdirSync(d).some((f) => f.endsWith('.xcodeproj') || f.endsWith('.xcworkspace'));
    } catch {
      return false;
    }
  };
  if (here(dir)) return true;
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .some((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && here(path.join(dir, e.name)));
  } catch {
    return false;
  }
}

const GRADLE = ['build.gradle', 'build.gradle.kts'];
const androidApp = (file: string) => /com\.android\.application/.test(read(file) ?? '');

/** The kinds and phone platforms of one folder. */
export function kindsOf(dir: string): { kinds: ProjectKind[]; platforms: Platform[] } {
  const kinds: ProjectKind[] = [];
  const platforms = new Set<Platform>();
  const deps = packages(dir);
  const pubspec = read(path.join(dir, 'pubspec.yaml'));
  // A Dart package names the Flutter SDK as a dependency: `flutter:` then `sdk: flutter`.
  const flutter = pubspec !== null && /^\s+sdk:\s*["']?flutter\b/m.test(pubspec);
  const reactNative = Boolean(deps && ('react-native' in deps || 'expo' in deps));
  if (flutter) kinds.push('flutter');
  if (reactNative) kinds.push('react-native');
  if (flutter || reactNative) {
    if (has(dir, 'ios')) platforms.add('ios');
    if (has(dir, 'android')) platforms.add('android');
    if (has(dir, 'web')) platforms.add('web');
    // Expo makes the phone folders when it builds: it builds for both phones.
    if (reactNative && deps && 'expo' in deps && !has(dir, 'ios') && !has(dir, 'android')) {
      platforms.add('ios');
      platforms.add('android');
    }
  } else {
    if (deps) {
      kinds.push('web');
      platforms.add('web');
    }
    if (xcodeProject(dir)) {
      kinds.push('ios');
      platforms.add('ios');
    }
    if (GRADLE.some((g) => has(dir, 'android', 'app', g) || androidApp(path.join(dir, 'app', g)) || androidApp(path.join(dir, g)))) {
      kinds.push('android');
      platforms.add('android');
    }
  }
  if (['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].some((f) => has(dir, f))) kinds.push('docker');
  for (const kind of remoteUrls(dir).map(remoteKind)) if (kind && !kinds.includes(kind as ProjectKind)) kinds.push(kind as ProjectKind);
  return { kinds, platforms: [...platforms] };
}

/** The repo's git config file, for a folder in it: its own `.git`, or the shared one of a git worktree. */
function gitConfigOf(dir: string): string | null {
  for (let d = path.resolve(dir), i = 0; i < 12; i++, d = path.dirname(d)) {
    const dot = path.join(d, '.git');
    try {
      if (fs.statSync(dot).isDirectory()) return path.join(dot, 'config');
      const gitdir = /^gitdir:\s*(.+)$/m.exec(read(dot) ?? '')?.[1]?.trim();
      if (!gitdir) return null;
      const at = path.resolve(d, gitdir);
      const common = read(path.join(at, 'commondir'))?.trim();
      return path.join(common ? path.resolve(at, common) : at, 'config');
    } catch {
      // No .git here: the folder above.
    }
    if (path.dirname(d) === d) break;
  }
  return null;
}

/** The addresses of the repo's remotes, read from its git config. */
function remoteUrls(dir: string): string[] {
  const file = gitConfigOf(dir);
  const text = file ? read(file) : null;
  if (!text) return [];
  const out: string[] = [];
  let inRemote = false;
  for (const line of text.split('\n')) {
    const section = /^\s*\[([^\]]+)\]/.exec(line);
    if (section) inRemote = /^remote\s+"/.test(section[1]!);
    const url = inRemote ? /^\s*url\s*=\s*(.+?)\s*$/.exec(line)?.[1] : undefined;
    if (url) out.push(url);
  }
  return out;
}

/**
 * The folders to read: each part's folder, or each repo's top folder when the project has no named parts yet. For a
 * story with its own copy of the code, its copies are read instead (a first story may add the app there), and only its
 * own parts and repos count.
 */
export function placesOf(root: string, meta: BoardMeta | null, story?: Pick<Ticket, 'parts' | 'repo' | 'worktree' | 'copies'>): { dir: string; place: string; part?: string }[] {
  const repos = meta ? reposOf(meta) : [{ path: '.', base: 'main', remote: '', commands: {} }];
  const copies = meta && story?.worktree && fs.existsSync(story.worktree) ? copiesOf(meta, story as Ticket) : [];
  const storyRepos = new Set(copies.length ? copies.map((c) => c.repo.path) : story?.repo ? [story.repo] : []);
  const parts = meta ? partsOf(meta).filter((p) => !p.shared && !p.off) : [];
  const wanted = story?.parts?.length ? new Set(story.parts) : null;
  const out: { dir: string; place: string; part?: string }[] = [];
  for (const r of repos) {
    if (storyRepos.size && !storyRepos.has(r.path)) continue;
    const top = copies.find((c) => c.repo.path === r.path)?.dir ?? path.join(root, r.path);
    const inRepo = parts.filter((p) => (p.repo ?? '.') === r.path && (!wanted || wanted.has(p.id)));
    if (!inRepo.length) out.push({ dir: top, place: r.path });
    for (const p of inRepo) out.push({ dir: path.join(top, p.folder ?? ''), place: path.join(r.path, p.folder ?? ''), part: p.name });
  }
  const seen = new Set<string>();
  return out.filter((p) => (seen.has(p.dir) ? false : (seen.add(p.dir), true)));
}

/** The kinds of every place of a project, or of one story. Places with no kind are left out. */
export function projectKinds(root: string, meta: BoardMeta | null, story?: Pick<Ticket, 'parts' | 'repo' | 'worktree' | 'copies'>): PlaceKinds[] {
  return placesOf(root, meta, story)
    .map((p) => ({ place: p.place, ...(p.part ? { part: p.part } : {}), ...kindsOf(p.dir) }))
    .filter((p) => p.kinds.length);
}
