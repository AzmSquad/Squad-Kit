import { randomUUID } from 'node:crypto';
import { addActivity, listDecisions, now, readTicket, writeMeta } from '../../board/store.js';
import { applyPlanEdits, changeSummary } from '../../board/actions.js';
import { scheduleSquad } from '../../board/schedule.js';
import type { DecisionArea, ProjectCommands } from '../../board/types.js';
import { holdTestCommand } from '../not-checked.js';
import * as P from '../prompts.js';
import { partsOf } from '../../board/parts.js';
import { designCommands } from '../self-project.js';
import { reposOfParts } from '../copies.js';
import { dependsProblem } from '../answers.js';
import { designDepends } from '../../board/depends.js';
import { openTicketsFor } from '../depends.js';
import { APPROVING, addDecided } from '../../board/auto.js';
import * as A from '../auto-prompts.js';
import { WORDS_STEP_MS } from './limits.js';
import { type AgentAsk, attachmentDirs, projectRoot } from './shared.js';
import type { LiveSquad } from './squad.js';
import { proposedProofs } from '../../board/proof-lock.js';
import { hasAppToStart } from '../../board/apps.js';

/** The spec and the design. */
export const planPart = {
  /** Full track, step one: the Analyst writes the what (story, done when). You approve it before any design. */
  async spec(this: LiveSquad, id: string, change?: string, fromChat = false): Promise<void> {
    const root = projectRoot(this.bp);
    const t0 = this.update(id, (t) => {
      t.stage = 'specs';
      t.live = true;
      t.status = change ? 'Analyst is updating the spec' : 'Analyst is writing the spec';
      t.sessions = { ...t.sessions, intake: t.sessions?.intake ?? randomUUID() };
    });
    const resume = fromChat || Boolean(t0.activity.some((a) => a.who === 'analyst'));
    // The other open tickets, so the spec does not do what one of them already does (E5).
    const others = await openTicketsFor(this.bp, t0);
    const r = await this.runAgent({
      role: 'analyst',
      step: 'spec',
      ticket: id,
      cwd: root,
      ...(resume ? { resume: t0.sessions!.intake } : { sessionId: t0.sessions!.intake }),
      prompt: resume
        ? P.specPrompt(t0, change, fromChat, others, this.meta())
        : `${P.intakePrompt(this.meta(), listDecisions(this.bp), t0, this.ctx())}\n\n${P.specPrompt(t0, change, false, others, this.meta())}`,
      permissions: ['read'],
      schema: P.SPEC_SCHEMA,
      timeoutMs: WORDS_STEP_MS,
      addDirs: attachmentDirs(t0),
      onTool: this.watcher(id, 'analyst', root),
    });
    const out = r.structured as { story: string; criteria: { given: string; when: string; then: string }[]; releaseNote: string };
    this.update(id, (t) => {
      t.story = out.story;
      t.criteria = proposedProofs(out.criteria, hasAppToStart(this.meta()));
      t.releaseNote = out.releaseNote;
      applyPlanEdits(t);
      delete t.decision;
      delete t.steps;
      delete t.work;
      addActivity(t, 'analyst', fromChat ? (t.planReview?.before ? 'Updated the spec from your talk' : 'Wrote the spec from your talk') : change ? `Updated the spec: ${changeSummary(change)}` : 'Wrote the spec');
      t.changeRequest = undefined;
      t.live = false;
      t.status = 'Spec ready for you';
      t.waiting = { kind: 'spec', summary: 'The spec is ready: is this what you want?' };
      t.squad = null;
    });
  },

  async plan(this: LiveSquad, id: string, change?: string, answered = false, fromChat = false): Promise<void> {
    const root = projectRoot(this.bp);
    const t0 = this.update(id, (t) => {
      t.stage = 'specs';
      t.live = true;
      t.status = change ? (t.specApproved ? 'Architect is updating the design' : 'Spec writer is updating the plan') : 'Architect is choosing the design';
      t.sessions = { ...t.sessions, intake: t.sessions?.intake ?? randomUUID() };
    });
    // An answer to the Architect's own question goes on in its conversation (Builds by itself has no Analyst lines).
    const resume = fromChat || answered || Boolean(readTicket(this.bp, id)?.activity.some((a) => a.who === 'analyst'));
    // Full track: the spec is approved, so the Architect writes only the design. Express writes both at once.
    const design = Boolean(t0.specApproved);
    const asked = answered ? t0.agentQuestion : undefined;
    // The other open tickets and the files their branches changed: the design names the ones it needs (E5).
    const others = await openTicketsFor(this.bp, t0);
    const ask = `${asked ? `${P.answerPrompt(asked, 'architect')}\n\n` : ''}${design ? P.designPrompt(t0, change, this.meta(), fromChat, others) : P.planPrompt(t0, change, this.meta(), others)}`;
    // Builds by itself: the Architect plans with the breakdown in view, and may read the document's text and pictures.
    const brd = t0.track === 'auto' ? A.breakdownFor(this.bp, t0) : null;
    const brief = brd ? A.autoArchitectPrompt(this.meta(), listDecisions(this.bp), t0, this.ctx(), brd.text) : P.intakePrompt(this.meta(), listDecisions(this.bp), t0, this.ctx());
    const r = await this.runAgent({
      role: 'architect',
      step: 'design',
      ticket: id,
      cwd: root,
      ...(resume ? { resume: t0.sessions!.intake } : { sessionId: t0.sessions!.intake }),
      prompt: resume ? ask : `${brief}\n\n${ask}`,
      permissions: ['read'],
      schema: design ? P.DESIGN_SCHEMA : P.PLAN_SCHEMA,
      check: (a) => dependsProblem(a, others.map((o) => o.id), id),
      timeoutMs: WORDS_STEP_MS,
      addDirs: [...attachmentDirs(t0), ...(brd?.dirs ?? [])],
      onTool: this.watcher(id, 'architect', root),
    });
    const out = r.structured as {
      question?: AgentAsk;
      mockup?: string;
      story?: string;
      criteria?: { given: string; when: string; then: string }[];
      decision?: { title: string; options: { name: string; note: string; chosen: boolean }[]; why: string; clientCheck?: string; replaces?: string; area?: DecisionArea };
      follows?: string[];
      dependsOn?: string[];
      steps: string[];
      tests: number;
      screens: number;
      asks?: number;
      releaseNote?: string;
      commands?: ProjectCommands;
      repo?: string;
      parts?: string[];
      decided?: string[];
    };
    if (design) this.askIfNeeded(id, 'architect', out.question);
    const mockup = out.mockup?.trim() && out.screens > 0 ? this.saveMockup(id, out.mockup) : undefined;
    const meta = this.meta();
    // The parts the Architect named, in its order: their repos are the story's copies, and the first is its main one.
    const named = meta.repos?.length ? (out.parts ?? []).map((p) => String(p).trim()) : [];
    const inRepos = reposOfParts(meta, named);
    const repo = meta.repos?.length ? (inRepos[0] ?? meta.repos.find((r) => r.path === out.repo?.replace(/\/$/, ''))?.path ?? meta.repos[0]!.path) : undefined;
    // A new test command waits for the checks to want it, a different one for squad-kit to try it (see not-checked.ts);
    // the others apply at once.
    const held = holdTestCommand((repo && meta.repos ? meta.repos.find((r) => r.path === repo)?.commands : meta.commands) ?? {}, designCommands(this.bp, meta, clean(out.commands ?? {})));
    if (Object.values(held.apply).some(Boolean)) {
      if (repo && meta.repos) {
        meta.repos = meta.repos.map((r) => (r.path === repo ? { ...r, commands: { ...r.commands, ...held.apply } } : r));
      } else {
        meta.commands = { ...(meta.commands ?? {}), ...held.apply };
      }
      writeMeta(this.bp, meta);
    }
    if (held.change) this.log('info', `The design changes the test command from "${held.change.from}" to "${held.change.to}"`, id);
    this.update(id, (t) => {
      if (repo && !t.worktree) t.repo = repo;
      if (inRepos.length) t.parts = named.filter((p) => partsOf(meta).some((x) => x.id === p && !x.shared && !x.off));
      if (held.suggest) t.testSuggestion = held.suggest;
      // A different test command is tried at the checks, after the build; until then the checks keep the current one.
      if (held.change) {
        t.testChange = { ...held.change, ...(repo ? { repo } : {}), at: now() };
        addActivity(t, 'architect', 'The design changes how the tests run. squad-kit tries the new way after the build');
      } else delete t.testChange;
      if (!design) {
        t.story = out.story;
        t.criteria = out.criteria && proposedProofs(out.criteria, hasAppToStart(meta));
        t.releaseNote = out.releaseNote;
      }
      t.agentQuestion = undefined;
      if (mockup) {
        t.mockup = mockup;
        addActivity(t, 'architect', 'Made a mockup of how the screen will look');
      } else if (!out.screens) delete t.mockup;
      if (out.decision) t.decision = { ...out.decision };
      else delete t.decision;
      const known = new Set(listDecisions(this.bp).map((d) => d.id));
      t.follows = [...new Set(out.follows ?? [])].filter((x) => known.has(x));
      t.dependsOn = designDepends(this.bp, t, out.dependsOn);
      if (t.decision?.replaces && !known.has(t.decision.replaces)) delete t.decision.replaces;
      t.steps = out.steps.map((s) => ({ title: s, status: 'todo' }));
      applyPlanEdits(t);
      t.work = { steps: out.steps.length, tests: Math.max(0, out.tests), screens: Math.max(0, out.screens), ...(out.asks ? { asks: Math.max(0, out.asks) } : {}) };
      addActivity(t, design ? 'architect' : 'spec', change ? `Updated the ${design ? 'design' : 'plan'}: ${changeSummary(change)}` : design ? 'Wrote the design' : 'Wrote the plan');
      if (design) addDecided(t, 'architect', out.decided);
      if ((t.track === 'express' || t.track === 'auto') && !change) {
        t.status = t.track === 'auto' ? APPROVING : 'Express track: approving the plan';
        scheduleSquad(t, 'express-approve', 0.2, 1);
        return;
      }
      t.live = false;
      t.status = design ? 'Design ready for you' : 'Plan ready for you';
      t.waiting = { kind: 'plan', summary: design ? 'The design is ready: is this how to build it?' : 'The plan is ready for your approval' };
      t.squad = null;
    });
  },
};

function clean(c: ProjectCommands): ProjectCommands {
  return Object.fromEntries(Object.entries(c).filter(([, v]) => typeof v === 'string' && v.trim())) as ProjectCommands;
}
