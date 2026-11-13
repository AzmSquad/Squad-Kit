import { useEffect, useState } from 'react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import type { LeadView } from '../../api/types';
import { useApps, useBoard } from '../../lib/data';
import { detect } from '../../lib/lang';
import { exampleQuestions, leadCount, pageContext } from '../../lib/lead';
import { leadAsk, useLeadAsk } from '../../lib/leadAsk';
import { useLead, useLeadConversation } from '../../lib/leadData';
import { popups, usePopups, type Pop } from '../../lib/popups';
import { BoxLine, ChatBox, useBoxAsk } from '../decide/BoxAsk';
import { AskInput, ContextChip, useSendLead } from '../LeadAsk';
import { LeadMark } from '../LeadMark';
import { LeadTurnView } from '../LeadTurn';
import { Written } from '../ui';
import { Frame } from './Frame';
import { useStickToBottom } from '../../lib/stick-to-bottom';
import { useWaitingCount } from '../../lib/waiting-count';
import { ToBottom } from '../ToBottom';

/** The lead's popup: what needs you and questions to start from, then the conversation. */
export function LeadPopup({ pop }: { pop: Pop }) {
  const s = usePopups();
  const ask = useLeadAsk();
  const conv = useLeadConversation(s.lead);
  const c = s.lead ? conv.data : undefined;
  const lead = useLead();
  const board = useBoard();
  const navigate = useNavigate();
  const loc = useRouterState({ select: (r) => r.location });
  const { send, busy } = useSendLead();
  const [text, setText] = useState(ask.text);
  // It opens at the bottom, back from its bar too, and follows the answer only while you are at the bottom.
  const stick = useStickToBottom(c?.id ?? 'new', leadCount(c));
  // "Something's wrong" on a card: the box asks for the note, and only its own Send takes it to the board.
  const { box, cancel: cancelBox, door } = useBoxAsk();
  const meta = board.data?.ready ? board.data.meta : undefined;
  const project = meta?.project ?? 'the project';
  const stories = board.data?.ready ? board.data.tickets.length + board.data.stats.released30 : 0;
  // A question asked from a card starts with its words in the box.
  useEffect(() => setText(ask.text), [ask.n, ask.text]);
  const context = ask.context ?? pageContext(loc.pathname, loc.search as Record<string, unknown>);
  const go = (q: string, fresh = false) =>
    send({ text: q.trim(), context: c ? null : context, conversation: c?.id ?? null, fresh }, (x) => {
      popups.follow(x.id);
      leadAsk.used();
      setText('');
      stick.toBottom();
    });
  // The box's own Send: the note for the board while a card asks for one, else a question for the lead.
  const submit = () => {
    if (box) {
      box.send(text.trim());
      setText('');
    } else go(text);
  };
  const last = c?.turns.at(-1)?.ask.text ?? text;
  return (
    <Frame
      pop={pop}
      avatar={
        <span className="av lead">
          <LeadMark size={20} />
        </span>
      }
      title="Squad lead"
      sub={`${project} · knows the code${stories ? `, ${stories} ${stories === 1 ? 'story' : 'stories'}` : ''}`}
      busy={Boolean(c?.thinking)}
      dir={last.trim() ? detect(last).dir : undefined}
      onExpand={() => void navigate({ to: '/lead', search: c ? { c: c.id } : {} })}
    >
      <ChatBox.Provider value={door}>
        {/* A conversation sticks to its newest message; the start, with what needs you, reads from the top. */}
        <div className="feed" ref={c ? stick.boxRef : undefined}>
          <div className="feedcol" ref={c ? stick.contentRef : undefined}>
            {c ? (
              c.turns.map((t, i) => (
                <LeadTurnView
                  key={t.n}
                  c={c}
                  turn={t}
                  last={i === c.turns.length - 1}
                  onAgain={(q, fresh) => {
                    // Ask again goes to the lead, never to the board: the box stops asking for a note.
                    cancelBox();
                    go(q, fresh);
                  }}
                />
              ))
            ) : s.lead && conv.isLoading ? null : (
              <LeadStart view={lead.data} onPick={setText} />
            )}
          </div>
          {c && <ToBottom s={stick} />}
        </div>
      </ChatBox.Provider>
      <div className="composer">
        {box && <BoxLine box={box} onCancel={cancelBox} />}
        <AskInput value={text} onChange={setText} onSend={submit} busy={busy || Boolean(c?.thinking)} placeholder={box ? box.placeholder : c ? 'Ask a follow-up…' : `Ask about ${project}, or ask for something…`} autoFocus />
        <div className="where">
          <ContextChip ctx={c?.context ?? context} />
          <span>Enter to send</span>
        </div>
      </div>
    </Frame>
  );
}

/** No conversation yet: what needs you, each opening its story's popup, what's new, and a few questions to start from. */
function LeadStart({ view, onPick }: { view?: LeadView; onPick(q: string): void }) {
  const apps = (useApps().data?.apps ?? []).map((a) => a.name);
  const needs = (view?.needsYou ?? []).filter((n) => n.kind !== 'slow');
  // The same number as the top bar: the list shows the stories, the rest wait in Waiting for you.
  const total = Math.max(useWaitingCount(), needs.length);
  const news = view?.whatsNew ?? [];
  const examples = exampleQuestions({ apps, needsYou: view?.needsYou ?? [], squadNow: view?.squadNow ?? [] });
  return (
    <div className="empty">
      {needs.length > 0 && (
        <>
          <h6>Needs you</h6>
          {needs.slice(0, 4).map((n, i) => (
            <button key={n.id} className="need" style={{ ['--i' as string]: i }} onClick={() => popups.open(n.story)}>
              <div>
                <Written as="b" text={n.words} />
                <Written as="small" text={n.more ?? n.title} />
              </div>
              <span className="go">{n.kind === 'questions' || n.kind === 'ask' ? 'Answer' : 'Open'}</span>
            </button>
          ))}
          {total > Math.min(4, needs.length) && (
            <Link to="/inbox" className="linkbtn">
              and {total - Math.min(4, needs.length)} more in Waiting for you
            </Link>
          )}
        </>
      )}
      {news.length > 0 && (
        <>
          <h6>What&apos;s new</h6>
          <ul className="news">
            {news.slice(0, 3).map((x) => (
              <li key={x.id}>
                <Link to="/board" search={{ ticket: x.story }}>
                  <Written text={x.words} />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
      <h6>Try asking</h6>
      <div className="sugs">
        {examples.map((q) => (
          <button key={q} className="sug" onClick={() => onPick(q)}>
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
