import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { git } from '../git.js';
import { folderBytes } from './run.js';
import { DbError, type DbKind, type DbTemplate, type TemplateInfo, type TemplateOptions } from './types.js';

/**
 * A template's folder on this computer. A new template is made in a folder beside the old one and takes its place only
 * when it is ready, so a template that fails half way leaves the last good one as it was. Never inside git: a template
 * holds rows from the person's database.
 */

export const INFO_FILE = 'template.json';

export const DEFAULTS = { smallRows: 1000, sampleRows: 1000 };

/** The options with their defaults, checked. */
export function withDefaults(opts: TemplateOptions): Required<TemplateOptions> {
  const n = (v: number | undefined, d: number) => (Number.isInteger(v) && v! > 0 ? v! : d);
  if (!opts.folder || !path.isAbsolute(opts.folder)) throw new DbError('The template needs a full path to a folder on this computer.', 'bad-address');
  return { folder: path.resolve(opts.folder), smallRows: n(opts.smallRows, DEFAULTS.smallRows), sampleRows: n(opts.sampleRows, DEFAULTS.sampleRows), hidePersonal: opts.hidePersonal === true };
}

/** True when the folder (or the nearest one above it that exists) is inside a git work tree. */
function insideGit(folder: string): boolean {
  let dir = folder;
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  // Through the engine's one way of running git, which runs no hook and no program of the folder's own.
  return git(dir, ['rev-parse', '--is-inside-work-tree'], { allowFail: true, timeoutMs: 5000 }) === 'true';
}

/** A new, empty folder beside the template's, to make the new template in. */
export function startFolder(folder: string): string {
  if (insideGit(folder)) throw new DbError('A template holds rows from your database, so it is never kept inside a git folder. Choose a folder outside the project.', 'bad-address');
  fs.mkdirSync(path.dirname(folder), { recursive: true });
  const making = `${folder}.making-${randomBytes(4).toString('hex')}`;
  fs.mkdirSync(making, { recursive: true, mode: 0o700 });
  return making;
}

/** Writes template.json and puts the new folder in the old one's place. */
export function finishFolder(making: string, folder: string, info: Omit<TemplateInfo, 'bytes'>): TemplateInfo {
  const full: TemplateInfo = { ...info, bytes: 0 };
  fs.writeFileSync(path.join(making, INFO_FILE), JSON.stringify(full, null, 2) + '\n');
  full.bytes = folderBytes(making);
  fs.writeFileSync(path.join(making, INFO_FILE), JSON.stringify(full, null, 2) + '\n');
  const old = `${folder}.old-${randomBytes(4).toString('hex')}`;
  if (fs.existsSync(folder)) fs.renameSync(folder, old);
  fs.renameSync(making, folder);
  fs.rmSync(old, { recursive: true, force: true });
  return full;
}

/** Removes a folder a template was being made in. */
export function dropFolder(making: string): void {
  fs.rmSync(making, { recursive: true, force: true });
}

/** A template made earlier, from its folder, or null when there is none (or it is of another kind). */
export function readTemplate(folder: string, source: string, kind?: DbKind): DbTemplate | null {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(folder, INFO_FILE), 'utf8')) as TemplateInfo;
    if (!info?.kind || (kind && info.kind !== kind)) return null;
    return { kind: info.kind, folder: path.resolve(folder), source, info };
  } catch {
    return null;
  }
}
