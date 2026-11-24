/**
 * When the open ticket's top row shows the title (drawer/scroll.ts). No React and no page here, so the rule is tested
 * on its own.
 *
 * Once the title has scrolled under the top row, the row shows it and hides its links and labels. On a narrow panel the
 * links take two lines, so the row got shorter. The browser keeps what is read in place, so it moved the page up by
 * what the row lost, the old rule saw the title back in view and flipped back, which moved the page down again: the
 * page drew itself over and over until React stopped it ("This page ran into a problem"). Now the row keeps its full
 * height with the title (styles/ticket-scroll.css), and this rule decides with that full height, measured while the
 * row showed its links, so a row that still changes height cannot flip it back. At the top of the page the big title
 * shows. One scroll gives one answer.
 */

export interface TopRow {
  /** The row shows the title. */
  past: boolean;
  /** The row's height while it shows its links and labels: 0 until it is measured. */
  full: number;
}

export interface TopRowSeen {
  /** The row's height now. */
  row: number;
  /** True while the page shows the short row, with the title in it. */
  short: boolean;
  /** How far the panel is scrolled. */
  scroll: number;
  /** How far the big title's bottom is from the top of the panel's view, or null when there is none. */
  titleBottom: number | null;
}

export function topRow(before: TopRow, seen: TopRowSeen): TopRow {
  const full = seen.short && before.full > 0 ? before.full : seen.row;
  if (seen.titleBottom === null) return { past: false, full };
  if (!seen.short) return { past: seen.titleBottom < seen.row, full };
  // A little room, so a row with fractional pixels (a zoomed page) cannot rest right on the line.
  return { past: seen.scroll > 0 && seen.titleBottom <= full + 2, full };
}

/**
 * Two flips in one frame are the page answering itself, never a person scrolling: the second waits for the next
 * frame. A net under the rule above, so a layout no one foresaw can never stop the page.
 */
export class FlipGuard {
  private flipped = false;

  constructor(private nextFrame: (fn: () => void) => void) {}

  allow(): boolean {
    if (this.flipped) return false;
    this.flipped = true;
    this.nextFrame(() => {
      this.flipped = false;
    });
    return true;
  }
}
