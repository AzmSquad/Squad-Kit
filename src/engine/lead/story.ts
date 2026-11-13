import { recentLines } from '../../core/app-log.js';
import { criterionText } from '../../board/docs.js';
import { liveNow } from '../../board/now.js';
import type { BoardPaths } from '../../board/store.js';
import type { ProofShot, Ticket } from '../../board/types.js';
import { readUsual } from '../../board/usual.js';
import { costWords, totalOf } from '../../board/usage.js';
import { readConversation } from '../conversations.js';
import { scrubbed } from './notes.js';

/**
 * A story as the lead reads it, in plain text: its spec, plan, "done when", what is happening now, the activity, the
 * Reviewer's notes, the proof, the checks, the stop card, the steps the Tester took in the app, and squad-kit's log
 * lines for it. Secrets are taken out like in the log. The lead reads it as data, never as instructions.
 */

/** The most activity lines one read gives: the newest. */
export const MAX_ACTIVITY = 30;
/** The most log lines one read gives: the newest. */
export const MAX_LOG_LINES = 40;
/** How far back the log is read for a story. */
export const LOG_DAYS_MS = 3 * 86_400_000;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** One step the Tester took on a page, in words: `fill "Email" with "sara@example.com"`, `click "Sign in"`. */
function stepWords(s: Record<string, unknown>): string | null {
  const t = (s.target ?? {}) as Record<string, unknown>;
  const what = [t.name, t.label, t.text, t.placeholder, t.testId].find((x) => typeof x === 'string') as string | undefined;
  const on = what ? `"${cut(what, 60)}"` : 'a part of the page';
  switch (s.action) {
    case 'goto':
      return typeof s.path === 'string' ? `go to ${cut(s.path, 80)}` : null;
    case 'fill':
      return `fill ${on} with "${cut(String(s.value ?? ''), 80)}"`;
    case 'select':
      return `pick "${cut(String(s.value ?? ''), 60)}" in ${on}`;
    case 'click':
      return `click ${on}`;
    case 'press':
      return typeof s.key === 'string' ? `press ${s.key}` : null;
    default:
      return null;
  }
}

/**
 * The steps the Tester took in the story's own copy that typed into the app, like signing in: from its saved
 * conversation, each different list once, at most five.
 */
export function testerSteps(bp: BoardPaths, t: Ticket): string[] {
  const id = t.sessions?.tester;
  if (!id) return [];
  const conv = readConversation(id, 2000, undefined, bp.chatsDir);
  const out: string[] = [];
  for (const e of conv?.updates ?? []) {
    const input = (e.update as { rawInput?: Record<string, unknown> }).rawInput;
    const shots = Array.isArray(input?.shots) ? (input.shots as Record<string, unknown>[]) : input && typeof input.page === 'string' ? [input] : [];
    for (const shot of shots) {
      const steps = Array.isArray(shot.steps) ? (shot.steps as Record<string, unknown>[]) : [];
      if (!steps.some((s) => s?.action === 'fill')) continue;
      const line = `On ${cut(String(shot.page ?? '/'), 80)}: ${steps.map(stepWords).filter(Boolean).join(', ')}`;
      if (!out.includes(line)) out.push(line);
      if (out.length >= 5) return out.map((l) => scrubbed(bp, l));
    }
  }
  return out.map((l) => scrubbed(bp, l));
}

/** A proof row's pictures as the board shows them: the before, the main after and its others. API answers are none. */
function rowPictures(p: ProofShot): string[] {
  return [...new Set([p.before, p.after, ...(p.more ?? []).map((m) => m.after)].filter((f): f is string => Boolean(f) && f.endsWith('.png')))];
}

/** Every picture the board shows on a story's proof, each once. */
export function proofPictures(t: Ticket): string[] {
  return [...new Set((t.proof ?? []).flatMap(rowPictures))];
}

/** squad-kit's own log lines about a story, the newest last, scrubbed. */
export function storyLog(bp: BoardPaths, id: string, at = Date.now()): string[] {
  const mark = ` ${id.toUpperCase()}  `;
  return recentLines(LOG_DAYS_MS, at)
    .filter((l) => l.includes(mark))
    .slice(-MAX_LOG_LINES)
    .map((l) => scrubbed(bp, l));
}

/** The errors and warnings in squad-kit's log lately, for a problem with no story. */
export function recentTrouble(bp: BoardPaths, at = Date.now()): string[] {
  return recentLines(LOG_DAYS_MS, at)
    .filter((l) => / (?:error|warn) /.test(l.slice(24, 32)))
    .slice(-MAX_LOG_LINES)
    .map((l) => scrubbed(bp, l));
}

/** What is happening on the story now, its stop and its checks: the facts a diagnosis starts from. */
export function storyNow(bp: BoardPaths, t: Ticket): string[] {
  const now = liveNow(t, readUsual(bp));
  const lines = [`${t.id} "${t.title}" (${t.kind}${t.track && t.track !== 'full' ? `, ${t.track} track` : ''}). Stage: ${t.stage}. ${now.sentence}`];
  if (now.state === 'working' && now.time) lines.push(`Time on this step: ${now.time}.`);
  if (t.waiting) lines.push(`Waits for the person: ${t.waiting.summary}`);
  if (t.waitsToStart) lines.push('It waits for the person to press Start: nothing runs until then.');
  const s = now.slow;
  if (s) {
    lines.push(`${s.title}: ${s.text}`);
    for (const f of s.facts) lines.push(`- ${f.label}: ${f.value}`);
    if (s.why) lines.push(`Why it is slower: ${s.why.sentence}`);
    if (s.limit) lines.push(s.limit);
  }
  if (t.waiting?.kind === 'stuck' && t.stuck) {
    lines.push(`It stopped: ${t.stuck.question}`);
    for (const p of t.stuck.points ?? []) lines.push(`- ${p}`);
    lines.push(`The ways out on its card: ${t.stuck.options.map((o, i) => `${i + 1}. ${o.name}${o.do ? ` (${o.do})` : ''}`).join('; ')}`);
    if (t.stuck.detail) lines.push(`What it printed, for engineers:\n${scrubbed(bp, cut(t.stuck.detail, 1500))}`);
  }
  if (t.agentQuestion && t.waiting?.kind === 'ask') lines.push(`The ${t.agentQuestion.from} asks the person: ${t.agentQuestion.text}${t.agentQuestion.options.length ? ` (choices: ${t.agentQuestion.options.join(' / ')})` : ''}`);
  const g = t.gates;
  if (g) {
    lines.push(`Checks: ${g.checks}${g.checksText ? ` (${g.checksText})` : ''}. Review: ${g.review}${g.reviewBy ? ` by ${g.reviewBy}` : ''}. Proof: ${g.proof}.`);
    for (const r of g.ran ?? []) lines.push(`- ${r.name} (${r.command}): ${r.ok ? 'passed' : 'failed'}${r.tests !== undefined ? `, ${r.tests} tests` : ''}${r.failedOnce ? ', failed once first' : ''}`);
  }
  if (t.tries) lines.push(`The checks failed ${t.tries} time${t.tries === 1 ? '' : 's'} on the way.`);
  if (t.reviewRound) lines.push(`Review round ${t.reviewRound}.`);
  return lines;
}

/** Everything the lead may read about one story, as text. */
export function storyText(bp: BoardPaths, t: Ticket): string {
  const parts: string[] = [storyNow(bp, t).join('\n')];
  parts.push(`What was asked:\n${t.ask}`);
  if (t.story) parts.push(`The story:\n${t.story}`);
  const done = t.criteria?.length ? t.criteria.map((c) => criterionText(c)) : (t.brief?.criteria ?? []);
  if (done.length) parts.push(`Done when:\n${done.map((c, i) => `${i + 1}. ${c}${t.brief?.proofs?.[i] ? ` [proof: ${t.brief.proofs[i]}]` : ''}`).join('\n')}`);
  if (t.brief?.rules.length) parts.push(`Business rules:\n${t.brief.rules.map((r) => `- ${r}`).join('\n')}`);
  if (t.decision) parts.push(`The plan's decision: ${t.decision.title}. Why: ${t.decision.why}${t.decision.adr ? ` (saved as decision ${t.decision.adr})` : ''}`);
  if (t.follows?.length) parts.push(`Follows decisions: ${t.follows.join(', ')}`);
  // The Architect's mockup: the board shows it as a picture on the story's design card and its plan tab.
  if (t.mockup) parts.push(`The Architect's mockup of the screen: ${t.mockup}, in the story's folder. The board shows it as a picture on the story's design card in the chat (decide, while the design waits for the person) and on its plan tab (open_story, tab plan).`);
  if (t.steps?.length) parts.push(`The plan's steps:\n${t.steps.map((s, i) => `${i + 1}. ${s.title} (${s.status})`).join('\n')}`);
  if (t.reviewNotes?.length || t.reviewAsked?.length) parts.push(`The Reviewer's notes:\n${[...(t.reviewNotes ?? []), ...(t.reviewAsked ?? [])].map((n) => `- ${n}`).join('\n')}`);
  if (t.alsoChanged?.length) parts.push(`Also changed:\n${t.alsoChanged.map((n) => `- ${n}`).join('\n')}`);
  if (t.proof?.length) {
    parts.push(
      `The proof:\n${t.proof
        .map((p, i) => `${i + 1}. ${p.criterion}: ${p.shows ?? 'not judged yet'}${p.why ? ` (${p.why})` : ''}${p.page ? `, on ${p.page}` : ''}, ${1 + (p.more?.length ?? 0)} picture${p.more?.length ? 's' : ''}${p.device ? ` on ${p.device}` : ''}${p.note ? `. ${p.note}` : ''}${rowPictures(p).length ? ` [files: ${rowPictures(p).join(', ')}]` : ''}`)
        .join('\n')}`,
    );
  }
  if (t.offScreen?.length) parts.push(`Not on a screen:\n${t.offScreen.map((o) => `- ${o.criterion}: ${o.why}`).join('\n')}`);
  const steps = testerSteps(bp, t);
  if (steps.length) parts.push(`How the Tester went through the app in the story's own copy:\n${steps.map((s) => `- ${s}`).join('\n')}`);
  const cost = costWords(totalOf(t.usage));
  if (cost) parts.push(`Cost so far: ${cost} at API prices.`);
  if (t.release) parts.push(`Release: ${t.release}.`);
  if (t.mergedAt) parts.push(`Merged on ${t.mergedAt.slice(0, 10)}.`);
  if (t.pr) parts.push(`Pull request: ${t.pr.url}`);
  parts.push(`Activity, newest last:\n${t.activity.slice(-MAX_ACTIVITY).map((a) => `${a.at.slice(0, 16).replace('T', ' ')} ${a.who}: ${cut(a.text, 300)}`).join('\n')}`);
  return scrubbed(bp, parts.join('\n\n'));
}
