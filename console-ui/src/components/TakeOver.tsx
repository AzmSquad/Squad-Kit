import { Code } from 'lucide-react';
import type { Ticket } from '../api/types';
import { useAct } from '../lib/data';

/** Take over once the Builder has started, until the change is accepted. */
export function canTakeOver(t: Ticket): boolean {
  return !t.takenOver && ['implement', 'test', 'review'].includes(t.stage);
}

export function TakeOverButton({ t }: { t: Ticket }) {
  const act = useAct();
  return (
    <button
      className="btn sm"
      disabled={act.isPending}
      title="The squad stops. You work in the Builder's Claude Code session, then give it back."
      onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/take-over`, done: 'It is yours. The squad waits until you give it back.' })}
    >
      <Code size={12} /> Take over
    </button>
  );
}
