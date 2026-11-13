import type { BoardMeta, Ticket } from '../../board/types.js';
import { MAX_PICTURES, MAX_PICTURES_PER_DONE_WHEN, criterionText } from '../proof-verdict.js';
import {
  doneWhen,
  doneWhenItems,
  EXAMPLES_FIT,
  LOOK,
  notesText,
  type PromptContext,
  rulesText,
  theirLanguage,
} from './context.js';
import { FIX_ONLY_BROKEN } from './build.js';

/**
 * The Tester's brief for the proof: it takes the pictures with squad-kit's own tools (the window), looks at each one,
 * takes a wrong one again, and hands in the files per "done when", one per part or case, with one plain note each. It
 * never runs a browser or the app itself, and only reads the code.
 */
export function proofPrompt(meta: BoardMeta, t: Ticket, when: 'before' | 'after', ctx?: PromptContext, appUrl?: string, beforeSizes: Record<string, string> = {}, apiParts: string[] = [], onPhone?: PhoneForPictures): string {
  const criteria = doneWhen(t);
  // Each "done when"'s before picture, so the after picture it pairs with is taken at the same size.
  const paired = doneWhenItems(t).flatMap((_, i) => {
    const size = beforeSizes[criterionText(t, i + 1) ?? ''];
    return size ? [`- "done when" ${i + 1}: ${size}`] : [];
  });
  const url = appUrl ?? (ctx?.repo?.commands ?? meta.commands ?? {}).url ?? 'its usual address';
  return `You are the Tester of a software squad. Take screenshots that show each "done when" below ${
    when === 'before' ? 'as the app is BEFORE the change (a screen may not exist yet: show the closest one)' : 'working AFTER the change'
  }.

Done when:
${criteria}

${
    onPhone
      ? phoneToolsText(onPhone)
      : `The app is running at ${url}; squad-kit started it and stops it. Use squad-kit's tools, never a browser or the app of
your own (your shell only reads):
- look_at_page: opens a page and gives back its address and what is on it (roles, names, text). Use it to find the
  names of the fields and buttons.
- take_screenshots: for each shot, the page to open (a path in the app starting with "/", never a full address), the
  steps to do there first (fill, click, select, press, wait and so on, each naming its part of the page one way: role
  and name is best), and the size ("phone" for a phone screen; desktop by default). The pictures come back to you
  with their file names. Look at each one: when it does not show the "done when" (wrong page, an error, still
  loading, the wrong data), take it again with better steps.
- start_app, stop_app, app_status: the app, should it stop. run_checks: the project's own saved tests, lint and build,
  should you need them. i_am_stuck: anything technical in your way.`
  }
Read the code first for the pages, the labels, and the test sign-ins or sample data in the project's own seed,
fixture or example files. Use only those, never a real person's details.
When an example in a "done when" breaks another rule of the story (a date when the office is closed, a time outside
opening hours), use the nearest example that fits every rule, and say so in the note.
${
    when === 'after'
      ? `Each picture must show the RESULT of its "done when", not the page before it: the message it shows, the saved
item in the list, the refused booking with its reason, the page at phone width. Do the steps (fill, click, then wait
for the answer) in take_screenshots, so the picture is taken after them. The picture shows only what fits the window:
when the part that matters is lower down, add a hover step on it, so it comes into view.
A "done when" with several parts, cases or pages gets one picture per part or case, at most ${MAX_PICTURES_PER_DONE_WHEN} for one "done when".
For example: "refused when empty, spaces or 61 characters" gets one picture per message when the messages differ, and
"shows on the day view and in Upcoming bookings" gets one picture of each place. Each picture must show the result of
its own part, with its own note. The "done when" is judged over all its pictures together, so every part must be in
one of them. Plan the pictures first: a step takes at most ${MAX_PICTURES}.
A "done when" that says the screen stays as it was (looks the same as before, unchanged, as today, still shows ...)
is on a screen too: its picture is the screen as it is now, and it may be the same as the picture from before.${
          paired.length
            ? `
The first picture you name for a "done when" sits beside its picture from before the change, so take it at the same
size, unless the "done when" itself names another. The sizes from before:
${paired.join('\n')}`
            : ''
        }`
      : 'Each picture shows the screen where the "done when" will happen, as it is now.'
  }

In shots, ${
    when === 'after' ? 'one entry per picture, at least one for each "done when" that shows on a screen' : 'one for each "done when" that shows on a screen'
  }: criterion (its number), file (a file name from the list
of pictures take_screenshots gives you, the pictures you took in this step, never an older one), shows and note.
- shows: ${
    when === 'after'
      ? `"met" when the picture shows the "done when", or its part of it, works as written.
  "broken" when the picture shows it does not work as written: an error, the wrong result, text cut off by the page, a
  page wider than a phone screen. Say what the picture shows. A "broken" goes back to the Builder to fix.
  "not-shown" when the picture does not show it clearly: the part that matters is out of view, it is still loading,
  the steps did not reach the result. Take it again first; hand in "not-shown" only when you cannot get it into a
  picture. A picture you framed badly is never "broken".`
      : '"not-shown": the change is not made yet.'
  }
- note: one plain sentence for the person, what the picture shows${when === 'after' ? ', and for "broken" what is wrong' : ''}.
offScreen: each "done when" that cannot show on any screen (it happens after a restart, it is about speed, it is an
email), with why in plain words for a project manager. A "done when" about what a page shows, or how it looks at a
size, is on a screen: it needs a picture. Every "done when" is in shots or in offScreen.
When a part of a "done when" truly cannot be shown (it needs an old record, the app has none, and its screens cannot
make one), hand in the pictures of the parts that can be shown, and also put it in offScreen, saying which part and
why. squad-kit's check reads your reason and looks at the code and the sample data itself. "I did not try" or "it takes
too long" is no reason: it sends you back to take the picture.
${apiParts.length ? `A "done when" about what the API answers: when a page of the app shows it, a picture comes first. When no page shows it, call
ask_api with part (${apiParts.join(', ')}), path, and method and body when it needs them. squad-kit makes the call and saves it as
a file in your list, with exactly what was asked and answered. Name that file in shots like a picture, with shows judged
by the answer, and a note for a project manager like "Asked for the sale price of an item of 200 cents. It answered 150."
Never quote raw data in the note. A "done when" the API can show is never offScreen.
` : ''}Never wait for the clock. Do not sleep or pause to let a booking end, a day pass or a timer run out: when a part needs
time to pass, it is one of those parts that cannot be shown.
Never ask the person anything technical. Do not change project files: squad-kit puts back anything changed.${theirLanguage(t)}${notesText((t.notes ?? []).filter((n) => n.kind !== 'criterion'))}${rulesText(ctx)}
${LOOK}`;
}

/** squad-kit's own phone for the pictures: its real devices by size, and the app's own link names. */
export interface PhoneForPictures {
  labels: Partial<Record<string, string>>;
  links: string[];
}

/** The Tester's tools on squad-kit's phone, in place of the browser's: the same steps, by the words on the screen. */
function phoneToolsText(p: PhoneForPictures): string {
  const devices = Object.entries(p.labels).map(([size, name]) => `"${size}" is a real ${name}`).join(', ') || '"phone" is a real iPhone';
  const page = p.links.length ? `"/" is the app's start screen, and another path opens by the app's own link, like "/book"` : `"/", the app's start screen: this app has no links of its own, so each shot starts there and its steps reach the screen`;
  return `The app runs on squad-kit's own phone: an iPhone simulator squad-kit runs itself, hidden (${devices}). Use
squad-kit's tools, never a simulator, a browser or the app of your own (your shell only reads):
- look_at_page: opens the app on the phone, does the steps, and gives back what the screen shows as text, the words of
  each part. Use it to find the words on the fields and buttons.
- take_screenshots: for each shot, the screen to open (${page}), the steps to do there first (fill, click, select,
  press, wait and so on, each naming its part of the screen by its words: role and name, label or text), the size,
  and the language the app opens in ("en" by default, "ar" for Arabic). Each shot starts the app fresh. The pictures
  come back to you with their file names and devices. Look at each one: when it does not show the "done when" (wrong
  screen, an error, still loading, the wrong data), take it again with better steps.
- run_checks: the project's own saved tests, lint and build, should you need them. i_am_stuck: anything technical in
  your way.`;
}

/** The screenshots failed squad-kit's check: the Tester takes what is missing, told what was wrong. Its good pictures stay. */
export function proofAgainPrompt(problems: string[]): string {
  return `squad-kit checked your last screenshots and some do not prove anything yet:
${problems.map((p) => `- ${p}`).join('\n')}

Take what is missing now with take_screenshots, and hand in the new files. squad-kit keeps your other pictures of each
"done when" and adds the new ones beside them, so take only what is listed here, not the rest again. An "after" must
show the change: open the screen, state or data where the "done when" can be seen, not the same view as before the
change, do the steps that lead to its result (the message, the saved item, the refused booking), and let it finish
loading (a wait step). Only pictures you take from now on count, so name only those in your answer, and only for the
"done when" listed here. If what is missing truly cannot be shown, because the app has no such data and no way to make
it on a screen, put that "done when" in offScreen with which part and why; your pictures of it stay.`;
}

/** A picture of the proof for squad-kit's own check: the file and where it was taken. */
export interface PictureFile {
  file: string;
  page?: string;
  size?: string;
  /** The device it was taken on: "iPhone 16 Pro", "Web version". */
  device?: string;
  note?: string;
}

/** One "done when" for squad-kit's own check: its number, its main picture and the others, or none with the Tester's reason. */
export interface PictureToCheck extends Omit<PictureFile, 'file'> {
  criterion: number;
  /** The main picture. None when the Tester says it shows on no screen. */
  file?: string;
  /** Why the Tester says it, or a part of it, cannot be shown on a screen. */
  offScreen?: string;
  /** The Tester's own verdict on this "done when". */
  said?: string;
  /** The main picture is the very same as the one from before the change. */
  same?: boolean;
  /** The other pictures of this "done when", judged together with the main one. */
  more?: PictureFile[];
}

/**
 * squad-kit's own check of the proof, in one short run for all pictures: a Reviewer looks at all the pictures of each
 * "done when" together and says once met, broken or not shown, with one plain sentence, and for not shown exact advice
 * on what is missing and whether it can be shown at all. A "done when" the Tester says cannot be shown is judged too,
 * by its reason. It only reads; the pictures are in the proof folder, which it may read.
 */
export function proofCheckPrompt(t: Ticket, pictures: PictureToCheck[]): string {
  const items = doneWhenItems(t);
  const where = (p: Omit<PictureFile, 'file'> & { file?: string }) => `${p.file}${p.size || p.device || p.page ? ` (${[p.size, p.device, p.page ? `page ${p.page}` : ''].filter(Boolean).join(', ')})` : ''}`;
  const list = pictures
    .map((p) =>
      [
        `${p.criterion}. Done when: ${items[p.criterion - 1] ?? '(not in the list)'}`,
        ...(p.file ? [`   Picture: ${where(p)}`] : ['   No picture.']),
        ...(p.note || p.said ? [`   The Tester says${p.said ? ` ${p.said}` : ''}${p.note ? `: ${p.note}` : ''}`] : []),
        ...(p.same ? ['   This picture is the very same as the one from before the change.'] : []),
        ...(p.more ?? []).flatMap((m) => [`   Also this picture: ${where(m)}`, ...(m.note ? [`   The Tester says: ${m.note}`] : [])]),
        ...(p.offScreen ? [`   The Tester says this cannot be shown on a screen: ${p.offScreen}`] : []),
      ].join('\n'),
    )
    .join('\n');
  return `You check the proof of a software squad's work: screenshots the Tester took, one or more per "done when". Do not
edit files, and do not take the Tester's word for anything: judge from each picture itself.

Story: ${t.story ?? t.title}

Open every picture below with your tool for reading files (like Read) and look at it closely, next to its "done when".
A "done when" with several parts or cases can have several pictures. Judge them together, and answer once for each
"done when": no one picture has to show all of it. When two pictures show the same part, go by the clearer one, since
the Tester may have taken it again.
- met: the picture shows the result of the "done when" as written: the message, the saved item, the refused booking.
  With several pictures, they show every part of it together.
- broken: a picture itself shows it does not work as written: an error, the wrong result, text cut off by the page,
  or a page wider than the phone screen (it would scroll sideways) where it should fit. Say what the picture shows.
- not-shown: the pictures do not show it clearly: they show only the page before the action, one is still loading, the
  part that matters is out of view, or one part of the "done when" is in none of them. This is a problem with the
  pictures, never with the product, so it is never "broken". The Builder only gets what is broken and never changes
  the product to make a picture clearer.
A "done when" with no picture is not-shown. Some have no picture, or pictures of only a part, with the Tester's reason
why it cannot be shown on a screen. Do not take the reason on trust: read the code and the project's seed or sample
data, and judge it.
A file ending in .api.json is no picture: squad-kit asked the product's API and saved the call, with what was asked and
what it answered. Read it, and judge by what was answered, not by what the Tester says about it. An Excel answer has its
sheets in the record, under "sheets": judge by those rows. Numbers the "done when" names are met only when the rows show
them, and what the local data cannot show goes to off-screen with the reason. Any other saved file (a PDF) cannot be
opened here: judge by its status, type and size, and the person opens it.
A picture is taken at one of two sizes: "phone" (390 wide) or "desktop" (1280 wide). When a "done when" names another
width, judge the nearest size, and do not fault the picture for its size, or for being at another size than the
picture from before the change. A picture named with a real device (like iPhone 16 Pro or iPad Air) was taken on that
phone or tablet, at its own size.
${EXAMPLES_FIT} When the Tester used the nearest example that fits, judge that example.

${list}

In checks, one for each "done when" above, whatever the number of its pictures:
- criterion: its number.
- shows: met, broken or not-shown.
- why: one plain sentence for a project manager, what the pictures show.
- advice: for not-shown only, exactly what the Tester should add: only the part that is missing, never a part a picture
  already shows, since squad-kit keeps those pictures. Say the part of the page, the state after which action, and the
  size (phone or desktop).
- canShow: for not-shown only. Can what is missing be shown at all, with this app's data and squad-kit's tools (they
  open pages, fill in forms and press buttons), given the Tester's reason? true when it can, even with more steps or
  by making the data through the app's own screens. A reason like "I did not try", "it takes too long" or "too many
  steps" is always true. false only when it truly cannot: the app has no such data and its screens cannot make it, or
  it happens away from any screen (after a restart, in an email).
- canShowWhy: for canShow false only, one or two plain sentences for a project manager: what the pictures show, then
  which part could not be shown and why. For example: "Shown for upcoming bookings. Past bookings could not be shown:
  the app has none yet." With no picture, only the second part.
- noChange: true when the "done when" itself says the screen stays as it was (looks the same as before, unchanged, as
  today, still shows ...), else false. For those, a picture the same as the one from before is the proof, not a fault:
  judge what it shows.${theirLanguage(t)}`;
}

/**
 * The screenshots show a "done when" does not work: the Builder fixes it, told what the pictures show. `newTests` off:
 * the story is built without new tests, so it adds none for it.
 */
export function proofFixPrompt(notes: string[], newTests = true): string {
  return `squad-kit looked at the screenshots of your work, and they show these "done when" do not work yet:
${notes.map((n) => `- ${n}`).join('\n')}

Print ">> fix" first. Fix the code so each one works as written, ${newTests ? 'add or update a test for it where you can, ' : ''}and run
the tests again. ${FIX_ONLY_BROKEN} The checks, the review and the screenshots run again after you.`;
}
