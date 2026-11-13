import kleur from 'kleur';
import { buildPaths, requireSquadRoot } from '../core/paths.js';
import { openBoard } from '../board/move.js';
import { boardExists, readTicket, type BoardPaths } from '../board/store.js';
import { askLead } from '../engine/lead/ask.js';
import { morningBrief } from '../engine/lead/brief.js';
import { ACTIONS, ALLOWABLE, leadCan } from '../engine/lead/can.js';
import { cardCommand, runCard } from '../engine/lead/cards.js';
import { MAX_LEAD_DAY_USD } from '../engine/lead/limits.js';
import { needsYou, squadNow } from '../engine/lead/needs-you.js';
import { leadRules, listConversations, readConversation, requireConversation, saveLeadRules, spentToday, summaryOf } from '../engine/lead/store.js';
import type { LeadCard, LeadContext, LeadConversation, LeadStep, LeadSummary, LeadTurn, MorningBrief, NeedsYouItem, SquadNowItem } from '../engine/lead/types.js';
import { boardApi, type BoardApi } from './app.js';
import { splitLines } from './split.js';

/**
 * The Squad lead in the terminal, the same as on the board: `squad ask "<question>"` prints the work trace as it goes,
 * then the answer and the cards with their commands; `squad lead` lists the conversations, what needs you and the squad
 * now; `squad lead run <card>` presses a card. With the board open, each is the board's own REST call, so both show
 * the same conversation; without it, squad-kit answers here.
 */

const out = (s = '') => process.stdout.write(`${s}\n`);
const cmd = (s: string) => kleur.green(s);
const grey = (s: string) => kleur.gray(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function board(): BoardPaths {
  const { bp } = openBoard(buildPaths(requireSquadRoot()).squadDir);
  if (!boardExists(bp)) throw new Error('This project has no board yet. Run: squad console');
  return bp;
}

export interface AskCliOptions {
  story?: string;
  page?: string;
  /** The app the page is in, when the project has several. */
  app?: string;
  /** A follow-up in this conversation. */
  in?: string;
  fresh?: boolean;
}

/** Where it was asked from, from the flags. */
function contextOf(o: AskCliOptions): LeadContext | undefined {
  if (o.story) return { from: 'story', story: o.story.toUpperCase() };
  if (o.page) return { from: 'app', path: o.page, ...(o.app ? { app: o.app } : {}) };
  return o.in ? undefined : { from: 'board' };
}

function cost(n: number | undefined): string {
  if (n === undefined) return 'cost not reported';
  return n < 0.005 ? 'under $0.01' : `$${n.toFixed(2)}`;
}

/** A card with the command that presses it. */
export function cardLines(card: LeadCard): string[] {
  const level = card.level === 1 ? 'On its own' : 'Needs your OK';
  const what =
    card.kind === 'draft_story' ? (card.split?.size === 'brd' ? `Too big for one story: ${card.title}` : card.split ? `Split into ${card.split.parts.length} stories: ${card.title}` : `Story draft (${card.storyKind}): ${card.title}`)
    : card.kind === 'requirements' ? 'Too big for one story: send it to Requirements'
    : card.kind === 'board_action' ? `${ACTIONS[card.action].name}${card.story ? ` on ${card.story}` : ''}`
    : card.kind === 'send_answer' ? `Send to ${card.story}: "${card.text}"`
    : card.kind === 'settings_change' ? `Save ${card.setting} = ${card.value}`
    : card.kind === 'open_story' ? card.label
    : card.kind === 'decide' ? `${card.story} waits for you: only you decide it (${card.label})`
    : 'Prepare a report for an engineer';
  const lines = [`  ${kleur.bold(what)}  ${grey(level)}`];
  if (card.why) lines.push(`    ${card.why}`);
  if (card.kind === 'draft_story' && card.split) lines.push(...splitLines(card.split).map((l) => `  ${l}`));
  else if (card.kind === 'draft_story') {
    lines.push(`    ${card.ask}`);
    card.doneWhen.forEach((d, i) => lines.push(`    ${i + 1}. ${d.text} ${grey(`[${d.proof}]`)}`));
    for (const w of card.warnings) lines.push(`    ${kleur.yellow(`! ${w}`)}`);
  }
  if (card.kind === 'requirements' && card.found.length) lines.push(`    ${grey(`squad-kit's own count: ${card.found.join(', ')}`)}`);
  if (card.byItself) lines.push(`    ${kleur.green(card.byItself)}`);
  else if (card.status === 'done') lines.push(`    ${grey(`Done: ${card.result ?? ''}`)}`);
  else if (card.status === 'dismissed') lines.push(`    ${grey('Put aside')}`);
  else {
    if (card.result) lines.push(`    ${kleur.yellow(card.result)}`);
    if (card.kind === 'draft_story' && card.split) lines.push(`    ${cmd(`${card.command} ${card.split.size === 'brd' ? '--requirements' : '--split'}`)}${grey('   or one story: ')}${cmd(`${card.command} --one`)}`);
    else lines.push(`    ${cmd(card.command)}${card.allowAlways ? `${grey('   or always: ')}${cmd(cardCommand(card.id, true))}` : ''}`);
    if (card.asksFirst) lines.push(`    ${grey('It asks first: this came from what the lead read, not from your message.')}`);
  }
  return lines;
}

/** One answer, as the terminal prints it. */
export function turnLines(turn: LeadTurn): string[] {
  const lines: string[] = [];
  const a = turn.answer;
  if (turn.error) return [`  ${kleur.yellow(turn.error)}`];
  if (!a) return [];
  const how = a.by === 'note' ? "from squad-kit's notes, no AI" : a.by === 'record' ? "from the story's live record, no AI" : a.by === 'refusal' ? 'squad-kit refused, no AI' : a.by === 'check' ? "squad-kit's own count, no AI" : a.by === 'limit' ? 'no AI' : `${turn.seconds ?? 0} s, ${cost(turn.costUsd)}${turn.model ? `, ${turn.model}` : ''}`;
  lines.push(`  ${kleur.bold(a.headline)}  ${grey(how)}`);
  for (const l of a.body.split('\n')) lines.push(`  ${l}`);
  for (const e of a.evidence) lines.push(`  ${grey('Picture:')} ${e.caption} ${grey(e.story ? `${e.file}, from ${e.story}'s proof` : e.file)}`);
  if (a.sources.length) lines.push(`  ${grey('Sources:')} ${a.sources.map((s) => `${s.ref}${s.label ? ` (${s.label})` : ''}`).join(', ')}`);
  for (const r of turn.refused) if (r !== a.headline) lines.push(`  ${kleur.yellow(r)}`);
  if (a.learned) lines.push(`  ${grey(`Saved in squad-kit's notes: ${a.learned}`)}`);
  if (a.cards.length) {
    lines.push('');
    for (const c of a.cards) lines.push(...cardLines(c));
  }
  return lines;
}

/** Prints the new lines of the work trace, and the answer once it came. Returns the conversation when it is done. */
async function follow(read: () => Promise<LeadConversation>, n: number): Promise<LeadConversation> {
  let shown = 0;
  for (;;) {
    const c = await read();
    const turn = c.turns.find((t) => t.n === n);
    const trace: LeadStep[] = turn?.trace ?? [];
    for (const s of trace.slice(shown)) out(`  ${grey('·')} ${s.text}`);
    shown = trace.length;
    if (!c.thinking) return c;
    await sleep(700);
  }
}

/** `squad ask "<question>" [--story MA-9] [--page /path]`. The old `squad ask MA-9 <question>` still works. */
export async function runLeadAsk(words: string[], o: AskCliOptions = {}): Promise<void> {
  const bp = board();
  let text = words.join(' ').trim();
  // `squad ask MA-9 is it ready?`: the first word is a story on the board.
  if (!o.story && !o.page && words.length > 1 && /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(words[0]!) && readTicket(bp, words[0]!.toUpperCase())) {
    o = { ...o, story: words[0]! };
    text = words.slice(1).join(' ').trim();
  }
  if (!text) throw new Error('Ask a question, for example: squad ask "How do I sign in to the app?"');
  const context = contextOf(o);
  const api = boardApi(bp);
  out();
  out(`  ${kleur.bold('Squad lead')}  ${grey(text)}`);
  let c: LeadConversation;
  if (api) {
    const payload = { text, ...(context ? { context } : {}), ...(o.fresh ? { fresh: true } : {}) };
    const first = await api.call<LeadConversation>('POST', o.in ? `/lead/conversations/${encodeURIComponent(o.in)}/messages` : '/lead/conversations', payload);
    c = await follow(() => api.call<LeadConversation>('GET', `/lead/conversations/${encodeURIComponent(first.id)}`), first.turns.at(-1)!.n);
  } else {
    const asked = askLead(bp, { text, ...(context ? { context } : {}), ...(o.in ? { conversation: o.in } : {}), fresh: Boolean(o.fresh) });
    const n = asked.conversation.turns.at(-1)!.n;
    const id = asked.conversation.id;
    await follow(async () => readConversation(bp, id) ?? asked.conversation, n);
    await asked.done;
    c = requireConversation(bp, id);
  }
  out();
  for (const l of turnLines(c.turns.at(-1)!)) out(l);
  out();
  out(grey(`  Conversation ${c.id}. Follow up: squad ask --in ${c.id} "..."`));
  out();
}

function summaryLine(s: LeadSummary): string {
  return `  ${s.id}  ${s.title}  ${grey(`${s.updatedAt.slice(0, 16).replace('T', ' ')}, ${s.turns} question${s.turns === 1 ? '' : 's'}, ${cost(s.costUsd)}${s.story ? `, made ${s.story}` : ''}${s.thinking ? ', answering now' : ''}`)}`;
}

function needsLines(items: NeedsYouItem[]): string[] {
  const lines: string[] = [];
  for (const x of items) {
    lines.push(`  ${kleur.bold(x.words)}${x.more ? `  ${grey(x.more)}` : ''}`);
    for (const c of x.cards) {
      if (c.byItself) lines.push(`    ${kleur.green(c.byItself)}`);
      else lines.push(`    ${c.label}: ${cmd(c.command)}${c.allowAlways ? `${grey('   or always: ')}${cmd(cardCommand(c.id, true))}` : ''}`);
    }
  }
  return lines;
}

function nowLines(items: SquadNowItem[]): string[] {
  return items.map((x) => `  ${kleur.bold(x.who)} ${x.story}  ${x.doing}${x.progress !== undefined ? grey(`  ${Math.round(x.progress * 100)}%`) : ''}${x.slow ? kleur.yellow('  slower than usual') : ''}`);
}

function briefLines(b: MorningBrief): string[] {
  return [`  ${kleur.bold('Since yesterday evening')}  ${b.headline}`, grey(`  ${b.merged.length} merged, ${b.working.length} working, ${b.waiting} waiting for you${b.costUsd !== undefined ? `, $${b.costUsd.toFixed(2)} AI used` : ''}`)];
}

/** `squad lead`: the conversations, what needs you, the squad now, and the morning brief when it is on. */
export async function runLead(): Promise<void> {
  const bp = board();
  const api = boardApi(bp);
  type View = { conversations: LeadSummary[]; needsYou: NeedsYouItem[]; squadNow: SquadNowItem[]; brief?: MorningBrief; today: { costUsd: number; limitUsd: number } };
  const v: View = api
    ? await api.call<View>('GET', '/lead')
    : { conversations: listConversations(bp).map(summaryOf), needsYou: needsYou(bp), squadNow: squadNow(bp), ...(leadRules(bp).brief ? { brief: morningBrief(bp) } : {}), today: { costUsd: spentToday(bp), limitUsd: MAX_LEAD_DAY_USD } };
  out();
  if (v.brief) out([...briefLines(v.brief), ''].join('\n'));
  out(kleur.bold(`  Needs you (${v.needsYou.length})`));
  out(v.needsYou.length ? needsLines(v.needsYou).join('\n') : grey('  Nothing waits for you.'));
  out();
  out(kleur.bold('  The squad now'));
  out(v.squadNow.length ? nowLines(v.squadNow).join('\n') : grey('  Nobody is working right now.'));
  out();
  out(kleur.bold('  Conversations'));
  out(v.conversations.length ? v.conversations.map(summaryLine).join('\n') : grey('  None yet. Ask: squad ask "How do I sign in to the app?"'));
  out(grey(`  Today: $${v.today.costUsd.toFixed(2)} of the $${v.today.limitUsd} a day the lead may use.`));
  out();
}

/** `squad lead show <conversation>`. */
export async function runLeadShow(id: string): Promise<void> {
  const bp = board();
  const api = boardApi(bp);
  const c = api ? await api.call<LeadConversation>('GET', `/lead/conversations/${encodeURIComponent(id)}`) : requireConversation(bp, id);
  out();
  out(`  ${kleur.bold(c.title)}  ${grey(c.id)}`);
  for (const t of c.turns) {
    out();
    out(`  ${kleur.bold('You')}  ${t.ask.text}`);
    for (const s of t.trace) out(`  ${grey('·')} ${s.text}`);
    for (const l of turnLines(t)) out(l);
  }
  if (c.thinking) out(grey('\n  The lead is answering now.'));
  out();
}

/** `squad lead run <card> [--always] [--dismiss]`: presses a card, the same as its button. */
export async function runLeadCard(id: string, o: { always?: boolean; dismiss?: boolean; split?: boolean; one?: boolean; requirements?: boolean } = {}): Promise<void> {
  const bp = board();
  const api = boardApi(bp);
  // A story draft that is more than one story: its parts, Requirements, or one story anyway.
  const choice = o.split ? ('split' as const) : o.requirements ? ('requirements' as const) : o.one ? ('one' as const) : undefined;
  const payload = { ...(o.always ? { always: true } : {}), ...(o.dismiss ? { dismiss: true } : {}), ...(choice ? { choice } : {}) };
  const r = api
    ? await api.call<{ card: LeadCard }>('POST', `/lead/cards/${encodeURIComponent(id)}/run`, payload)
    : await runCard(bp, id, { ...payload, find: (x) => needsYou(bp).flatMap((n) => n.cards).find((c) => c.id === x) });
  out();
  if (r.card.status === 'dismissed') out('  Put aside.');
  else out(`  ${kleur.green('✓')} ${r.card.result ?? 'Done.'}`);
  if (r.card.kind === 'engineer_report' && r.card.report) out(`\n${r.card.report}`);
  out();
}

/** `squad lead rules [--always a,b] [--brief on|off]`: "Always allow" and the morning brief; the never list, read only. */
export async function runLeadRules(o: { always?: string; brief?: string } = {}): Promise<void> {
  const bp = board();
  const api: BoardApi | null = boardApi(bp);
  const change: { always?: string[]; brief?: boolean } = {
    ...(o.always !== undefined ? { always: o.always.split(',').map((x) => x.trim()).filter((x) => x && x !== 'none') } : {}),
    ...(o.brief !== undefined ? { brief: /^(on|yes|true)$/i.test(o.brief) } : {}),
  };
  const rules = Object.keys(change).length ? (api ? await api.call<ReturnType<typeof leadRules>>('PUT', '/lead/rules', change) : saveLeadRules(bp, change)) : leadRules(bp);
  const can = leadCan();
  out();
  out(`  ${kleur.bold('Always allow')}  ${rules.always.length ? rules.always.map((a) => ACTIONS[a].name).join(', ') : grey('nothing yet')}`);
  out(grey(`  It can only cover: ${ALLOWABLE.join(', ')}. Change it: squad lead rules --always more_time,start_app`));
  out(`  ${kleur.bold('Morning brief')}  ${rules.brief ? 'on' : 'off'}  ${grey('squad lead rules --brief on')}`);
  out();
  for (const l of can.levels) {
    out(`  ${kleur.bold(l.name)}  ${grey(l.words)}`);
    for (const x of l.items) out(`    - ${x}`);
  }
  out();
}
