import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowRight, ArrowUp, Check, CircleAlert, MessageCircle, Plus, RefreshCw, Square, X } from 'lucide-react';
import { api, assetUrl } from '../api/client';
import type { Ticket } from '../api/types';
import type { CodePart, OverviewTalk, OverviewView } from '../api/onboard-types';
import { useAct } from '../lib/data';
import { partColumns, usesLine } from '../lib/overview';
import { Cmd, clock, dateShort } from '../components/ui';
import { SetupCard } from '../components/Setup';
import { NewTicketDialog } from '../components/dialogs';
import { Avatar } from '../components/Chat';
import { ChatMarkdown } from '../components/ChatMarkdown';
import { useDraft } from '../lib/drafts';

/**
 * The Overview, first in the sidebar. The first time it is the handover: what squad-kit found, how the code fits
 * together, who uses it, what it does, what is worth knowing, the rules it found and three ticket ideas, with "Looks
 * right, start working" to approve the rules. After that it is the project's home, kept up to date after every merged
 * ticket. Terminal: `squad overview`.
 */

export function useOverview() {
  return useQuery({
    queryKey: ['overview'],
    queryFn: () => api<OverviewView>('/api/v1/overview'),
    refetchInterval: (q) => (q.state.data?.talk?.thinking || q.state.data?.handover === 'reading' ? 1000 : 3000),
  });
}

function readWhen(at?: string): string {
  if (!at) return '';
  const d = new Date(at);
  return d.toDateString() === new Date().toDateString() ? `Read today at ${clock(at)}` : `Read on ${dateShort(at)}`;
}

export function OverviewPage() {
  const q = useOverview();
  const act = useAct();
  const navigate = useNavigate();
  const [writing, setWriting] = useState(false);
  // "Change what I said", on a project with no code.
  const [changing, setChanging] = useState(false);
  const v = q.data;
  if (q.isLoading) return <div className="center">Loading the overview…</div>;
  if (!v) return <div className="center">No overview yet.</div>;
  const opened = (t: Ticket) => void navigate({ to: '/board', search: { ticket: t.id } });
  // A project with no code: one plain question first. There is nothing to check or read yet.
  const asking = v.empty && v.handover === 'ready' && (!v.idea || changing);

  return (
    <>
      <div className="top">
        <h1>{v.project}</h1>
        {v.readAt && !v.empty && <span className="note ob-read">{readWhen(v.readAt)}</span>}
        <span className="grow" />
        {v.handover !== 'reading' && !v.empty && (
          <button className="btn" disabled={act.isPending} onClick={() => act.mutate({ path: '/api/v1/overview/read-again', done: 'The Architect reads the project again' })}>
            <RefreshCw size={14} /> Read it again
          </button>
        )}
        <Cmd text={v.command} />
      </div>
      <div className="scroll">
        <div className="page ob-page">
          {v.handover === 'reading' && <SetupCard />}
          {asking && <AskIdea v={v} onSent={() => setChanging(false)} onWrite={() => setWriting(true)} />}
          {v.handover === 'ready' && !asking && !v.talk?.open && <Handover v={v} {...(v.empty ? { onChange: () => setChanging(true) } : {})} />}
          {v.talk?.open && <Talk t={v.talk} />}
          {v.handover === 'approved' && v.approved && (
            <div className="calmlane ob-approved">
              <span className="glyph">
                <Check size={14} strokeWidth={2.5} />
              </span>
              <span>
                <b>{v.approved.by} approved this on {dateShort(v.approved.at)}.</b> {v.rules.length ? 'The squad follows these rules. ' : ''}This page stays up to date after every merged ticket.
              </span>
            </div>
          )}
          {v.old && (
            <div className="ob-card">
              <span className="grow">
                <b>Read by an older squad-kit</b>
                <span>Read it again to see who uses it, what it can do today, how its parts fit together and three ticket ideas.</span>
              </span>
              <button className="btn sm" onClick={() => act.mutate({ path: '/api/v1/overview/read-again', done: 'The Architect reads the project again' })}>
                Read it again
              </button>
            </div>
          )}

          {v.empty ? (
            !asking &&
            v.handover !== 'reading' && (
              <div className="ob-row2">
                <WhatItIs v={v} />
                <Ideas v={v} onCreated={opened} onWrite={() => setWriting(true)} />
              </div>
            )
          ) : (
            <>
              <div className="ob-row2">
                <WhatItIs v={v} />
                <Proof v={v} />
              </div>
              {v.parts.length > 0 ? <Parts v={v} /> : v.map.length > 0 ? <MapCard v={v} /> : null}
              <div className="ob-row3">
                <Rules v={v} />
                <Worth v={v} />
                <Ideas v={v} onCreated={opened} onWrite={() => setWriting(true)} />
              </div>
              <p className="note ob-foot">
                Kept in .squad/knowledge, updated after every merged ticket. Decisions and their history are on the <Link to="/architecture">Architecture page</Link>.
              </p>
            </>
          )}
        </div>
      </div>
      {writing && <NewTicketDialog onClose={() => setWriting(false)} onCreated={opened} />}
    </>
  );
}

/**
 * A project with no code: "What do you want to build?". The answer goes to the Architect's read, in Arabic or English,
 * and the overview comes back with first stories for it. The technology is the Architect's choice, with the first story.
 */
function AskIdea({ v, onSent, onWrite }: { v: OverviewView; onSent(): void; onWrite(): void }) {
  const act = useAct();
  const [text, setText] = useState(v.idea ?? '');
  const send = () => {
    if (!text.trim() || act.isPending) return;
    act.mutate({ path: '/api/v1/overview/idea', body: { text }, done: 'The Architect is reading what you want to build' }, { onSuccess: onSent });
  };
  return (
    <section className="ob-talk ob-ask" aria-label="What do you want to build?">
      <div className="ob-talk-h">
        <Avatar role="architect" small />
        <h2>What do you want to build?</h2>
      </div>
      <p className="note">Say it in your own words, in Arabic or English. The Architect picks the technology itself when your first story is planned.</p>
      <div className="cbox ob-talk-box">
        <textarea
          className="cta t-mx"
          rows={3}
          dir="auto"
          value={text}
          placeholder="For example: a page where staff write down visitors' names and see today's list"
          aria-label="What you want to build"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="crow">
          <span className="grow" />
          <button className="csend" aria-label="Send" disabled={!text.trim() || act.isPending} onClick={send}>
            <ArrowUp size={17} />
          </button>
        </div>
      </div>
      <div className="ob-talk-f">
        <button className="ob-link" onClick={onWrite}>
          Or write your first ticket yourself.
        </button>
        <span className="grow" />
        <Cmd text={'squad overview --build "…"'} />
      </div>
    </section>
  );
}

/** The handover: check what squad-kit understood, then start. A project with no code changes what it said instead. */
function Handover({ v, onChange }: { v: OverviewView; onChange?(): void }) {
  const act = useAct();
  const n = v.proposed;
  return (
    <section className="ob-hand" aria-label="Check the overview">
      <div className="grow">
        <b>{v.empty ? 'The Architect wrote down what you want to build. Check it, then start.' : v.approved && n ? `squad-kit found ${n} new ${n === 1 ? 'rule' : 'rules'} in your code. Check them, then carry on.` : 'squad-kit has read your project. Check what it understood, then start.'}</b>
        <span>{n ? `When you approve, the ${n} ${n === 1 ? 'rule' : 'rules'} below become the rules every agent follows.` : 'When you approve, this page becomes the project’s home.'}</span>
      </div>
      <span className="ob-hand-acts">
        {onChange ? (
          <button className="btn" disabled={act.isPending} onClick={onChange}>
            <MessageCircle size={14} /> Change what I said
          </button>
        ) : (
          <button className="btn" disabled={act.isPending} onClick={() => act.mutate({ path: '/api/v1/overview/talk', body: {} })}>
            <MessageCircle size={14} /> Something is wrong
          </button>
        )}
        <button className="btn pri" disabled={act.isPending} onClick={() => act.mutate({ path: '/api/v1/overview/approve', done: v.empty ? 'Approved. Start with your first story.' : 'Approved. The squad follows these rules now. Start with a ticket.' })}>
          <Check size={15} /> Looks right, start working
        </button>
        <Cmd text="squad overview --approve" />
      </span>
    </section>
  );
}

/** "Something is wrong": a talk with the Architect, then the read again with what was said. */
function Talk({ t }: { t: OverviewTalk }) {
  const act = useAct();
  const [text, setText] = useDraft('overview', 'talk', '');
  const said = t.messages.some((m) => m.who === 'you');
  const send = (msg = text) => {
    if (!msg.trim() || t.thinking) return;
    act.mutate({ path: '/api/v1/overview/talk', body: { text: msg } }, { onSuccess: () => setText('') });
  };
  return (
    <section className="ob-talk" aria-label="Talk with the Architect">
      <div className="ob-talk-h">
        <Avatar role="architect" small />
        <b>Tell the Architect what is wrong</b>
        <span className="grow" />
        <button className="iconbtn" aria-label="Close the talk" onClick={() => act.mutate({ path: '/api/v1/overview/talk/close' })}>
          <X size={15} />
        </button>
      </div>
      <div className="ob-thread ccol">
        {t.messages.map((m, i) =>
          m.who === 'you' ? (
            <div key={i} className="cyou cmsg">
              <div className="cybub">
                <ChatMarkdown text={m.text} ticket="" />
              </div>
              <span className="cmeta">You · {clock(m.at)}</span>
            </div>
          ) : m.who === 'squad' ? (
            <div key={i} className="cnote-w cmsg">
              <span className="cnote-pill">{m.text}</span>
            </div>
          ) : (
            <div key={i} className="cag cmsg ag-architect">
              <Avatar role="architect" />
              <div className="cwho">
                <b>Architect</b>
                <span className="ctime">{clock(m.at)}</span>
              </div>
              <div className="cagb">
                <ChatMarkdown text={m.text} ticket="" />
                {m.options && m.options.length > 0 && i === t.messages.length - 1 && (
                  <div className="cchoices">
                    {m.options.map((o) => (
                      <button key={o} className="cch" onClick={() => send(o)}>
                        {o}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ),
        )}
        {t.thinking && (
          <div className="cag cmsg ag-architect thinking">
            <Avatar role="architect" live />
            <div className="cwho">
              <b>Architect</b>
              <span className="shim">{said ? 'Reading your message' : 'Looking at what it wrote'}</span>
            </div>
            <div className="cagb">
              <span className="cdots" aria-label="The Architect is answering">
                <i />
                <i />
                <i />
              </span>
            </div>
          </div>
        )}
      </div>
      <div className="cbox ob-talk-box">
        <textarea
          className="cta t-en"
          rows={2}
          dir="auto"
          value={text}
          placeholder="What did squad-kit get wrong? In Arabic or English"
          aria-label="Your message"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="crow">
          <span className="grow" />
          {t.thinking ? (
            <button className="cstop" onClick={() => act.mutate({ path: '/api/v1/overview/talk/stop' })}>
              <Square size={12} fill="currentColor" /> Stop
            </button>
          ) : (
            <button className="csend" aria-label="Send" disabled={!text.trim() || act.isPending} onClick={() => send()}>
              <ArrowUp size={17} />
            </button>
          )}
        </div>
      </div>
      <div className="ob-talk-f">
        <button
          className="btn pri"
          disabled={!said || t.thinking || act.isPending}
          onClick={() => act.mutate({ path: '/api/v1/overview/talk/read-again', done: 'The Architect reads the project again with what you said' })}
        >
          <RefreshCw size={14} /> Read it again with this
        </button>
        <span className="note">The Architect reads the whole project again with what you said. You check the overview again after.</span>
        <span className="grow" />
        <Cmd text={'squad overview --wrong "…"'} />
      </div>
    </section>
  );
}

function WhatItIs({ v }: { v: OverviewView }) {
  const can = [...v.can.map((x) => ({ text: x, id: '' })), ...v.since.map((x) => ({ text: x.title, id: x.id }))];
  return (
    <section className="ob-c">
      <h3>What it is</h3>
      {v.summary ? (
        <p className="ob-lead" dir="auto">
          {v.summary}
        </p>
      ) : (
        <p className="note">squad-kit has not read the project yet.</p>
      )}
      {v.empty && <p>No code yet. The Architect picks the technology when your first story is planned, and saves it as a decision engineers can see.</p>}
      {(v.users || can.length > 0) && (
        <div className="ob-two">
          {v.users && (
            <div>
              <div className="ob-k">Who uses it</div>
              <p>{v.users}</p>
            </div>
          )}
          {can.length > 0 && (
            <div>
              <div className="ob-k">What it can do today</div>
              <ul className="ob-list">
                {can.map((x, i) => (
                  <li key={i}>
                    {x.text}
                    {x.id && (
                      <Link to="/board" search={{ ticket: x.id }} className="pill ok sm ob-new" title="Merged since the first read">
                        new · {x.id}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Proof({ v }: { v: OverviewView }) {
  const p = v.proof;
  const [open, setOpen] = useState<number | null>(null);
  return (
    <section className="ob-c">
      <h3>Proof squad-kit can work here</h3>
      {!p ? (
        <p className="note">{v.handover === 'reading' ? 'Comes when the setup has tried your tests and your app.' : 'Read it again to have squad-kit run your tests and open your app once.'}</p>
      ) : (
        <ul className="ob-proof">
          {p.files !== undefined && (
            <li className="ok">
              <Check size={14} /> {p.files ? `Read the project: ${p.files} ${p.files === 1 ? 'file' : 'files'}` : 'Read the project'}
            </li>
          )}
          {(p.tests ?? []).map((t, i) => (
            <li key={i} className={t.ok ? 'ok' : 'bad'}>
              {t.ok ? <Check size={14} /> : <CircleAlert size={14} />}
              <span>
                {t.ok ? `Ran your tests${t.repo && t.repo !== '.' ? ` in ${t.repo}` : ''}: ${t.passed !== undefined ? `${t.passed} pass` : 'they pass'}` : 'Your tests did not pass here'}
                {!t.ok && t.output && (
                  <button className="btn sm quiet" onClick={() => setOpen(open === i ? null : i)}>
                    {open === i ? 'Hide' : 'See what failed'}
                  </button>
                )}
              </span>
              {open === i && t.output && <pre className="ob-out">{`${t.command}:\n${t.output}`}</pre>}
            </li>
          ))}
          {p.tests?.length === 0 && (
            <li className="skip">
              <CircleAlert size={14} /> No tests yet. Your first ticket can add some.
            </li>
          )}
          {p.app && (
            <li className={p.app.ok ? 'ok' : 'bad'}>
              {p.app.ok ? <Check size={14} /> : <CircleAlert size={14} />}
              <span>{p.app.ok ? 'Opened the app' : 'The app did not open here'}</span>
            </li>
          )}
          {p.app?.shot && (
            <li className="ob-shot">
              <img src={`${assetUrl(`/api/v1/proof/${p.app.shot}`)}&v=${encodeURIComponent(v.readAt ?? '')}`} alt="The app's first page, as squad-kit opened it" />
            </li>
          )}
          {p.branch && (
            <li className="ok">
              <Check size={14} /> On git branch {p.branch}, {p.unsaved ? `${p.unsaved} changes not saved in git yet` : 'nothing unsaved'}
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/** How it fits together: the parts in the order a request flows, with the tests under them. */
function Parts({ v }: { v: OverviewView }) {
  const [open, setOpen] = useState<string | null>(null);
  const { columns, below } = partColumns(v.parts, v.links);
  const node = (p: CodePart) => {
    const uses = usesLine(p, v.parts, v.links);
    return (
      <button key={p.id} className={`ob-node k-${p.kind ?? 'part'} ${open === p.id ? 'on' : ''}`} onClick={() => setOpen(open === p.id ? null : p.id)} aria-expanded={open === p.id}>
        <b>{p.name}</b>
        {p.what && <span>{p.what}</span>}
        {p.files.length > 0 && <code>{open === p.id ? p.files.join('\n') : p.files[0]}</code>}
        {open === p.id && uses && <small>{uses}</small>}
      </button>
    );
  };
  return (
    <section className="ob-c">
      <div className="ob-c-h">
        <h3>How it fits together</h3>
        <span className="note">Click a box to see its files</span>
      </div>
      <div className="ob-flow">
        {columns.map((col, i) => (
          <div key={i} className="ob-col-w">
            {i > 0 && (
              <span className="ob-arw" aria-hidden>
                <ArrowRight size={16} className="h" />
                <ArrowDown size={16} className="v" />
              </span>
            )}
            <div className="ob-col">{col.map(node)}</div>
          </div>
        ))}
      </div>
      {below.length > 0 && (
        <>
          <div className="ob-checks" aria-hidden>
            ↑ checks ↑
          </div>
          <div className="ob-below">{below.map(node)}</div>
        </>
      )}
    </section>
  );
}

/** A project read before the overview had its picture: the project map instead. */
function MapCard({ v }: { v: OverviewView }) {
  return (
    <section className="ob-c">
      <h3>The project map</h3>
      {v.map.map((m) => (
        <div key={m.area} className="maprow">
          <b>{m.area}</b>
          <span>{m.detail}</span>
        </div>
      ))}
    </section>
  );
}

function Rules({ v }: { v: OverviewView }) {
  const rules = v.rules;
  const scan = rules.filter((r) => r.fromScan).length;
  return (
    <section className="ob-c">
      <h3>Rules the squad {v.proposed ? 'will follow' : 'follows'}</h3>
      <div className="note">{rules.length ? (scan === rules.length ? `${scan}, taken from your code` : `${rules.length}: ${scan} from your code, ${rules.length - scan} from tickets`) : 'None yet. The Architect proposes them with your first ticket.'}</div>
      <ul className="ob-list">
        {rules.slice(0, 10).map((r) => (
          <li key={r.id} title={r.why}>
            {r.title}
            {r.proposed && v.handover !== 'ready' && <span className="pill you sm ob-new">proposed</span>}
          </li>
        ))}
      </ul>
      {rules.length > 0 && (
        <Link to="/architecture" search={{ view: 'list' }} className="ob-more">
          Review them one by one
        </Link>
      )}
    </section>
  );
}

function Worth({ v }: { v: OverviewView }) {
  return (
    <section className="ob-c">
      <h3>Worth knowing</h3>
      {v.worth.length ? (
        <ul className="ob-list ob-worth">
          {v.worth.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      ) : (
        <p className="note">Nothing yet.</p>
      )}
    </section>
  );
}

function Ideas({ v, onCreated, onWrite }: { v: OverviewView; onCreated(t: Ticket): void; onWrite(): void }) {
  const act = useAct<Ticket>();
  return (
    <section className="ob-c">
      <h3>{v.empty ? 'Your first stories' : 'Good first tickets'}</h3>
      <ul className="ob-ideas">
        {v.ideas.map((idea, i) => (
          <li key={i}>
            <span dir="auto">
              <b>{idea.title}</b>
              {idea.why && <small>{idea.why}</small>}
            </span>
            {idea.ticket ? (
              <Link to="/board" search={{ ticket: idea.ticket }} className="btn sm">
                {idea.ticket}
              </Link>
            ) : (
              <button
                className="btn sm"
                disabled={act.isPending}
                title={`squad overview --idea ${i + 1}`}
                onClick={() => act.mutate({ path: `/api/v1/overview/ideas/${i + 1}`, done: 'On the board. The Analyst reads it first.' }, { onSuccess: (t) => onCreated(t) })}
              >
                Create
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="note">
        {v.ideas.length ? (v.empty ? 'Ideas from what you said. Or ' : 'Ideas from what the Architect saw. Or ') : ''}
        <button className="ob-link" onClick={onWrite}>
          {v.ideas.length ? 'write your own.' : 'Write your first ticket.'}
        </button>
      </p>
      {v.ideas.some((x) => !x.ticket) && <Cmd text={`squad overview --idea ${v.ideas.findIndex((x) => !x.ticket) + 1}`} />}
      {!v.ideas.length && (
        <button className="btn sm pri" onClick={onWrite}>
          <Plus size={14} /> New ticket
        </button>
      )}
    </section>
  );
}
