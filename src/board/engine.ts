import fs from 'node:fs';
import path from 'node:path';
import {
  addActivity,
  boardExists,
  listDecisions,
  listTickets,
  now,
  readMeta,
  readTicket,
  updateTicket,
  writeDecision,
  writeMeta,
  type BoardPaths,
} from './store.js';
import { scheduleSquad } from './schedule.js';
import { applyPlanEdits, approveExpress, changeParts, changeSummary, needsSpec, openChange } from './actions.js';
import { AMBIENT, scriptFor } from './scripts.js';
import type { BoardMeta, Question, Ticket } from './types.js';
import { ticketDir } from './store.js';
import { keepDemoClock, stopDemoStep, watchDemoSlow } from './demo-clock.js';
import { wakeIfReady } from './depends.js';
import { playDemoSetup } from './demo-setup.js';

/**
 * The demo squad. It plays a recorded journey for each ticket on a timer and writes every
 * step into the same .squad/board files the board and the terminal read. The live engine
 * will replace this with Claude Code and Codex doing the work.
 */
export function startDemoSquad(bp: BoardPaths, intervalMs = 500): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    try {
      tick(bp);
    } catch {
      // A half-written file or a ticket removed mid-step; the next tick tries again.
    } finally {
      busy = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

/** When each sample board last looked for slow steps. */
const lastSlowLook = new Map<string, number>();

export function tick(bp: BoardPaths): void {
  if (!boardExists(bp)) return;
  const meta = readMeta(bp);
  if (meta.engine !== 'demo') return;
  // The first run and the Overview's talk, played on the same timer.
  playDemoSetup(bp, meta);
  const at = Date.now();
  const tickets = listTickets(bp);
  if (at - (lastSlowLook.get(bp.root) ?? 0) >= 5000) {
    lastSlowLook.set(bp.root, at);
    watchDemoSlow(bp, tickets, at);
  }
  for (const t of tickets) {
    // Being deleted: the sample squad leaves it alone, and says so for a delete started in another window.
    if (t.deleting) {
      if (!t.deleting.stopped) updateTicket(bp, t.id, (x) => x.deleting && (x.deleting.stopped = now()));
      continue;
    }
    if (t.stopRequested) {
      updateTicket(bp, t.id, (x) => stopDemoStep(bp, x, meta.speed));
      continue;
    }
    // "Wait" for a ticket it depends on: once that one is merged, the build starts (board/depends.ts).
    if (wakeIfReady(bp, t)) continue;
    const q = t.questions?.find((x) => x.thinking);
    if (q && at - lastMessageAt(q) >= 2200 / meta.speed) reply(bp, t.id, q.id);
    const c = t.chat;
    if (c?.stopping) chatStopped(bp, t.id);
    else if (c?.open && c.thinking && at - Date.parse(c.messages.at(-1)?.at ?? t.activity[0]?.at ?? new Date(0).toISOString()) >= 2200 / meta.speed) chatReply(bp, t.id);
    const ch = openChange(t);
    if (ch?.status === 'writing' && at - Date.parse(ch.at) >= 2200 / meta.speed) writeChange(bp, t.id);
    if (t.squad && Date.parse(t.squad.nextAt) <= at) {
      advance(bp, t.id, meta);
      updateTicket(bp, t.id, (x) => keepDemoClock(bp, x));
    }
  }
}

function lastMessageAt(q: Question): number {
  const last = q.thread?.[q.thread.length - 1];
  return last ? Date.parse(last.at) : 0;
}

function reply(bp: BoardPaths, id: string, qid: string): void {
  updateTicket(bp, id, (t) => {
    const q = t.questions?.find((x) => x.id === qid);
    if (!q || !q.thinking) return;
    const script = scriptFor(t);
    const asked = q.thread?.filter((m) => m.who === 'you').length ?? 0;
    const text =
      asked <= 1
        ? (script.replies[qid] ?? 'Good question. If you are not sure, pick the closest choice and I will mark it in the plan.')
        : 'Then pick the choice closest to what you mean. I will show my reasoning in the plan, and you can change it there.';
    q.thread = [...(q.thread ?? []), { who: q.from, text, at: now() }];
    q.thinking = false;
  });
}

/** You pressed Stop on the answer: the talk stays open, with a way on. */
function chatStopped(bp: BoardPaths, id: string): void {
  updateTicket(bp, id, (t) => {
    const c = t.chat;
    if (!c) return;
    if (c.thinking && c.open) c.messages.push({ who: 'squad', text: 'You stopped this answer. Ask again, or carry on.', at: now(), note: 'stopped' });
    c.thinking = false;
    c.stopping = undefined;
  });
}

/** The demo agents talk back with short scripted lines, so the chat can be shown without Claude. */
function chatReply(bp: BoardPaths, id: string): void {
  updateTicket(bp, id, (t) => {
    const c = t.chat;
    if (!c?.open || !c.thinking) return;
    const said = c.messages.filter((m) => m.who === 'you');
    const last = c.messages.at(-1);
    const opening = last?.who !== 'you';
    const name = c.with[0]!.toUpperCase() + c.with.slice(1);
    const released = t.stage === 'release' || t.stage === 'done';
    const where = released
      ? `${t.id} is ${t.stage === 'done' ? 'released' : 'accepted'}, so I can only answer questions. To change it, add a new linked ticket or report a bug.`
      : `${t.id} keeps going while we talk. Right now: ${t.status}.`;
    const text = c.beside
      ? opening
        ? `I am the ${name} on ${t.id}. ${where} What would you like to know?`
        : `About **${last.text}**: ${where}`
      : opening
      ? c.with === 'analyst'
        ? `I read "${t.title}". As I understand it: ${t.ask || 'the ticket asks for a change'}.\n\nTwo things are not clear to me yet:\n1. **Who** uses this most?\n2. Is there a **rule** about it I must follow?`
        : `I am the ${name} on ${t.id}. ${t.status ? `Where I am: ${t.status}.` : ''} What would you like to talk through?`
      : said.length < 2
        ? `Got it: **${last.text}**${last.files?.length ? ` (I looked at ${last.files.length === 1 ? 'your file' : `your ${last.files.length} files`})` : ''}. Anything else I should know?`
        : `Thank you. I think I understand enough now. ${c.with === 'analyst' ? 'Press **Write the spec** when you are happy.' : c.with === 'architect' ? 'Press **Write the design** when you are happy.' : 'Press **Done** and I will carry on as we agreed.'}`;
    c.messages.push({ who: c.with, text, at: now() });
    c.ready = !c.beside && !opening && said.length >= 2;
    c.thinking = false;
  });
}

/** The demo Analyst writes a proposed change as one more "done when", so a proposal can be shown without Claude. */
function writeChange(bp: BoardPaths, id: string): void {
  updateTicket(bp, id, (t) => {
    const c = openChange(t);
    if (c?.status !== 'writing') return;
    const why = 'The design still holds: it is one more check on the work as planned.';
    c.parts = changeParts(t, { summary: c.ask, size: 'small', why, story: '', criteria: [{ number: 0, action: 'add', given: 'the change you asked for', when: 'the squad builds it', then: c.ask }] });
    c.status = 'proposed';
    c.size = 'small';
    c.summary = c.ask;
    c.why = why;
    addActivity(t, 'analyst', `Wrote change ${c.id} into the spec (small): ${c.ask}`);
  });
}

function advance(bp: BoardPaths, id: string, meta: BoardMeta): void {
  const speed = meta.speed;
  if (readTicket(bp, id)?.squad?.phase === 'express-approve') {
    approveExpress(bp, id);
    return;
  }
  updateTicket(bp, id, (t) => {
    const state = t.squad;
    if (!state) return;
    const i = state.index ?? 0;
    const script = scriptFor(t);
    switch (state.phase) {
      case 'analyst-read': {
        const line = script.analystLines[i];
        if (t.track === 'express') {
          t.questions = [];
          t.stage = 'specs';
          t.status = 'Spec writer is writing the plan';
          addActivity(t, 'squad', 'Express track: no questions, straight to the plan');
          scheduleSquad(t, 'plan-write', 1.5, speed, 0);
          return;
        }
        if (line) {
          t.stage = 'tickets';
          t.live = true;
          t.status = line;
          addActivity(t, 'analyst', line);
          scheduleSquad(t, 'analyst-read', 2.2, speed, i + 1);
          return;
        }
        if (script.questions.length === 0) {
          t.stage = 'specs';
          t.status = 'Spec writer is writing the plan';
          scheduleSquad(t, 'plan-write', 1.5, speed, 0);
          return;
        }
        t.stage = 'specs';
        t.questions = script.questions.map((q) => ({ ...q, options: [...q.options] }));
        t.live = false;
        t.status = `${t.questions.length} questions for you`;
        t.waiting = { kind: 'questions', summary: `${t.questions.length} questions from the Analyst and Architect` };
        t.squad = null;
        addActivity(t, 'analyst', `Asked ${t.questions.length} questions`);
        return;
      }
      case 'chat-spec':
      case 'chat-design': {
        // The demo writer adds what you said in the chat as one more "done when", so the change shows.
        const said = (t.chat?.messages ?? []).filter((m) => m.who === 'you' && m.text).map((m) => m.text);
        if (state.phase === 'chat-spec') {
          t.story = t.story ?? script.story(t);
          t.criteria = [...(t.criteria ?? script.criteria(t)), ...said.slice(-1).map((x) => ({ given: 'what we agreed in the chat', when: 'the squad builds it', then: x }))];
          t.releaseNote = t.releaseNote ?? script.releaseNote(t);
          applyPlanEdits(t);
          t.waiting = { kind: 'spec', summary: 'The spec is ready: is this what you want?' };
          t.status = 'Spec ready for you';
          addActivity(t, 'analyst', t.planReview?.before ? 'Updated the spec from your talk' : 'Wrote the spec from your talk');
        } else {
          t.steps = [...(t.steps ?? script.steps.map((x) => ({ title: x.title, status: 'todo' as const }))), ...said.slice(-1).map((x) => ({ title: `As agreed: ${x}`, status: 'todo' as const }))];
          const decision = script.decision(t);
          if (decision && !t.decision) t.decision = decision;
          t.work = { steps: t.steps.length, tests: Math.round(script.tests * 0.43), screens: script.proof.length };
          applyPlanEdits(t);
          t.waiting = { kind: 'plan', summary: 'The design is ready: is this how to build it?' };
          t.status = 'Design ready for you';
          addActivity(t, 'architect', t.planReview?.before ? 'Updated the design from your talk' : 'Wrote the design from your talk');
        }
        t.stage = 'specs';
        t.live = false;
        t.squad = null;
        return;
      }
      case 'chat-carry-builder':
      case 'chat-carry-reviewer':
      case 'chat-carry-tester': {
        const who = state.phase.slice('chat-carry-'.length) as 'builder' | 'reviewer' | 'tester';
        addActivity(t, who, 'Carried on with what you agreed');
        if (who === 'builder') {
          t.stage = 'test';
          t.status = `Running ${script.tests} checks`;
          scheduleSquad(t, 'test', 1.5, speed, 0);
        } else if (who === 'reviewer') {
          t.stage = 'review';
          t.status = 'Reviewer is reading the changes';
          scheduleSquad(t, 'review', 1.5, speed, 0);
        } else {
          t.status = 'Recording the proof';
          scheduleSquad(t, 'review', 1.5, speed, 0);
        }
        return;
      }
      case 'spec-rewrite':
      case 'plan-write':
      case 'plan-rewrite': {
        // Full track, step one: the Analyst writes the what, and you approve it before any design.
        if (state.phase === 'spec-rewrite' || (state.phase === 'plan-write' && needsSpec(t))) {
          if (i === 0) {
            t.stage = 'specs';
            t.live = true;
            t.status = 'Analyst is writing the spec';
            addActivity(t, 'analyst', 'Writing the story and the "done when" list');
            scheduleSquad(t, state.phase, 2, speed, 1);
            return;
          }
          t.story = script.story(t);
          t.criteria = script.criteria(t);
          t.releaseNote = script.releaseNote(t);
          // The demo writer takes each comment as one more "done when", so the new version shows what changed.
          if (state.phase === 'spec-rewrite') {
            for (const c of t.planReview?.sent ?? []) t.criteria.push({ given: 'your comment', when: 'the squad builds it', then: c.text });
          }
          applyPlanEdits(t);
          t.live = false;
          t.status = 'Spec ready for you';
          t.waiting = { kind: 'spec', summary: 'The spec is ready: is this what you want?' };
          t.squad = null;
          addActivity(t, 'analyst', state.phase === 'spec-rewrite' ? `Updated the spec: ${changeSummary(t.changeRequest)}` : 'Wrote the spec');
          return;
        }
        const design = Boolean(t.specApproved);
        const line = script.planLines[i];
        if (line) {
          t.stage = 'specs';
          t.live = true;
          t.status = line.text;
          addActivity(t, line.who, line.text);
          scheduleSquad(t, state.phase, 2, speed, i + 1);
          return;
        }
        if (!design) {
          t.story = script.story(t);
          t.criteria = script.criteria(t);
          t.releaseNote = script.releaseNote(t);
        }
        const decision = script.decision(t);
        if (decision) t.decision = decision;
        t.steps = script.steps.map((s) => ({ title: s.title, status: 'todo' }));
        if (state.phase === 'plan-rewrite') {
          for (const c of t.planReview?.sent ?? []) t.steps.splice(t.steps.length - 1, 0, { title: `Change: ${c.text}`, status: 'todo' });
        }
        applyPlanEdits(t);
        t.work = { steps: script.steps.length, tests: Math.round(script.tests * 0.43), screens: script.proof.length };
        // Full track with screens: the look is approved with the design, before anything is built.
        if (design && script.proof.length) {
          t.mockup = writeDemoMockup(bp, t);
          addActivity(t, 'architect', 'Made a mockup of how the screen will look');
        }
        if (t.track === 'express' && state.phase === 'plan-write') {
          addActivity(t, 'spec', 'Wrote the plan');
          t.status = 'Express track: approving the plan';
          scheduleSquad(t, 'express-approve', 1, speed, 0);
          return;
        }
        t.live = false;
        t.status = design ? 'Design ready for you' : 'Plan ready for you';
        t.waiting = design ? { kind: 'plan', summary: 'The design is ready: is this how to build it?' } : { kind: 'plan', summary: 'The plan is ready for your approval' };
        t.squad = null;
        const what = design ? 'design' : 'plan';
        addActivity(t, design ? 'architect' : 'spec', state.phase === 'plan-rewrite' ? `Updated the ${what}: ${changeSummary(t.changeRequest)}` : `Wrote the ${what}`);
        return;
      }
      case 'build':
      case 'unstick': {
        buildStep(t, i, speed);
        return;
      }
      case 'fix': {
        const steps = t.steps ?? [];
        const fixTitle = `Fix: ${t.changeRequest ?? 'what you found'}`;
        let fix = steps.find((s) => s.title === fixTitle);
        if (!fix) {
          fix = { title: fixTitle, status: 'doing', live: 'Reading what you found' };
          steps.push(fix);
          t.steps = steps;
          t.status = 'Builder is fixing what you found';
          addActivity(t, 'builder', `Started: ${fixTitle}`);
          scheduleSquad(t, 'fix', 3, speed);
          return;
        }
        fix.status = 'done';
        fix.live = undefined;
        fix.minutes = 3;
        addActivity(t, 'builder', `Finished: ${fixTitle}`);
        t.changeRequest = undefined;
        t.stage = 'test';
        t.status = `Running ${script.tests} checks`;
        scheduleSquad(t, 'test', 1.5, speed, 0);
        return;
      }
      case 'answered-builder':
      case 'answered-reviewer': {
        const builder = state.phase === 'answered-builder';
        addActivity(t, builder ? 'builder' : 'reviewer', `Carried on with your answer: ${t.agentQuestion?.answer ?? ''}`);
        t.agentQuestion = undefined;
        t.stage = builder ? 'test' : 'review';
        t.status = builder ? `Running ${script.tests} checks` : 'Reviewer is reading the changes';
        if (builder) scheduleSquad(t, 'test', 1.5, speed, 0);
        else scheduleSquad(t, 'review', 1.5, speed, 0);
        return;
      }
      case 'answered-architect': {
        addActivity(t, 'architect', `Carried on with your answer: ${t.agentQuestion?.answer ?? ''}`);
        t.agentQuestion = undefined;
        t.live = true;
        t.status = 'Architect is writing the design';
        scheduleSquad(t, 'plan-write', 1.5, speed, script.planLines.length);
        return;
      }
      case 'test': {
        testStep(bp, t, i, speed, script.tests, script.proof.length > 0);
        return;
      }
      case 'review': {
        reviewStep(t, i, speed, script.reviewFix);
        return;
      }
      case 'triage': {
        const priority = t.severity === 'stops-work' ? 'high' : t.severity === 'small' ? 'low' : 'normal';
        t.priority = priority;
        const label = priority === 'high' ? 'High' : priority === 'low' ? 'Low' : 'Medium';
        addActivity(t, 'triage', `Sorted the bug. Priority: ${label}${t.foundIn ? `. Linked to ${t.foundIn}` : ''}`);
        t.status = `Sorted as ${label.toLowerCase()} priority`;
        scheduleSquad(t, 'analyst-read', 2.5, speed, 0);
        return;
      }
      case 'ambient': {
        const lines = AMBIENT[t.id] ?? [t.status];
        t.status = lines[(i + 1) % lines.length] ?? t.status;
        if (typeof t.progress === 'number') t.progress = Math.min(92, t.progress + 3);
        scheduleSquad(t, 'ambient', 7, speed, i + 1);
        return;
      }
      default:
        t.squad = null;
    }
  });
}

function buildStep(t: Ticket, i: number, speed: number): void {
  const steps = t.steps ?? [];
  const step = steps[i];
  const plan = scriptFor(t).steps[i];
  if (!step) {
    t.stage = 'test';
    t.status = `Running ${scriptFor(t).tests} checks`;
    t.progress = 0;
    scheduleSquad(t, 'test', 1.5, speed, 0);
    return;
  }
  const lines = plan?.live ?? ['Working on it'];
  t.stage = 'implement';
  t.live = true;
  if (step.status === 'done') {
    // Resuming after a decision: skip the steps that were already finished.
    scheduleSquad(t, t.squad?.phase ?? 'build', 0.3, speed, i + 1);
    return;
  }
  if (step.status === 'todo') {
    step.status = 'doing';
    step.live = lines[0];
    t.status = `Step ${i + 1} of ${steps.length} with ${t.builder ?? 'the Builder'}`;
    addActivity(t, 'builder', `Started step ${i + 1}: ${step.title}`);
    scheduleSquad(t, t.squad?.phase ?? 'build', 2.4, speed, i);
    return;
  }
  const at = lines.indexOf(step.live ?? '');
  if (at >= 0 && at < lines.length - 1) {
    step.live = lines[at + 1];
    scheduleSquad(t, t.squad?.phase ?? 'build', 2.2, speed, i);
    return;
  }
  step.status = 'done';
  step.live = undefined;
  step.minutes = 2 + ((i * 3) % 5);
  t.progress = Math.round(((i + 1) / steps.length) * 100);
  addActivity(t, 'builder', `Finished step ${i + 1}: ${step.title}`);
  scheduleSquad(t, t.squad?.phase ?? 'build', 1.2, speed, i + 1);
}

function testStep(bp: BoardPaths, t: Ticket, i: number, speed: number, total: number, hasScreens: boolean): void {
  const gates = (t.gates ??= { checks: 'pending', review: 'pending', proof: 'pending' });
  t.stage = 'test';
  t.live = true;
  const rounds = 3;
  if (i < rounds) {
    const passed = Math.round((total * (i + 1)) / rounds);
    t.progress = Math.round((passed / total) * 100);
    t.status = `${passed} of ${total} checks pass`;
    if (i === 0) addActivity(t, 'tester', `Running ${total} checks`);
    scheduleSquad(t, 'test', 2, speed, i + 1);
    return;
  }
  if (i === rounds) {
    gates.checks = 'pass';
    gates.checksText = `${total} of ${total} checks pass`;
    addActivity(t, 'tester', `All ${total} checks pass`);
    markDecisionChecked(bp, t.id);
    t.status = hasScreens ? 'Recording before and after screens' : 'Checking the change by hand';
    addActivity(t, 'tester', hasScreens ? 'Recording before and after screens for each "done when"' : 'No screens change, so the checks are the proof');
    scheduleSquad(t, 'test', 2.4, speed, i + 1);
    return;
  }
  gates.proof = 'pass';
  t.progress = undefined;
  t.stage = 'review';
  t.status = `Reviewer is reading the changes with ${t.reviewer ?? 'a second AI'}`;
  if (t.proof === undefined) t.proof = scriptFor(t).proof;
  scheduleSquad(t, 'review', 1.5, speed, 0);
}

function reviewStep(t: Ticket, i: number, speed: number, fix?: { ask: string; fixed: string }): void {
  const gates = (t.gates ??= { checks: 'pass', review: 'pending', proof: 'pass' });
  t.stage = 'review';
  t.live = true;
  const alreadyFixed = t.activity.some((a) => fix && a.text === fix.fixed);
  if (i === 0) {
    addActivity(t, 'reviewer', `Reading the changes (round 1 of 2, ${t.reviewer ?? 'second AI'})`);
    scheduleSquad(t, 'review', 2.6, speed, fix && !alreadyFixed ? 1 : 3);
    return;
  }
  if (i === 1 && fix) {
    addActivity(t, 'reviewer', fix.ask);
    t.status = 'Builder is fixing 1 review comment';
    scheduleSquad(t, 'review', 2.8, speed, 2);
    return;
  }
  if (i === 2 && fix) {
    addActivity(t, 'builder', fix.fixed);
    t.status = 'Reviewer is checking the fix (round 2 of 2)';
    scheduleSquad(t, 'review', 2.2, speed, 3);
    return;
  }
  gates.review = 'pass';
  gates.reviewBy = t.reviewer ?? 'second AI';
  addActivity(t, 'reviewer', 'Approved the changes');
  t.live = false;
  t.status = 'Proof ready to check';
  t.waiting = { kind: 'proof', summary: 'The proof is ready for you to check' };
  t.squad = null;
}

function markDecisionChecked(bp: BoardPaths, ticketId: string): void {
  for (const d of listDecisions(bp)) {
    if (d.from === ticketId && d.checkedBy && !d.checkedBy.passing) {
      d.checkedBy.passing = true;
      writeDecision(bp, d);
    }
  }
  const meta = readMeta(bp);
  const t = listTickets(bp).find((x) => x.id === ticketId);
  if (t?.kind === 'bug' && !meta.lessons.some((l) => l.from === ticketId)) {
    meta.lessons.unshift({
      id: `L-${String(meta.lessons.length + 1).padStart(3, '0')}`,
      text: `${t.title}. A test now guards it so it cannot come back.`,
      from: ticketId,
      date: now(),
    });
    writeMeta(bp, meta);
  }
}

/** A small clickable mockup for the demo board, like the one the Architect makes for a real ticket. */
function writeDemoMockup(bp: BoardPaths, t: Ticket): string {
  const dir = ticketDir(bp, t.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'mockup.html');
  const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const rows = (t.criteria ?? []).map((c) => `<li>${esc(c.then)}</li>`).join('');
  fs.writeFileSync(
    file,
    `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:14px system-ui,sans-serif;background:#f4f6f8;color:#1b2430;transition:background .3s,color .3s}
body.dark{background:#11161c;color:#e4e9ee}
header{display:flex;align-items:center;gap:12px;padding:14px 20px;background:#1f3a5f;color:#fff}
header b{flex:1;font-size:16px}
button{border:0;border-radius:999px;padding:7px 14px;font:inherit;cursor:pointer;background:#fff;color:#1f3a5f}
main{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;padding:20px}
.card{background:#fff;border-radius:10px;padding:16px;box-shadow:0 1px 2px #0002}
body.dark .card{background:#1b232c}
.card small{opacity:.6}.card h3{margin:6px 0 0;font-size:22px}
ul{margin:0 20px 20px;padding:16px 16px 16px 34px;background:#fff8;border-radius:10px}
body.dark ul{background:#0004}
</style></head><body>
<header><b>${esc(t.title)}</b><button onclick="document.body.classList.toggle('dark')">Switch theme</button></header>
<main><div class="card"><small>Open cases</small><h3>128</h3></div><div class="card"><small>Hearings today</small><h3>14</h3></div><div class="card"><small>Waiting on documents</small><h3>9</h3></div></main>
<ul>${rows}</ul>
</body></html>`,
  );
  return file;
}
