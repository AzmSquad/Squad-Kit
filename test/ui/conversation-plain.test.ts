import { describe, expect, it } from 'vitest';
import { merge, toolWords, type Item } from '../../console-ui/src/lib/conversation.js';
import type { AcpUpdate } from '../../console-ui/src/api/types.js';

type Tool = Extract<Item, { kind: 'tool' }>;
const text = (t: string) => ({ type: 'content' as const, content: { type: 'text' as const, text: t } });
const tools = (updates: AcpUpdate[]) => merge(updates.map((update) => ({ update }))).filter((i): i is Tool => i.kind === 'tool');

describe('the live conversation in plain words', () => {
  it('the structured answer reads "Handed in its answer", without its receipt', () => {
    const [row] = tools([
      { sessionUpdate: 'tool_call', toolCallId: 'a1', title: 'StructuredOutput', kind: 'other', status: 'pending' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'a1', status: 'completed', content: [text('Structured output provided successfully')] },
    ]);
    expect(row).toMatchObject({ title: 'Handed in its answer', answer: true, status: 'completed', content: [] });
    // Older conversations, converted from the saved session, said it another way.
    expect(tools([{ sessionUpdate: 'tool_call', toolCallId: 'a2', title: 'Gave squad-kit its answer', status: 'completed' }])[0]!.title).toBe('Handed in its answer');
  });

  it('a command the step may not run is skipped, not failed, with the command kept', () => {
    const [row, real] = tools([
      { sessionUpdate: 'tool_call', toolCallId: 'b1', title: 'Running npm test', kind: 'execute', status: 'pending', rawInput: { command: 'npm test' } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'b1', status: 'failed', content: [text('User refused permission to run tool')] },
      { sessionUpdate: 'tool_call', toolCallId: 'b2', title: 'Running ls missing', kind: 'execute', status: 'pending', rawInput: { command: 'ls missing' } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'b2', status: 'failed', content: [text('ls: missing: No such file or directory')] },
    ]);
    expect(row).toMatchObject({ title: 'Skipped a command this step may not run', skipped: true, detail: 'Running npm test', command: 'npm test', content: [] });
    // A command that really failed stays a failure.
    expect(real).toMatchObject({ title: 'Running ls missing', status: 'failed' });
    expect(real!.skipped).toBeUndefined();
  });

  it('knows the ways agents say a call was not allowed', () => {
    const refused = (reason: string, kind: 'execute' | 'edit' = 'execute') =>
      tools([
        { sessionUpdate: 'tool_call', toolCallId: 'c', title: 'Writing notes.md', kind, status: 'pending' },
        { sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'failed', content: [text(reason)] },
      ])[0]!;
    expect(refused('Permission denied: User refused permission to run tool').skipped).toBe(true);
    expect(refused("Claude requested permissions to use Bash, but you haven't granted it yet.").skipped).toBe(true);
    expect(refused('User refused permission to run tool', 'edit').title).toBe('Skipped a change this step may not make');
    expect(refused('cat: secret: Permission denied').skipped).toBeUndefined();
  });

  it('bare tool names read as what they do, for the Full log', () => {
    expect(toolWords('Bash')).toBe('Ran a command');
    expect(toolWords('TodoWrite')).toBe('Updated its plan');
    expect(toolWords('Unknown Tool')).toBe('Used a tool');
    expect(toolWords('mcp__files__read_file')).toBe('Used read file from files');
    expect(toolWords('SomeNewTool')).toBe('Used some new tool');
    // A title that already says what it does stays.
    expect(toolWords('Read src/app.ts')).toBeNull();
    const [cmd, raw] = tools([
      { sessionUpdate: 'tool_call', toolCallId: 'd1', title: 'npm test', kind: 'execute', status: 'pending', rawInput: { command: 'npm test' } },
      { sessionUpdate: 'tool_call', toolCallId: 'd2', title: 'Task', kind: 'other', status: 'completed' },
    ]);
    expect(cmd!.title).toBe('Ran npm test');
    expect(raw!.title).toBe('Asked a helper');
  });
});
