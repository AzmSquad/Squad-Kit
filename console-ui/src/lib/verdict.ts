import type { OffScreen, ProofShot, Ticket } from '../api/types';

/**
 * What each proof picture shows, in the board's words: its "done when" is Met, Not working yet (the picture shows it
 * does not work), Not shown yet (the picture does not show it clearly) or Not on a screen (the rest of it cannot be
 * shown at all), with why. squad-kit decides it from the Tester's verdict and its own check of the picture
 * (src/engine/proof-verdict.ts).
 */

/** "Met", "Not working yet", "Not shown yet" or "Not on a screen"; rows from before verdicts have none. */
export function verdictWord(shows: ProofShot['shows']): 'Met' | 'Not working yet' | 'Not shown yet' | 'Not on a screen' | null {
  return shows === 'met' ? 'Met' : shows === 'broken' ? 'Not working yet' : shows === 'not-shown' ? 'Not shown yet' : shows === 'off-screen' ? 'Not on a screen' : null;
}

/** The class of a row by its verdict: the color of its tag and its note. */
export function verdictClass(shows: ProofShot['shows']): 'met' | 'broken' | 'notshown' | 'notonscreen' | '' {
  return shows === 'met' ? 'met' : shows === 'broken' ? 'broken' : shows === 'not-shown' ? 'notshown' : shows === 'off-screen' ? 'notonscreen' : '';
}

/** The row's words: why it is not met yet, which part could not be shown, or what its main picture shows. */
export function verdictNote(p: Pick<ProofShot, 'shows' | 'why' | 'note'>): string {
  return p.shows === 'broken' || p.shows === 'not-shown' || p.shows === 'off-screen' ? (p.why ?? p.note ?? '') : (p.note ?? '');
}

/** Every "done when" that ended as Not on a screen, with why: those with pictures of a part, then those with none. */
export function notOnScreen(t: Pick<Ticket, 'proof' | 'offScreen'>): OffScreen[] {
  const parts = (t.proof ?? []).filter((p) => p.shows === 'off-screen').map((p) => ({ criterion: p.criterion, why: verdictNote(p) }));
  return [...parts, ...(t.offScreen ?? []).filter((o) => !parts.some((p) => p.criterion === o.criterion))];
}

/**
 * Every picture of the proof in order, for the viewer: each row's before and after, then its others. `starts` says
 * where each row begins; its others begin two after that.
 */
export function proofViewer(rows: ProofShot[], src: (file: string) => string): { pictures: { src: string; caption: string }[]; starts: number[] } {
  const pictures: { src: string; caption: string }[] = [];
  const starts: number[] = [];
  for (const r of rows) {
    starts.push(pictures.length);
    pictures.push({ src: src(r.before), caption: `${r.criterion} · ${r.beforeLabel}` }, { src: src(r.after), caption: `${r.criterion} · ${r.afterLabel}` });
    (r.more ?? []).forEach((m, i) => pictures.push({ src: src(m.after), caption: `${r.criterion} · ${m.note || `Picture ${i + 2}`}` }));
  }
  return { pictures, starts };
}
