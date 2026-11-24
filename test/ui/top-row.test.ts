import { describe, expect, it } from 'vitest';

/**
 * The open ticket's top row shows the title once it scrolls away (console-ui/src/pages/drawer/top-row.ts). With the
 * short row, the old rule flipped the title back, and the browser's scroll anchoring moved the page back, so it flipped
 * again until React stopped the page: "This page ran into a problem" (Minified React error #185).
 */

const { FlipGuard, topRow } = await import(/* @vite-ignore */ new URL('../../console-ui/src/pages/drawer/top-row.ts', import.meta.url).pathname);

/** A panel as a 1366-wide laptop drew it: the top row wraps to 82 px with its links, 44 px with the title. */
const FULL = 82;
const SHORT = 44;
const TITLE_BELOW_ROW = 28;
const VIEW = 700;
const CONTENT = 2000;

type Rule = (s: number, row: number, short: boolean, state: { past: boolean; full: number }) => { past: boolean; full: number };

const before: Rule = (s, row) => ({ past: s + row > row + TITLE_BELOW_ROW, full: row });
const now: Rule = (s, row, short, state) => topRow(state, { row, short, scroll: s, titleBottom: row + TITLE_BELOW_ROW - s });

/**
 * Scrolled to `start`, the page measures and draws until the answer stays. `anchor` 1 is Chrome and Firefox, which keep
 * what is read in place when the row changes height; 0 is a browser that does not. Returns the flips, or -1 for "never stops".
 */
function settle(rule: Rule, start: number, anchor: 0 | 1): number {
  let s = start;
  let short = false;
  let state = { past: false, full: 0 };
  for (let flips = 0; flips < 50; flips++) {
    const row = short ? SHORT : FULL;
    state = rule(s, row, short, state);
    if (state.past === short) return flips;
    const next = state.past ? SHORT : FULL;
    // Chrome moves the page by what the row gained or lost, except at the very top (measured on the real board).
    if (s > 0) s = Math.min(Math.max(0, s + anchor * (next - row)), CONTENT + next - VIEW);
    short = state.past;
  }
  return -1;
}

describe('the title on the open ticket top row', () => {
  it('the old rule never stopped at some scroll spots, which crashed the page', () => {
    const stuck = Array.from({ length: 200 }, (_, s) => s).filter((s) => settle(before, s, 1) === -1);
    expect(stuck.length).toBeGreaterThan(0);
  });

  it('settles at every scroll spot, with or without scroll anchoring', () => {
    for (const anchor of [0, 1] as const) {
      for (let s = 0; s <= 400; s++) {
        const flips = settle(now, s, anchor);
        expect(flips, `scroll ${s}, anchoring ${anchor}`).toBeGreaterThanOrEqual(0);
        // Near the top the browser can carry the page back to 0, where the big title shows again: two flips at most.
        expect(flips, `scroll ${s}, anchoring ${anchor}`).toBeLessThanOrEqual(2);
      }
    }
  });

  it('a second flip in the same frame waits for the next scroll', () => {
    const frames: (() => void)[] = [];
    const guard = new FlipGuard((fn: () => void) => frames.push(fn));
    expect(guard.allow()).toBe(true);
    expect(guard.allow()).toBe(false);
    frames.shift()!();
    expect(guard.allow()).toBe(true);
  });

  it('shows the title once it is under the full row, and the links again once it shows', () => {
    let r = topRow({ past: false, full: 0 }, { row: FULL, short: false, scroll: 0, titleBottom: 200 });
    expect(r).toEqual({ past: false, full: FULL });
    r = topRow(r, { row: FULL, short: false, scroll: 150, titleBottom: 60 });
    expect(r.past).toBe(true);
    // The row is short now: the full height it had still decides.
    r = topRow(r, { row: SHORT, short: true, scroll: 112, titleBottom: 60 });
    expect(r).toEqual({ past: true, full: FULL });
    r = topRow(r, { row: SHORT, short: true, scroll: 40, titleBottom: FULL + 3 });
    expect(r.past).toBe(false);
    // At the top of the page the big title is there to read.
    expect(topRow({ past: true, full: FULL }, { row: SHORT, short: true, scroll: 0, titleBottom: 72 }).past).toBe(false);
    expect(topRow({ past: false, full: 0 }, { row: FULL, short: false, scroll: 0, titleBottom: null }).past).toBe(false);
  });
});
