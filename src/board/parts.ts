import fs from 'node:fs';
import path from 'node:path';
import type { CodePart, PartLink } from './overview.js';
import type { BoardMeta, ProductPart, ProjectCommands } from './types.js';
import { readMeta, writeMeta, type BoardPaths } from './store.js';

/**
 * What the product is made of: the parts that run by themselves (a web app, an API, a worker) and the services they
 * share (a database, Redis). The Architect finds them when it reads the project. An engineer corrects them in Settings
 * or with `squad parts`, and a new read keeps what the engineer said. A project with one part sees none of this.
 */

const MAX_PARTS = 30;

export const repoPaths = (meta: BoardMeta): string[] => (meta.repos?.length ? meta.repos.map((r) => r.path) : ['.']);

const commandsOn = (meta: BoardMeta, repo?: string): ProjectCommands | undefined => (meta.repos?.length ? meta.repos.find((r) => r.path === repo)?.commands : meta.commands);

/** The only part in its repo: the repo's App address in Settings is that part's address. */
const aloneInRepo = (parts: ProductPart[], p: ProductPart): boolean => !p.shared && parts.filter((x) => !x.shared && x.repo === p.repo).length === 1;

const withoutUrl = ({ url: _url, ...rest }: ProductPart): ProductPart => rest;

const idFrom = (text: string): string =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/** A repo as a part, when nothing better is known: "pdf-service" reads "Pdf service". */
function partOfRepo(meta: BoardMeta, repo: string): ProductPart {
  const words = repo.replace(/[-_.]+/g, ' ').trim();
  const name = repo === '.' || !words ? meta.project : `${words[0]!.toUpperCase()}${words.slice(1)}`;
  return { id: idFrom(repo) || 'app', name, repo, needs: [] };
}

/** The product's parts, as saved. A project read before squad-kit kept them: one part for each repo. */
export function partsOf(meta: BoardMeta): ProductPart[] {
  const parts = meta.parts?.length ? meta.parts : repoPaths(meta).map((r) => partOfRepo(meta, r));
  return parts.map((p) => {
    const url = aloneInRepo(parts, p) ? commandsOn(meta, p.repo)?.url?.trim() : undefined;
    return url ? { ...p, url } : p;
  });
}

/** Whether there is anything to show the person: more than one part that runs. */
export function severalParts(meta: BoardMeta): boolean {
  return partsOf(meta).filter((p) => !p.shared).length > 1;
}

const wordsOf = (names: string[]): string => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** The product in one plain sentence, for a product with several parts. Only once the Architect named them: a repo's name says nothing to a person. */
export function productLine(meta: BoardMeta): string | undefined {
  if (!meta.parts?.length || !severalParts(meta)) return undefined;
  const on = partsOf(meta).filter((p) => !p.off && !p.noRun);
  const running = on.filter((p) => !p.shared).map((p) => p.name);
  const shared = on.filter((p) => p.shared).map((p) => p.name);
  const first = running.length === 1 ? `The product has one part in use: ${running[0]}.` : `The product has ${running.length} parts: ${wordsOf(running)}.`;
  return shared.length ? `${first} ${running.length === 1 ? 'It uses' : 'They share'} ${wordsOf(shared)}.` : first;
}

/**
 * Whether stories run the whole product: several parts that start by themselves, once the Architect named them. Those keep
 * their usual addresses. A project with one part moves to a free port when its own is taken, as it always did.
 */
export function runsAsProduct(meta: BoardMeta): boolean {
  return Boolean(meta.parts?.length) && partsOf(meta).filter((p) => !p.shared && !p.off && !p.noRun).length > 1;
}

/**
 * What must run for a story, first things first: the parts it changed, what relies on them (a web app shows what its API
 * changed), and what all of those need. A part of another product in the same folder is none of these.
 */
export function partsToRun(meta: BoardMeta, changed: string[]): ProductPart[] {
  const parts = partsOf(meta).filter((p) => !p.off);
  const want = new Set(changed.filter((id) => parts.some((p) => p.id === id)));
  const grow = (more: (p: ProductPart) => string[]) => {
    for (let before = -1; before !== want.size; ) {
      before = want.size;
      for (const p of parts) for (const id of more(p)) if (parts.some((x) => x.id === id)) want.add(id);
    }
  };
  grow((p) => (p.needs.some((n) => want.has(n)) ? [p.id] : []));
  grow((p) => (want.has(p.id) ? p.needs : []));
  const ordered: ProductPart[] = [];
  const seen = new Set<string>();
  const visit = (p: ProductPart) => {
    if (seen.has(p.id)) return;
    seen.add(p.id);
    for (const n of p.needs) {
      const dep = parts.find((x) => x.id === n);
      if (dep && want.has(dep.id)) visit(dep);
    }
    ordered.push(p);
  };
  parts.filter((p) => want.has(p.id)).forEach(visit);
  return ordered.filter((p) => !p.shared && !p.noRun);
}

/** The overview's picture as an engineer corrected it: under the names they gave, without what they marked Not used. */
export function pictureInUse(meta: BoardMeta, picture: { parts: CodePart[]; links: PartLink[] }): { parts: CodePart[]; links: PartLink[] } {
  const known = partsOf(meta);
  const off = known.filter((p) => p.off);
  const parts = picture.parts
    .filter((p) => !off.some((o) => o.id === p.id || o.name.toLowerCase() === p.name.toLowerCase()))
    .map((p) => {
      const run = known.find((k) => k.byHand && k.id === p.id);
      return run ? { ...p, name: run.name } : p;
    });
  return { parts, links: picture.links.filter((l) => parts.some((p) => p.id === l.from) && parts.some((p) => p.id === l.to)) };
}

/** Whether anything in this repo is used. A repo that holds only what is marked Not used is not installed, tested or started. */
export function repoInUse(meta: BoardMeta, repo: string): boolean {
  const parts = (meta.parts ?? []).filter((p) => p.repo === repo);
  return !parts.length || parts.some((p) => !p.off);
}

/** Whether anything in this repo starts by itself, for the list of apps a person can open. */
export function repoRuns(meta: BoardMeta, repo: string): boolean {
  const parts = (meta.parts ?? []).filter((p) => p.repo === repo);
  return !parts.length || parts.some((p) => !p.off && !p.noRun);
}

/** What a person calls this repo: its parts' names, once the Architect named them. */
export function repoLabel(meta: BoardMeta, repo: string): string | undefined {
  const names = (meta.parts ?? []).filter((p) => p.repo === repo && !p.off && !p.shared).map((p) => p.name);
  return names.length ? names.join(', ') : undefined;
}

/* ── The checks ────────────────────────────────────────── */

const isAddress = (text: string): boolean => /^https?:\/\/[^\s/]+\S*$/i.test(text);

/** A folder inside the repo as a plain relative path, or null when it reaches outside. Its top folder is ''. */
function folderInRepo(text: string): string | null {
  const parts = text.trim().replace(/\\/g, '/').split('/').filter((x) => x && x !== '.');
  if (text.trim().startsWith('/') || /^[a-z]:/i.test(text.trim()) || parts.includes('..')) return null;
  return parts.join('/');
}

/** Whether `from` already reaches `to` through what it needs, so `to` needing `from` could never start. */
function reaches(parts: ProductPart[], from: string, to: string, seen = new Set<string>()): boolean {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return (parts.find((p) => p.id === from)?.needs ?? []).some((n) => reaches(parts, n, to, seen));
}

/* ── What the Architect found ──────────────────────────── */

/**
 * The Architect's list as squad-kit can use it, whatever it said. Nothing here can stop a read: what does not fit is
 * left out. A repo it left out starts nothing by itself, like a library: a story may still change it, and only an engineer
 * can say it is not used.
 */
export function cleanParts(found: unknown, meta: BoardMeta, root: string): ProductPart[] {
  const repos = repoPaths(meta);
  const parts: ProductPart[] = [];
  for (const raw of (Array.isArray(found) ? found : []).slice(0, MAX_PARTS)) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    const id = idFrom(typeof p.id === 'string' ? p.id : name);
    if (!id || !name || parts.some((x) => x.id === id)) continue;
    const url = typeof p.url === 'string' && isAddress(p.url.trim()) ? p.url.trim() : '';
    if (p.shared === true) {
      parts.push({ id, name, shared: true, needs: [], ...(url ? { url } : {}) });
      continue;
    }
    const said = typeof p.repo === 'string' ? p.repo.trim().replace(/\/+$/, '').replace(/^\.\//, '') : '';
    const repo = repos.includes(said) ? said : repos.length === 1 ? repos[0]! : '';
    if (!repo) continue;
    const folder = typeof p.folder === 'string' ? folderInRepo(p.folder) : '';
    const real = folder && fs.existsSync(path.join(root, repo, folder)) ? folder : '';
    parts.push({ id, name, repo, needs: [], ...(real ? { folder: real } : {}), ...(url ? { url } : {}) });
  }
  // It placed nothing, like an answer from before squad-kit asked: a part for each repo, as for an older project.
  if (!parts.some((p) => !p.shared)) return [];
  for (const repo of meta.repos?.length ? repos : []) {
    if (parts.some((p) => p.repo === repo)) continue;
    const p = partOfRepo(meta, repo);
    parts.push({ ...p, id: parts.some((x) => x.id === p.id) ? `${p.id}-repo` : p.id, noRun: true });
  }
  // What each needs, one at a time, leaving out a need that could never be met: a loop, or a part it does not have.
  for (const raw of Array.isArray(found) ? found : []) {
    const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const part = parts.find((x) => x.id === idFrom(typeof p.id === 'string' ? p.id : typeof p.name === 'string' ? p.name : ''));
    for (const need of Array.isArray(p.needs) ? p.needs : []) {
      const id = typeof need === 'string' ? idFrom(need) : '';
      if (part && parts.some((x) => x.id === id) && !part.needs.includes(id) && !reaches(parts, id, part.id)) part.needs.push(id);
    }
  }
  // A folder tells apart the parts that share a repo. Alone in it, its commands run from the top, as for any repo.
  return oneAddress(meta, parts).map((p) => (p.folder && aloneInRepo(parts, p) ? (({ folder: _folder, ...rest }) => rest)(p) : p));
}

/** A part alone in its repo with an App address keeps no address of its own, so the two can never differ. */
function oneAddress(meta: BoardMeta, parts: ProductPart[]): ProductPart[] {
  return parts.map((p) => (aloneInRepo(parts, p) && commandsOn(meta, p.repo)?.url?.trim() ? withoutUrl(p) : p));
}

const samePart = (a: ProductPart, b: ProductPart): boolean => a.id === b.id || a.name.toLowerCase() === b.name.toLowerCase();

/**
 * A new read of the project: what an engineer added or changed stays, in place of what the Architect found for it. What
 * an engineer said a part needs stays too, even when the read now names that thing differently or misses it.
 */
export function partsAfterRead(found: ProductPart[], kept: ProductPart[] = []): ProductPart[] {
  const mine = kept.filter((p) => p.byHand);
  const parts = [...found.map((f) => mine.find((m) => samePart(m, f)) ?? f), ...mine.filter((m) => !found.some((f) => samePart(m, f)))];
  const needed = kept.filter((k) => !parts.some((p) => samePart(p, k)) && mine.some((m) => m.needs.includes(k.id)));
  const all = [...parts, ...needed];
  const before = [...found, ...kept];
  const idNow = (need: string): string | undefined => {
    const was = before.find((p) => p.id === need);
    return all.find((p) => p.id === need)?.id ?? (was ? all.find((p) => samePart(p, was))?.id : undefined);
  };
  return all.map((p) => ({ ...p, needs: [...new Set(p.needs.map(idNow).filter((n): n is string => Boolean(n)))] }));
}

/* ── What an engineer changes ──────────────────────────── */

export interface PartChange {
  name?: string;
  shared?: boolean;
  repo?: string;
  folder?: string;
  /** Ids or names. */
  needs?: string[];
  url?: string;
  off?: boolean;
}

/** A part by its id or its name, as a person would write it. */
export function findPart(parts: ProductPart[], which: string): ProductPart {
  const said = which.trim().toLowerCase();
  const part = parts.find((p) => p.id === said || p.id === idFrom(said) || p.name.toLowerCase() === said);
  if (!part) throw new Error(`There is no part "${which}". The parts: ${parts.map((p) => p.id).join(', ')}.`);
  return part;
}

function applied(bp: BoardPaths, meta: BoardMeta, parts: ProductPart[], part: ProductPart, change: PartChange): ProductPart {
  const name = change.name?.trim() ?? part.name;
  if (!name) throw new Error('Give the part a name.');
  if (parts.some((p) => p.id !== part.id && p.name.toLowerCase() === name.toLowerCase())) throw new Error(`There is a part called ${name} already.`);
  const shared = change.shared ?? Boolean(part.shared);
  const url = (change.url ?? part.url ?? '').trim();
  if (url && !isAddress(url)) throw new Error(`"${url}" is not a web address. Write it like http://localhost:5180`);
  const off = change.off ?? Boolean(part.off);
  if (off && !part.shared && !parts.some((p) => p.id !== part.id && !p.shared && !p.off)) throw new Error(`${name} is the only part in use, so the squad would have nothing to work on.`);
  const needs = (change.needs ?? part.needs).map((n) => findPart(parts, n).id);
  for (const id of needs) {
    const other = findPart(parts, id);
    if (id === part.id) throw new Error(`${name} cannot need itself.`);
    if (reaches(parts.map((p) => (p.id === part.id ? { ...p, needs } : p)), other.id, part.id)) throw new Error(`${name} and ${other.name} need each other, so neither could start first. Take one of them out.`);
  }
  const base: ProductPart = { id: part.id, name, needs: [...new Set(needs)], byHand: true, ...(url ? { url } : {}), ...(off ? { off } : {}) };
  if (shared) return { ...base, shared };
  const repo = change.repo?.trim() || part.repo || (repoPaths(meta).length === 1 ? repoPaths(meta)[0]! : '');
  if (!repoPaths(meta).includes(repo)) throw new Error(repo ? `There is no code repo at ${repo}. The repos: ${repoPaths(meta).join(', ')}.` : `Say which repo it is in: ${repoPaths(meta).join(', ')}.`);
  const folder = folderInRepo(change.folder ?? part.folder ?? '');
  if (folder === null) throw new Error('The folder must be inside the repo, like apps/web.');
  if (folder && !fs.existsSync(path.join(bp.root, repo, folder))) throw new Error(`There is no folder ${folder} in ${repo === '.' ? 'the project' : repo}.`);
  return { ...base, repo, ...(folder ? { folder } : {}) };
}

/** Saves the list. An address given to a part alone in its repo becomes the repo's App address. */
function saveParts(bp: BoardPaths, meta: BoardMeta, parts: ProductPart[], changed?: ProductPart): void {
  let next = meta;
  if (changed && aloneInRepo(parts, changed)) {
    const withUrl = (c: ProjectCommands = {}): ProjectCommands => {
      const { url: _old, ...rest } = c;
      return changed.url ? { ...rest, url: changed.url } : rest;
    };
    next = meta.repos?.length ? { ...meta, repos: meta.repos.map((r) => (r.path === changed.repo ? { ...r, commands: withUrl(r.commands) } : r)) } : { ...meta, commands: withUrl(meta.commands) };
  }
  writeMeta(bp, { ...next, parts: oneAddress(next, parts) });
}

export function addPart(bp: BoardPaths, change: PartChange): ProductPart {
  const meta = readMeta(bp);
  const parts = partsOf(meta);
  const name = change.name?.trim() ?? '';
  if (!name) throw new Error('Give the part a name.');
  const base = idFrom(name) || 'part';
  let id = base;
  for (let n = 2; parts.some((p) => p.id === id); n += 1) id = `${base}-${n}`;
  const part = applied(bp, meta, parts, { id, name, needs: [] }, change);
  saveParts(bp, meta, [...parts, part], part);
  return part;
}

export function changePart(bp: BoardPaths, which: string, change: PartChange): ProductPart {
  const meta = readMeta(bp);
  const parts = partsOf(meta);
  const part = applied(bp, meta, parts, findPart(parts, which), change);
  saveParts(bp, meta, parts.map((p) => (p.id === part.id ? part : p)), part);
  return part;
}

/** Takes out a part an engineer added or changed. One the Architect finds would only come back: mark that one Not used. */
export function removePart(bp: BoardPaths, which: string): void {
  const meta = readMeta(bp);
  const parts = partsOf(meta);
  const part = findPart(parts, which);
  if (!part.byHand) throw new Error(`The Architect found ${part.name}, so it would come back at the next read. Mark it Not used instead.`);
  const left = parts.filter((p) => p.id !== part.id);
  if (!left.some((p) => p.repo === part.repo) && !part.shared) throw new Error(`${part.name} is the only part in ${part.repo === '.' ? 'the project' : part.repo}. Mark it Not used instead.`);
  saveParts(bp, meta, left.map((p) => ({ ...p, needs: p.needs.filter((n) => n !== part.id) })));
}
