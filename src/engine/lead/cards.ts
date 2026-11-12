import { plainArabic } from '../../board/ask.js';
import { addNote, answerAgent, BoardActionError, createTicket, decideStuckBeside, keepWaiting, restartStep, startTicket, stopTicket } from '../../board/actions.js';
import { findApp } from '../../board/apps.js';
import { addActivity, readMeta, readTicket, requireTicket, updateTicket, type BoardPaths } from '../../board/store.js';
import { saveSettings, type SettingsInput } from '../../board/settings.js';
import type { Ticket } from '../../board/types.js';
import { appRunner } from '../run-app.js';
import { getToolNow, updateToolNow } from '../tools/index.js';
import { ACTIONS, ENGINEERS_ONLY, SETTINGS, isAllowable, isEngineer, neverAction, type Never } from './can.js';
import { MAX_LEAD_CARDS } from './limits.js';
import { engineerReport } from './report.js';
import { allowAlways, requireConversation, updateConversation, saveLeadRules } from './store.js';
import type { DoneWhen, LeadAction, LeadCard, LeadConversation, ProofKind, StoryTab } from './types.js';

/**
 * The lead's cards. Level 1 only writes text (a report for an engineer) or opens a story on the board. Level 2 runs an existing board action through
 * the same function as the board's own button, and only when the person presses it, or when "Always allow" is on for
 * one of the four low-risk actions. Anything else an agent hands in as a card is refused in squad-kit's own words.
 */

/** A card as the agent hands it in, before squad-kit checks it. */
export interface CardInput {
  kind?: unknown;
  why?: unknown;
  title?: unknown;
  ask?: unknown;
  storyKind?: unknown;
  doneWhen?: unknown;
  warnings?: unknown;
  action?: unknown;
  story?: unknown;
  minutes?: unknown;
  app?: unknown;
  tool?: unknown;
  tab?: unknown;
  text?: unknown;
  setting?: unknown;
  value?: unknown;
}

const PROOFS: ProofKind[] = ['screen', 'api', 'data', 'test'];

/** The board actions that act on one story. */
const ON_A_STORY: LeadAction[] = ['more_time', 'pictures_again', 'try_again', 'restart', 'stop', 'start_story', 'stop_story', 'engineer'];

const TABS: StoryTab[] = ['proof', 'spec', 'plan', 'questions'];

const str = (v: unknown, n = 2000) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

/** The terminal command that presses a card. */
export function cardCommand(id: string, always = false): string {
  return `squad lead run ${id}${always ? ' --always' : ''}`;
}

/** A board action as a card, made by squad-kit itself or from what the agent handed in. */
export function actionCard(id: string, action: LeadAction, o: { story?: string; minutes?: number; app?: string; tool?: string; why?: string } = {}): LeadCard {
  const a = ACTIONS[action];
  const label = action === 'more_time' ? `Give it ${o.minutes ?? 10} more minutes` : a.label;
  return {
    id,
    kind: 'board_action',
    level: 2,
    action,
    label,
    command: cardCommand(id),
    status: 'open',
    ...(o.story ? { story: o.story } : {}),
    ...(o.minutes ? { minutes: o.minutes } : {}),
    ...(o.app ? { app: o.app } : {}),
    ...(o.tool ? { tool: o.tool } : {}),
    ...(o.why ? { why: o.why } : {}),
    ...(isAllowable(action) ? { allowAlways: true } : {}),
  };
}

/** The tab a story's own wait is about: its proof, its spec, its plan or its questions. */
export function waitTab(t: Ticket): StoryTab | undefined {
  return TABS.find((x) => x === t.waiting?.kind);
}

/**
 * Where the board opens a story at a tab, the same places as its own buttons: a proof that waits for Looks right on
 * its proof page; what waits for the person, its questions and a stop at the proof in the story's Now tab, with their
 * buttons; the rest in their own tab (the spec is the Story tab).
 */
export function openPlace(t: Ticket, tab?: StoryTab): string {
  const id = encodeURIComponent(t.id);
  if (tab === 'proof' && t.waiting?.kind === 'proof') return `/tickets/${id}/proof`;
  const now = !tab || tab === 'questions' || waitTab(t) === tab || (tab === 'proof' && t.waiting?.kind === 'stuck' && t.stuck?.gate === 'proof');
  return `/board?ticket=${id}${now ? '' : `&tab=${tab === 'spec' ? 'story' : tab}`}`;
}

/** "Open MA-17's proof": a story on the board, at its tab. It changes nothing, so it needs no OK. */
export function openCard(id: string, t: Ticket, tab?: StoryTab, why?: string): LeadCard {
  return {
    id,
    kind: 'open_story',
    level: 1,
    story: t.id,
    ...(tab ? { tab } : {}),
    open: openPlace(t, tab),
    label: `Open ${t.id}${tab ? `'s ${tab}` : ''}`,
    command: `squad show ${t.id}`,
    status: 'open',
    ...(why ? { why } : {}),
  };
}

/** The card, or the "never" it falls under, or why it was left out (it is no card squad-kit has, or not for this person). */
export function makeCard(bp: BoardPaths, raw: CardInput, id: string, role?: string): { card: LeadCard } | { refused: Never } | { left: string } {
  const kind = str(raw.kind, 60).toLowerCase().replace(/[\s-]+/g, '_');
  const why = str(raw.why, 300);
  const base = { id, command: cardCommand(id), status: 'open' as const, ...(why ? { why } : {}) };
  if (kind === 'draft_story' || kind === 'story' || kind === 'bug' || kind === 'draft_bug') {
    const doneWhen: DoneWhen[] = (Array.isArray(raw.doneWhen) ? raw.doneWhen : [])
      .map((d) => ({ text: str((d as { text?: unknown })?.text, 300), proof: PROOFS.find((p) => p === (d as { proof?: unknown })?.proof) ?? 'screen' }))
      .filter((d) => d.text)
      .slice(0, 8);
    const title = str(raw.title, 120);
    if (!title || !doneWhen.length) return { left: 'a story draft with no title or "done when"' };
    const storyKind = raw.storyKind === 'bug' || kind === 'bug' || kind === 'draft_bug' ? 'bug' : 'feature';
    const warnings = (Array.isArray(raw.warnings) ? raw.warnings : []).map((w) => str(w, 300)).filter(Boolean).slice(0, 4);
    return { card: { ...base, kind: 'draft_story', level: 2, label: 'Create story', title, ask: str(raw.ask, 2000) || title, storyKind, doneWhen, warnings } };
  }
  if (kind === 'board_action' || kind === 'action') {
    const name = str(raw.action, 60).toLowerCase().replace(/[\s-]+/g, '_');
    if (!(name in ACTIONS)) {
      const never = neverAction(name);
      return never ? { refused: never } : { left: `"${name.slice(0, 40)}" is not a board action` };
    }
    const action = name as LeadAction;
    const story = str(raw.story, 40).toUpperCase();
    if (ON_A_STORY.includes(action) && !(story && readTicket(bp, story))) return { left: `${ACTIONS[action].name.toLowerCase()} names no story on this board` };
    const tool = str(raw.tool, 40).toLowerCase();
    if ((action === 'get_tool' || action === 'update_tool') && !tool) return { left: `${ACTIONS[action].name.toLowerCase()} names no tool` };
    const minutes = typeof raw.minutes === 'number' && raw.minutes >= 1 && raw.minutes <= 120 ? Math.round(raw.minutes) : undefined;
    return { card: actionCard(id, action, { ...(ON_A_STORY.includes(action) ? { story } : {}), ...(action === 'more_time' ? { minutes: minutes ?? 10 } : {}), ...(str(raw.app, 80) ? { app: str(raw.app, 80) } : {}), ...(tool ? { tool } : {}), ...(why ? { why } : {}) }) };
  }
  if (kind === 'send_answer' || kind === 'answer') {
    const story = str(raw.story, 40).toUpperCase();
    const text = str(raw.text, 2000);
    if (!story || !readTicket(bp, story) || !text) return { left: "an answer with no story or no words" };
    return { card: { ...base, kind: 'send_answer', level: 2, label: 'Send', story, text } };
  }
  if (kind === 'settings_change' || kind === 'setting') {
    const setting = str(raw.setting, 60);
    const value = str(raw.value, 400);
    const known = SETTINGS[setting];
    if (!known) return { refused: neverAction(setting) === 'secrets' ? 'secrets' : 'around' };
    if (known.values && !known.values.includes(value)) return { left: `"${value.slice(0, 40)}" is not a value of ${known.name.toLowerCase()}` };
    // A technical setting is only offered to an engineer: a project manager is never asked a technical question.
    if (known.technical && !isEngineer(role ?? readMeta(bp).user.role)) return { left: 'a technical setting, which only an engineer changes' };
    return { card: { ...base, kind: 'settings_change', level: 2, label: 'Save', setting, value, technical: known.technical } };
  }
  if (kind === 'open_story' || kind === 'open') {
    const story = str(raw.story, 40).toUpperCase();
    const t = story ? readTicket(bp, story) : null;
    if (!t) return { left: 'an Open card names no story on this board' };
    return { card: openCard(id, t, TABS.find((x) => x === str(raw.tab, 20).toLowerCase()) ?? waitTab(t), why) };
  }
  if (kind === 'engineer_report' || kind === 'report') {
    return { card: { ...base, kind: 'engineer_report', level: 1, label: 'Prepare a report for an engineer' } };
  }
  const never = neverAction(kind) ?? neverAction(str(raw.action, 60));
  return never ? { refused: never } : { left: `"${kind.slice(0, 40)}" is not a card squad-kit has` };
}

/** The story a card is for, when it is for one. */
export function cardStory(card: LeadCard): string | undefined {
  return card.kind === 'board_action' || card.kind === 'send_answer' || card.kind === 'open_story' ? card.story : undefined;
}

/** A story's id in an answer's words: MA-17, never a decision like MA-17.1. */
const STORY_ID = /\b[A-Z][A-Z0-9]*-\d+\b(?!\.\d)/g;

/** Words that send the person somewhere on the board: open it, press, accept, review, answer. Arabic as plainArabic writes it. */
const SENDS = /\b(?:open|press|click|tap|accept|approve|review|check|look at|go to|answer|decide|reply|start|send (?:it )?back)\b|looks right|(?:^|\s)[وف]?(?:افتح|اضغط|انقر|راجع|اقبل|وافق|اعتمد|ادخل|اذهب|شوف|تحقق|افحص|جاوب|اجب)/i;

/** The tab a sentence is about, by its words. */
const TAB_WORDS: [StoryTab, RegExp][] = [
  ['proof', /\b(?:proof|pictures?|screenshots?|looks right|accept)\b|اثبات|صور|لقطات/i],
  ['plan', /\b(?:plan|design)\b|الخطه|التصميم/i],
  ['spec', /\b(?:spec|specification|done when)\b|مواصفات/i],
  ['questions', /\bquestions?\b|اسئله/i],
];

/**
 * Open cards for the stories an answer sends the person to, so each is one press away: a story it names that waits for
 * the person, one a sentence tells them to open, press or decide on, or any story it names when something only the
 * person may do was refused. A story a card is already for is left out, and the answer keeps at most MAX_LEAD_CARDS.
 */
export function openCardsFor(bp: BoardPaths, words: string, have: LeadCard[], prefix: string, o: { refused?: boolean; also?: string[] } = {}): LeadCard[] {
  const covered = new Set(have.map(cardStory));
  const sentences = words.split(/(?<=[.!?؟])\s+|\n+/).map((x) => plainArabic(x));
  const named = [...new Set([...(o.also ?? []), ...(words.match(STORY_ID) ?? [])])];
  const out: LeadCard[] = [];
  for (const id of named) {
    if (have.length + out.length >= MAX_LEAD_CARDS) break;
    if (covered.has(id)) continue;
    const t = readTicket(bp, id);
    if (!t) continue;
    const said = sentences.filter((x) => x.includes(id));
    if (!t.waiting && !o.refused && !said.some((x) => SENDS.test(x))) continue;
    out.push(openCard(`${prefix}.${out.length + 1}`, t, waitTab(t) ?? TAB_WORDS.find(([, re]) => said.some((x) => re.test(x)))?.[0]));
    covered.add(id);
  }
  return out;
}

/** The cards that fit a story where it stands now, for the lead's read of it. */
export function fitsNow(t: Ticket): string {
  const actions = ON_A_STORY.filter((a) => !actionMisfit(t, a));
  const tab = waitTab(t);
  return `Cards for ${t.id} now: open_story${tab ? ` (tab ${tab})` : ''}${actions.length ? `; board_action ${actions.join(', ')}` : '; no board action fits it now'}.`;
}

/**
 * The real ways out of where a story stands, as cards, the safest first: more time for a slow step, Try again or the
 * pictures again on a stop. The person's other choices stay on the story's own card.
 */
export function waysOut(t: Ticket, prefix: string): LeadCard[] {
  const out: LeadCard[] = [];
  const add = (action: LeadAction, why: string, o: { minutes?: number } = {}) => out.push(actionCard(`${prefix}.${out.length + 1}`, action, { story: t.id, why, ...o }));
  if (t.waitsToStart) add('start_story', 'It waits for you to start it.');
  if (t.quiet?.kind === 'long') add('more_time', 'It is slower than usual but still working.', { minutes: 10 });
  if (t.quiet) add('restart', 'The step stops, then starts again at once. The work so far is kept.');
  if (t.waiting?.kind === 'stuck' && t.stuck) {
    const retry = t.stuck.options.some((o) => o.do === 'retry');
    if (retry) add(t.stuck.gate === 'proof' && t.stuck.kind !== 'broken' ? 'pictures_again' : 'try_again', t.stuck.options.find((o) => o.do === 'retry')?.note ?? 'Runs the same step again.');
    if (t.stuck.options.some((o) => o.do === 'engineer')) add('engineer', 'The story waits here, with what it printed in the details.');
  }
  return out;
}

/** Why a board action does not fit where the story stands now, or null when it does. */
export function actionMisfit(t: Ticket, action: LeadAction): string | null {
  const running = Boolean(t.live || t.squad);
  const retry = t.waiting?.kind === 'stuck' && Boolean(t.stuck?.options.some((o) => o.do === 'retry'));
  switch (action) {
    case 'more_time':
      return running || t.quiet ? null : `${t.id} is not running now`;
    case 'restart':
    case 'stop':
    case 'stop_story':
      return running && !t.waiting ? null : `${t.id} is not running now`;
    case 'start_story':
      return t.waitsToStart ? null : `${t.id} does not wait to be started`;
    case 'try_again':
      return retry ? null : `${t.id} has no Try again now`;
    case 'pictures_again':
      return retry && t.stuck?.gate === 'proof' ? null : `${t.id} does not wait for new pictures`;
    case 'engineer':
      return t.waiting?.kind === 'stuck' && t.stuck?.options.some((o) => o.do === 'engineer') ? null : `${t.id} has no "Let an engineer look" now`;
    default:
      return null;
  }
}

/** Finds a card in its conversation. */
function findCard(c: LeadConversation, id: string): LeadCard | undefined {
  for (const t of c.turns) for (const card of t.answer?.cards ?? []) if (card.id === id) return card;
  return undefined;
}

/** The choice on a story's stop card that does this, by its `do`. */
function choiceOf(t: Ticket, does: 'retry' | 'engineer', action: string): number {
  const i = t.waiting?.kind === 'stuck' ? (t.stuck?.options.findIndex((o) => o.do === does) ?? -1) : -1;
  if (i < 0) throw new BoardActionError(`${t.id} has no "${ACTIONS[action as LeadAction].name}" now: it moved on since the lead looked.`);
  return i;
}

/** Edits the person made to a card before pressing it: a draft's words, or an answer's. */
export interface CardEdits {
  title?: string;
  ask?: string;
  doneWhen?: DoneWhen[];
  text?: string;
}

/** Runs one card through the board's own function, and says what it did. */
export async function doCard(bp: BoardPaths, card: LeadCard, o: { conversation?: string; edits?: CardEdits } = {}): Promise<{ result: string; story?: string; report?: string }> {
  const e = o.edits ?? {};
  switch (card.kind) {
    case 'draft_story': {
      const doneWhen = (e.doneWhen?.length ? e.doneWhen : card.doneWhen).filter((d) => d.text?.trim());
      const t = createTicket(bp, {
        title: e.title?.trim() || card.title,
        ask: e.ask?.trim() || card.ask,
        kind: card.storyKind,
        criteria: doneWhen.map((d) => d.text),
        proofs: doneWhen.map((d) => (PROOFS.includes(d.proof) ? d.proof : 'screen')),
        waitsToStart: true,
        key: card.id,
      });
      updateTicket(bp, t.id, (x) => {
        if (o.conversation) x.lead = o.conversation;
        addActivity(x, 'you', 'Made it from a conversation with the Squad lead. Nothing starts until you press Start');
      });
      for (const w of card.warnings) addNote(bp, t.id, { text: w, kind: 'note' });
      return { result: `Created ${t.id}. Nothing starts until you press Start.`, story: t.id };
    }
    case 'board_action':
      return { result: await doAction(bp, card.action, card) };
    case 'send_answer':
      answerAgent(bp, card.story, e.text?.trim() || card.text);
      return { result: `Sent your answer to ${card.story}.` };
    case 'settings_change': {
      const known = SETTINGS[card.setting];
      if (!known) throw new BoardActionError('squad-kit does not change this setting from a card.');
      if (known.technical && !isEngineer(readMeta(bp).user.role)) throw new BoardActionError(ENGINEERS_ONLY);
      saveSettings(bp, settingInput(bp, card.setting, card.value));
      return { result: `Saved: ${known.name.toLowerCase()} is now ${card.value}.` };
    }
    case 'open_story':
      return { result: `It opens on the board: ${card.open}. In the terminal: ${card.command}` };
    case 'engineer_report': {
      if (!o.conversation) throw new BoardActionError('A report needs the conversation it is about.');
      const report = engineerReport(bp, requireConversation(bp, o.conversation));
      return { result: 'The report is ready to copy. Nothing was sent.', report };
    }
  }
}

/** A setting from a card, in the shape Settings saves. */
function settingInput(bp: BoardPaths, setting: string, value: string): SettingsInput {
  if (setting === 'quality') return { quality: value };
  const key = setting.replace(/^commands\./, '');
  return { commands: { ...(readMeta(bp).commands ?? {}), [key]: value } };
}

async function doAction(bp: BoardPaths, action: LeadAction, card: { story?: string; minutes?: number; app?: string; tool?: string }): Promise<string> {
  const t = card.story ? requireTicket(bp, card.story) : undefined;
  switch (action) {
    case 'more_time':
      keepWaiting(bp, t!.id, card.minutes ?? 10);
      return `Gave ${t!.id} ${card.minutes ?? 10} more minutes. The step still stops at its own limit.`;
    case 'pictures_again':
      if (t!.stuck?.gate !== 'proof') throw new BoardActionError(`${t!.id} does not wait for new pictures now.`);
      await decideStuckBeside(bp, t!.id, choiceOf(t!, 'retry', action));
      return `The Tester takes ${t!.id}'s pictures again. Nothing is rebuilt.`;
    case 'try_again':
      await decideStuckBeside(bp, t!.id, choiceOf(t!, 'retry', action));
      return `${t!.id} runs the same step again.`;
    case 'engineer':
      await decideStuckBeside(bp, t!.id, choiceOf(t!, 'engineer', action));
      return `${t!.id} waits for an engineer to look.`;
    case 'restart':
      restartStep(bp, t!.id);
      return `${t!.id} stops, then tries the step again. The work so far is kept.`;
    case 'stop':
    case 'stop_story':
      stopTicket(bp, t!.id);
      return `${t!.id} is stopping. Everything done so far is kept.`;
    case 'start_story':
      startTicket(bp, t!.id);
      return `${t!.id} started: the Analyst reads it first.`;
    case 'start_app': {
      const app = findApp(readMeta(bp), card.app);
      const s = await appRunner(bp).startAs(app.name);
      return `${app.name} is ${s.state === 'running' ? `running at ${s.url}` : 'starting'}.`;
    }
    case 'get_tool':
      getToolNow(card.tool ?? '');
      return `squad-kit is getting ${card.tool}. The Tools page shows how it goes.`;
    case 'update_tool':
      await updateToolNow(bp, card.tool ?? '', { ok: true });
      return `squad-kit is updating ${card.tool}. The Tools page shows how it goes.`;
    case 'morning_brief':
      saveLeadRules(bp, { brief: true });
      return 'The morning brief is on: it shows under "This morning" each day.';
  }
}

/**
 * The person pressed a card: it runs once, through the board's own function. `always` turns "Always allow" on for its
 * action first, only where that is allowed. `dismiss` is Not now or Discard. A card on the "Needs you" rail is found by
 * `find`, from the board's state now.
 */
export async function runCard(
  bp: BoardPaths,
  id: string,
  o: { always?: boolean; dismiss?: boolean; edits?: CardEdits; find?: (id: string) => LeadCard | undefined } = {},
): Promise<{ card: LeadCard; conversation?: string }> {
  const rail = id.startsWith('now.');
  const conversationId = rail ? undefined : id.split('.')[0]!;
  const card = rail ? o.find?.(id) : findCard(requireConversation(bp, conversationId!), id);
  if (!card) throw new BoardActionError(rail ? 'That card is gone: the story moved on.' : `There is no card "${id.slice(0, 60)}".`);
  // An Open card only shows a place on the board: it stays as it is, to open again.
  if (card.kind === 'open_story') return { card: { ...card, result: (await doCard(bp, card)).result }, ...(conversationId ? { conversation: conversationId } : {}) };
  if (card.status === 'done' && card.kind !== 'engineer_report') throw new BoardActionError('This card was already used.');
  if (card.status === 'dismissed' && !o.dismiss) throw new BoardActionError('This card was put aside.');
  if (o.always) {
    if (card.kind !== 'board_action' || !card.allowAlways || !isAllowable(card.action)) throw new BoardActionError('"Always allow" is only for giving more time, taking the pictures again, starting the app and the morning brief. This one asks you each time.');
    allowAlways(bp, card.action);
  }
  let next: LeadCard;
  if (o.dismiss) next = { ...card, status: 'dismissed' };
  else {
    try {
      const done = await doCard(bp, card, { ...(conversationId ? { conversation: conversationId } : {}), ...(o.edits ? { edits: o.edits } : {}) });
      next = { ...card, status: 'done', result: done.result, ...(done.story && card.kind === 'draft_story' ? { story: done.story } : {}), ...(done.report && card.kind === 'engineer_report' ? { report: done.report } : {}) };
    } catch (err) {
      if (conversationId) saveCard(bp, conversationId, { ...card, result: (err as Error).message });
      throw err;
    }
  }
  if (conversationId) {
    saveCard(bp, conversationId, next);
    if (next.kind === 'draft_story' && next.story) updateConversation(bp, conversationId, (c) => (c.story = next.kind === 'draft_story' ? next.story : c.story));
  }
  return { card: next, ...(conversationId ? { conversation: conversationId } : {}) };
}

function saveCard(bp: BoardPaths, conversation: string, card: LeadCard): void {
  updateConversation(bp, conversation, (c) => {
    for (const t of c.turns) if (t.answer) t.answer.cards = t.answer.cards.map((x) => (x.id === card.id ? card : x));
  });
}
