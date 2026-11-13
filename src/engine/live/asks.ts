import fs from 'node:fs';
import path from 'node:path';
import { addActivity, now, readTicket, ticketDir } from '../../board/store.js';
import { scheduleSquad } from '../../board/schedule.js';
import type { PortAsk } from '../../board/types.js';
import * as P from '../prompts.js';
import { allowedFile, ticketFolders } from '../conversations.js';
import {
  endProcess,
  folderOf,
  listenerOn,
  ownedBySquadKit,
  processes,
  projectCopies,
  workingFolders,
} from '../leftovers.js';
import {
  STOP_IT,
  cardAnswer,
  goAroundAnswer,
  inTheWay,
  ownWorkAnswer,
  portCard,
  settledAnswer,
  type AroundIt,
} from '../port-ask.js';
import { appPortVariables } from '../port-vars.js';
import { endPid } from '../process-group.js';
import { nextFreePort, portTaken, squadKitOn } from '../run-app.js';
import { addDecided, askWords, cleanSources } from '../../board/auto.js';
import type { DecidedBy } from '../../board/requirements-types.js';
import { type AgentAsk, WaitingForYou } from './shared.js';
import type { LiveSquad } from './squad.js';

/** An agent that asks: the question filter, a busy port, and the person's answer back to the Builder. */
export const asksPart = {
  /**
   * The Builder asked about a busy port or a program in its way (engine/port-ask.ts). A squad-kit leftover holds it:
   * squad-kit stops it and answers the Builder itself. squad-kit's work on another ticket holds it: the Builder is told
   * to leave it alone. Another program holds it: the Builder is told to go around it, with a free port. Only when it asks
   * again about that same program does the person get one plain choice, with the details for engineers. `told` keeps
   * what the Builder was told to go around in this step; left out, the agent is always told (it cannot ask the person).
   * Null when the question is about something else.
   */
  async inTheWay(this: LiveSquad, id: string, q: AgentAsk, told?: Set<string>): Promise<{ answer?: string; ask?: AgentAsk } | null> {
    const hit = inTheWay([q.text, q.why, ...(q.options ?? [])].filter(Boolean).join('\n'));
    if (!hit) return null;
    const copies = projectCopies(this.bp);
    const busy = this.busyCopies(id);
    const outside: PortAsk[] = [];
    const settled: string[] = [];
    const holders = hit.ports.length
      ? hit.ports.map((port) => ({ port, holder: listenerOn(port) }))
      : hit.pids.map((pid) => ({ port: undefined, holder: processes().find((r) => r.pid === pid) ? { pid, program: '' } : null }));
    for (const { port, holder } of holders) {
      if (!holder) {
        // Taken, by a program the system will not name (another user's): only the person can do something about it.
        if (port && (await portTaken(port))) outside.push({ port, pid: 0, asked: q.text.trim() });
        else settled.push(port ? `Port ${port} is free now; carry on. Run what you needed it for again, then go on with the work.` : 'That program has ended; carry on with the work.');
        continue;
      }
      if ((await this.clearCopies(copies, { busy, only: [holder.pid] }, id)).length) {
        settled.push(settledAnswer({ ...(port ? { port } : {}) }));
        continue;
      }
      // One of the project's apps squad-kit runs from Your apps: the person's to stop, from the card.
      const app = port ? squadKitOn(this.bp, port)?.app : undefined;
      const cwd = workingFolders([holder.pid]).get(holder.pid);
      if (!app && (ownedBySquadKit(holder.pid) || (cwd && folderOf(cwd, copies)))) {
        settled.push(ownWorkAnswer(await this.aroundIt(id, port)));
        continue;
      }
      outside.push({ ...(port ? { port } : {}), pid: holder.pid, ...(holder.program ? { program: holder.program } : {}), ...(app ? { app } : {}), asked: q.text.trim() });
    }
    const key = (p: PortAsk) => (p.port ? `port ${p.port}` : `process ${p.pid}`);
    const again = outside.find((p) => told?.has(key(p)));
    if (again) {
      const card = portCard(again);
      this.log('info', `The Builder asked again about ${key(again)}, held by ${again.program || 'a program'}${again.pid ? ` (process ${again.pid})` : ''}: it asks the person`, id);
      return { ask: { text: card.text, options: card.options, why: card.why, port: again } };
    }
    // First the way around it: another port. Nothing that is not squad-kit's is stopped without the person's press.
    for (const p of outside) {
      told?.add(key(p));
      settled.push(goAroundAnswer(await this.aroundIt(id, p.port)));
    }
    this.log('info', `Asked about ${[...hit.ports.map((p) => `port ${p}`), ...hit.pids.map((p) => `process ${p}`)].join(', ')}: ${settled.join(' ')}`, id);
    this.update(id, (x) =>
      addActivity(x, 'squad', outside.length ? 'Another program on this computer was in the way, so squad-kit showed how to go around it. The work carries on' : 'Something squad-kit left running was in the way. squad-kit dealt with it, and the work carries on'),
    );
    return { answer: settled.join('\n') };
  },

  /** The busy port, a free one near it, and the app's own port settings to set it in, for the agent to run on. */
  async aroundIt(this: LiveSquad, id: string, port?: number): Promise<AroundIt> {
    if (!port) return {};
    const free = await nextFreePort(port);
    const cwd = readTicket(this.bp, id)?.worktree;
    const vars = cwd && fs.existsSync(cwd) ? appPortVariables(cwd, port) : [];
    return { port, ...(free ? { free } : {}), ...(vars.length ? { vars } : {}) };
  },

  /** The person chose on the plain card about a program in the way. "Stop it" stops that program, checked again first. */
  async portAnswer(this: LiveSquad, id: string, p: PortAsk, choice: string): Promise<string> {
    if (choice !== STOP_IT) return cardAnswer(p, choice, null);
    // Checked again now, never from what the card said: only the very program the person saw is stopped.
    const now = p.port ? listenerOn(p.port) : processes().find((r) => r.pid === p.pid) ?? null;
    let stopped = !now && !(p.port && (await portTaken(p.port)));
    const app = p.port ? squadKitOn(this.bp, p.port) : null;
    // squad-kit itself and what it runs now are never stopped this way; one of Your apps stops as a whole.
    if (p.pid > 0 && now?.pid === p.pid && (app?.app || !ownedBySquadKit(p.pid))) {
      if (app?.app) await endPid(app.group);
      else await endProcess(p.pid);
      stopped = p.port ? !(await portTaken(p.port)) : !processes().some((r) => r.pid === p.pid);
    }
    // The port and the process are for engineers: on the card's details, and here.
    this.log('info', `${stopped ? 'Stopped' : 'Could not stop'} ${p.port ? `the program on port ${p.port}` : 'the program in the way'} (process ${p.pid}), as the person asked`, id);
    this.update(id, (x) => addActivity(x, 'squad', stopped ? 'Stopped the other program, as you asked' : 'Could not stop the other program, so the Builder goes on without it'));
    return cardAnswer(p, choice, stopped);
  },

  /** The person answered the Builder: the same conversation carries on, then the checks run as after any build. */
  async builderAnswered(this: LiveSquad, id: string): Promise<void> {
    const t = await this.workspace(id);
    this.update(id, (x) => {
      x.stage = 'implement';
      x.live = true;
    });
    const q = t.agentQuestion;
    await this.runBuilder(id, q?.port ? await this.portAnswer(id, q.port, q.answer ?? '') : P.answerPrompt(q ?? { text: '' }, 'builder'), true, 'build');
    this.update(id, (x) => {
      for (const s of x.steps ?? []) {
        s.status = 'done';
        s.live = undefined;
      }
      x.progress = 100;
      x.agentQuestion = undefined;
      addActivity(x, 'builder', 'Carried on with your answer and finished');
      x.stage = 'test';
      x.status = 'Running the project checks';
      scheduleSquad(x, 'test', 0.2, 1);
    });
  },

  /**
   * An agent filled "question" in its answer: pause the ticket in Waiting for you. The answer goes back into the same
   * session. Throws WaitingForYou so the step stops here without counting as a failure.
   */
  askIfNeeded(this: LiveSquad, id: string, from: 'architect' | 'builder' | 'reviewer', q: AgentAsk | undefined): void {
    if (!q?.text?.trim()) return;
    const who = { architect: 'Architect', builder: 'Builder', reviewer: 'Reviewer' }[from];
    this.update(id, (x) => {
      // Only files the board may show: inside the ticket's copy, its proof or its attachments.
      const folders = ticketFolders(x, this.bp);
      const files = (q.files ?? []).map((f) => allowedFile(f.replace(/^file:\/\//, ''), folders)).filter((f): f is string => Boolean(f)).slice(0, 6);
      // Builds by itself: why it stops, a gap or a clash, and where that comes from. Other tracks keep their usual words.
      const kind = x.track === 'auto' && (q.kind === 'gap' || q.kind === 'clash') ? q.kind : undefined;
      const sources = kind ? cleanSources(q.sources) : [];
      x.agentQuestion = {
        from,
        text: q.text.trim(),
        options: (q.options ?? []).filter((o) => o.trim()).slice(0, 4),
        ...(q.why ? { why: q.why } : {}),
        ...(files.length ? { files } : {}),
        ...(q.port ? { port: q.port } : {}),
        ...(kind ? { kind } : {}),
        ...(sources.length ? { sources } : {}),
        at: now(),
      };
      const words = askWords(who, kind);
      x.live = false;
      x.squad = null;
      x.status = words.status;
      x.waiting = { kind: 'ask', summary: words.summary };
      addActivity(x, from, `Asked you: ${q.text.trim()}${files.length ? ` (with ${files.length} ${files.length === 1 ? 'file' : 'files'})` : ''}`);
    });
    throw new WaitingForYou();
  },

  /** Builds by itself: the small choices an agent made instead of asking go on the ticket as "Decided for you". */
  saveDecided(this: LiveSquad, id: string, by: DecidedBy, out: unknown): void {
    const decided = (out as { decided?: unknown } | undefined)?.decided;
    if (!Array.isArray(decided) || !decided.length || readTicket(this.bp, id)?.track !== 'auto') return;
    this.update(id, (x) => addDecided(x, by, decided));
  },

  /** The Architect's mockup is text in its answer (it only reads); squad-kit saves it with the ticket's files. */
  saveMockup(this: LiveSquad, id: string, html: string): string {
    const dir = ticketDir(this.bp, id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'mockup.html');
    fs.writeFileSync(file, html);
    return file;
  },
};
