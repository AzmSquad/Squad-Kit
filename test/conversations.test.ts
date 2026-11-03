import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowedFile, readConversation, ticketConversations, ticketFolders } from '../src/engine/conversations.js';
import { boardPaths } from '../src/board/store.js';
import type { Ticket } from '../src/board/types.js';

let base: string;
let work: string;
const ID = 'b5a9a6ab-2632-4011-89ff-8ec837feb166';

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-conv-'));
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-work-'));
  fs.mkdirSync(path.join(work, 'shots'));
  fs.writeFileSync(path.join(work, 'shots', 'home.png'), 'png');
  const dir = path.join(base, '-tmp-work');
  fs.mkdirSync(dir);
  const lines = [
    { type: 'queue-operation' },
    { type: 'user', cwd: work, timestamp: '2026-10-30T12:30:00Z', message: { content: 'You are the Builder of a software squad.' } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Start with the rules.' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'I will read the rules first.' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'Sign-up form', status: 'in_progress' }, { content: 'Tests', status: 'pending' }] } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: `${work}/src/app.ts`, old_string: 'a = 1', new_string: 'a = 2' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'The file was updated.' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npx playwright screenshot http://localhost:3000 shots/home.png' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: 'FAIL timeout', is_error: true }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't4', name: 'Read', input: { file_path: `${work}/shots/home.png` } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't4', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] }] } },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'side task' }] } },
    { type: 'user', message: { content: '[structured-output-enforce] You MUST call the StructuredOutput tool.' } },
  ];
  fs.writeFileSync(path.join(dir, `${ID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\nnot json\n');
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

describe('conversations in ACP format', () => {
  it('turns a saved Claude Code session into ACP session updates', () => {
    const c = readConversation(ID, 400, base)!;
    expect(c.cwd).toBe(work);
    expect(c.updates.map((e) => e.update.sessionUpdate)).toEqual([
      'user_message_chunk',
      'agent_thought_chunk',
      'agent_message_chunk',
      'plan',
      'tool_call',
      'tool_call_update',
      'tool_call',
      'tool_call_update',
      'tool_call',
      'tool_call_update',
      'user_message_chunk',
    ]);
    const [first, , , plan, edit, editDone, bash, bashDone, , readDone, note] = c.updates.map((e) => e.update) as any[];
    expect(first.content._meta).toEqual({ squadKit: { from: 'squad-kit' } });
    expect(note.content._meta).toEqual({ squadKit: { from: 'claude-code' } });
    expect(plan.entries).toEqual([
      { content: 'Sign-up form', priority: 'medium', status: 'in_progress' },
      { content: 'Tests', priority: 'medium', status: 'pending' },
    ]);
    expect(edit).toMatchObject({ toolCallId: 't2', kind: 'edit', title: 'Editing src/app.ts', locations: [{ path: `${work}/src/app.ts` }] });
    expect(edit.content).toEqual([{ type: 'diff', path: `${work}/src/app.ts`, oldText: 'a = 1', newText: 'a = 2' }]);
    expect(editDone).toMatchObject({ toolCallId: 't2', status: 'completed' });
    expect(bash).toMatchObject({ kind: 'execute', rawInput: { command: 'npx playwright screenshot http://localhost:3000 shots/home.png' } });
    // The screenshot the command names is attached as a file link, even though the command failed.
    expect(bashDone.status).toBe('failed');
    expect(bashDone.content).toContainEqual({ type: 'content', content: { type: 'resource_link', uri: `file://${path.join(work, 'shots/home.png')}`, name: 'home.png', mimeType: 'image/png', size: 3 } });
    expect(readDone.content[0]).toEqual({ type: 'content', content: { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' } });
  });

  it('keeps only the latest updates and refuses odd ids', () => {
    expect(readConversation(ID, 2, base)!.updates.map((e) => e.update.sessionUpdate)).toEqual(['tool_call_update', 'user_message_chunk']);
    expect(readConversation('../../etc/passwd', 400, base)).toBeNull();
  });

  it('says the answer was handed in, without the tool’s receipt', () => {
    const id = 'c0ffee00-2632-4011-89ff-8ec837feb166';
    const lines = [
      { type: 'assistant', cwd: work, message: { content: [{ type: 'tool_use', id: 's1', name: 'StructuredOutput', input: { approved: true } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: 'Structured output provided successfully' }] } },
    ];
    fs.writeFileSync(path.join(base, '-tmp-work', `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
    const [call, done] = readConversation(id, 400, base)!.updates.map((e) => e.update) as any[];
    expect(call).toMatchObject({ toolCallId: 's1', title: 'Handed in its answer' });
    expect(done).toMatchObject({ toolCallId: 's1', status: 'completed', content: [] });
  });

  it('lists a ticket’s conversations by role', () => {
    const t = { sessions: { intake: 'aaaaaaaa-1111', build: ID } } as unknown as Ticket;
    expect(ticketConversations(t, base)).toEqual([
      { key: 'intake', label: 'Analyst and Architect', sessionId: 'aaaaaaaa-1111', started: false },
      { key: 'build', label: 'Builder', sessionId: ID, started: true },
    ]);
  });

  it('only serves files from the ticket’s own folders', () => {
    const t = { id: 'MA-1', worktree: work } as unknown as Ticket;
    const folders = ticketFolders(t, boardPaths(path.join(base, '.squad')));
    expect(allowedFile(path.join(work, 'shots', 'home.png'), folders)).toBe(fs.realpathSync(path.join(work, 'shots', 'home.png')));
    expect(allowedFile(path.join(work, 'shots', '..', '..', 'etc', 'passwd'), folders)).toBeNull();
    expect(allowedFile('/etc/hosts', folders)).toBeNull();
  });
});
