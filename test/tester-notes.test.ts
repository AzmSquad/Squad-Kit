import { describe, it, expect } from 'vitest';
import { isPlainNote, plainParts } from '../src/engine/shots.js';
import { judgeQuestion } from '../src/engine/question-filter.js';

/**
 * The Tester's notes reach the person when they are plain (RO-6 and RO-7, 2026-11-04): measures like "390 px",
 * "1280 wide" or "phone width" are plain, and one technical sentence (an address, a port) no longer hides the rest
 * of a note. Stack traces, error codes, tools and the sandbox stay out. The notes are the Tester's real words.
 */

const technical = (s: string) => {
  const v = judgeQuestion({ text: s });
  return !v.pass && v.kind === 'technical';
};

/** RO-6's notes, as its Tester wrote them on the real run. */
const RO6 = {
  wide: 'The day view at 1280 wide shows Atlas as "8 people · Floor 2 · Screen, Video call kit" and Delta as "2 people · Floor 1" with no empty equipment part.',
  phone:
    'At phone width (390 px) the day view runs off the right edge: the Book buttons and the 21:00 timeline label are cut off and the date controls are clipped, so the page scrolls sideways. This does not meet criterion 5.',
  skipped:
    'Criterion 4 (data survives a restart, nothing duplicated, cancel an old booking): not shown on screen. The screen cannot restart the app, and the test account has no bookings to cancel. Criterion 6 (50 rooms and 500 bookings loaded in under 1 second): not shown on screen. A large test copy needs to be seeded outside this tool, and the timing cannot be read from a screenshot. Sign-in is a placeholder: the Sign in button opens the app for any email and password, so no test account was needed. The app runs on http://127.0.0.1:61880 and was not stopped.',
};
/** RO-7's and RO-10's, from the same run. */
const RO7 =
  "Criterion 6 cannot be shown on a screen with this project's data. It needs a booking made before Phase 2 that is 5 hours long or on a Friday, and the project's seed data holds no bookings. The booking form now refuses such a booking, so the screen cannot create one. Criterion 2 uses Thu 3 Dec and Sun 6 Dec, not 4 Dec and 5 Dec: 4 Dec 2026 is a Friday, when the office is closed, and 5 Dec is a Saturday, which would also show a second message. The app on port 62307 is still running; squad-kit started it, so squad-kit stops it.";
const RO10 =
  'On a phone-width screen the add-a-room form, its fields, checkboxes and Add room button fit within the screen, and the room list starts below them. Shot at 390 px, the closest phone size available; 360 px and the desktop Chrome/Edge check were not separately shot.';

describe("the Tester's notes", () => {
  it('keep plain measures: "390 px", "1280 wide", "phone width"', () => {
    for (const note of [RO6.wide, RO6.phone, RO10]) expect(plainParts(note, technical), note).toEqual({ kept: note, left: '' });
    for (const s of ['Shot at 390 px.', 'The page at 1280 wide.', 'At phone width the list fits.', 'Recorded at 1440 by 900.', 'Room code 101 shows.', 'The button says EDIT.', 'Bookings on Friday are an exception.'])
      expect(isPlainNote(s), s).toBe(true);
  });

  it('leave out only the technical sentence, and keep the rest of the note', () => {
    expect(plainParts(RO6.skipped, technical)).toEqual({
      kept: RO6.skipped.replace(' The app runs on http://127.0.0.1:61880 and was not stopped.', ''),
      left: 'The app runs on http://127.0.0.1:61880 and was not stopped.',
    });
    const ro7 = plainParts(RO7, technical);
    expect(ro7.left).toBe('The app on port 62307 is still running; squad-kit started it, so squad-kit stops it.');
    expect(ro7.kept).toContain('Criterion 2 uses Thu 3 Dec and Sun 6 Dec, not 4 Dec and 5 Dec');
  });

  it('keep the real technical ones out: stack traces, error codes, tools, the sandbox', () => {
    for (const s of [
      "TypeError: Cannot read properties of undefined (reading 'id')",
      'It failed at render (src/app.js:10:5)',
      'listen EADDRINUSE: address already in use',
      'Run npm test in the terminal to see it.',
      'The sandbox blocks Chrome (Mach port), so no screenshots.',
      'Playwright could not find the locator.',
      'The server answered with status code 500.',
      'Set ROOMFLOW_PORT to 8001 first.',
      'docker compose up starts the database.',
    ]) {
      expect(plainParts(s, technical), s).toEqual({ kept: '', left: s });
    }
  });
});
