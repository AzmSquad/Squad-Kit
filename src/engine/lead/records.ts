import fs from 'node:fs';
import path from 'node:path';
import { liveNow } from '../../board/now.js';
import { readOverview } from '../../board/overview.js';
import { breakdownWaits, listBreakdowns } from '../../board/requirements.js';
import { listDecisions, listReleases, listTickets, readMeta, type BoardPaths } from '../../board/store.js';
import { readUsual } from '../../board/usual.js';
import { boardUsage, costWords, monthKey, readMonths, totalOf } from '../../board/usage.js';
import { harnessView } from '../harness.js';
import { projectTools } from '../tools/index.js';
import { ALLOWABLE, ACTIONS, AFTER_YOUR_OK, NEVER, NEVER_MORE, ON_ITS_OWN } from './can.js';
import { readNotes } from './notes.js';
import { boardNumbers } from './small-talk.js';
import { leadRules, spentToday } from './store.js';
import { pressNeeded, releasedNews } from './waiting.js';

/**
 * What the lead may read besides the stories and the code, each as plain text: the board, the decisions, the
 * requirements, the releases, the usage, the Tools page, the Harness rules, and squad-kit's notes. All of it is
 * squad-kit's own record of the project; none of it holds a secret.
 */

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The board now: each open story, where it stands and what happens on it. */
export function boardText(bp: BoardPaths): string {
  const meta = readMeta(bp);
  const usual = readUsual(bp);
  const all = listTickets(bp);
  const open = all.filter((t) => t.stage !== 'done' && !t.archived);
  const rows = open.map((t) => {
    const now = liveNow(t, usual);
    return `- ${t.id} "${t.title}" (${t.kind}, ${t.stage}${t.waiting ? `, waits for you: ${t.waiting.summary}` : ''}${t.waitsToStart ? ', waits for you to start it' : ''}): ${now.state === 'working' ? now.line : now.sentence}`;
  });
  const done = all.filter((t) => t.stage === 'done').length;
  // The board's own count of what needs the person, the same number its top bar shows (lead/waiting.ts).
  const needs = [...pressNeeded(bp).map((t) => t.id), ...breakdownWaits(bp).map((b) => `${b.id} (the Analyst's questions on a requirements document)`)];
  const news = releasedNews(bp).map((t) => `${t.id} (${(t.outdated ?? []).map((o) => o.adr).join(', ') || 'a decision'} came after its plan)`);
  return [
    `Project ${meta.project}: ${open.length} open stor${open.length === 1 ? 'y' : 'ies'}, ${done} released.`,
    `Things that need the person now: ${needs.length}, the board's own count and the number its top bar shows${needs.length ? `: ${needs.join(', ')}` : ''}. Say this number.`,
    ...(news.length ? [`News, not counted as needing the person: ${news.join(', ')}.`] : []),
    ...rows,
  ].join('\n');
}

/** The saved decisions, or one of them in full. */
export function decisionsText(bp: BoardPaths, id?: string): string | null {
  const all = listDecisions(bp);
  if (id) {
    const d = all.find((x) => x.id.toUpperCase() === id.trim().toUpperCase());
    if (!d) return null;
    return [
      `Decision ${d.id}: ${d.title}${d.proposed ? ' (found in the code, not approved yet)' : ''}${d.replacedBy ? ` (replaced by ${d.replacedBy}, no longer a rule)` : ''}`,
      `Chosen: ${d.chosen}`,
      `Why: ${d.why}`,
      d.options.length ? `Options it weighed: ${d.options.join('; ')}` : '',
      `From ${d.from}, approved by ${d.approvedBy || 'nobody yet'} on ${d.date}. Stories: ${d.tickets.join(', ') || 'none'}.`,
      d.replaces ? `It replaces ${d.replaces}.` : '',
      d.buildsOn?.length ? `It builds on ${d.buildsOn.join(', ')}.` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (!all.length) return 'There are no saved decisions yet.';
  return all.map((d) => `- ${d.id} ${d.title}: ${cut(d.chosen, 160)}${d.proposed ? ' (not approved yet)' : ''}${d.replacedBy ? ` (replaced by ${d.replacedBy})` : ''}`).join('\n');
}

/** The requirements: each breakdown with its epics, features and stories, and the story each became. */
export function requirementsText(bp: BoardPaths): string {
  const all = listBreakdowns(bp);
  if (!all.length) return 'There are no requirements documents on this board.';
  const story = (s: { key: string; title: string; ticket?: string }) => `    - ${s.key} ${s.title}${s.ticket ? ` (became ${s.ticket})` : ''}`;
  return all
    .map((b) =>
      [
        `${b.id} "${b.title}" (${b.status}${b.approved ? `, approved by ${b.approved.by}` : ''})${b.summary ? `: ${cut(b.summary, 400)}` : ''}`,
        ...b.epics.flatMap((e) => [`  ${e.key} ${e.title}`, ...e.stories.map(story), ...e.features.flatMap((f) => [`   ${f.key} ${f.title}`, ...f.stories.map(story)])]),
      ].join('\n'),
    )
    .join('\n\n');
}

/** The releases, newest first, with their stories and notes. */
export function releasesText(bp: BoardPaths): string {
  const all = listReleases(bp);
  if (!all.length) return 'There are no releases yet.';
  return all
    .slice(0, 20)
    .map((r) => `${r.version} (${r.status}${r.date ? `, ${r.date.slice(0, 10)}` : ''}): ${r.tickets.join(', ') || 'no stories'}${r.notes.trim() ? `\n${cut(r.notes.trim(), 600)}` : ''}`)
    .join('\n\n');
}

/** What the squad used, at API prices: this month, in all, per role, and the lead's own questions today. */
export function usageText(bp: BoardPaths): string {
  const u = boardUsage(bp);
  const month = readMonths(bp)[monthKey()];
  const lines = [
    `In all: ${costWords(u.total) ?? 'no cost reported'} over ${u.total.runs} runs, on ${u.tickets} stories.`,
    month ? `This month: ${costWords(month) ?? 'no cost reported'} over ${month.runs} runs.` : 'Nothing counted this month yet.',
    ...u.roles.map((r) => `- ${r.role}: ${costWords(r.total) ?? 'no cost reported'} over ${r.total.runs} runs`),
    `The Squad lead today: $${spentToday(bp).toFixed(2)}.`,
  ];
  for (const t of listTickets(bp).filter((x) => x.usage?.length).slice(-15)) {
    const total = costWords(totalOf(t.usage));
    if (total) lines.push(`- ${t.id} "${t.title}": ${total}`);
  }
  return lines.join('\n');
}

/** The Tools page's lines for this project on this computer: what it needs, and what is missing. */
export async function toolsText(bp: BoardPaths): Promise<string> {
  const v = await projectTools(bp);
  return [
    v.summary,
    ...v.lines.map((l) => `- ${l.name} (${l.priority}): ${l.state}${l.version ? `, ${l.version}` : ''}. Needed for ${l.usedFor}.${l.state === 'ready' ? '' : ` ${l.installer === 'squad-kit' ? 'squad-kit gets it itself (Get it on the Tools page).' : `You install it: ${l.steps.slice(0, 3).join(' ')}`}`}${l.note ? ` ${l.note}` : ''}`),
  ].join('\n');
}

/** The Harness rules: every gate on the line, what watches it always, the team's own additions, and the lead's own rules. */
export function rulesText(bp: BoardPaths): string {
  const meta = readMeta(bp);
  const v = harnessView(meta, bp);
  const rules = leadRules(bp);
  return [
    ...v.stages.map((s) => `${s.name}: ${s.about}\n${s.gates.map((g) => `- ${g.name}: ${g.what}${g.fail ? ` If it fails: ${g.fail}` : ''}`).join('\n')}`),
    `Always on:\n${v.alwaysOn.map((r) => `- ${r.name}: ${r.what}${r.then ? ` ${r.then}` : ''}`).join('\n')}`,
    `Limits:\n${v.limits.map((l) => `- ${l.name}: ${l.n}${l.what ? `. ${l.what}` : ''}`).join('\n')}`,
    `The Squad lead on its own:\n${ON_ITS_OWN.map((x) => `- ${x}`).join('\n')}`,
    `The Squad lead after the person's OK:\n${AFTER_YOUR_OK.map((x) => `- ${x}`).join('\n')}`,
    `The Squad lead never:\n${[...Object.values(NEVER).map((n) => n.name), ...NEVER_MORE].map((x) => `- ${x}`).join('\n')}`,
    `Always allow is on for: ${rules.always.map((a) => ACTIONS[a].name).join(', ') || 'nothing'} (it can only cover ${ALLOWABLE.map((a) => ACTIONS[a].name.toLowerCase()).join(', ')}).`,
  ].join('\n\n');
}

/** What squad-kit already knows about the project, cheapest first: the lead's notes, the first read, the knowledge files. */
export function notesText(bp: BoardPaths): string {
  const meta = readMeta(bp);
  const notes = readNotes(bp);
  const overview = readOverview(bp);
  const parts: string[] = [];
  // The board's numbers first: they are newer than the first read, which may say the project had no code yet.
  const b = boardNumbers(bp);
  parts.push(`The board now, squad-kit's own count and newer than anything below: ${b.open} open stories, ${b.accepted} accepted for the next release, ${b.released} released, ${b.waiting} things need the person, ${b.working} agents working.`);
  if (notes.length) parts.push(`The Squad lead's saved notes, newest last:\n${notes.map((n) => `- (${n.about}, ${n.at.slice(0, 10)}, asked "${cut(n.question, 120)}") ${n.text}${n.sources?.length ? ` [${n.sources.join(', ')}]` : ''}`).join('\n')}`);
  if (overview.users) parts.push(`Who uses the app (from squad-kit's first read): ${overview.users}`);
  if (overview.can.length) parts.push(`What it can do today:\n${overview.can.map((c) => `- ${c}`).join('\n')}`);
  if (overview.worth.length) parts.push(`Worth knowing:\n${overview.worth.map((c) => `- ${c}`).join('\n')}`);
  if (meta.scan?.summary) {
    const at = meta.scan.at;
    const since = at ? listTickets(bp).filter((t) => t.mergedAt && t.mergedAt > at).length : 0;
    parts.push(`The project in short, from squad-kit's first read${at ? ` on ${at.slice(0, 10)}` : ''}${since ? `; ${since} stories were merged since, so it is older than the code` : ''}: ${meta.scan.summary}`);
  }
  if (meta.map.length) parts.push(`Its parts:\n${meta.map.map((m) => `- ${m.area}: ${m.detail}`).join('\n')}`);
  if (meta.lessons.length) parts.push(`Lessons:\n${meta.lessons.map((l) => `- ${l.text}`).join('\n')}`);
  let files: string[] = [];
  try {
    files = fs.readdirSync(bp.knowledgeDir).filter((f) => f.endsWith('.md'));
  } catch {
    // No knowledge files yet.
  }
  if (files.length) parts.push(`Knowledge files you may read, written at the first read (the board's numbers above are newer): ${files.map((f) => path.relative(bp.root, path.join(bp.knowledgeDir, f))).join(', ')}`);
  return parts.join('\n\n');
}
