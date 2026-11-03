import type { StuckChoice, WayOut } from '../api/types';

/**
 * The ways out of a stuck ticket as the error card's buttons (phase 10). Try again and Send it back act at once;
 * Continue anyway first asks why (only the person may skip a failed check, with a reason on the record), and Fix it
 * yourself first opens the ticket's copy of the code.
 */
export interface WayButton {
  /** The choice's place on the card, as `squad decide <ticket> <n>` counts it from 1. */
  index: number;
  label: string;
  note: string;
  way: WayOut | undefined;
  /** What the person gives before it goes: a reason, or their own fix. */
  needs: 'reason' | 'fix' | null;
  primary: boolean;
}

export function wayButtons(stuck: StuckChoice | undefined): WayButton[] {
  return (stuck?.options ?? []).map((o, i) => {
    // Older cards have no `do`: their first choice tries again.
    const way = o.do ?? (i === 0 ? 'retry' : undefined);
    return {
      index: i,
      label: o.name,
      note: o.note,
      way,
      needs: way === 'continue' ? 'reason' : way === 'yourself' ? 'fix' : null,
      primary: i === 0,
    };
  });
}

/** The card's title for a stuck ticket, for a board older than the titles. */
export function stuckTitle(stuck: StuckChoice | undefined): string {
  return stuck?.title ?? 'The squad stopped and needs you';
}
