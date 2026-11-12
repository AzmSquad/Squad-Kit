import path from 'node:path';
import { BoardActionError } from '../../board/actions.js';
import { answerAsk, isArabic } from '../../board/ask.js';
import { liveNow } from '../../board/now.js';
import { readMeta, type BoardPaths } from '../../board/store.js';
import { readUsual } from '../../board/usual.js';
import { recordUsage } from '../../board/usage.js';
import { writeLog } from '../../core/app-log.js';
import type { AgentResult, ToolEvent } from '../../modules/ai-tool/types.js';
import { AI_TOOLS, aiTool } from '../../modules/registry.js';
import { readAgent } from '../agents.js';
import { describeLevel, effortOn, personLevels, resolveLevel, stepCaps, DEFAULT_QUALITY } from '../levels.js';
import { secretFiles } from '../live.js';
import { ownRunWords } from '../plain-stop.js';
import { agentPrivatePlaces } from '../project-guard.js';
import { PROCESS_RULE, answerAgainPrompt } from '../prompts.js';
import { startPause } from '../usage-limit.js';
import { closeWindow, openWindow, windowAccess } from '../window-server.js';
import { cleanAnswer, laterOffer, leadAnswerProblem, learnedAbout, LEAD_SCHEMA } from './answer.js';
import { AFTER_REFUSAL, NEVER, isAllowable, neverAsked, refusalIn } from './can.js';
import { actionMisfit, cardStory, doCard, openCard, openCardsFor, waitTab, waysOut } from './cards.js';
import { contextFacts, contextStory } from './context.js';
import { LEAD_ANSWER_MS, MAX_LEAD_DAY_USD, MAX_QUESTION_CHARS } from './limits.js';
import { noteFor, saveNote } from './notes.js';
import { leadAppPlan, startLeadApp, stopLeadApp } from './own-app.js';
import { followUpPrompt, leadPrompt, leadRules } from './prompt.js';
import { notesText } from './records.js';
import { allowsAlways, cleanContext, markWorking, newConversationId, requireConversation, spentToday, titleOf, updateConversation, writeConversation } from './store.js';
import type { LeadAnswer, LeadCard, LeadContext, LeadConversation, LeadStep, LeadTurn } from './types.js';
import { LeadWindow, type LeadWindowSetup } from './window.js';
import type { RunningApp } from '../checks.js';

/**
 * Asking the Squad lead. squad-kit answers at once itself when it can, cheapest first, with no AI: a refusal of what
 * the lead never does, a saved note, the story's live record. Anything else goes to the lead: an agent with the
 * read-only permission set and git read, squad-kit's own window scoped to the lead, the balanced level by default and
 * a limit per question and per day. Its answer comes back in a fixed shape, checked and asked for once more when it
 * does not fit; then squad-kit cleans it, adds the real ways out of a problem, runs what "Always allow" covers when the
 * person's own message asked for it, and keeps what the lead learned.
 */

/** The lead's role in usage lines and levels. */
export const LEAD_ROLE = 'lead';
/** Its permission sets: it reads and looks at git, and changes nothing. */
export const LEAD_PERMISSIONS = ['read', 'git-read'] as const;

export interface LeadAsk {
  text: string;
  /** Where it was asked from; left out, a follow-up keeps the conversation's. */
  context?: unknown;
  /** A follow-up in this conversation. */
  conversation?: string;
  /** Look again, even when a saved note answers it. */
  fresh?: boolean;
}

export interface LeadAskOptions {
  signal?: AbortSignal;
  /** Tests use less. */
  limits?: LeadWindowSetup['limits'];
  appWaitMs?: number;
}

const jobs = new Map<string, AbortController>();
const jobKey = (bp: BoardPaths, id: string) => `${bp.squadDir}\n${id}`;
const now = () => new Date().toISOString();

/** The first sentence of a text, for a headline. */
function firstSentence(text: string): string {
  const m = /^(.{12,300}?[.!?؟])(\s|$)/s.exec(text.trim());
  return (m?.[1] ?? text.trim().slice(0, 300)).trim();
}

/**
 * What squad-kit answers itself, with no AI and no cost: what the lead never does (with an Open card for each story it
 * names, so the person is one press from doing it themselves), a saved note, a status question about the story it was
 * asked from, the day's limit, a sample board. Null when the lead must answer. `prefix` names its cards.
 */
function answerAtOnce(bp: BoardPaths, turn: LeadTurn, fresh: boolean, prefix: string): LeadAnswer | null {
  const text = turn.ask.text;
  const step = (t: string, kind: LeadStep['kind']) => turn.trace.push({ at: now(), text: t, kind });
  const never = neverAsked(text);
  if (never.length) {
    const ar = isArabic(text);
    turn.refused = never.map((id) => refusalIn(id, ar));
    step(`squad-kit refused: ${never.map((id) => NEVER[id].name.toLowerCase()).join('; ')}`, 'refused');
    const asked = contextStory(bp, turn.ask.context)?.id;
    const cards = openCardsFor(bp, text, [], `${prefix}.o`, { refused: true, ...(asked ? { also: [asked] } : {}) });
    return { headline: turn.refused[0]!, body: [...turn.refused.slice(1), AFTER_REFUSAL[ar ? 'ar' : 'en']].join('\n\n'), evidence: [], sources: [], cards, by: 'refusal' };
  }
  if (!fresh) {
    const note = noteFor(bp, text);
    if (note) {
      step(`Found it in squad-kit's notes, saved on ${note.at.slice(0, 10)}`, 'notes');
      return {
        headline: firstSentence(note.text),
        body: note.text,
        evidence: [],
        sources: [{ kind: 'note', ref: note.at.slice(0, 10), label: `Saved from "${note.question.slice(0, 100)}"` }, ...(note.sources ?? []).map((ref) => ({ kind: /^[A-Z][A-Z0-9]*-\d+$/.test(ref) ? ('story' as const) : ('file' as const), ref }))],
        cards: [],
        by: 'note',
      };
    }
  }
  const t = contextStory(bp, turn.ask.context);
  if (t && turn.ask.context.from === 'story') {
    const usual = readUsual(bp);
    const live = liveNow(t, usual);
    const a = answerAsk(t, live, usual, text);
    const plain = a.instant && (['when', 'doing', 'next', 'cost'].includes(a.topic) || (a.topic === 'problem' && live.state === 'working' && !live.slow));
    if (plain && a.lines.length) {
      step(`Read ${t.id}'s live record`, 'story');
      return { headline: a.lines[0]!, body: a.lines.slice(1).join('\n'), evidence: [], sources: [{ kind: 'story', ref: t.id, label: t.title }], cards: [], by: 'record' };
    }
  }
  if (readMeta(bp).engine !== 'live') {
    return { headline: 'A sample board has no squad to ask.', body: 'Open a real project to ask the Squad lead about it.', evidence: [], sources: [], cards: [], by: 'record' };
  }
  const spent = spentToday(bp);
  if (spent >= MAX_LEAD_DAY_USD) {
    step(`The lead's answers today came to $${spent.toFixed(2)}`, 'notes');
    return {
      headline: `The lead has used today's $${MAX_LEAD_DAY_USD} at API prices, so it answers again tomorrow.`,
      body: "Saved notes and status questions about a story are still answered at once, and the board's own buttons work as always.",
      evidence: [],
      sources: [],
      cards: [],
      by: 'limit',
    };
  }
  return null;
}

/**
 * Asks the lead: a new conversation, or a follow-up in `conversation`. It answers at once when squad-kit can answer
 * itself; otherwise the conversation comes back thinking, and `done` resolves once the answer is in its file.
 */
export function askLead(bp: BoardPaths, input: LeadAsk, o: LeadAskOptions = {}): { conversation: LeadConversation; done: Promise<LeadConversation> } {
  const text = (input.text ?? '').trim();
  if (!text) throw new BoardActionError('Write your question first.');
  if (text.length > MAX_QUESTION_CHARS) throw new BoardActionError(`Ask in at most ${MAX_QUESTION_CHARS} characters.`);
  const before = input.conversation ? requireConversation(bp, input.conversation) : null;
  if (before?.thinking) throw new BoardActionError('The lead is still answering. Wait a moment.');
  const context: LeadContext = input.context !== undefined ? cleanContext(input.context) : (before?.context ?? { from: 'board' });
  const at = now();
  const c: LeadConversation = before ?? { id: newConversationId(), title: titleOf(text), startedAt: at, updatedAt: at, context, turns: [] };
  const facts = contextFacts(bp, context);
  const turn: LeadTurn = { n: c.turns.length + 1, ask: { text, at, context, ...(facts.length ? { facts } : {}) }, trace: [], refused: [] };
  c.turns.push(turn);
  c.updatedAt = at;
  const quick = answerAtOnce(bp, turn, Boolean(input.fresh), `${c.id}.${turn.n}`);
  if (quick) {
    Object.assign(turn, { answer: quick, seconds: 0, costUsd: 0 });
    writeConversation(bp, c);
    return { conversation: c, done: Promise.resolve(c) };
  }
  c.thinking = true;
  writeConversation(bp, c);
  markWorking(bp, c.id, true);
  const stop = new AbortController();
  const onStop = () => stop.abort();
  o.signal?.addEventListener('abort', onStop, { once: true });
  jobs.set(jobKey(bp, c.id), stop);
  const done = answerTurn(bp, c.id, turn.n, stop.signal, o).finally(() => {
    markWorking(bp, c.id, false);
    jobs.delete(jobKey(bp, c.id));
    o.signal?.removeEventListener('abort', onStop);
  });
  return { conversation: c, done };
}

/** Stop: the lead stops answering; what it found so far stays in the trace. */
export function stopLead(bp: BoardPaths, id: string): LeadConversation {
  jobs.get(jobKey(bp, id))?.abort();
  return requireConversation(bp, id);
}

/** A tool call of the lead's own (reading the code), as a line of the trace; null for the window's, which say their own. */
export function codeStep(e: ToolEvent, root: string): string | null {
  if (e.name.startsWith('mcp__')) return null;
  const rel = (p: string) => {
    const r = path.relative(root, path.resolve(root, p));
    return r.startsWith('..') || path.isAbsolute(r) ? null : r.split(path.sep).join('/') || '.';
  };
  const file = [e.input.file_path, e.input.path, e.input.notebook_path].find((p): p is string => typeof p === 'string' && p.length > 0);
  const pattern = typeof e.input.pattern === 'string' ? e.input.pattern.slice(0, 60) : '';
  if (e.name === 'Read' || e.name === 'NotebookRead') return file ? (rel(file) ? `Read ${rel(file)}` : 'Read a file outside the project') : null;
  if (e.name === 'Grep') return `Searched the code for "${pattern}"`;
  if (e.name === 'Glob') return `Looked for files named "${pattern}"`;
  if (e.name === 'LS') return `Looked in ${file ? (rel(file) ?? 'a folder outside the project') : 'the project folder'}`;
  if (e.name === 'Bash') {
    // The project's own folder is left out of the words: "cat roomflow/store.py", not the whole path.
    const cmd = (typeof e.input.command === 'string' ? e.input.command.trim() : '').split(`${root}${path.sep}`).join('');
    if (/^git\s+(log|show|diff|status|blame)\b/.test(cmd)) return "Looked at the code's history";
    const read = /^(?:cat|head|tail|wc)\s+(?:-\S+\s+)*([^\s|;&]+)$/.exec(cmd)?.[1];
    return read && rel(read) ? `Read ${rel(read)}` : `Ran a read command: ${cmd.slice(0, 80)}`;
  }
  return null;
}

/** The person's own message, or where they asked from, names what this card acts on: only then may "Always allow" run it. */
export function askedFor(card: LeadCard, text: string, ctx: LeadContext): boolean {
  if (card.kind !== 'board_action') return false;
  const story = card.story;
  const named = Boolean(story) && (new RegExp(`\\b${story}\\b`, 'i').test(text) || (ctx.from === 'story' && ctx.story === story) || (ctx.from === 'problem' && ctx.story === story));
  switch (card.action) {
    case 'more_time':
    case 'pictures_again':
      return named;
    case 'start_app':
      return ctx.from === 'app' || /\b(app|start|run|open|launch)\b|تطبيق|شغل/i.test(text);
    case 'morning_brief':
      return /\b(brief|morning|summary|every day|daily)\b|صباح|ملخص|يومي/i.test(text);
    default:
      return false;
  }
}

/** The conversation so far, for a lead that starts a new session on it. */
function earlierOf(c: LeadConversation, n: number): string {
  return c.turns
    .filter((t) => t.n < n)
    .slice(-4)
    .map((t) => `The person: ${t.ask.text}\nThe lead: ${t.answer ? `${t.answer.headline} ${t.answer.body}` : (t.error ?? '(no answer)')}`)
    .join('\n\n');
}

async function answerTurn(bp: BoardPaths, id: string, n: number, signal: AbortSignal, o: LeadAskOptions): Promise<LeadConversation> {
  const started = Date.now();
  const meta = readMeta(bp);
  const first = requireConversation(bp, id);
  const turn = first.turns.find((t) => t.n === n)!;
  const step = (s: Omit<LeadStep, 'at'>) => {
    try {
      updateConversation(bp, id, (c) => c.turns.find((t) => t.n === n)?.trace.push({ at: now(), ...s }));
    } catch {
      // A step that could not be written is still in the answer's own record.
    }
  };
  const finish = (fields: Partial<LeadTurn>, session?: string) =>
    updateConversation(bp, id, (c) => {
      const t = c.turns.find((x) => x.n === n)!;
      Object.assign(t, fields, { seconds: Math.round((Date.now() - started) / 1000) });
      c.thinking = false;
      if (session) c.session = session;
    });
  const agent = readAgent(bp, 'analyst');
  const tool = aiTool(agent.tool);
  if (!tool?.canRun) {
    const can = AI_TOOLS.filter((t) => t.canRun).map((t) => t.label).join(' or ');
    return finish({ error: `The lead runs on the Analyst's AI tool, ${tool?.label ?? agent.tool}, which squad-kit cannot run yet. Switch it to ${can} on the Harness page, under Agents.` });
  }
  // The lead's own copy of the app, when the project has one it can start.
  const plan = leadAppPlan(bp);
  let ownUrl: string | undefined;
  const app = plan.why
    ? undefined
    : {
        cwd: plan.dir ?? bp.root,
        start: plan.start!,
        url: plan.url!,
        run: async (): Promise<RunningApp> => {
          const a = await startLeadApp(bp, { signal, ...(o.appWaitMs ? { waitMs: o.appWaitMs } : {}), onWait: (words) => step({ text: words, kind: 'app' }) });
          ownUrl = a.url;
          step({ text: plan.product ? 'Started the product in its own copies, with their own values' : 'Started its own copy of the app, with its own database', kind: 'app' });
          return a;
        },
        after: () => stopLeadApp(bp),
      };
  const win = new LeadWindow({
    bp,
    conversation: id,
    turn: n,
    ...(app ? { app } : {}),
    ...(app ? { api: () => plan.parts ?? { app: { name: plan.name ?? 'the app', url: ownUrl ?? plan.url! } } } : {}),
    signal,
    onStep: step,
    ...(o.limits ? { limits: o.limits } : {}),
  });
  openWindow(win);
  try {
    const access = await windowAccess(win);
    const quality = meta.quality ?? DEFAULT_QUALITY;
    const lv = resolveLevel({ role: LEAD_ROLE, step: 'ask', quality }, undefined, personLevels());
    const effort = effortOn(tool, lv.effort);
    const caps = stepCaps({ role: LEAD_ROLE, step: 'ask', quality });
    const runCaps = { ...(tool.caps?.turns ? { turns: caps.turns } : {}), ...(tool.caps?.spend ? { spendUsd: caps.spendUsd } : {}) };
    const facts = turn.ask.facts ?? [];
    const prompt = first.session
      ? followUpPrompt({ question: turn.ask.text, context: turn.ask.context, facts, refused: turn.refused })
      : leadPrompt(meta, { question: turn.ask.text, context: turn.ask.context, facts, notes: notesText(bp), refused: turn.refused, ...(n > 1 ? { earlier: earlierOf(first, n) } : {}) });
    const secrets = await secretFiles(bp, bp.root);
    const used = { role: LEAD_ROLE as 'lead', step: 'ask', level: lv.level, model: lv.model || tool.modelFor(lv.level) };
    let cost = 0;
    let costKnown = false;
    const run = async (p: string, resume?: string): Promise<AgentResult> => {
      const r = await tool.run({
        cwd: bp.root,
        prompt: p,
        permissions: [...LEAD_PERMISSIONS],
        schema: LEAD_SCHEMA,
        instructions: [PROCESS_RULE, leadRules(win.tools, isArabic(turn.ask.text))].join('\n\n'),
        secretFiles: secrets,
        privatePlaces: agentPrivatePlaces(),
        level: lv.level,
        ...(effort ? { effort } : {}),
        ...(lv.model ? { model: lv.model } : {}),
        ...(Object.keys(runCaps).length ? { caps: runCaps } : {}),
        timeoutMs: LEAD_ANSWER_MS,
        signal,
        window: access,
        logDir: bp.chatsDir,
        direct: meta.runner === 'direct',
        ...(resume ? { resume } : {}),
        onTool: (e) => {
          const line = codeStep(e, bp.root);
          if (line) step({ text: line, kind: 'code' });
        },
      });
      // A question has no story: it counts on the project's own line, and in the month.
      recordUsage(bp, undefined, used, r.usage);
      if (typeof r.usage?.costUsd === 'number') {
        cost += r.usage.costUsd;
        costKnown = true;
      }
      return r;
    };
    const failed = (r: AgentResult): string => {
      if (r.limit) {
        startPause(r.limit, { project: meta.project });
        return `Your ${r.limit.name} usage limit is reached, so the lead cannot answer now. Ask again once it resets.`;
      }
      if (r.capped) return `The lead used the most one question may use ($${caps.spendUsd} or ${caps.turns} turns), so it stopped. Ask a narrower question.`;
      if (signal.aborted) return 'You stopped the lead.';
      writeLog({ level: 'warn', project: meta.project, text: `The Squad lead did not answer: ${r.detail ?? r.error ?? 'no answer'}` });
      return r.error && ownRunWords(r.error, tool) ? r.error : 'The lead stopped before it answered, on something technical. Ask again.';
    };
    let r = await run(prompt, first.session);
    if (!r.ok) return finish({ error: failed(r), ...(costKnown ? { costUsd: cost } : {}), model: describeLevel(lv, tool) }, r.sessionId || undefined);
    let structured = r.structured;
    const problem = leadAnswerProblem(structured);
    if (problem) {
      step({ text: `The answer was not complete (${problem}), so squad-kit asked for it again`, kind: 'card' });
      const again = await run(answerAgainPrompt(problem), r.sessionId || undefined);
      if (!again.ok) return finish({ error: failed(again), ...(costKnown ? { costUsd: cost } : {}), model: describeLevel(lv, tool) }, again.sessionId || r.sessionId || undefined);
      r = again;
      structured = again.structured;
      const still = leadAnswerProblem(structured);
      // The words came, with a broken card: the words stay and the card goes. No words: no answer.
      const words = structured as { headline?: unknown; body?: unknown } | undefined;
      if (still && !(typeof words?.headline === 'string' && words.headline.trim() && typeof words.body === 'string')) {
        return finish({ error: 'The lead did not give a complete answer. Ask again.', ...(costKnown ? { costUsd: cost } : {}), model: describeLevel(lv, tool) }, r.sessionId || undefined);
      }
      // Still offering to do something later: the words and cards stay, and squad-kit adds the Open cards below.
      if (still && still !== laterOffer(structured as Parameters<typeof laterOffer>[0])) structured = { evidence: [], sources: [], ...(structured as object), cards: [] };
    }
    const cleaned = cleanAnswer(bp, structured, { taken: new Set(win.pictures.keys()), prefix: `${id}.${n}`, role: meta.user.role });
    for (const s of cleaned.steps) step(s);
    const answer = cleaned.answer;
    const t = contextStory(bp, turn.ask.context);
    // A board action that no longer fits where its story stands is left out; the story opens instead, so the person
    // still sees its own buttons there.
    const misfits = new Map(
      answer.cards.map((card) => {
        if (card.kind !== 'board_action' || !card.story) return [card, null] as const;
        const story = contextStory(bp, { from: 'story', story: card.story });
        return [card, story ? actionMisfit(story, card.action) : `${card.story} is gone`] as const;
      }),
    );
    const opened = new Set<string>();
    answer.cards = answer.cards.flatMap((card) => {
      const misfit = misfits.get(card);
      if (!misfit || card.kind !== 'board_action') return [card];
      step({ text: `Left out a card: ${misfit}`, kind: 'card' });
      const story = contextStory(bp, { from: 'story', story: card.story! });
      if (!story || opened.has(story.id) || answer.cards.some((x) => !misfits.get(x) && cardStory(x) === story.id)) return [];
      opened.add(story.id);
      return [openCard(card.id, story, card.action === 'pictures_again' ? 'proof' : waitTab(story), card.why)];
    });
    // Diagnosing a story: its real ways out, as cards, when the lead offered none.
    if (t && !answer.cards.some((x) => x.kind === 'board_action')) answer.cards.push(...waysOut(t, `${id}.${n}.w`));
    // Buttons, not "go and press it": each story the answer sends the person to gets its Open card.
    answer.cards.push(...openCardsFor(bp, `${answer.headline}\n${answer.body}`, answer.cards, `${id}.${n}.o`, { refused: cleaned.refused.length > 0 }));
    // "Always allow": the low-risk ones run by themselves, only when the person's own words asked about them.
    for (const [i, card] of answer.cards.entries()) {
      if (card.kind !== 'board_action' || !isAllowable(card.action) || !allowsAlways(bp, card.action)) continue;
      if (!askedFor(card, turn.ask.text, turn.ask.context)) {
        answer.cards[i] = { ...card, asksFirst: true };
        continue;
      }
      try {
        const done = await doCard(bp, card, { conversation: id });
        answer.cards[i] = { ...card, status: 'done', result: done.result, byItself: `Ran by itself: Always allow is on for this. ${done.result}` };
        step({ text: `Ran "${card.label}" by itself: Always allow is on for it`, kind: 'card' });
      } catch (err) {
        answer.cards[i] = { ...card, result: (err as Error).message };
      }
    }
    if (answer.learned) {
      saveNote(bp, { about: learnedAbout(structured), text: answer.learned, question: turn.ask.text, conversation: id, sources: answer.sources.filter((s) => s.kind === 'story' || s.kind === 'file').map((s) => s.ref) });
      step({ text: "Saved what it learned in squad-kit's notes", kind: 'notes' });
    }
    return finish({ answer, refused: [...turn.refused, ...cleaned.refused], ...(costKnown ? { costUsd: cost } : {}), model: describeLevel(lv, tool) }, r.sessionId || undefined);
  } catch (err) {
    writeLog({ level: 'warn', project: meta.project, text: `The Squad lead did not answer: ${(err as Error).stack ?? String(err)}` });
    return finish({ error: err instanceof BoardActionError ? err.message : signal.aborted ? 'You stopped the lead.' : 'The lead stopped before it answered, on something technical. Ask again.' });
  } finally {
    await closeWindow(win);
  }
}
