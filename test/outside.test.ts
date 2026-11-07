import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addActivity, boardPaths, readMeta, readTicket, requireTicket, ticketDir, updateTicket, writeMeta, writeTicket, type BoardPaths } from '../src/board/store.js';
import { seedDemoBoard } from '../src/board/demo.js';
import * as actions from '../src/board/actions.js';
import { bringBack, checkOutside, recordApproval, workOutside } from '../src/board/outside.js';
import { markCheckedOutside, outsideWords } from '../src/board/outside-step.js';
import { readTicketDocs, shapeTroubles, ticketDocs } from '../src/board/docs.js';
import { GUIDE_FILE, SAMPLE_DOCS, guideText, lookAtFiles, outsidePrompt, writeGuide } from '../src/engine/outside-guide.js';
import { LiveSquad } from '../src/engine/live.js';
import { whereItStands } from '../src/board/at-review.js';
import { lockFile } from '../src/board/lock.js';

let tmp: string;
let bp: BoardPaths;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-outside-')));
  git(tmp, 'init', '-q', '-b', 'main');
  git(tmp, 'config', 'user.name', 'Test');
  git(tmp, 'config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(tmp, 'app.txt'), 'one\n');
  git(tmp, 'add', 'app.txt');
  git(tmp, 'commit', '-q', '-m', 'first');
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  for (const t of fs.readdirSync(bp.ticketsDir)) fs.rmSync(path.join(bp.ticketsDir, t), { recursive: true, force: true });
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', git: { base: 'main', remote: '' } } as ReturnType<typeof readMeta>);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const SPEC = SAMPLE_DOCS['spec.md']!;
const DESIGN = SAMPLE_DOCS['design.md']!;

function write(id: string, file: string, text: string) {
  fs.writeFileSync(path.join(ticketDir(bp, id), file), text);
}

/** A story waiting for its proof, with a real copy holding real code. */
async function withCopy(id: string) {
  await new LiveSquad(bp).copyForOutside(id);
  return requireTicket(bp, id);
}

describe('moving a story out', () => {
  it('keeps the squad off it, whatever it was doing', async () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings' });
    expect(t.squad?.phase).toBe('analyst-read');
    const out = await workOutside(bp, t.id);
    expect(out.takenOver?.free).toBeTruthy();
    expect(out.squad).toBeNull();
    expect(out.live).toBe(false);
    expect(out.waiting?.kind).toBe('yours');
    expect(whereItStands(out)).toContain('outside squad-kit');
  });

  it('stays out when pressed again, and does not forget what it left', async () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings' });
    const first = await workOutside(bp, t.id);
    const again = await workOutside(bp, t.id);
    expect(again.takenOver?.free).toEqual(first.takenOver?.free);
  });

  it.each([
    ['a story someone else owns', (x: any) => (x.owner = 'Someone Else'), 'Someone Else'],
    ['a story being deleted', (x: any) => (x.deleting = { at: 'now', by: 'me' }), 'being deleted'],
    ['an archived story', (x: any) => (x.archived = { at: 'now', by: 'me' }), 'archived'],
    ['an accepted story', (x: any) => (x.stage = 'release'), 'accepted'],
    ['a released story', (x: any) => (x.stage = 'done'), 'accepted'],
    ['a story with a chat open', (x: any) => (x.chat = { open: true, messages: [], with: 'analyst' }), 'chat'],
    ['a story taken over', (x: any) => (x.takenOver = { by: 'me', at: 'now', session: 's', cwd: '/x' }), 'yours already'],
  ])('refuses %s', async (_name, change, words) => {
    const t = actions.createTicket(bp, { title: 'Limit bookings' });
    updateTicket(bp, t.id, change);
    await expect(workOutside(bp, t.id)).rejects.toThrow(words);
  });

  it('with a squad alive, a running step finishes or stops first, and then it can go', async () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings' });
    fs.mkdirSync(path.dirname(lockFile(bp)), { recursive: true });
    fs.writeFileSync(lockFile(bp), String(process.pid));
    await expect(workOutside(bp, t.id)).rejects.toThrow('press Stop first');
    updateTicket(bp, t.id, (x) => {
      x.stopRequested = true;
    });
    await expect(workOutside(bp, t.id)).rejects.toThrow('press Stop first');
    updateTicket(bp, t.id, (x) => {
      x.stopRequested = undefined;
      x.live = false;
      x.squad = null;
      x.waiting = { kind: 'stuck', summary: 'Stopped' };
    });
    const out = await workOutside(bp, t.id);
    expect(out.takenOver?.free?.waiting?.kind).toBe('stuck');
    const back = await bringBack(bp, t.id);
    expect(back.waiting?.kind).toBe('stuck');
    expect(back.squad).toBeNull();
  });

  it('refuses with a change still open', async () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings' });
    updateTicket(bp, t.id, (x) => (x.changes = [{ id: 'c1', ask: 'More', by: 'me', at: 'now', status: 'proposed' }]));
    await expect(workOutside(bp, t.id)).rejects.toThrow('change still open');
  });

  it('no change can be proposed while it is out', () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings', outside: true });
    expect(() => actions.proposeChange(bp, t.id, 'More')).toThrow('outside squad-kit');
  });

  it('refuses on the sample board', async () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings' });
    writeMeta(bp, { ...readMeta(bp), engine: 'demo' } as ReturnType<typeof readMeta>);
    await expect(workOutside(bp, t.id)).rejects.toThrow('sample board');
  });

  it('a step the squad ends while it is out does not move it on', () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings', outside: true });
    expect(t.squad).toBeNull();
    const squad = new LiveSquad(bp) as unknown as { update(id: string, change: (x: any) => void): any };
    const after = squad.update(t.id, (x) => {
      x.waiting = { kind: 'spec', summary: 'Ready' };
      x.live = true;
    });
    expect(after.waiting.kind).toBe('yours');
    expect(after.waiting.summary).toContain('outside squad-kit');
    expect(after.live).toBe(false);
  });

  it('Give back says to bring it back instead', async () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings', outside: true });
    expect(() => actions.giveBack(bp, t.id)).toThrow('Bring it back');
  });
});

describe('the real step comes from its files', () => {
  it('moves on as the files are written, and never back before where it left', async () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings', outside: true });
    expect(requireTicket(bp, t.id).stage).toBe('tickets');
    write(t.id, 'spec.md', SPEC);
    expect(requireTicket(bp, t.id).stage).toBe('specs');
    expect(requireTicket(bp, t.id).status).toContain('spec is written');
    write(t.id, 'design.md', DESIGN);
    expect(requireTicket(bp, t.id).status).toContain('design is written');
    await withCopy(t.id);
    expect(requireTicket(bp, t.id).stage).toBe('implement');
    expect(requireTicket(bp, t.id).status).toContain('building');
  });

  it('a story that left at the review stays at the review', async () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings' });
    updateTicket(bp, t.id, (x) => {
      x.stage = 'review';
      x.squad = null;
      x.live = false;
      x.waiting = { kind: 'proof', summary: 'Ready' };
    });
    const out = await workOutside(bp, t.id);
    expect(out.stage).toBe('review');
    expect(out.takenOver?.free?.from).toBe('the proof');
  });
});

describe('bringing it back', () => {
  it('with nothing changed it is as it was, with no label', async () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings' });
    updateTicket(bp, t.id, (x) => {
      x.story = 'A story';
      x.stage = 'specs';
      x.squad = null;
      x.live = false;
      x.status = 'Spec ready for you';
      x.waiting = { kind: 'spec', summary: 'Is this right?' };
    });
    await workOutside(bp, t.id);
    const back = await bringBack(bp, t.id);
    expect(back.outside).toBeUndefined();
    expect(back.takenOver).toBeUndefined();
    expect(back.stage).toBe('specs');
    expect(back.status).toBe('Spec ready for you');
    expect(back.waiting).toEqual({ kind: 'spec', summary: 'Is this right?' });
    expect(back.stopRequested).toBeUndefined();
  });

  it('with nothing changed the step that ran starts again', async () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings' });
    await workOutside(bp, t.id);
    const back = await bringBack(bp, t.id);
    expect(back.squad?.phase).toBe('analyst-read');
    expect(back.live).toBe(true);
    expect(back.outside).toBeUndefined();
  });

  it('with a spec: the person approves it, and the label says all of it was outside', async () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings', outside: true });
    write(t.id, 'spec.md', SPEC);
    const back = await bringBack(bp, t.id);
    expect(back.waiting?.kind).toBe('spec');
    expect(back.stage).toBe('specs');
    expect(back.squad).toBeNull();
    expect(outsideWords(back.outside!)).toBe('Worked outside squad-kit');
  });

  it('with a spec approved in the conversation: the squad writes the design', async () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings', outside: true });
    write(t.id, 'spec.md', SPEC);
    recordApproval(bp, t.id, 'spec');
    const back = await bringBack(bp, t.id);
    expect(back.waiting).toBeNull();
    expect(back.squad?.phase).toBe('plan-write');
    expect(back.specApproved?.by).toContain('outside squad-kit');
  });

  it('with a design: the person approves it, then the squad builds', async () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings', outside: true });
    write(t.id, 'spec.md', SPEC);
    write(t.id, 'design.md', DESIGN);
    const back = await bringBack(bp, t.id);
    expect(back.waiting?.kind).toBe('plan');
    const approved = actions.approve(bp, t.id);
    expect(approved.stage).toBe('implement');
    expect(approved.squad?.phase).toBe('build');
    expect(approved.specApproved).toBeTruthy();
    expect(approved.decision?.adr).toBeTruthy();
  });

  it('with a design approved in the conversation: the decision is saved and the squad builds', async () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings', outside: true });
    write(t.id, 'spec.md', SPEC);
    write(t.id, 'design.md', DESIGN);
    recordApproval(bp, t.id, 'design');
    const back = await bringBack(bp, t.id);
    expect(back.stage).toBe('implement');
    expect(back.squad?.phase).toBe('build');
    expect(back.decision?.adr).toBeTruthy();
    expect(back.outside).toBeTruthy();
  });

  it('with a design on a track that approves its own plan: the squad goes on', async () => {
    const t = actions.createTicket(bp, { title: 'Fix a typo', track: 'express', outside: true });
    write(t.id, 'spec.md', SPEC);
    write(t.id, 'design.md', DESIGN);
    const back = await bringBack(bp, t.id);
    expect(back.waiting).toBeNull();
    expect(back.squad?.phase).toBe('express-approve');
  });

  it('with code: the proof card, nothing counted as passed, and it can merge', async () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings', outside: true });
    write(t.id, 'spec.md', SPEC);
    write(t.id, 'design.md', DESIGN);
    recordApproval(bp, t.id, 'design');
    const made = await withCopy(t.id);
    fs.writeFileSync(path.join(made.worktree!, 'app.txt'), 'two\n');
    const back = await bringBack(bp, t.id);
    expect(back.stage).toBe('review');
    expect(back.waiting?.kind).toBe('proof');
    expect(back.gates).toEqual({ checks: 'pending', review: 'pending', proof: 'pending' });
    expect(back.steps?.every((s) => s.status === 'done')).toBe(true);
    expect(back.decision?.adr).toBeTruthy();
    expect(back.outside?.checked).toBeUndefined();
    const done = actions.acceptProof(bp, requireTicket(bp, t.id), undefined, { noHooks: true });
    expect(done.stage).toBe('release');
    expect(done.outside).toBeTruthy();
    expect(done.activity.some((a) => a.text.includes('no check by squad-kit'))).toBe(true);
    expect(fs.readFileSync(path.join(tmp, 'app.txt'), 'utf8')).toBe('two\n');
    expect(git(tmp, 'show', 'main:app.txt')).toBe('two');
  });

  it('a copy with no code is not built', async () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings', outside: true });
    write(t.id, 'spec.md', SPEC);
    write(t.id, 'design.md', DESIGN);
    await withCopy(t.id);
    const back = await bringBack(bp, t.id);
    expect(back.waiting?.kind).toBe('plan');
  });

  it('the label keeps the step it first left at, and a new trip takes Checked away', async () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings' });
    updateTicket(bp, t.id, (x) => {
      x.story = 'A story';
      x.criteria = [{ given: 'a', when: 'b', then: 'c' }];
      x.specApproved = { by: 'me', at: 'now' };
      x.stage = 'specs';
      x.squad = null;
      x.live = false;
      x.waiting = null;
    });
    await workOutside(bp, t.id);
    write(t.id, 'design.md', DESIGN);
    const once = await bringBack(bp, t.id);
    expect(outsideWords(once.outside!)).toBe('Continued outside from the design');
    updateTicket(bp, t.id, (x) => {
      x.outside = { ...x.outside!, checked: { at: 'now', by: 'squad-kit' } };
      x.stage = 'implement';
      x.squad = null;
      x.waiting = null;
      x.live = false;
    });
    await workOutside(bp, t.id);
    const made = await withCopy(t.id);
    fs.writeFileSync(path.join(made.worktree!, 'app.txt'), 'two\n');
    const twice = await bringBack(bp, t.id);
    expect(outsideWords(twice.outside!)).toBe('Continued outside from the design');
    expect(twice.outside?.checked).toBeUndefined();
  });

  it('the label is in ticket.md, so it stays on the record and travels with the story', async () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings', outside: true });
    write(t.id, 'spec.md', SPEC);
    await bringBack(bp, t.id);
    expect(fs.readFileSync(path.join(ticketDir(bp, t.id), 'ticket.md'), 'utf8')).toContain('outside:');
  });

  it('an edit with nothing committed is a change, even a line swapped in a file already changed', async () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings', outside: true });
    write(t.id, 'spec.md', SPEC);
    const made = await withCopy(t.id);
    const file = path.join(made.worktree!, 'app.txt');
    fs.writeFileSync(file, 'two\n');
    await bringBack(bp, t.id);
    await workOutside(bp, t.id);
    fs.writeFileSync(file, 'six\n');
    const back = await bringBack(bp, t.id);
    expect(back.activity.some((a) => a.text.includes('Nothing changed'))).toBe(false);
    expect(back.waiting?.summary).toContain('has not checked');
  });

  it('an untracked file added outside is a change', async () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings', outside: true });
    write(t.id, 'spec.md', SPEC);
    const made = await withCopy(t.id);
    fs.writeFileSync(path.join(made.worktree!, 'app.txt'), 'two\n');
    await bringBack(bp, t.id);
    updateTicket(bp, t.id, (x) => {
      x.outside = undefined;
      x.gates = { checks: 'pass', review: 'pass', proof: 'pass' };
    });
    await workOutside(bp, t.id);
    fs.writeFileSync(path.join(made.worktree!, 'new.txt'), 'new\n');
    const back = await bringBack(bp, t.id);
    expect(back.outside).toBeTruthy();
    expect(back.gates?.checks).toBe('pending');
  });

  it('work still there and not touched outside: as it was, gates and all', async () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings', outside: true });
    write(t.id, 'spec.md', SPEC);
    const made = await withCopy(t.id);
    fs.writeFileSync(path.join(made.worktree!, 'app.txt'), 'two\n');
    await bringBack(bp, t.id);
    updateTicket(bp, t.id, (x) => {
      x.outside = undefined;
      x.gates = { checks: 'pass', review: 'pass', proof: 'pass' };
    });
    await workOutside(bp, t.id);
    const back = await bringBack(bp, t.id);
    expect(back.outside).toBeUndefined();
    expect(back.gates?.checks).toBe('pass');
  });

  it('an approval given in the conversation counts, with no file changed', async () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings' });
    write(t.id, 'spec.md', SPEC);
    write(t.id, 'design.md', DESIGN);
    updateTicket(bp, t.id, (x) => {
      x.stage = 'specs';
      x.squad = null;
      x.live = false;
      x.waiting = { kind: 'plan', summary: 'Is this how?' };
    });
    await workOutside(bp, t.id);
    recordApproval(bp, t.id, 'design');
    const back = await bringBack(bp, t.id);
    expect(back.stage).toBe('implement');
    expect(back.squad?.phase).toBe('build');
    expect(back.decision?.adr).toBeTruthy();
  });

  it('refuses a story that is not out', async () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings' });
    await expect(bringBack(bp, t.id)).rejects.toThrow('not in a conversation');
  });

  it('a file it cannot read stops it coming back, and names the file', async () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings', outside: true });
    write(t.id, 'spec.md', '# Limit bookings\n\nJust some free text about the story.\n');
    await expect(bringBack(bp, t.id)).rejects.toThrow();
    expect(lookAtFiles(bp, t.id).problems.some((p) => p.file === 'spec.md')).toBe(true);
    write(t.id, 'spec.md', SPEC);
    expect((await bringBack(bp, t.id)).waiting?.kind).toBe('spec');
  });
});

describe('Check', () => {
  async function builtBack() {
    const t = actions.createTicket(bp, { title: 'Limit bookings', outside: true });
    write(t.id, 'spec.md', SPEC);
    const made = await withCopy(t.id);
    fs.writeFileSync(path.join(made.worktree!, 'app.txt'), 'two\n');
    return bringBack(bp, t.id);
  }

  it('runs the checks, the review and the proof by the squad', async () => {
    const back = await builtBack();
    const t = checkOutside(bp, back.id);
    expect(t.squad?.phase).toBe('test');
    expect(t.stage).toBe('test');
    expect(t.waiting).toBeNull();
    expect(t.live).toBe(true);
    expect(t.gates).toEqual({ checks: 'pending', review: 'pending', proof: 'pending' });
  });

  it('refuses while it is still out, and when no built work waits', async () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings', outside: true });
    write(t.id, 'spec.md', SPEC);
    updateTicket(bp, t.id, (x) => (x.outside = { by: 'me', at: 'now' }));
    expect(() => checkOutside(bp, t.id)).toThrow('Bring it back');
    await bringBack(bp, t.id);
    expect(() => checkOutside(bp, t.id)).toThrow('no built work');
  });

  it('refuses with no "Done when" to check against', async () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings', outside: true });
    const made = await withCopy(t.id);
    fs.writeFileSync(path.join(made.worktree!, 'app.txt'), 'two\n');
    await bringBack(bp, t.id);
    expect(() => checkOutside(bp, t.id)).toThrow('Done when');
  });

  it('refuses a story that was never outside', () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings' });
    expect(() => checkOutside(bp, t.id)).toThrow('not worked on outside');
  });

  it('Checked ends when more work is asked for, or a gate is gone past', async () => {
    const back = await builtBack();
    updateTicket(bp, back.id, (x) => {
      x.gates = { checks: 'pass', review: 'pass', proof: 'pass' };
      x.outside = { ...x.outside!, checked: { at: 'now', by: 'squad-kit' } };
    });
    expect(requireTicket(bp, back.id).outside?.checked).toBeTruthy();
    updateTicket(bp, back.id, (x) => (x.gates = { checks: 'pass', review: 'pass', proof: 'skipped' }));
    expect(requireTicket(bp, back.id).outside?.checked).toBeUndefined();
    expect(requireTicket(bp, back.id).outside?.by).toBeTruthy();
  });

  it('Take over says why there is no session to open', async () => {
    const back = await builtBack();
    expect(() => actions.takeOver(bp, back.id)).toThrow('built outside');
  });

  it('the Builder gets a conversation of its own, with the story first', async () => {
    const back = await builtBack();
    const squad = new LiveSquad(bp) as unknown as { runBuilder(id: string, prompt: string, resume: boolean): Promise<void>; runAgent: unknown };
    const asked: { prompt: string; sessionId?: string; resume?: string }[] = [];
    squad.runAgent = async (o: { prompt: string; sessionId?: string; resume?: string }) => {
      asked.push(o);
      throw new Error('enough');
    };
    await squad.runBuilder(back.id, 'Fix the empty list', false).catch(() => undefined);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.sessionId).toBeTruthy();
    expect(asked[0]!.resume).toBeUndefined();
    expect(asked[0]!.prompt).toContain('People with no email can sign in');
    expect(asked[0]!.prompt).toContain('built outside squad-kit');
    expect(asked[0]!.prompt).toContain('Fix the empty list');
    expect(requireTicket(bp, back.id).sessions?.build).toBe(asked[0]!.sessionId);
  });

  it('the Tester looks for screens on a story designed outside', async () => {
    const { changesScreens } = await import('../src/board/outside-step.js');
    const back = await builtBack();
    expect(changesScreens(back)).toBe(true);
    expect(changesScreens({ ...back, work: { steps: 1, tests: 1, screens: 0 } })).toBe(false);
    expect(changesScreens({ work: undefined, outside: undefined })).toBe(false);
  });

  it('Checked only when no gate was gone past', async () => {
    const back = await builtBack();
    const pass = { ...back, gates: { checks: 'pass', review: 'pass', proof: 'pass' } } as typeof back;
    markCheckedOutside(pass);
    expect(pass.outside?.checked?.by).toBe('squad-kit');
    expect(pass.outside?.checked?.noTests).toBeUndefined();
    const noTests = { ...back, gates: { checks: 'unchecked', review: 'pass', proof: 'pass' } } as typeof back;
    markCheckedOutside(noTests);
    expect(noTests.outside?.checked?.noTests).toBe(true);
    for (const gates of [{ checks: 'skipped', review: 'pass', proof: 'pass' }, { checks: 'pass', review: 'skipped', proof: 'pass' }, { checks: 'pass', review: 'pass', proof: 'skipped' }]) {
      const past = { ...back, gates } as typeof back;
      markCheckedOutside(past);
      expect(past.outside?.checked).toBeUndefined();
    }
  });
});

describe('the guide', () => {
  it('shows shapes that read back the same', () => {
    const read = readTicketDocs({ 'ticket.md': '---\nid: SK-1\n---\n# t\n', ...SAMPLE_DOCS });
    expect(read.criteria).toHaveLength(2);
    expect(read.criteria?.[0]?.then).toBe('they are signed in');
    expect(read.steps).toHaveLength(3);
    expect(read.decision?.options.find((o) => o.chosen)?.name).toBe('In the database');
    expect(read.questions?.[0]?.answer?.choice).toBe('After 5 minutes');
    expect(shapeTroubles(SAMPLE_DOCS)).toEqual([]);
  });

  it('holds each shape, as written by the code that writes them', () => {
    const text = guideText(bp);
    for (const file of ['spec.md', 'design.md', 'questions.md']) expect(text).toContain(SAMPLE_DOCS[file]!.trimEnd());
    expect(ticketDocs({ id: 'SK-1', title: 'x', story: 'y' })['spec.md']).toContain('## Story');
  });

  it('names the commands that exist', () => {
    const cli = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.ts'), 'utf8');
    for (const [, name] of guideText(bp).matchAll(/squad outside (\w+)/g)) expect(cli).toContain(`.command('${name}`);
  });

  it('is written once, stays out of git, and is written again after a change', () => {
    const file = writeGuide(bp);
    expect(path.basename(file)).toBe(GUIDE_FILE);
    expect(git(tmp, 'status', '--porcelain', '--', `.squad/${GUIDE_FILE}`)).toBe('');
    fs.writeFileSync(file, 'old words');
    writeGuide(bp);
    expect(fs.readFileSync(file, 'utf8')).toBe(guideText(bp));
    const exclude = fs.readFileSync(path.join(tmp, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter((l) => l.endsWith(GUIDE_FILE))).toHaveLength(1);
    writeGuide(bp);
    expect(fs.readFileSync(path.join(tmp, '.git', 'info', 'exclude'), 'utf8')).toBe(exclude);
  });
});

describe('the prompt follows the state', () => {
  it('a new story says to start one', () => {
    const p = outsidePrompt(bp);
    expect(p).toContain('new story');
    expect(p).toContain(bp.root);
    expect(p).toContain(GUIDE_FILE);
  });

  it('says what is done and what comes next, at each step', async () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings', outside: true });
    expect(outsidePrompt(bp, requireTicket(bp, t.id))).toContain('Next: Write the spec');
    write(t.id, 'spec.md', SPEC);
    const spec = outsidePrompt(bp, requireTicket(bp, t.id));
    expect(spec).toContain('The spec is written, and not approved yet');
    expect(spec).toContain('Next: Show the spec');
    recordApproval(bp, t.id, 'spec');
    expect(outsidePrompt(bp, requireTicket(bp, t.id))).toContain('Next: Write the design');
    write(t.id, 'design.md', DESIGN);
    expect(outsidePrompt(bp, requireTicket(bp, t.id))).toContain('Next: Show the design');
    recordApproval(bp, t.id, 'design');
    expect(outsidePrompt(bp, requireTicket(bp, t.id))).toContain('Next: Make the copy');
    const made = await withCopy(t.id);
    const built = outsidePrompt(bp, made);
    expect(built).toContain(made.worktree!);
    expect(built).toContain('Next: Build what is left');
    expect(built).toContain(`squad outside back ${t.id}`);
  });

  it('carries what is still open: a stop, the Reviewer, the person', () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings' });
    const open = updateTicket(bp, t.id, (x) => {
      x.stuck = { question: 'The checks failed twice', options: [] };
      x.reviewNotes = ['Handle the empty list'];
      x.changeRequest = 'Make the button bigger';
      x.notes = [{ at: 'now', by: 'me', kind: 'note', text: 'Also this' }];
    });
    const p = outsidePrompt(bp, open);
    expect(p).toContain('The checks failed twice');
    expect(p).toContain('Handle the empty list');
    expect(p).toContain('Make the button bigger');
    expect(p).toContain('notes.md');
  });
});

describe('squad outside show: which file and why', () => {
  it('says all is well on good files', () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings', outside: true });
    write(t.id, 'spec.md', SPEC);
    write(t.id, 'design.md', DESIGN);
    expect(lookAtFiles(bp, t.id).problems).toEqual([]);
  });

  it.each([
    ['spec.md', '# t\n\n## Acceptance criteria\n\n- it works\n', 'Acceptance criteria'],
    ['spec.md', '# t\n\n## Story\n\nA story\n\n## Done when\n\n1. it works\n', 'not read'],
    ['spec.md', '# t\n\n## Story\n\nA story\n\n## Done when\n\n', 'nothing under it'],
    ['design.md', '# t\n\n## Approach\n\nDo it.\n', 'Approach'],
    ['design.md', '# t: design\n\n## Steps\n\n- do it\n', 'numbered'],
    ['design.md', '# t: design\n\n## Decision: A\n\n### Options\n\n- [ ] One\n\n### Why\n\nWhy\n\n## Steps\n\n1. Do it\n', 'chosen'],
    ['design.md', '# t: design\n\n## Decision: A\n\n### Why\n\nWhy\n\n## Steps\n\n1. Do it\n', 'no ### Options'],
    ['design.md', '# t: design\n\n## Decision: A\n\n### Options\n\n- [x] One\n\n## Steps\n\n1. Do it\n', 'no ### Why'],
    ['spec.md', '# t\n\n## Story\n\nA story\n', 'no ## Done when'],
    ['spec.md', '# t\n\n## Story\n\nA story\n\n### Done when\n\n1. **Given** a, **when** b, **then** c\n', 'no ## Done when'],
    ['spec.md', '# t\n\n## Done when\n\n1. **Given** a, **when** b, **then** c\n', 'no ## Story'],
    ['questions.md', '# t: questions\n\nShould it expire?\n\n### q1, from the analyst\nWhy?\n\n- [x] Yes\n', 'not under a question'],
    ['questions.md', '# t: questions\n\n### q1, from the analyst\nWhy?\n\n- [x] Yes\n\n### q2, from the tester\nWhy?\n\n- [x] No\n', 'q2, from the tester'],
    ['questions.md', '# t: questions\n\n### q1, from the analyst\nWhy?\n\n- [ ] Yes\n\nAnswer: Five minutes\n', 'answer with no choice'],
  ])('%s with %j', (file, text, says) => {
    const t = actions.createTicket(bp, { title: 'Limit bookings', outside: true });
    write(t.id, file, text);
    const { problems } = lookAtFiles(bp, t.id);
    expect(problems.some((p) => p.file === file && p.problem.includes(says))).toBe(true);
  });

  it('names a file squad-kit does not read', () => {
    const t = actions.createTicket(bp, { title: 'Limit bookings', outside: true });
    write(t.id, 'plan.md', 'my plan');
    expect(lookAtFiles(bp, t.id).problems[0]?.file).toBe('plan.md');
  });

  it('says so when the story is not there', () => {
    expect(lookAtFiles(bp, 'NOPE-1').ticket).toBeNull();
  });
});

describe('the page and the terminal', () => {
  async function api() {
    const { Hono } = await import('hono');
    const { mountBoardApi } = await import('../src/console/api/board.js');
    const { buildPaths } = await import('../src/core/paths.js');
    const app = new Hono();
    mountBoardApi(app, { paths: buildPaths(tmp) });
    return app;
  }
  const send = async (app: Awaited<ReturnType<typeof api>>, method: string, url: string) => {
    const r = await app.request(url, { method });
    return { status: r.status, json: (await r.json()) as any };
  };

  it('goes out, gives the words, comes back, and says why when it cannot', async () => {
    const app = await api();
    const t = actions.createTicket(bp, { title: 'Limit bookings' });
    const fresh = await send(app, 'GET', '/api/v1/outside-prompt');
    expect(fresh.json.prompt).toContain('new story');
    const before = await send(app, 'POST', `/api/v1/tickets/${t.id}/bring-back`);
    expect(before.status).toBe(400);
    expect(before.json.error).toContain('not in a conversation');
    const out = await send(app, 'POST', `/api/v1/tickets/${t.id}/outside`);
    expect(out.status).toBe(200);
    expect(out.json.prompt).toContain(t.id);
    expect(out.json.takenOver.free).toBeTruthy();
    expect((await send(app, 'GET', `/api/v1/tickets/${t.id}/outside-prompt`)).json.prompt).toContain(t.id);
    const check = await send(app, 'POST', `/api/v1/tickets/${t.id}/check-outside`);
    expect(check.status).toBe(400);
    const back = await send(app, 'POST', `/api/v1/tickets/${t.id}/bring-back`);
    expect(back.status).toBe(200);
    expect(back.json.takenOver).toBeUndefined();
    expect((await send(app, 'GET', '/api/v1/tickets/NOPE-1/outside-prompt')).status).toBe(400);
  });

  it('the proof card does not call what never ran a pass', async () => {
    const { checksWords, noGateRan, noShotsText, proofLead } = await import('../console-ui/src/lib/gates.js');
    const none = { checks: 'pending', review: 'pending', proof: 'pending' } as const;
    expect(noGateRan(none)).toBe(true);
    expect(proofLead(none)).not.toContain('green');
    expect(noShotsText({ gates: none })).toContain('Check');
    const all = { checks: 'pass', review: 'pass', proof: 'pass' } as const;
    expect(noGateRan(all)).toBe(false);
    expect(proofLead(all)).toContain('green');
    expect(checksWords(all)).toBe('All checks pass');
  });
});

describe('words on both sides', () => {
  it('Ask a question and the board say the same about a story outside', async () => {
    const { whereItStands: onThePage } = await import('../console-ui/src/lib/review.js');
    const t = actions.createTicket(bp, { title: 'Limit bookings', outside: true });
    const held = requireTicket(bp, t.id);
    expect(onThePage(held as never)).toBe(whereItStands(held));
    expect(whereItStands(held)).toContain('outside squad-kit');
    addActivity(held, 'you', 'x');
    writeTicket(bp, held);
    expect(readTicket(bp, t.id)?.takenOver?.free).toBeTruthy();
  });
});
