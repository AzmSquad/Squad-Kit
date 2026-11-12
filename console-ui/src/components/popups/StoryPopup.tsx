import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { AgentName } from '../../api/types';
import { INITIALS } from '../../lib/chats';
import { useTicket } from '../../lib/data';
import { agentFor } from '../../lib/decide';
import { detect, isolated } from '../../lib/lang';
import { popups, type Pop } from '../../lib/popups';
import { AGENT_TITLE, ChatView } from '../Chat';
import type { OpenDoc } from '../ChatFiles';
import { Frame } from './Frame';

/** A story's talk in its popup: the same talk as its full page, with what the story waits on you for at its end. */
export function StoryPopup({ pop, onOpenDoc }: { pop: Pop; onOpenDoc(d: OpenDoc): void }) {
  const q = useTicket(pop.id);
  const t = q.data;
  // Its story was deleted: the popup goes too.
  const gone = q.error instanceof Error && q.error.message.startsWith('404 ');
  useEffect(() => {
    if (gone) popups.close(pop.id);
  }, [gone, pop.id]);
  const navigate = useNavigate();
  const role: AgentName = t ? agentFor(t) : 'analyst';
  // Looking at it counts as seeing what it waits for: its head stops asking.
  useEffect(() => {
    if (!pop.min && t?.waitKey) popups.looked(pop.id, t.waitKey);
  }, [pop.min, pop.id, t?.waitKey]);
  const said = (t?.chat?.messages ?? []).slice(-6).map((m) => m.text).join(' ');
  return (
    <Frame
      pop={pop}
      avatar={<span className={`av av-${role}`}>{INITIALS[role]}</span>}
      title={
        <>
          {AGENT_TITLE[role]} <span className="mono">{pop.id}</span>
        </>
      }
      sub={t ? isolated(t.title) : pop.id}
      busy={Boolean(t?.chat?.thinking)}
      dir={said.trim() ? detect(said).dir : undefined}
      onExpand={() => void navigate(t?.chat ? { to: '/conversations', search: { ticket: pop.id } } : { to: '/board', search: { ticket: pop.id } })}
    >
      <ChatView id={pop.id} size="pop" onOpenDoc={onOpenDoc} />
    </Frame>
  );
}
