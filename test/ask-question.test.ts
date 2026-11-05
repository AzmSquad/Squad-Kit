import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { Hono } from 'hono';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import type { AgentName, Ticket } from '../src/board/types.js';

/**
 * Ask a question, in every state: one button at the top of the story opens a questions-only chat with whoever knows
 * the story best, and the ticket stays exactly where it was, before and after Done. The AI tool is a fake.
 */

const calls: RunOptions[] = [];
const answers: unknown[] = [];
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    return { ok: true, structured: answers.shift() ?? { reply: 'ok', ready: false }, text: '', sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

const { boardPaths, readMeta, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const server = await import('../src/board/at-review.js');
const board = await import('../console-ui/src/lib/review.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { mountBoardApi } = await import('../src/console/api/board.js');
const { buildPaths } = await import('../src/core/paths.js');
const { queuedLine } = await import('../src/board/now.js');

type Squad = { chatReply(id: string): Promise<void> };

let tmp: string;
let bp: ReturnType<typeof boardPaths>;
const live = () => writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct' });

beforeEach(() => {
  calls.length = 0;
  answers.length = 0;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-ask-')));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Where a ticket stands: everything Ask a question must leave as it was. */
function place(t: Ticket) {
  const { stage, waiting, stuck, live: on, squad, status, takenOver, agentQuestion, dependsOn, dependency, gates, quiet, steps, specApproved, story, criteria } = t;
  return { stage, waiting, stuck, live: on, squad, status, takenOver, agentQuestion, dependsOn, dependency, gates, quiet, steps, specApproved, story, criteria };
}

/** The demo board's tickets, put in each state the button must work in. */
const STATES: { name: string; id: string; agent: AgentName; line: string; set?: (x: Ticket) => void }[] = [
  { name: 'working', id: 'SK-153', agent: 'builder', line: 'SK-153 is being built' },
  {
    name: 'queued',
    id: 'SK-149',
    agent: 'analyst',
    line: 'SK-149 waits in the queue',
    set: (x) => {
      x.squad = { phase: 'analyst-read', nextAt: new Date(Date.now() - 1000).toISOString() };
      x.status = queuedLine(2, 2);
    },
  },
  { name: 'waiting for another story', id: 'SK-152', agent: 'builder', line: 'SK-152 waits for SK-146 to be merged' },
  {
    name: 'stuck before review',
    id: 'SK-153',
    agent: 'builder',
    line: 'SK-153 stopped and waits for your decision',
    set: (x) => {
      x.live = false;
      x.squad = null;
      x.status = 'Stopped: the build broke';
      x.waiting = { kind: 'stuck', summary: 'The squad is stuck and needs one decision' };
      x.stuck = { question: 'The build broke.', options: [{ do: 'retry', name: 'Try again', note: '' }] } as Ticket['stuck'];
    },
  },
  { name: 'stuck at review', id: 'SK-150', agent: 'builder', line: 'SK-150 stopped at a check and waits for your decision' },
  {
    name: 'agent asked',
    id: 'SK-153',
    agent: 'builder',
    line: "SK-153 waits for your answer to the Builder's question",
    set: (x) => {
      x.live = false;
      x.squad = null;
      x.waiting = { kind: 'ask', summary: 'The Builder has a question' };
      x.agentQuestion = { from: 'builder', text: 'One upload at a time, or many?', options: ['One', 'Many'], at: new Date().toISOString() };
    },
  },
  { name: 'taken over', id: 'SK-153', agent: 'builder', line: 'You have SK-153, and the squad waits until you give it back', set: () => undefined },
  { name: 'at review', id: 'SK-139', agent: 'tester', line: 'SK-139 waits for your check' },
  { name: 'released', id: 'SK-138', agent: 'builder', line: 'SK-138 is released in v2.3.1' },
];

describe('Ask a question, in every state', () => {
  for (const s of STATES) {
    it(`${s.name}: a questions-only chat with the ${s.agent}, and the ticket stays where it was`, () => {
      if (s.set) updateTicket(bp, s.id, s.set);
      if (s.name === 'taken over') actions.takeOver(bp, s.id);
      const before = readTicket(bp, s.id)!;
      expect(server.whereItStands(before)).toBe(s.line);
      expect(server.askAgent(before, false)).toBe(s.agent);

      let t = actions.askQuestion(bp, s.id);
      expect(t.chat).toMatchObject({ with: s.agent, open: true, beside: true, thinking: true });
      expect(place(t)).toEqual(place(before));
      expect(t.activity[0]!.text).toBe(`Started asking the ${s.agent[0]!.toUpperCase()}${s.agent.slice(1)}. Questions only: ${s.line}`);

      // Pressed again with the chat open: it opens that chat, nothing changes.
      expect(actions.askQuestion(bp, s.id).chat).toEqual(t.chat);

      // It never writes the spec or the design.
      updateTicket(bp, s.id, (x) => (x.chat!.thinking = false));
      expect(() => actions.chatWrite(bp, s.id)).toThrow(/questions only|for questions/);
      expect(place(readTicket(bp, s.id)!)).toEqual(place(before));

      t = actions.chatDone(bp, s.id);
      expect(t.chat!.open).toBe(false);
      expect(place(t)).toEqual(place(before));
    });
  }

  it('Done while the answer is still written stops that answer only', () => {
    const before = readTicket(bp, 'SK-152')!;
    actions.askQuestion(bp, 'SK-152');
    const t = actions.chatDone(bp, 'SK-152');
    expect(t.chat).toMatchObject({ open: false, stopping: true });
    expect(place(t)).toEqual(place(before));
  });

  it('a running squad is not stopped, and the step it runs stays next', () => {
    const before = readTicket(bp, 'SK-153')!;
    expect(before.live).toBe(true);
    const t = actions.askQuestion(bp, 'SK-153');
    expect(t.stopRequested).toBeFalsy();
    expect(t.squad).toEqual(before.squad);
  });
});

describe('who answers', () => {
  it('the Analyst before the build, the Builder during and after it, the Tester once there are screenshots', () => {
    const t = readTicket(bp, 'SK-139')!;
    const at = (over: Partial<Ticket>) => ({ ...t, proof: [], sessions: {}, ...over });
    expect(server.askAgent(at({ stage: 'specs' }), false)).toBe('analyst');
    expect(server.askAgent(at({ stage: 'implement' }), false)).toBe('builder');
    expect(server.askAgent(at({ stage: 'done' }), false)).toBe('builder');
    expect(server.askAgent(at({}), false)).toBe('builder');
    expect(server.askAgent(t, false)).toBe('tester');
    // The live engine: an agent answers from its own conversation, so one with none yet leaves it to the Analyst.
    expect(server.askAgent(at({ stage: 'implement' }), true)).toBe('analyst');
    expect(server.askAgent(at({ stage: 'implement', sessions: { intake: 'i', build: 'b' } }), true)).toBe('builder');
    expect(server.askAgent(at({ stage: 'specs', sessions: { intake: 'i', build: 'b' } }), true)).toBe('builder');
    expect(server.askAgent({ ...t, sessions: { build: 'b' } }, true)).toBe('analyst');
    expect(server.askAgent({ ...t, sessions: { build: 'b', tester: 'x' } }, true)).toBe('tester');
  });

  it('the board and the engine agree on every ticket, in both engines', () => {
    const tickets = ['SK-138', 'SK-139', 'SK-140', 'SK-143', 'SK-144', 'SK-145', 'SK-148', 'SK-149', 'SK-150', 'SK-151', 'SK-152', 'SK-153'].map((id) => readTicket(bp, id)!);
    const more = [
      { ...tickets[0]!, stage: 'release' as const, release: undefined },
      { ...tickets[11]!, takenOver: { by: 'Sara', at: '', session: 's', cwd: '/x' } },
      { ...tickets[11]!, live: false, squad: null, waiting: { kind: 'ask' as const, summary: '' }, agentQuestion: { from: 'reviewer' as const, text: '?', options: [], at: '' } },
      { ...tickets[7]!, squad: { phase: 'analyst-read', nextAt: '' }, status: queuedLine(1, 1) },
      { ...tickets[11]!, sessions: { intake: 'i', build: 'b' } },
    ];
    for (const t of [...tickets, ...more]) {
      for (const on of [true, false]) expect(board.askAgent(t as never, on), t.id).toBe(server.askAgent(t, on));
      expect(board.whereItStands(t as never)).toBe(server.whereItStands(t));
      expect(board.squadWorks(t as never)).toBe(server.squadWorks(t));
    }
  });

  it('with the live engine, the button goes to the Analyst while the Builder has no conversation yet', () => {
    live();
    let t = actions.askQuestion(bp, 'SK-152');
    expect(t.chat).toMatchObject({ with: 'analyst', beside: true });
    actions.chatDone(bp, 'SK-152');
    updateTicket(bp, 'SK-152', (x) => (x.sessions = { intake: 'i-1', build: 'b-1' }));
    t = actions.askQuestion(bp, 'SK-152');
    expect(t.chat).toMatchObject({ with: 'builder', beside: true });
    // Naming an agent that never worked on it is refused, as for any talk.
    actions.chatDone(bp, 'SK-152');
    expect(() => actions.askQuestion(bp, 'SK-152', 'tester')).toThrow(/has not worked on/);
  });
});

describe('the agent is told where the story stands, and where to look', () => {
  /** A ticket's own copy of the code with one new page since its base. */
  function copy(): { dir: string; base: string } {
    const dir = path.join(tmp, 'copy');
    fs.mkdirSync(dir, { recursive: true });
    const sh = (cmd: string) => execSync(cmd, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    fs.writeFileSync(path.join(dir, 'README.md'), 'app\n');
    sh('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm start');
    const base = sh('git rev-parse HEAD');
    fs.mkdirSync(path.join(dir, 'src', 'pages'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'pages', 'sign-up.tsx'), 'export const route = "/sign-up";\n');
    return { dir, base };
  }

  it('waiting for another story: questions only, where it stands, and the files its copy changed', async () => {
    live();
    writeMeta(bp, { ...readMeta(bp), commands: { url: 'http://localhost:3000' } });
    const c = copy();
    updateTicket(bp, 'SK-152', (x) => {
      x.worktree = c.dir;
      x.baseCommit = c.base;
      x.sessions = { intake: 'i-1', build: 'b-1' };
    });
    actions.askQuestion(bp, 'SK-152');
    answers.push({ reply: 'It waits for SK-146. The new page is /sign-up.', ready: true });
    await (new LiveSquad(bp) as unknown as Squad).chatReply('SK-152');
    const call = calls.at(-1)!;
    expect(call.resume).toBeUndefined();
    expect(call.sessionId).not.toBe('b-1');
    expect(call.cwd).toBe(c.dir);
    expect(call.prompt).toContain('Do not write or change any files');
    expect(call.prompt).toContain('Where the ticket stands, as the person sees it: "SK-152 waits for SK-146 to be merged"');
    expect(call.prompt).toContain('This talk is for questions only');
    expect(call.prompt).toContain("tell them which of the ticket's own buttons on its card does it");
    expect(call.prompt).not.toContain('The squad is working on this ticket right now');
    expect(call.prompt).toContain('Where to look in the app');
    // Nothing runs, and a story that waits for another cannot be tried yet: no address, whatever the settings say.
    expect(call.prompt).toContain("This ticket's own copy of the app is NOT running now");
    expect(call.prompt).toContain('it can be tried once the ticket waits for their check');
    expect(call.prompt).not.toContain('http://localhost:3000');
    expect(call.prompt).toContain('src/pages/sign-up.tsx');
    const t = readTicket(bp, 'SK-152')!;
    expect(t.chat!.ready).toBe(false);
    expect(t.waiting?.kind).toBe('depends');
  });

  it('taken over: the Builder answers in a side conversation, read only, while the person works', async () => {
    live();
    const c = copy();
    updateTicket(bp, 'SK-153', (x) => {
      x.worktree = c.dir;
      x.baseCommit = c.base;
      x.sessions = { intake: 'i-1', build: 'b-1' };
      x.live = false;
      x.squad = null;
    });
    actions.takeOver(bp, 'SK-153');
    const before = readTicket(bp, 'SK-153')!;
    expect(() => actions.startChat(bp, 'SK-153', 'builder')).toThrow(/Give it back first/);
    actions.askQuestion(bp, 'SK-153');
    await (new LiveSquad(bp) as unknown as Squad).chatReply('SK-153');
    const call = calls.at(-1)!;
    expect(call.sessionId).not.toBe('b-1');
    expect(call.resume).toBeUndefined();
    expect(call.prompt).toContain('You have SK-153, and the squad waits until you give it back');
    expect(place(readTicket(bp, 'SK-153')!)).toEqual(place(before));
  });

  it('while the squad works, the talk is beside the work as before', async () => {
    live();
    updateTicket(bp, 'SK-153', (x) => (x.sessions = { intake: 'i-1', build: 'b-1' }));
    actions.askQuestion(bp, 'SK-153');
    await (new LiveSquad(bp) as unknown as Squad).chatReply('SK-153');
    const call = calls.at(-1)!;
    expect(call.prompt).toContain('The squad is working on this ticket right now');
    expect(call.prompt).toContain('This talk is beside the work');
  });

  it('the demo agent says where the story stands', async () => {
    const { tick } = await import('../src/board/engine.js');
    actions.askQuestion(bp, 'SK-152');
    // The demo answers once a beat has passed since the chat started.
    await new Promise((r) => setTimeout(r, 120));
    tick(bp);
    const said = readTicket(bp, 'SK-152')!.chat!.messages.at(-1)!;
    expect(said.who).toBe('builder');
    expect(said.text).toContain('SK-152 waits for SK-146 to be merged. Nothing changes while we talk.');
  });
});

describe('Talk it through stays as it was', () => {
  it('on the questions panel: the talk pauses the questions and may write the spec', () => {
    const before = readTicket(bp, 'SK-148')!;
    expect(before.waiting?.kind).toBe('questions');
    let t = actions.startChat(bp, 'SK-148', 'analyst');
    expect(t.chat!.beside).toBeFalsy();
    expect(t.waiting?.kind).toBe('chat');
    updateTicket(bp, 'SK-148', (x) => (x.chat!.thinking = false));
    t = actions.chatWrite(bp, 'SK-148');
    expect(t.squad?.phase).toBe('chat-spec');
    expect(t.stage).toBe('specs');
  });

  it('on the plan panel: the Architect may write the design', () => {
    updateTicket(bp, 'SK-148', (x) => {
      x.waiting = { kind: 'plan', summary: 'The design is ready for you' };
      x.specApproved = { by: 'Momen', at: new Date().toISOString() } as Ticket['specApproved'];
      x.steps = [{ title: 'Add the toggle', status: 'todo' }] as Ticket['steps'];
    });
    let t = actions.startChat(bp, 'SK-148', 'architect');
    expect(t.chat!.beside).toBeFalsy();
    expect(t.waiting?.kind).toBe('chat');
    updateTicket(bp, 'SK-148', (x) => (x.chat!.thinking = false));
    t = actions.chatWrite(bp, 'SK-148');
    expect(t.squad?.phase).toBe('chat-design');
    expect(t.status).toBe('Architect is updating the design from your talk');
  });

  it('a talk it through that is open already is what the button opens', () => {
    actions.startChat(bp, 'SK-148', 'analyst');
    const t = actions.askQuestion(bp, 'SK-148');
    expect(t.chat).toMatchObject({ with: 'analyst', open: true });
    expect(t.chat!.beside).toBeFalsy();
  });
});

describe('one call, and its terminal command', () => {
  it('POST chat/start with ask picks the agent on the server; again with the chat open changes nothing', async () => {
    const app = new Hono();
    mountBoardApi(app, { paths: buildPaths(tmp) });
    const post = async (body: unknown) => {
      const res = await app.request('/api/v1/tickets/SK-139/chat/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Ticket & { error?: string } };
    };
    const before = readTicket(bp, 'SK-139')!;
    const first = await post({ ask: true });
    expect(first.status).toBe(200);
    expect(first.body.chat).toMatchObject({ with: 'tester', beside: true, open: true });
    expect(place(first.body)).toEqual(place(before));
    const again = await post({ ask: true });
    expect(again.status).toBe(200);
    expect(again.body.chat).toEqual(first.body.chat);
    // Without ask, a second start says a chat is open, as before.
    expect((await post({ with: 'builder' })).body.error).toMatch(/already has a chat open/);
  });

  it('squad chat --ask asks the agent the button would, and leaves the ticket where it was', async () => {
    const prev = process.cwd();
    process.chdir(tmp);
    let said = '';
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((said += String(s)), true));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const { runChat } = await import('../src/commands/board.js');
      const before = readTicket(bp, 'SK-150')!;
      await runChat('SK-150', [], { ask: true });
      const t = readTicket(bp, 'SK-150')!;
      expect(t.chat).toMatchObject({ with: 'builder', beside: true, open: true });
      expect(t.chat!.messages.at(-1)!.who).toBe('builder');
      expect(place(t)).toEqual(place(before));
      expect(said).toContain('Questions only: SK-150 stopped at a check and waits for your decision. Asking changes nothing.');
    } finally {
      out.mockRestore();
      err.mockRestore();
      log.mockRestore();
      process.chdir(prev);
    }
  });
});
