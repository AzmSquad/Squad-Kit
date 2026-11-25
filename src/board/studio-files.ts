import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { STUDIO_ID, VERSION_DIR } from './studio-paths.js';

/**
 * The Studio's files on disk: how its folders are listed, how an item's change stamp is made from its files, and how a
 * save writes. Only the Studio store (studio.ts and studio-read.ts) uses these; later stories go through studio.ts.
 *
 * A symbolic link under `.squad/studio/` is not part of the Studio: listing, reading and the stamp all leave it out, so
 * a read never goes outside the folder and never reads a file the stamp does not count.
 */

/** Names a save is still writing (`… .tmp`) and hidden files (.DS_Store) are not part of the Studio. */
function counts(name: string): boolean {
  return !name.startsWith('.') && !name.endsWith('.tmp');
}

/** A file itself, not a link to one: the only kind a read takes and the stamp counts. */
export function plainFile(file: string): boolean {
  return fs.lstatSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
}

/** A folder itself, not a link to one. */
export function plainDir(dir: string): boolean {
  return fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

export function readYamlFile(file: string): unknown {
  const text = fs.readFileSync(file, 'utf8');
  try {
    return yaml.load(text);
  } catch {
    throw problem(`The file ${file}`);
  }
}

/** The folders in a folder, by name. A link to a folder is left out. */
export function folders(dir: string): string[] {
  if (!plainDir(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && counts(e.name))
    .map((e) => e.name)
    .sort();
}

/** The version folders in a folder, oldest first. */
export function versionsIn(dir: string): number[] {
  return folders(dir)
    .map((name) => VERSION_DIR.exec(name)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

/** The `<id>.html` files in a folder, by id. A link to a file is left out, as the stamp leaves it out. */
export function htmlFiles(dir: string): Record<string, string> {
  if (!plainDir(dir)) return {};
  const out: Record<string, string> = {};
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const id = e.name.endsWith('.html') ? e.name.slice(0, -'.html'.length) : '';
    if (STUDIO_ID.test(id) && e.isFile()) out[id] = fs.readFileSync(path.join(dir, e.name), 'utf8');
  }
  return out;
}

export function sha1(data: string | Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Every shared file in an item's folder, as paths inside it with `/`, sorted by name. */
function sharedFiles(dir: string, inside = ''): string[] {
  if (!plainDir(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!counts(e.name)) continue;
    const rel = inside ? `${inside}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...sharedFiles(path.join(dir, e.name), rel));
    else if (e.isFile()) out.push(rel);
  }
  return out.sort();
}

/**
 * The change stamp of an item's folder: a short fingerprint of every shared file's name and text, sorted by name.
 * It comes from the files alone, so the same files give the same stamp on every computer, and any change (here, in
 * another tab, or through a git pull) gives a new one. Null when the item has no files.
 */
export function stampOfFolder(dir: string): string | null {
  const files = sharedFiles(dir);
  if (!files.length) return null;
  const h = createHash('sha1');
  for (const rel of files) h.update(`${rel}\n${sha1(fs.readFileSync(path.join(dir, ...rel.split('/'))))}\n`);
  return h.digest('hex').slice(0, 16);
}

/** The ids of the items of one kind in the project. Reading never makes a folder. */
export function idsIn(dir: string): string[] {
  return folders(dir).filter((id) => STUDIO_ID.test(id));
}

/**
 * Writes through a temp file, the way the store does, so a reader never sees half a file. A file whose text is
 * unchanged is left alone, so a save that changes nothing makes no change in git. Folders appear only here.
 */
export function writeShared(file: string, text: string | Buffer): void {
  if (fs.existsSync(file) && fs.readFileSync(file).equals(Buffer.from(text))) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * Writes a whole new version folder (v1, v2 …) at once: its files go into a temp folder that is then renamed, so a
 * reader sees all of the version or none of it. A saved version is never written again.
 */
export function writeNewVersion(dir: string, files: Record<string, string>): void {
  if (fs.existsSync(dir)) throw new Error(`${path.basename(dir)} is already saved, and a saved version never changes. Reload and save again.`);
  const tmp = `${dir}.${process.pid}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    for (const [file, text] of Object.entries(files)) {
      const inTmp = path.join(tmp, path.relative(dir, file));
      fs.mkdirSync(path.dirname(inTmp), { recursive: true });
      fs.writeFileSync(inTmp, text, 'utf8');
    }
    fs.mkdirSync(tmp, { recursive: true });
    fs.renameSync(tmp, dir);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

export function dumpYaml(data: unknown): string {
  return yaml.dump(JSON.parse(JSON.stringify(data)), { lineWidth: 110, noRefs: true });
}

/** A Studio file that could not be read, in words for the person. */
export function problem(what: string): Error {
  return new Error(`${what} could not be read. Nothing is lost. An engineer can look at it.`);
}
