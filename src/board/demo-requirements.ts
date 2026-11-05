import fs from 'node:fs';
import path from 'node:path';
import { zip } from '../core/zip.js';
import { now, type BoardPaths } from './store.js';
import type { BoardMeta } from './types.js';
import type { Breakdown, BreakdownEpic, BreakdownQuestion, BreakdownState, BreakdownStory, BrdRef, StorySize } from './requirements-types.js';
import { breakdownDir, requirementsDir } from './requirements-paths.js';
import {
  addBreakdownActivity,
  allStories,
  breakdownJobs,
  findItem,
  nextKey,
  readBreakdown,
  readBreakdownState,
  updateBreakdown,
  updateBreakdownState,
  writeBreakdown,
  writeBreakdownState,
} from './requirements.js';
import { SKIP_CHOICE, breakdownStopped, nextDecidedId, usualReadSeconds } from './requirements-actions.js';
import { prepareText, textParts } from './requirements-text.js';
import { fillBuildQueue } from './requirements-build.js';

/**
 * The sample board's requirements: the court case portal's BRD, already broken down and ready to approve (BR-1), and
 * a scripted Analyst for a BRD added on the sample board. It reads for a few seconds, asks one gap and one clash,
 * then drafts the same court portal breakdown, an epic at a time. No AI runs on the sample board.
 */

/* ── The sample BRD, as a Word file ─────────────────────── */

type Block = { title: string } | { h1: string } | { h2: string } | { p: string } | { bullets: string[] } | { numbers: string[] } | { table: string[][] };

const BRD: Block[] = [
  { title: 'Case Portal BRD v1' },
  { p: "Business requirements for the commercial court's online case portal. Version 1, from the court's business team." },
  { h1: '1 Purpose' },
  { p: "Lawyers and parties book hearings, pay court fees and follow their cases online, in **Arabic and English**. Court staff manage hearing days and see reports. The portal runs on the court's Angular front end and .NET services." },
  { h1: '2 Users' },
  { bullets: ['Lawyer: books hearings and pays fees for their clients.', 'Party: follows their own case and pays its fees.', 'Clerk: manages court rooms and hearing days.', 'Court admin: sees the reports and the audit log.'] },
  { h1: '3 Book a hearing' },
  { h2: '3.1 Find a free slot' },
  { p: 'A lawyer picks a court and a date range and sees the free hearing slots.' },
  { h2: '3.2 Judge calendar' },
  { p: 'A calendar shows the days each judge sits, with the free slots marked.' },
  { h2: '3.3 Holding a slot' },
  { p: 'While the lawyer fills in the booking, the slot is held for **10 minutes** so nobody else takes it.' },
  { h2: '3.4 Confirm a booking' },
  { p: 'The booking is confirmed once the fee is paid, or straight away for legal aid cases.' },
  { h2: '3.5 Cancel or move a hearing' },
  { p: 'A lawyer can cancel a hearing, or move it to another free slot, up to 48 hours before it.' },
  { h1: '4 Court fees' },
  { h2: '4.1 Fees by case type' },
  { table: [['Case type', 'Fee (SAR)'], ['Commercial claim', '500'], ['Appeal', '750'], ['Urgent order', '300']] },
  { h2: '4.2 Paying online' },
  { p: 'Fees are paid by card in the portal.' },
  { h2: '4.3 Receipts' },
  { p: 'Each payment gets a receipt as a PDF, in Arabic and English.' },
  { h2: '4.4 Refunds' },
  { p: 'When a hearing is cancelled, the fee is refunded in full to the card that paid.' },
  { h2: '4.5 Legal aid' },
  { p: 'Cases with legal aid pay no fee. A clerk marks a case as legal aid.' },
  { h1: '5 Notifications' },
  { numbers: ['A confirmation by email and SMS when a hearing is booked.', 'A reminder one day before the hearing.', 'Every message in the language the person chose, Arabic or English.'] },
  { h1: '6 Courts and hearing days' },
  { h2: '6.1 Court rooms' },
  { p: 'Clerks add and edit court rooms, with their size and equipment.' },
  { h2: '6.2 Hearing days' },
  { p: 'Clerks open and close hearing days for each judge.' },
  { h2: '6.3 Holidays and late cancels' },
  { p: 'A clerk blocks the slots of public holidays. The fee is kept when a party cancels less than 48 hours before the hearing.' },
  { h1: '7 Reports' },
  { bullets: ['Hearings per court each week.', 'Fees paid and refunded each month.', 'Every report can be exported to Excel.', 'An audit log shows who booked, moved or cancelled a hearing.'] },
  { h1: '8 Later phases' },
  { p: 'A mobile app for parties comes in a later phase. It is not part of this version.' },
];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** "Paid **in full**" as Word runs, the starred part bold. */
function runs(text: string): string {
  return text
    .split(/(\*\*[^*]+\*\*)/)
    .filter(Boolean)
    .map((t) => (t.startsWith('**') ? `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${esc(t.slice(2, -2))}</w:t></w:r>` : `<w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`))
    .join('');
}

const para = (text: string, style?: string, num?: number) =>
  `<w:p>${style || num ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${num ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${num}"/></w:numPr>` : ''}</w:pPr>` : ''}${runs(text)}</w:p>`;

function blockXml(b: Block): string {
  if ('title' in b) return para(b.title, 'Title');
  if ('h1' in b) return para(b.h1, 'Heading1');
  if ('h2' in b) return para(b.h2, 'Heading2');
  if ('p' in b) return para(b.p);
  if ('bullets' in b) return b.bullets.map((x) => para(x, undefined, 1)).join('');
  if ('numbers' in b) return b.numbers.map((x) => para(x, undefined, 2)).join('');
  return `<w:tbl>${b.table.map((row) => `<w:tr>${row.map((c) => `<w:tc>${para(c)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`;
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** The sample BRD as a real .docx, made with squad-kit's own zip writer. */
export function demoBrdDocx(): Buffer {
  const style = (id: string, name: string) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/></w:style>`;
  const level = (fmt: string) => `<w:lvl w:ilvl="0"><w:numFmt w:val="${fmt}"/></w:lvl>`;
  return zip([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    },
    {
      name: 'word/_rels/document.xml.rels',
      data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>',
    },
    { name: 'word/styles.xml', data: `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}>${style('Title', 'Title')}${style('Heading1', 'heading 1')}${style('Heading2', 'heading 2')}</w:styles>` },
    {
      name: 'word/numbering.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0">${level('bullet')}</w:abstractNum><w:abstractNum w:abstractNumId="1">${level('decimal')}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
    },
    { name: 'word/document.xml', data: `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${BRD.map(blockXml).join('')}</w:body></w:document>` },
  ]);
}

/* ── The breakdown the scripted Analyst writes ──────────── */

interface StoryPlan {
  title: string;
  who: string;
  want: string;
  why: string;
  done: [string, string, string][];
  size: StorySize;
  needs?: number[];
  ref: BrdRef;
}

interface FeaturePlan {
  title: string;
  summary: string;
  ref: BrdRef;
  stories: StoryPlan[];
}

interface EpicPlan {
  title: string;
  goal: string;
  ref: BrdRef;
  features: FeaturePlan[];
}

const ref = (section: string, title: string, page: number): BrdRef => ({ section, title, page });

/** The court portal's breakdown: 3 epics, 7 features, 20 stories. `needs` counts stories from 1, in this order. */
const PLAN: EpicPlan[] = [
  {
    title: 'Book a hearing',
    goal: 'Lawyers book a hearing slot online instead of at the court desk.',
    ref: ref('3', 'Book a hearing', 1),
    features: [
      {
        title: 'Find a free slot',
        summary: 'Lawyers see the free hearing slots of a court.',
        ref: ref('3.1', 'Find a free slot', 1),
        stories: [
          { title: 'Search free hearing slots', who: 'lawyer', want: 'to search the free hearing slots of a court by date', why: 'I can pick one that suits my client', done: [["I'm signed in as a lawyer", 'I pick a court and a date range', 'I see the free slots, earliest first'], ['no slot is free in that range', 'I search', 'I see "No free slots" and the next free day']], size: 'M', ref: ref('3.1', 'Find a free slot', 1) },
          { title: "See a judge's free days", who: 'lawyer', want: 'a calendar of the days each judge sits', why: 'I can plan around them', done: [['a court with three judges', 'I open the calendar', 'I see each judge\'s days with the free slots marked']], size: 'S', needs: [1], ref: ref('3.2', 'Judge calendar', 2) },
        ],
      },
      {
        title: 'Book and confirm',
        summary: 'A slot is held while the lawyer books, then confirmed.',
        ref: ref('3.3', 'Holding a slot', 2),
        stories: [
          { title: 'Hold a slot for 10 minutes', who: 'lawyer', want: 'my chosen slot held while I fill in the booking', why: 'nobody else takes it meanwhile', done: [['a free slot', 'I pick it', 'it shows as held for me, with 10 minutes left'], ['a slot held by someone else', 'I look at it', 'it shows as taken'], ['10 minutes pass without booking', 'the time ends', 'the slot is free again']], size: 'M', needs: [1], ref: ref('3.3', 'Holding a slot', 2) },
          { title: 'Confirm a hearing booking', who: 'lawyer', want: 'my booking confirmed once the fee is paid', why: 'the hearing is fixed in the court calendar', done: [['a held slot and a paid fee', 'I confirm', 'the hearing shows in the case and the calendar'], ['a legal aid case', 'I book', 'it is confirmed with no fee']], size: 'M', needs: [3], ref: ref('3.4', 'Confirm a booking', 2) },
          { title: 'Cancel or move a hearing', who: 'lawyer', want: 'to cancel a hearing or move it to another free slot', why: 'plans can change', done: [['a hearing more than 48 hours away', 'I move it to a free slot', 'the old slot is free and the new one is mine'], ['a hearing less than 48 hours away', 'I try to cancel it', 'I see that it is too late to change online']], size: 'M', needs: [4], ref: ref('3.5', 'Cancel or move a hearing', 2) },
        ],
      },
      {
        title: 'Notifications',
        summary: 'People hear about their hearings by email and SMS.',
        ref: ref('5', 'Notifications', 3),
        stories: [
          { title: 'Email and SMS when a hearing is booked', who: 'party', want: 'an email and an SMS when my hearing is booked', why: 'I know the date without asking my lawyer', done: [['a hearing is confirmed', 'the booking ends', 'the lawyer and the party get an email and an SMS with the date and court']], size: 'S', needs: [4], ref: ref('5', 'Notifications', 3) },
          { title: 'Reminder one day before the hearing', who: 'party', want: 'a reminder the day before my hearing', why: 'I do not miss it', done: [['a hearing tomorrow', 'the reminders go out at 9:00', 'the lawyer and the party get a reminder']], size: 'S', needs: [4], ref: ref('5', 'Notifications', 3) },
          { title: 'Messages in Arabic and English', who: 'party', want: 'every message in the language I chose', why: 'I understand it', done: [['my language is Arabic', 'a message is sent to me', 'it is in Arabic, right to left'], ['my language is English', 'a message is sent to me', 'it is in English']], size: 'S', needs: [6], ref: ref('5', 'Notifications', 3) },
        ],
      },
    ],
  },
  {
    title: 'Pay court fees',
    goal: 'Parties and lawyers pay court fees online and get a receipt.',
    ref: ref('4', 'Court fees', 2),
    features: [
      {
        title: 'Pay online',
        summary: 'The fee of a case, paid by card, with a receipt.',
        ref: ref('4.2', 'Paying online', 3),
        stories: [
          { title: 'Show the fee for a case type', who: 'lawyer', want: 'to see the fee of a case before I book', why: 'I can tell my client what it costs', done: [['a commercial claim', 'I start a booking', 'I see the fee: 500 SAR']], size: 'S', ref: ref('4.1', 'Fees by case type', 2) },
          { title: 'Pay the fee by card', who: 'lawyer', want: 'to pay the fee by card in the portal', why: 'the hearing is confirmed at once', done: [['a held slot and its fee', 'I pay by card', 'the fee shows as paid and the booking is confirmed'], ['the card is declined', 'I pay', 'I see why and the slot stays held']], size: 'L', needs: [9, 4], ref: ref('4.2', 'Paying online', 3) },
          { title: 'Receipt as a PDF in two languages', who: 'party', want: 'a receipt for every payment', why: 'I have proof that I paid', done: [['a paid fee', 'I open the case', 'I can download the receipt as a PDF in Arabic and English']], size: 'M', needs: [10], ref: ref('4.3', 'Receipts', 3) },
        ],
      },
      {
        title: 'Refunds and legal aid',
        summary: 'Money back when a hearing is cancelled, and no fee with legal aid.',
        ref: ref('4.4', 'Refunds', 3),
        stories: [
          { title: 'Refund the fee when a hearing is cancelled', who: 'lawyer', want: 'the fee refunded when my hearing is cancelled', why: 'my client does not pay for a hearing that did not happen', done: [['a paid hearing', 'it is cancelled', 'the fee goes back to the card that paid'], ['a refund was sent', 'I open the case', 'I see the refund and its date']], size: 'M', needs: [10, 5], ref: ref('4.4', 'Refunds', 3) },
          { title: 'No fee for legal aid cases', who: 'clerk', want: 'to mark a case as legal aid', why: 'its party pays no fee', done: [['a case', 'I mark it as legal aid', 'its bookings show no fee']], size: 'M', needs: [9], ref: ref('4.5', 'Legal aid', 3) },
        ],
      },
    ],
  },
  {
    title: 'Admin and reports',
    goal: 'Court staff manage hearing days and see how the courts are used.',
    ref: ref('6', 'Courts and hearing days', 4),
    features: [
      {
        title: 'Courts and hearing days',
        summary: 'Clerks keep the court rooms and hearing days up to date.',
        ref: ref('6.1', 'Court rooms', 4),
        stories: [
          { title: 'Add and edit court rooms', who: 'clerk', want: 'to add and edit court rooms', why: 'bookings go to rooms that exist', done: [['I am a clerk', 'I add a room with its size and equipment', 'it shows in the list of rooms']], size: 'S', ref: ref('6.1', 'Court rooms', 4) },
          { title: 'Open and close hearing days', who: 'clerk', want: "to open and close a judge's hearing days", why: 'only real days can be booked', done: [['a judge', 'I open next Monday for hearings', 'its slots can be booked'], ['a day with bookings', 'I try to close it', 'I see the bookings to move first']], size: 'M', needs: [14], ref: ref('6.2', 'Hearing days', 4) },
          { title: 'Block slots on public holidays', who: 'clerk', want: 'to block the slots of a public holiday', why: 'nobody books a day the court is closed', done: [['a public holiday', 'I block it', 'none of its slots can be booked']], size: 'S', needs: [15], ref: ref('6.3', 'Holidays and late cancels', 4) },
        ],
      },
      {
        title: 'Reports',
        summary: 'How the courts are used, and who changed what.',
        ref: ref('7', 'Reports', 4),
        stories: [
          { title: 'Hearings per court each week', who: 'court admin', want: 'a weekly report of hearings per court', why: 'I see which courts are busy', done: [['last week had hearings', 'I open the report', 'I see the hearings of each court, day by day']], size: 'M', needs: [4], ref: ref('7', 'Reports', 4) },
          { title: 'Fees report for each month', who: 'court admin', want: 'a monthly report of the fees paid and paid back', why: 'the finance team can check them', done: [['a month with payments and money paid back', 'I open the report', 'I see the totals paid and paid back per case type']], size: 'M', needs: [10, 12], ref: ref('7', 'Reports', 4) },
          { title: 'Export a report to Excel', who: 'court admin', want: 'to export any report to Excel', why: 'I can share it', done: [['a report on screen', 'I press Export', 'I get an Excel file with the same rows']], size: 'S', needs: [17], ref: ref('7', 'Reports', 4) },
          { title: 'Audit log of hearing changes', who: 'court admin', want: 'a log of who booked, moved or cancelled a hearing', why: 'I can answer complaints', done: [['a hearing was moved', 'I open the audit log', 'I see who moved it, when, and from which slot']], size: 'M', needs: [5], ref: ref('7', 'Reports', 4) },
        ],
      },
    ],
  },
];

const LEFT_OUT = [{ text: 'A mobile app for parties', why: 'The BRD says it comes in a later phase.', ref: ref('8', 'Later phases', 5) }];

const SUMMARY =
  "The court's case portal: lawyers and parties book hearings, pay court fees and get notified, in Arabic and English. Clerks manage court rooms and hearing days, and court admins see reports and an audit log.";

/** The two questions the scripted Analyst asks: one clash, one gap. */
function demoQuestions(): BreakdownQuestion[] {
  return [
    {
      id: 'q1',
      from: 'analyst',
      kind: 'clash',
      text: 'Section 4.4 refunds the fee in full for every cancelled hearing. Section 6.3 keeps the fee when a party cancels less than 48 hours before. Which one is right?',
      options: ['Refund in full every time (4.4)', 'Keep the fee within 48 hours (6.3)'],
      refs: [ref('4.4', 'Refunds', 3), ref('6.3', 'Holidays and late cancels', 4)],
      impact: 'Changes 2 stories in Pay court fees',
    },
    {
      id: 'q2',
      from: 'analyst',
      kind: 'gap',
      text: 'Can parties also pay the court fee at the court desk, or only online?',
      options: ['Online only', 'Online or at the court desk'],
      refs: [ref('4.2', 'Paying online', 3)],
      impact: 'Changes the whole Pay court fees epic',
    },
  ];
}

/** What the scripted Analyst decides itself while reading, and which story each one ends up on (counted from 1). */
const READ_DECIDED: { text: string; story: number }[] = [
  { text: 'A held slot is freed after 10 minutes without a warning first. The BRD does not ask for one.', story: 3 },
  { text: 'Messages go in the language the person chose on their profile, Arabic when none is set.', story: 8 },
];

/** What each answer means for the breakdown, by question and option, and the story it is about. */
function fromAnswer(q: BreakdownQuestion): { text: string; story: number } | null {
  const a = q.answer;
  if (!a) return null;
  const pick = a.choice === SKIP_CHOICE ? q.options[0] : a.choice;
  if (q.id === 'q1') {
    if (a.choice === 'Other') return { text: `Refunds: ${a.value ?? ''}`, story: 12 };
    return pick === q.options[1] ? { text: 'The fee is kept when a party cancels less than 48 hours before the hearing, as section 6.3 says.', story: 12 } : { text: 'Every cancelled hearing is refunded in full, as section 4.4 says.', story: 12 };
  }
  if (q.id === 'q2') {
    if (a.choice === 'Other') return { text: `Paying the fee: ${a.value ?? ''}`, story: 10 };
    return pick === q.options[1] ? { text: 'Parties can also pay at the court desk: a clerk marks the fee as paid from the case page.', story: 10 } : { text: 'Fees are paid online only, by card.', story: 10 };
  }
  return null;
}

function storyOf(p: StoryPlan, key: string): BreakdownStory {
  return {
    key,
    title: p.title,
    story: `As a ${p.who}, I want ${p.want}, so that ${p.why}.`,
    criteria: p.done.map(([given, when, then]) => ({ given, when, then })),
    size: p.size,
    dependsOn: [],
    ref: p.ref,
  };
}

/** The keys of the plan's stories, counted from 1, once they are in the breakdown. */
function planKeys(b: Breakdown, first: number): Map<number, string> {
  return new Map(PLAN.flatMap((e) => e.features.flatMap((f) => f.stories)).map((_, i) => [i + 1, `S-${first + i}`] as const).filter(([, k]) => findItem(b, k)));
}

/** The outline: the plan's epics and features, with keys, no stories yet. */
function addOutline(b: Breakdown): void {
  b.epics = PLAN.map((e) => ({
    key: nextKey(b, 'epic'),
    title: e.title,
    goal: e.goal,
    ref: e.ref,
    features: e.features.map((f) => ({ key: nextKey(b, 'feature'), title: f.title, summary: f.summary, ref: f.ref, stories: [] })),
    stories: [],
  }));
  b.leftOut = LEFT_OUT.map((l) => ({ ...l }));
}

/** One epic's stories, from the plan; their needs point at the keys the plan's stories got. */
function addStories(b: Breakdown, index: number, first: number): number {
  const epic = b.epics[index];
  const plan = PLAN[index];
  if (!epic || !plan) return 0;
  let n = 0;
  plan.features.forEach((fp, fi) => {
    const f = epic.features[fi];
    if (!f) return;
    for (const sp of fp.stories) {
      f.stories.push(storyOf(sp, nextKey(b, 'story')));
      n += 1;
    }
  });
  const keys = planKeys(b, first);
  const flat = PLAN.flatMap((e) => e.features.flatMap((x) => x.stories));
  for (const [i, sp] of flat.entries()) {
    const s = findItem(b, keys.get(i + 1) ?? '')?.story;
    if (s) s.dependsOn = (sp.needs ?? []).map((x) => keys.get(x)).filter((k): k is string => Boolean(k));
  }
  return n;
}

/** Each Decided entry goes on its story once that story is written: the read's own, and what the answers meant. */
function placeDecided(b: Breakdown, first: number): void {
  const keys = planKeys(b, first);
  const all = [...READ_DECIDED, ...b.questions.map(fromAnswer).filter((a): a is { text: string; story: number } => Boolean(a))];
  for (const d of b.decided) {
    if (d.item) continue;
    const at = all.find((r) => r.text === d.text)?.story;
    const key = at ? keys.get(at) : undefined;
    if (key) d.item = key;
  }
}

/* ── BR-1 on the sample board ───────────────────────────── */

function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/** The sample board starts with no breakdowns but its own. */
export function clearDemoRequirements(bp: BoardPaths): void {
  fs.rmSync(requirementsDir(bp), { recursive: true, force: true });
}

/** BR-1: the court portal's BRD, read, asked about, answered and drafted, ready for the person to approve. */
export function seedDemoRequirements(bp: BoardPaths, user: string): void {
  clearDemoRequirements(bp);
  const id = 'BR-1';
  const dir = breakdownDir(bp, id);
  const file = 'source/Case Portal BRD v1.docx';
  fs.mkdirSync(path.join(dir, 'source'), { recursive: true });
  const docx = demoBrdDocx();
  fs.writeFileSync(path.join(dir, file), docx);
  const text = prepareText(dir, { file, kind: 'docx' });
  const questions = demoQuestions();
  questions[0]!.answer = { choice: questions[0]!.options[0]! };
  questions[1]!.answer = { choice: questions[1]!.options[1]! };
  const b: Breakdown = {
    id,
    title: 'Case Portal BRD v1',
    status: 'ready',
    source: { file, name: 'Case Portal BRD v1.docx', kind: 'docx', bytes: docx.length, pages: text.parts, addedBy: user, addedAt: ago(95) },
    summary: SUMMARY,
    questions,
    epics: [],
    decided: [],
    leftOut: [],
    createdAt: ago(95),
    createdBy: user,
    owner: user,
    next: { epic: 1, feature: 1, story: 1 },
  };
  addOutline(b);
  PLAN.forEach((_, i) => addStories(b, i, 1));
  const at = ago(88);
  for (const r of READ_DECIDED) b.decided.push({ id: nextDecidedId(b.decided), text: r.text, by: 'analyst', at });
  for (const q of questions) {
    const a = fromAnswer(q);
    if (a) b.decided.push({ id: nextDecidedId(b.decided), text: a.text, by: 'answer', at: ago(70) });
  }
  placeDecided(b, 1);
  writeBreakdown(bp, b);
  const stories = allStories(b).length;
  const state: BreakdownState = {
    activity: [
      { at: ago(66), who: 'analyst', text: `The breakdown is ready for you: ${b.epics.length} epics, 7 features and ${stories} stories` },
      { at: ago(70), who: 'you', text: 'Answered 2 questions' },
      { at: ago(86), who: 'analyst', text: 'Has 2 questions for you' },
      { at: ago(86), who: 'analyst', text: 'Read the document: found 3 epics and 7 features, and decided 2 small things itself' },
      { at: ago(95), who: 'squad', text: 'Turned the Word file into text. Kept the headings and tables' },
      { at: ago(95), who: 'you', text: 'Added Case Portal BRD v1.docx' },
    ],
    job: { step: 'draft', status: 'done', found: { epics: b.epics.length, features: 7, stories } },
  };
  writeBreakdownState(bp, id, state);
}

/* ── Build continuously ─────────────────────────────────── */

/** A turn of the queue running now, per sample board: the scripted squad's timer does not wait for it. */
const queueing = new Set<string>();

/**
 * The same queue the live squad runs, on the sample board: the parallel limit holds each breakdown, and the scripted
 * squad has no limit of its own (it plays every ticket at once). The sample board has no usage limit and no budget.
 */
export function playDemoQueue(bp: BoardPaths): void {
  if (queueing.has(bp.root)) return;
  queueing.add(bp.root);
  void fillBuildQueue(bp, { free: () => Infinity, pause: null, payment: async () => 'subscription' })
    .catch(() => undefined)
    .finally(() => queueing.delete(bp.root));
}

/* ── The scripted Analyst ───────────────────────────────── */

/** How long each scripted step takes at speed 1. */
const BEAT_MS = 2500;
const beats = new Map<string, number>();

/** True once a beat has passed since the last step of this breakdown's job. */
function beat(bp: BoardPaths, id: string, speed: number): boolean {
  const key = `${bp.root}:${id}`;
  const last = beats.get(key);
  const at = Date.now();
  if (last === undefined) {
    beats.set(key, at);
    return false;
  }
  if (at - last < BEAT_MS / Math.max(0.1, speed)) return false;
  beats.set(key, at);
  return true;
}

/** Plays each of my breakdowns' jobs one step per beat, the way the live Analyst would, with no AI. */
export function playDemoBreakdowns(bp: BoardPaths, meta: BoardMeta): void {
  for (const { id, job } of breakdownJobs(bp, meta)) {
    if (job.status === 'stopping') {
      breakdownStopped(bp, id);
      continue;
    }
    if (!beat(bp, id, meta.speed)) continue;
    try {
      playStep(bp, id);
    } catch (err) {
      updateBreakdown(bp, id, (x) => {
        if (job.step === 'reply' || job.step === 'redo') return;
        x.status = 'failed';
        x.error = (err as Error).message;
      });
      updateBreakdownState(bp, id, (s) => {
        if (s.job) Object.assign(s.job, { status: 'failed', error: (err as Error).message, now: undefined });
      });
    }
  }
}

function playStep(bp: BoardPaths, id: string): void {
  const state = readBreakdownState(bp, id);
  const job = state.job!;
  const b = readBreakdown(bp, id)!;
  if (job.status === 'pending') {
    updateBreakdownState(bp, id, (s) => Object.assign(s.job!, { status: 'running', startedAt: now() }));
  }
  switch (job.step) {
    case 'text': {
      const p = prepareText(breakdownDir(bp, id), b.source);
      updateBreakdownState(bp, id, (s) => {
        s.job = { step: 'read', status: 'running', startedAt: now(), now: 'Reading the document', at: { done: 0, of: p.pages ?? p.parts, unit: b.source.kind === 'pdf' ? 'page' : 'part' }, usualSeconds: usualReadSeconds(p) };
        addBreakdownActivity(s, 'squad', 'Turned the document into text');
      });
      return;
    }
    case 'read':
      return playRead(bp, b, state);
    case 'reply':
      return playReply(bp, b, job.question);
    case 'draft':
      return playDraft(bp, b);
    case 'redo':
      return playRedo(bp, b, job.item ?? '', job.ask ?? '');
  }
}

/** Reading: page by page (or part by part), the epics and features found growing, then the two questions. */
function playRead(bp: BoardPaths, b: Breakdown, state: BreakdownState): void {
  const of = b.source.kind === 'pdf' ? (b.source.pages ?? 1) : Math.max(1, textParts(breakdownDir(bp, b.id)).length);
  const unit = b.source.kind === 'pdf' ? 'page' : 'part';
  // Three beats of reading, the epics and features found growing with each, then the questions.
  const step = (state.job!.found?.epics ?? 0) + 1;
  if (step <= 3) {
    updateBreakdownState(bp, b.id, (s) =>
      Object.assign(s.job!, { now: 'Reading the document', at: { done: Math.max(1, Math.round((step * of) / 3)), of, unit }, found: { epics: step, features: [2, 5, 7][step - 1]!, stories: 0 } }),
    );
    return;
  }
  const questions = demoQuestions();
  updateBreakdown(bp, b.id, (x) => {
    x.summary = SUMMARY;
    x.questions = questions;
    for (const r of READ_DECIDED) if (!x.decided.some((d) => d.text === r.text)) x.decided.push({ id: nextDecidedId(x.decided), text: r.text, by: 'analyst', at: now() });
    x.status = 'questions';
  });
  updateBreakdownState(bp, b.id, (s) => {
    s.job = { step: 'read', status: 'done', found: { epics: 3, features: 7, stories: 0 }, at: { done: of, of, unit } };
    addBreakdownActivity(s, 'analyst', 'Read the document: found 3 epics and 7 features, and decided 2 small things itself');
    addBreakdownActivity(s, 'analyst', 'Has 2 questions for you');
  });
}

const REPLIES: Record<string, string> = {
  q1: 'Two sections of the BRD give different refund rules. Refunding every time is simpler for lawyers; keeping the fee within 48 hours protects the court from late cancels. The refund story is built the way you pick.',
  q2: 'The BRD only names paying by card. If parties can pay at the desk too, clerks need a way to mark a fee as paid, which adds a small story to the fees epic.',
};

function playReply(bp: BoardPaths, b: Breakdown, qid: string | undefined): void {
  updateBreakdown(bp, b.id, (x) => {
    const q = x.questions.find((y) => y.id === qid);
    if (!q) return;
    q.thread = [...(q.thread ?? []), { who: 'analyst', text: REPLIES[q.id] ?? 'Pick the option closest to what you mean. I will write down what it means for the stories.', at: now() }];
    q.thinking = false;
  });
  updateBreakdownState(bp, b.id, (s) => Object.assign(s.job!, { status: 'done', now: undefined }));
}

/** Drafting: the outline, then one epic's stories per beat, then ready. */
function playDraft(bp: BoardPaths, b: Breakdown): void {
  if (!b.epics.length) {
    const after = updateBreakdown(bp, b.id, (x) => {
      addOutline(x);
      for (const q of x.questions) {
        const a = fromAnswer(q);
        if (a) x.decided.push({ id: nextDecidedId(x.decided), text: a.text, by: q.answer?.choice === SKIP_CHOICE ? 'analyst' : 'answer', at: now() });
      }
    });
    updateBreakdownState(bp, b.id, (s) => {
      Object.assign(s.job!, { now: `Writing the stories of ${after.epics[0]?.title} (epic 1 of ${after.epics.length})`, found: { epics: after.epics.length, features: 7, stories: 0 } });
      addBreakdownActivity(s, 'analyst', `Wrote the outline: ${after.epics.length} epics and 7 features`);
    });
    return;
  }
  const i = b.epics.findIndex((e) => !e.features.some((f) => f.stories.length) && !e.stories.length);
  if (i >= 0) {
    // The plan's first story key: the next free one when the outline was written, before any story.
    const first = b.next.story - allStories(b).length;
    let made = 0;
    const after = updateBreakdown(bp, b.id, (x) => {
      made = addStories(x, i, first);
      placeDecided(x, first);
    });
    const next = after.epics[i + 1];
    updateBreakdownState(bp, b.id, (s) => {
      Object.assign(s.job!, { now: next ? `Writing the stories of ${next.title} (epic ${i + 2} of ${after.epics.length})` : 'Checking the breakdown', found: { epics: after.epics.length, features: 7, stories: allStories(after).length } });
      addBreakdownActivity(s, 'analyst', `Wrote ${made} stories for ${after.epics[i]!.title}`);
    });
    return;
  }
  const stories = allStories(b).length;
  updateBreakdown(bp, b.id, (x) => {
    x.status = 'ready';
    delete x.error;
  });
  updateBreakdownState(bp, b.id, (s) => {
    s.job = { step: 'draft', status: 'done', found: { epics: b.epics.length, features: 7, stories } };
    addBreakdownActivity(s, 'analyst', `The breakdown is ready for you: ${b.epics.length} epics, 7 features and ${stories} stories`);
  });
}

/** A scripted redo: the part takes the person's words, the way the live Analyst would rewrite it. */
function playRedo(bp: BoardPaths, b: Breakdown, item: string, ask: string): void {
  updateBreakdown(bp, b.id, (x) => {
    if (item === x.id) {
      x.summary = `${x.summary ?? ''} ${ask}`.trim();
      return;
    }
    const f = findItem(x, item);
    if (!f) return;
    if (f.level === 'story' && !f.story!.ticket) f.story!.criteria.push({ given: 'the story as you asked', when: 'it is built', then: ask.replace(/\.$/, '') });
    else if (f.level === 'feature') f.feature!.summary = ask;
    else if (f.level === 'epic') (f.item as BreakdownEpic).goal = ask;
  });
  updateBreakdownState(bp, b.id, (s) => {
    s.job = { step: 'redo', status: 'done', item, ask };
    addBreakdownActivity(s, 'analyst', `Redid ${item === b.id ? 'the breakdown' : item}`);
  });
}

