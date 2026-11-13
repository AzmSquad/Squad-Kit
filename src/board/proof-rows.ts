import type { Criterion } from './types.js';
import type { ProofKind } from './proof-kind.js';

/**
 * The proof's rows: what the proof of each "done when" holds, kept in the ticket's proof.md (board/proof-doc.ts). A row
 * is pictures, a saved answer, rows or a test run, by its kind.
 */

/** A Test row: the one test that proves the line, in plain words, and how it ran on main's code and on the story's. */
export interface TestProof {
  /** The test's name as its tool prints it, with its groups. */
  name: string;
  file: string;
  /** What the test does, in plain words, one short line each. */
  steps: string[];
  /** On main's code, with the story's test file: it must fail there. "unknown" when squad-kit could not run it there. */
  before: 'failed' | 'passed' | 'unknown';
  /** The line keeps something that already works: its test must pass there instead. */
  keeps?: boolean;
  /** On the story's code. */
  after: 'passed' | 'failed' | 'unknown';
  /** How long the run on the story's code took. */
  seconds?: number;
}

/** Another after picture of a "done when": a part or case its main picture does not show. */
export interface ProofPicture {
  after: string;
  /** Where it was taken, like a row's page. */
  page?: string;
  /** The device it was taken on, for people: "iPhone 16 Pro", "iPad Air 11-inch (M2)", "Web version". */
  device?: string;
  /** What it shows, one plain sentence from the Tester. */
  note?: string;
}

export interface ProofShot {
  criterion: string;
  before: string;
  /** The main after picture: the one the before pairs with. */
  after: string;
  beforeLabel: string;
  afterLabel: string;
  /** What the main after picture shows. */
  note?: string;
  /** Where the main after picture was taken, as the address in the app without the host, like "/test/sign-up". */
  page?: string;
  /** The device the main after picture was taken on: "iPhone 16 Pro", "Web version". Browser pictures of a web app have none. */
  device?: string;
  /** And the before picture's. */
  beforeDevice?: string;
  /** The other after pictures of this "done when", one per part or case. Rows with one picture have none. */
  more?: ProofPicture[];
  /**
   * What all its after pictures show together, from the Tester's verdict and squad-kit's own check of them: the "done
   * when" is met, "broken" (a picture shows it does not work) or "not-shown" (the pictures do not show all of it clearly).
   * "off-screen": the Tester and the check agree the rest of it cannot be shown at all, so the pictures that show a part
   * stay and it does not stop the story. Only broken goes back to the Builder. Rows from before verdicts have none.
   */
  shows?: 'met' | 'broken' | 'not-shown' | 'off-screen';
  /** Why it is not met yet, in plain words: the Tester's note or squad-kit's check. For "off-screen", which part could not be shown. */
  why?: string;
  /** How this row proves its "done when" (board/proof-kind.ts). Rows from before the kinds have none. */
  kind?: ProofKind;
  /** A Test row: the test squad-kit ran on main's code and on the story's. */
  test?: TestProof;
  /** A Not on a screen row: what the Reviewer checked, in its words. */
  checked?: string;
}

/** A "done when" that shows on no screen (it happens on a restart, in an email), with why in plain words. */
export interface OffScreen {
  criterion: string;
  why: string;
}

/** True when any "done when" of the spec says how it is proved. Old specs have none, and are proved as before. */
export function hasKinds(t: { criteria?: Criterion[] }): boolean {
  return Boolean(t.criteria?.some((c) => c.proof));
}
