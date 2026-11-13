import { questionWords, scheduleSquad } from '../../board/schedule.js';
import { randomUUID } from 'node:crypto';
import { addActivity, listDecisions, now, readTicket } from '../../board/store.js';
import type { Question } from '../../board/types.js';
import * as P from '../prompts.js';
import { LimitReached } from '../usage-limit.js';
import { NO_QUESTIONS } from '../../board/auto.js';
import { holdForSplit, sizeAtStart, storySize } from '../../board/split.js';
import { cleanSplit, sizeRule, splitAgainPrompt, splitAgainShape, splitProblem, withSplit } from '../split-prompts.js';
import { ANSWER_STEP_MS, WORDS_STEP_MS } from './limits.js';
import { attachmentDirs, projectRoot } from './shared.js';
import type { LiveSquad } from './squad.js';

/** The Analyst's first read and questions, a split asked again, and answers about a question. */
export const questionsPart = {
  async intake(this: LiveSquad, id: string): Promise<void> {
    const root = projectRoot(this.bp);
    const meta = this.meta();
    await this.hearNotes(id);
    const track = readTicket(this.bp, id)?.track;
    if (track === 'express' || track === 'auto') {
      this.update(id, (t) => {
        t.questions = [];
        t.stage = 'specs';
        t.live = true;
        t.status = track === 'auto' ? 'Architect is choosing the design' : 'Spec writer is writing the plan';
        addActivity(t, 'squad', track === 'auto' ? NO_QUESTIONS : 'Express track: no questions, straight to the plan');
        scheduleSquad(t, 'plan-write', 0.2, 1);
      });
      return;
    }
    // After a talk with the Analyst its session exists already: go on in it, so it remembers what you said.
    const had = readTicket(this.bp, id)?.sessions?.intake;
    const t0 = this.update(id, (t) => {
      t.stage = 'tickets';
      t.live = true;
      t.status = 'Analyst is reading the ticket';
      t.sessions = { ...t.sessions, intake: t.sessions?.intake ?? randomUUID() };
    });
    // squad-kit's own count of its size comes first, with no AI: the Analyst judges only what it leaves open (ADR-004).
    const size = sizeAtStart(t0);
    const mine = t0.brief?.criteria.length ?? 0;
    const r = await this.runAgent({
      role: 'analyst',
      step: 'questions',
      ticket: id,
      cwd: root,
      ...(had ? { resume: had } : { sessionId: t0.sessions!.intake }),
      prompt: `${P.intakePrompt(meta, listDecisions(this.bp), t0, this.ctx())}${size ? sizeRule(size, 'intake', mine) : ''}`,
      permissions: ['read'],
      schema: size ? withSplit(P.QUESTIONS_SCHEMA, size.size) : P.QUESTIONS_SCHEMA,
      ...(size ? { check: (a: unknown) => splitProblem(a, size.size) } : {}),
      timeoutMs: WORDS_STEP_MS,
      addDirs: attachmentDirs(t0),
      onTool: this.watcher(id, 'analyst', root),
    });
    const out = r.structured as { summary: string; questions: { from: 'analyst' | 'architect'; text: string; options: string[]; typedOption?: string }[] };
    const questions = out.questions.map((q, i): Question => {
      const options = [...q.options];
      // An option ending in ":" asks for a typed value, even when the model forgets to say so.
      const typed =
        (q.typedOption && options.find((o) => o.replace(/:$/, '') === q.typedOption!.replace(/:$/, ''))) ||
        options.find((o) => o.trim().endsWith(':'));
      return { id: `q${i + 1}`, from: q.from, text: q.text, options, ...(typed ? { inputOption: typed } : {}) };
    });
    const split = size ? cleanSplit(r.structured, size, now(), mine) : null;
    this.update(id, (t) => {
      addActivity(t, 'analyst', out.summary);
      // Too big for one story: the suggestion waits for the person, the questions kept for Keep as one.
      if (split) return holdForSplit(t, split, questions);
      if (!questions.length) {
        t.questions = [];
        t.stage = 'specs';
        t.status = 'Spec writer is writing the plan';
        scheduleSquad(t, 'plan-write', 0.5, 1);
        return;
      }
      t.questions = questions;
      t.stage = 'specs';
      t.live = false;
      t.status = `${questionWords(t.questions.length)} for you`;
      t.waiting = { kind: 'questions', summary: `${questionWords(t.questions.length)} from the Analyst and Architect` };
      t.squad = null;
      addActivity(t, 'analyst', `Asked ${questionWords(t.questions.length)}`);
    });
  },

  /** "Change the split": the Analyst writes it again from the person's note, in the conversation of its first read. */
  async splitAgain(this: LiveSquad, id: string): Promise<void> {
    const root = projectRoot(this.bp);
    const t0 = this.update(id, (t) => {
      t.live = true;
      t.status = 'The Analyst is changing the split';
      t.sessions = { ...t.sessions, intake: t.sessions?.intake ?? randomUUID() };
    });
    const r = await this.runAgent({
      role: 'analyst',
      step: 'questions',
      ticket: id,
      cwd: root,
      resume: t0.sessions!.intake,
      prompt: splitAgainPrompt(t0.split?.change ?? ''),
      permissions: ['read'],
      schema: splitAgainShape(),
      check: (a: unknown) => splitProblem(a, 'few'),
      timeoutMs: WORDS_STEP_MS,
      addDirs: attachmentDirs(t0),
      onTool: this.watcher(id, 'analyst', root),
    });
    const split = cleanSplit(r.structured, storySize(t0), now(), t0.brief?.criteria.length ?? 0);
    this.update(id, (t) => {
      const s = split ?? t.split?.suggestion;
      if (s) holdForSplit(t, s, t.split?.questions ?? []);
      if (!split) addActivity(t, 'squad', 'The Analyst could not write another split, so the one before waits for you');
    });
  },

  async reply(this: LiveSquad, id: string, qid: string): Promise<void> {
    const t = readTicket(this.bp, id)!;
    const q = t.questions!.find((x) => x.id === qid)!;
    const ask = [...(q.thread ?? [])].reverse().find((m) => m.who === 'you')?.text ?? '';
    const n = t.questions!.indexOf(q) + 1;
    try {
      const r = await this.runAgent({
        role: 'analyst',
        step: 'questions',
        ticket: id,
        cwd: projectRoot(this.bp),
        resume: t.sessions?.intake,
        prompt: P.replyPrompt(q, n, ask),
        permissions: ['read'],
        timeoutMs: ANSWER_STEP_MS,
        reply: true,
      });
      this.update(id, (x) => {
        const qq = x.questions?.find((y) => y.id === qid);
        if (!qq) return;
        qq.thread = [...(qq.thread ?? []), { who: qq.from, text: r.text.trim(), at: now() }];
        qq.thinking = false;
      });
    } catch (err) {
      // The usage limit: the answer comes once it resets.
      if (err instanceof LimitReached) return;
      this.update(id, (x) => {
        const qq = x.questions?.find((y) => y.id === qid);
        if (!qq) return;
        qq.thread = [...(qq.thread ?? []), { who: 'squad', text: this.couldNotAnswer(err, id, 'Could not answer this time. Ask again in a moment.'), at: now() }];
        qq.thinking = false;
      });
    }
  },
};
