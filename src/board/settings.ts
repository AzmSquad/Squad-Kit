import path from 'node:path';
import { readMeta, writeMeta, type BoardPaths } from './store.js';
import type { BoardMeta, ProjectCommands } from './types.js';
import { git, isRepo, remotes } from '../engine/git.js';
import { parseQuality } from '../engine/levels.js';
import { hostsProblem, parseHosts, parseNetwork } from '../engine/sandbox.js';
import { sharedPath } from '../engine/project-guard.js';
import { parseChoice } from '../engine/tools/which-phone.js';
import { checkEnvFiles } from '../engine/env-file.js';

/**
 * Settings, Save: the project's settings, checked, then saved. The board's Save and a Squad lead card that the person
 * presses run this same function, so a setting is checked the same way whichever way it comes.
 */

export type SettingsInput = {
  commands?: ProjectCommands;
  git?: { base?: string; remote?: string };
  parallel?: number;
  atOnce?: number | null;
  delivery?: 'pr' | 'push' | null;
  runner?: 'acp' | 'direct';
  documentsInGit?: boolean;
  alwaysNewTests?: boolean;
  phone?: string;
  quality?: string;
  allowedHosts?: string[];
  network?: string;
  guard?: { allowRead?: string[]; allowWrite?: string[] };
  repos?: { path: string; base?: string; remote?: string; commands?: ProjectCommands }[];
};

/**
 * A branch or remote that does not exist would only show much later, as a story or a release that fails. An engineer
 * sets these, so the words are an engineer's. A folder that is not in git yet, or has no commits, has nothing to check.
 */
function checkWhereCodeGoes(dir: string, base: string, remote: string): void {
  if (!isRepo(dir)) return;
  const remotesHere = remotes(dir);
  if (remote && !remotesHere.includes(remote)) throw new Error(`There is no remote called "${remote}" here. ${remotesHere.length ? `It has: ${remotesHere.join(', ')}.` : 'It has none yet.'} Nothing was saved.`);
  const branches = git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', ...(remote ? [`refs/remotes/${remote}`] : [])], { allowFail: true }).split('\n').map((b) => b.replace(`${remote}/`, '')).filter((b) => b && b !== 'HEAD' && b !== remote);
  if (branches.length && !branches.includes(base)) throw new Error(`There is no branch called "${base}" here. It has: ${[...new Set(branches)].slice(0, 8).join(', ')}. Nothing was saved.`);
}

export function saveSettings(bp: BoardPaths, b: SettingsInput): BoardMeta {
  const meta = readMeta(bp);
  if (b.allowedHosts !== undefined) {
    const parsed = parseHosts(Array.isArray(b.allowedHosts) ? b.allowedHosts : []);
    const problem = hostsProblem(parsed);
    if (problem) throw new Error(problem);
    meta.allowedHosts = parsed.hosts;
  }
  if (b.network !== undefined) {
    const level = parseNetwork(b.network);
    if (!level) throw new Error(`"${b.network}" is not a network level. Use standard, strict or off.`);
    meta.network = level;
  }
  if (b.guard !== undefined) {
    const clean = (list: unknown): string[] => [...new Set((Array.isArray(list) ? list : []).map((p) => String(p).trim()).filter(Boolean).map((p) => sharedPath(p)))];
    const read = clean(b.guard.allowRead);
    const write = clean(b.guard.allowWrite);
    meta.guard = read.length || write.length ? { ...(read.length ? { allowRead: read } : {}), ...(write.length ? { allowWrite: write } : {}) } : undefined;
  }
  if (b.quality !== undefined) {
    const q = parseQuality(b.quality);
    if (!q) throw new Error(`"${b.quality}" is not a Quality setting. Use best, balanced or thrifty.`);
    meta.quality = q;
  }
  if (b.commands) {
    meta.commands = Object.fromEntries(
      Object.entries(b.commands).map(([k, v]) => [k, String(v ?? '').trim()]).filter(([, v]) => v),
    ) as ProjectCommands;
  }
  if (b.git) {
    const next = { base: b.git.base?.trim() || meta.git?.base || 'main', remote: b.git.remote?.trim() ?? meta.git?.remote ?? '' };
    checkWhereCodeGoes(bp.root, next.base, next.remote);
    meta.git = next;
  }
  if (typeof b.parallel === 'number' && b.parallel >= 1 && b.parallel <= 5) meta.parallel = Math.round(b.parallel);
  if (b.delivery === null) delete meta.delivery;
  else if (b.delivery === 'pr' || b.delivery === 'push') meta.delivery = b.delivery;
  if (b.atOnce === null) delete meta.atOnce;
  else if (typeof b.atOnce === 'number' && b.atOnce >= 1 && b.atOnce <= 5) meta.atOnce = Math.round(b.atOnce);
  if (b.runner === 'acp' || b.runner === 'direct') meta.runner = b.runner;
  if (typeof b.documentsInGit === 'boolean') meta.documentsInGit = b.documentsInGit;
  // Left out when off, so a project that never chose has nothing new in its settings file.
  if (b.alwaysNewTests === true) meta.alwaysNewTests = true;
  else if (b.alwaysNewTests === false) delete meta.alwaysNewTests;
  // The phone an app for both phones uses: left out when automatic, like a project that never chose.
  if (b.phone !== undefined) {
    const choice = parseChoice(b.phone);
    if (!choice) throw new Error(`"${b.phone}" is not a phone here. Use iphone, android or auto.`);
    if (choice === 'auto') delete meta.phone;
    else meta.phone = choice;
  }
  if (b.repos && meta.repos) {
    meta.repos = meta.repos.map((r) => {
      const u = b.repos!.find((x) => x.path === r.path);
      if (!u) return r;
      const commands = Object.fromEntries(
        Object.entries(u.commands ?? r.commands).map(([k, v]) => [k, String(v ?? '').trim()]).filter(([, v]) => v),
      ) as ProjectCommands;
      const next = { base: u.base?.trim() || r.base, remote: u.remote?.trim() ?? r.remote };
      checkWhereCodeGoes(path.join(bp.root, r.path), next.base, next.remote);
      return { ...r, ...next, commands };
    });
  }
  // A part's env file must be a path inside its repo (engine/env-file.ts).
  checkEnvFiles(meta);
  writeMeta(bp, meta);
  return meta;
}
