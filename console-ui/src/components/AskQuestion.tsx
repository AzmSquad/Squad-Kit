import { MessageCircle } from 'lucide-react';
import type { AgentName, Ticket } from '../api/types';
import { useAct, useBoard } from '../lib/data';
import { popups } from '../lib/popups';
import { askAgent } from '../lib/review';
import { AGENT_TITLE } from './Chat';

/**
 * Ask a question, at the top of every story, in every state: a questions-only chat with whoever knows the story best
 * (askAgent, the same rule as the engine's). The story stays exactly where it is. With a chat open already, the
 * button opens that chat. One call, `POST /api/v1/tickets/:id/chat/start` with `ask`; in a terminal `squad chat <id> --ask`.
 */

/** Who answers Ask a question on this story now. */
export function useAskAgent(t: Ticket): AgentName {
  const board = useBoard();
  const live = board.data?.ready ? board.data.meta.engine === 'live' : true;
  return askAgent(t, live);
}

export function AskButton({ t }: { t: Ticket }) {
  const act = useAct();
  const who = AGENT_TITLE[useAskAgent(t)];
  // It opens in its popup over the page; on a phone the popup takes the whole screen.
  const show = () => popups.open(t.id);
  if (t.chat?.open) {
    return (
      <button className="btn sm askbtn" onClick={show} title={`The chat with the ${AGENT_TITLE[t.chat.with]} is open`}>
        <MessageCircle size={14} /> Open the chat
      </button>
    );
  }
  return (
    <button
      className="btn sm askbtn"
      disabled={act.isPending}
      title={`The ${who} answers. ${t.id} stays where it is.`}
      onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/chat/start`, body: { ask: true } }, { onSuccess: show })}
    >
      <MessageCircle size={14} /> Ask a question
    </button>
  );
}
