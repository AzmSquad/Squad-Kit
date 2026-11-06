import type { CodePart, PartLink, SetupStepView } from '../api/onboard-types';
import type { ProductPart } from '../api/types';
import type { KeyStore } from './waiting';

/**
 * The first run and the Overview, without React: the picture of the code's parts in columns, a step's time, and the
 * projects whose setup the person asked to hear about. Each rule is tested on its own.
 */

/**
 * The parts in columns, in the order a request flows: each part one column right of the parts that use it. Tests sit
 * in a row of their own under the picture, since they check the others. A loop in the links stops after as many
 * rounds as there are parts.
 */
export function partColumns(parts: CodePart[], links: PartLink[]): { columns: CodePart[][]; below: CodePart[] } {
  const below = parts.filter((p) => p.kind === 'tests');
  const main = parts.filter((p) => p.kind !== 'tests');
  const ids = new Set(main.map((p) => p.id));
  const edges = links.filter((l) => ids.has(l.from) && ids.has(l.to) && l.from !== l.to);
  const depth = new Map(main.map((p) => [p.id, 0]));
  for (let round = 0; round < main.length; round += 1) {
    let moved = false;
    for (const e of edges) {
      const d = depth.get(e.from)! + 1;
      if (d > depth.get(e.to)! && d < main.length) {
        depth.set(e.to, d);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const columns: CodePart[][] = [];
  for (const p of main) (columns[depth.get(p.id)!] ??= []).push(p);
  return { columns: columns.filter(Boolean), below };
}

/** What a part uses, in words: "calls Web API · signs in with Ministry sign-in". */
export function usesLine(part: CodePart, parts: CodePart[], links: PartLink[]): string {
  return links
    .filter((l) => l.from === part.id)
    .map((l) => `${l.label ?? 'uses'} ${parts.find((p) => p.id === l.to)?.name ?? l.to}`)
    .join(' · ');
}

/** "1:40" while a step runs; "2 s" or "3 min" once it is over; nothing for a step not started or skipped. */
export function stepTime(st: Pick<SetupStepView, 'state' | 'since' | 'seconds'>, now: number): string {
  if (st.state === 'now' && st.since) {
    const s = Math.max(0, Math.floor((now - Date.parse(st.since)) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  if (st.state === 'todo' || st.state === 'skipped' || st.seconds === undefined) return '';
  return st.seconds < 60 ? `${Math.max(1, st.seconds)} s` : `${Math.round(st.seconds / 60)} min`;
}

/* ── Notify me when it is ready ────────────────────────── */

const WISHES = 'sk.notices.setup';

/** The projects whose setup the person asked a notice for, in this browser. */
export function readWishes(store: KeyStore | null): string[] {
  try {
    const v = JSON.parse(store?.getItem(WISHES) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveWishes(store: KeyStore | null, ids: string[]): void {
  try {
    store?.setItem(WISHES, JSON.stringify([...new Set(ids)]));
  } catch {
    // Storage refused: the notice is asked for this visit only.
  }
}

export function addWish(store: KeyStore | null, id: string): void {
  saveWishes(store, [...readWishes(store), id]);
}

export function dropWish(store: KeyStore | null, id: string): void {
  saveWishes(store, readWishes(store).filter((x) => x !== id));
}

/** The projects the person asked about whose overview is ready now: each gets one notice. */
export function readyToTell<P extends { id: string; name: string; setup?: { ready?: boolean; approved?: boolean } }>(projects: P[], wishes: string[]): P[] {
  return projects.filter((p) => wishes.includes(p.id) && p.setup?.ready && !p.setup.approved);
}

export function readyText(name: string): { title: string; body: string } {
  return { title: `${name} is ready`, body: 'squad-kit has read your project. Check what it understood, then start.' };
}

/** The plain names of the parts in a repo, so the person never needs the repo's name. Empty when squad-kit knows none. */
export function partNames(parts: ProductPart[] | undefined, repo: string | undefined): string[] {
  return (parts ?? []).filter((p) => p.repo === repo && !p.shared).map((p) => p.name);
}
