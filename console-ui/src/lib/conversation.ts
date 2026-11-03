import type { AcpContentBlock, AcpToolContent, AcpToolKind, AcpToolStatus, AcpUpdate } from '../api/types';

/* ── Turning ACP updates into things to draw ───────────── */

export type Item =
  | { kind: 'message'; from: 'squad-kit' | 'claude-code' | 'agent' | 'thought'; content: AcpContentBlock; at?: string }
  | { kind: 'plan'; entries: Extract<AcpUpdate, { sessionUpdate: 'plan' }>['entries']; at?: string }
  | {
      kind: 'tool';
      id: string;
      title: string;
      toolKind: AcpToolKind;
      status: AcpToolStatus;
      content: AcpToolContent[];
      command?: string;
      at?: string;
      /** The call that handed squad-kit the step's answer. */
      answer?: boolean;
      /** squad-kit did not let this step run it, by design. `detail` keeps what the agent tried. */
      skipped?: boolean;
      detail?: string;
    };

type Tool = Extract<Item, { kind: 'tool' }>;

/** A tool call and its later updates become one row whose status and content grow as the agent works. */
export function merge(updates: { at?: string; update: AcpUpdate }[]): Item[] {
  const items: Item[] = [];
  const tools = new Map<string, Tool>();
  for (const { at, update: u } of updates) {
    switch (u.sessionUpdate) {
      case 'user_message_chunk': {
        const from = u.content.type === 'text' && u.content._meta?.squadKit?.from === 'claude-code' ? 'claude-code' : 'squad-kit';
        items.push({ kind: 'message', from, content: u.content, at });
        break;
      }
      case 'agent_message_chunk':
        items.push({ kind: 'message', from: 'agent', content: u.content, at });
        break;
      case 'agent_thought_chunk':
        items.push({ kind: 'message', from: 'thought', content: u.content, at });
        break;
      case 'plan':
        items.push({ kind: 'plan', entries: u.entries, at });
        break;
      case 'tool_call': {
        const row: Tool = {
          kind: 'tool',
          id: u.toolCallId,
          title: u.title,
          toolKind: u.kind ?? 'other',
          status: u.status ?? 'in_progress',
          content: [...(u.content ?? [])],
          command: u.rawInput?.command,
          at,
        };
        tools.set(u.toolCallId, row);
        items.push(row);
        break;
      }
      case 'tool_call_update': {
        // ACP: fields in an update replace the ones the call had.
        const row = tools.get(u.toolCallId);
        if (!row) break;
        if (u.status) row.status = u.status;
        if (u.title) row.title = u.title;
        if (u.kind) row.toolKind = u.kind;
        if (u.rawInput?.command) row.command = u.rawInput.command;
        if (u.content) row.content = [...u.content];
        break;
      }
    }
  }
  for (const row of tools.values()) inPlainWords(row);
  return items;
}

/* ── Plain words for the calls a person should not have to decode ── */

/** The tool that carries a step's structured answer, by the names agents give it. */
const ANSWER_TITLE = /^(StructuredOutput|Gave squad-kit its answer|Handed in its answer)$/;
const ANSWER_RECEIPT = /^structured output provided successfully\.?$/i;
/** How agents say a call was not allowed: squad-kit answers no to anything a step was not given. */
const REFUSED = /User refused permission to run tool|^Permission denied: |haven't granted it yet/i;

function textOf(c: AcpToolContent): string {
  return c.type === 'content' && c.content.type === 'text' ? c.content.text.trim() : '';
}

/** What a refused call was, in the words the row shows. */
export function skippedTitle(kind: AcpToolKind): string {
  if (kind === 'execute') return 'Skipped a command this step may not run';
  if (kind === 'edit' || kind === 'delete' || kind === 'move') return 'Skipped a change this step may not make';
  return 'Skipped something this step may not do';
}

function inPlainWords(row: Tool): void {
  if (ANSWER_TITLE.test(row.title)) {
    row.answer = true;
    row.title = 'Handed in its answer';
    // The tool's own receipt says nothing a person needs.
    row.content = row.content.filter((c) => !ANSWER_RECEIPT.test(textOf(c)));
    return;
  }
  if (row.status === 'failed' && row.content.some((c) => REFUSED.test(textOf(c)))) {
    row.skipped = true;
    row.detail = row.title;
    row.title = skippedTitle(row.toolKind);
    row.content = row.content.filter((c) => !REFUSED.test(textOf(c)));
  }
}
