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
import { approveExpress, needsSpec } from './actions.js';
import { AMBIENT, scriptFor } from './scripts.js';
import type { BoardMeta, Question, Ticket } from './types.js';

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

export function tick(bp: BoardPaths): void {
  if (!boardExists(bp)) return;
  const meta = readMeta(bp);
  if (meta.engine !== 'demo') return;
  const at = Date.now();
  for (const t of listTickets(bp)) {
    const q = t.questions?.find((x) => x.thinking);
    if (q && at - lastMessageAt(q) >= 2200 / meta.speed) reply(bp, t.id, q.id);
    if (t.squad && Date.parse(t.squad.nextAt) <= at) advance(bp, t.id, meta);
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
          t.live = false;
          t.status = 'Spec ready for you';
          t.waiting = { kind: 'spec', summary: 'The spec is ready: is this what you want?' };
          t.squad = null;
          addActivity(t, 'analyst', state.phase === 'spec-rewrite' ? `Updated the spec: ${t.changeRequest ?? 'your change'}` : 'Wrote the spec');
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
        addActivity(t, design ? 'architect' : 'spec', state.phase === 'plan-rewrite' ? `Updated the ${what}: ${t.changeRequest ?? 'your change'}` : `Wrote the ${what}`);
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
  const dir = path.join(bp.dir, 'attachments', t.id);
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
