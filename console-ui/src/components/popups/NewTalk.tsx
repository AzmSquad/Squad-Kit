import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { AgentName } from '../../api/types';
import { useAct, useBoard } from '../../lib/data';
import { isolated } from '../../lib/lang';
import { popups } from '../../lib/popups';
import { AGENT_TITLE } from '../Chat';

/** Start a talk with any agent on any ticket. It opens in its popup. */
export function NewTalk() {
  const board = useBoard();
  const act = useAct();
  const [open, setOpen] = useState(false);
  const [ticket, setTicket] = useState('');
  const [agent, setAgent] = useState<AgentName>('analyst');
  const tickets = (board.data?.ready ? board.data.tickets : []).filter((t) => !t.chat?.open && !t.takenOver);
  const start = () =>
    act.mutate(
      { path: `/api/v1/tickets/${ticket}/chat/start`, body: { with: agent } },
      {
        onSuccess: () => {
          setOpen(false);
          popups.open(ticket);
        },
      },
    );
  return (
    <span className="cmenu-w">
      <button className="iconbtn" onClick={() => setOpen(!open)} aria-label="Start a new conversation" title="Start a new conversation" aria-expanded={open}>
        <Plus size={16} />
      </button>
      {open && (
        <div className="cmenu cnew" role="dialog" aria-label="Start a new conversation">
          <label>
            <span>Ticket</span>
            <select className="input" value={ticket} onChange={(e) => setTicket(e.target.value)}>
              <option value="">Pick a ticket</option>
              {tickets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.id} · {isolated(t.title)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Talk to</span>
            <select className="input" value={agent} onChange={(e) => setAgent(e.target.value as AgentName)}>
              {(Object.keys(AGENT_TITLE) as AgentName[]).map((a) => (
                <option key={a} value={a}>
                  The {AGENT_TITLE[a]}
                </option>
              ))}
            </select>
          </label>
          <div className="cbtns">
            <button className="btn pri sm" disabled={!ticket || act.isPending} onClick={start}>
              Start talking
            </button>
            <button className="btn sm" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
