import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowLeft, ChevronLeft, Moon, Search, Sun } from 'lucide-react';
import type { ChatSummary, Ticket } from '../api/types';
import { useBoard, useTicket } from '../lib/data';
import { usePrefs } from '../lib/prefs';
import { PHONE, popups, useMedia, usePopups } from '../lib/popups';
import { detect, textClass, typedDir } from '../lib/lang';
import { AGENT_TITLE, Avatar, ChatView, stageLine } from '../components/Chat';
import { ChatFiles, DocPane, type OpenDoc } from '../components/ChatFiles';
import { NewTalk } from '../components/popups/NewTalk';
import { unreadOf, useChats } from '../lib/chats';
import { focusBoxIn, useShowsTalk } from '../lib/here';
import { ROLE_NAME, Runs, clock, dateShort } from '../components/ui';

/**
 * Every talk with an agent, full screen: the list on the left, the chat in the middle and the ticket's spec beside
 * it, growing as you add to it from the chat. On a phone it becomes one talk at a time with the others as chips.
 */
export function ConversationsPage() {
  const search = useSearch({ from: '/conversations' });
  const navigate = useNavigate({ from: '/conversations' });
  const phone = useMedia(PHONE);
  const [q, setQ] = useState('');
  const chats = useChats(q);
  const everyone = useChats();
  const all = everyone.data ?? [];
  const id = search.ticket ?? all.find((s) => s.open)?.id ?? all[0]?.id;
  const [doc, setDoc] = useState<OpenDoc | null>(null);
  const pick = (x: string) => {
    setDoc(null);
    void navigate({ search: { ticket: x } });
  };
  const toPanel = (x: string) => {
    popups.open(x);
    void navigate({ to: '/board' });
  };
  // The talk picked here is on this page: no popup of it meanwhile, and its head brings this box into view.
  useShowsTalk(id ?? null, () => focusBoxIn(document.querySelector<HTMLElement>('.ccenter, .cphone')));

  if (phone) return <PhoneChats id={id} all={all} pick={pick} doc={doc} setDoc={setDoc} />;

  return (
    <div className="cpage">
      <PageHead q={q} setQ={setQ} />
      <div className="cpage-b">
        <ChatList list={chats.data ?? []} id={id} pick={pick} searching={Boolean(q.trim())} />
        <section className="ccenter" aria-label="Conversation">
          {id ? (
            <ChatView key={id} id={id} size="full" onOpenDoc={setDoc} onPanel={() => toPanel(id)} />
          ) : (
            <div className="cempty">
              <p>No talks yet. Start one with any agent on any ticket.</p>
              <NewTalk />
            </div>
          )}
        </section>
        {doc ? <DocPane doc={doc} onClose={() => setDoc(null)} /> : id ? <SpecPane id={id} onOpenDoc={setDoc} /> : null}
      </div>
    </div>
  );
}

function PageHead({ q, setQ }: { q: string; setQ(v: string): void }) {
  const board = useBoard();
  const { theme, toggleTheme } = usePrefs();
  const project = board.data?.ready ? board.data.meta.project : '';
  return (
    <header className="cpage-h">
      <Link to="/board" className="btn">
        <ArrowLeft size={15} /> Back to the board
      </Link>
      <h1>Conversations</h1>
      <span className="cdim">{project}</span>
      <span className="grow" />
      <label className="search cpage-search">
        <Search size={15} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search all conversations" aria-label="Search all conversations" dir={typedDir(q)} />
      </label>
      <button className="iconbtn" onClick={toggleTheme} aria-label={theme === 'light' ? 'Switch to dark' : 'Switch to light'}>
        {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
      </button>
    </header>
  );
}

function when(at: string): string {
  return new Date(at).toDateString() === new Date().toDateString() ? clock(at) : dateShort(at);
}

/** The last words of a talk, without Markdown marks, in the direction they are written. */
function preview(s: ChatSummary): { text: string; dir: 'rtl' | 'ltr'; cls: string } {
  const raw = s.match ?? s.last?.text ?? '';
  const text = raw.replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
  const d = detect(text);
  return { text: `${s.last?.who === 'you' && !s.match ? 'You: ' : ''}${text}`, dir: d.dir, cls: textClass(d) };
}

function ChatList({ list, id, pick, searching }: { list: ChatSummary[]; id?: string; pick(x: string): void; searching: boolean }) {
  const dock = usePopups();
  const groups: [string, ChatSummary[]][] = [
    ['Waiting for you', list.filter((s) => s.open && s.yourTurn)],
    ['Talking now', list.filter((s) => s.open && !s.yourTurn)],
    ['Earlier', list.filter((s) => !s.open)],
  ];
  return (
    <nav className="clist" aria-label="All conversations">
      <div className="clist-s">
        {searching && !list.length && <p className="cdim" style={{ padding: '14px 18px' }}>Nothing found.</p>}
        {groups.map(([title, rows]) =>
          rows.length ? (
            <div key={title}>
              <div className="csec">{title}</div>
              {rows.map((s) => {
                const on = s.id === id;
                const p = preview(s);
                const unread = unreadOf(s, dock.seen);
                return (
                  <button key={s.id} className={`crow-i ${on ? 'on' : ''}`} onClick={() => pick(s.id)} aria-current={on}>
                    <Avatar role={s.with} live={s.thinking} />
                    <span className="rt">
                      <span className="cid">{s.id}</span>
                      <b>{AGENT_TITLE[s.with]}</b>
                      {s.yourTurn && <span className="cwait">Your turn</span>}
                    </span>
                    <span className="rtime">{s.thinking ? 'now' : when(s.at)}</span>
                    <span className={`rp ${s.thinking ? 't-en' : p.cls}`} dir={s.thinking ? 'ltr' : p.dir}>
                      {s.thinking ? (
                        <span className={`rtyping c-${s.with}`}>
                          <span className="cdots sm">
                            <i />
                            <i />
                            <i />
                          </span>
                          <span className="shim">Writing</span>
                        </span>
                      ) : (
                        <Runs text={p.text || s.title} dir={p.dir} />
                      )}
                    </span>
                    {unread > 0 && !on && <span className="cbadge rb">{unread}</span>}
                  </button>
                );
              })}
            </div>
          ) : null,
        )}
      </div>
    </nav>
  );
}

/* ── The spec beside the chat ──────────────────────────── */

/** The ticket's spec as it stands, with what you added from this talk marked "From chat". */
function SpecPane({ id, onOpenDoc }: { id: string; onOpenDoc(d: OpenDoc): void }) {
  const t = useTicket(id).data;
  const [tab, setTab] = useState<'spec' | 'files' | 'activity'>('spec');
  if (!t) return <aside className="cspec" />;
  const files = [...new Set([...(t.chat?.messages ?? []).flatMap((m) => m.files ?? []), ...(t.attachments ?? [])])];
  return (
    <aside className="cspec" aria-label="The ticket's spec">
      <div className="cstabs" role="tablist">
        <button className={`cstab ${tab === 'spec' ? 'on' : ''}`} role="tab" aria-selected={tab === 'spec'} onClick={() => setTab('spec')}>
          {t.chat?.open && !t.chat.beside && t.chat.with === 'analyst' ? 'Spec draft' : 'Spec'}
        </button>
        <button className={`cstab ${tab === 'files' ? 'on' : ''}`} role="tab" aria-selected={tab === 'files'} onClick={() => setTab('files')}>
          Files · {files.length}
        </button>
        <button className={`cstab ${tab === 'activity' ? 'on' : ''}`} role="tab" aria-selected={tab === 'activity'} onClick={() => setTab('activity')}>
          Activity
        </button>
      </div>
      <div className="csbody">
        {tab === 'spec' && <SpecDraft t={t} />}
        {tab === 'files' && (files.length ? <ChatFiles ticket={t.id} files={files} onOpen={onOpenDoc} /> : <p className="cdim">No files yet. Paste or drop screenshots into the chat.</p>)}
        {tab === 'activity' && (
          <div className="cact-list">
            {t.activity.slice(0, 60).map((a, i) => (
              <div key={i} className="cact-row">
                <span className="cdim">{when(a.at)}</span>
                <span>
                  <b>{ROLE_NAME[a.who]}</b> <Line text={a.text} />
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function Line({ text }: { text: string }) {
  const d = detect(text);
  return (
    <span dir={d.dir} className={textClass(d)}>
      <Runs text={text} dir={d.dir} />
    </span>
  );
}

function Item({ text, fresh, chk, tone }: { text: string; fresh?: boolean; chk?: boolean; tone?: 'open' }) {
  const d = detect(text);
  return (
    <div className={`citem ${fresh ? 'new' : ''} ${tone ?? ''}`}>
      {chk && <span className="cchk" />}
      <span className={`grow ${textClass(d)}`} dir={d.dir} lang={d.dir === 'rtl' ? 'ar' : 'en'}>
        <Runs text={text} dir={d.dir} />
      </span>
      {fresh && <span className="ctag">From chat</span>}
    </div>
  );
}

function SpecDraft({ t }: { t: Ticket }) {
  const started = t.chat?.messages[0]?.at ?? '';
  const notes = t.notes ?? [];
  const fresh = (at: string) => Boolean(started) && at >= started;
  const draft = t.chat?.open && !t.chat.beside && t.chat.with === 'analyst';
  const done = [
    ...(t.criteria ?? []).map((c) => ({ text: c.then, at: '' })),
    ...(t.brief?.criteria ?? []).map((x) => ({ text: x, at: '' })),
    ...notes.filter((n) => n.kind === 'criterion').map((n) => ({ text: n.text, at: n.at })),
  ];
  const rules = [...(t.brief?.rules ?? []).map((x) => ({ text: x, at: '' })), ...notes.filter((n) => n.kind === 'rule').map((n) => ({ text: n.text, at: n.at }))];
  const other = notes.filter((n) => n.kind === 'note' && !n.to);
  const open = (t.questions ?? []).filter((q) => !q.answer).map((q) => q.text);
  const story = t.story ?? t.ask;
  const d = detect(story);
  return (
    <>
      <div className="cdim">
        {draft
          ? 'Grows while you talk. Add to it from any message. The spec is written when you press Write the spec.'
          : 'What the squad works from. Add to it from any message with Add to spec.'}
      </div>
      <h3>Story</h3>
      <div className={textClass(d)} dir={d.dir}>
        <Runs text={story} dir={d.dir} />
      </div>
      <h3>Done when</h3>
      {done.length ? done.map((x, i) => <Item key={i} text={x.text} chk fresh={fresh(x.at)} />) : <p className="cdim">Nothing yet.</p>}
      {rules.length > 0 && (
        <>
          <h3>Rules</h3>
          {rules.map((x, i) => (
            <Item key={i} text={x.text} fresh={fresh(x.at)} />
          ))}
        </>
      )}
      {other.length > 0 && (
        <>
          <h3>Notes</h3>
          {other.map((n, i) => (
            <Item key={i} text={n.text} fresh={fresh(n.at)} />
          ))}
        </>
      )}
      {open.length > 0 && (
        <>
          <h3>Still open</h3>
          {open.map((x, i) => (
            <Item key={i} text={x} tone="open" />
          ))}
        </>
      )}
    </>
  );
}

/* ── Phone ─────────────────────────────────────────────── */

function PhoneChats({ id, all, pick, doc, setDoc }: { id?: string; all: ChatSummary[]; pick(x: string): void; doc: OpenDoc | null; setDoc(d: OpenDoc | null): void }) {
  const t = useTicket(id).data;
  const dock = usePopups();
  const navigate = useNavigate();
  const { theme, toggleTheme } = usePrefs();
  const c = t?.chat;
  const stage = t ? stageLine(t) : null;
  const chips = all.filter((s) => s.open || s.id === id);
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current?.querySelector('.cv.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [id, chips.length]);
  return (
    <div className="cphone">
      <header className="cph-h">
        <button className="ib" onClick={() => (doc ? setDoc(null) : void navigate({ to: '/board' }))} aria-label={doc ? 'Close the document' : 'Back to the board'}>
          <ChevronLeft size={22} />
        </button>
        {c && <Avatar role={c.with} live={c.thinking} />}
        <div className="cph-who">
          <div>
            <b>{c ? AGENT_TITLE[c.with] : 'Conversations'}</b> {t && <span className="cid">{t.id}</span>}
          </div>
          {stage && <div className={`cph-stage ${stage.tone}`}>{stage.text}</div>}
        </div>
        <span className="grow" />
        <button className="ib" onClick={toggleTheme} aria-label={theme === 'light' ? 'Switch to dark' : 'Switch to light'}>
          {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
        </button>
      </header>
      {chips.length > 1 && (
        <div className="cph-convs" role="tablist" aria-label="Conversations" ref={strip}>
          {chips.map((s) => {
            const on = s.id === id;
            const unread = unreadOf(s, dock.seen);
            return (
              <button key={s.id} className={`cv ${on ? 'on' : ''}`} role="tab" aria-selected={on} aria-label={`${AGENT_TITLE[s.with]} on ${s.id}`} onClick={() => pick(s.id)}>
                <Avatar role={s.with} small />
                {s.id}
                {s.thinking && !on && (
                  <span className={`cdots sm c-${s.with}`}>
                    <i />
                    <i />
                    <i />
                  </span>
                )}
                {unread > 0 && !on && <span className="cbadge">{unread}</span>}
              </button>
            );
          })}
        </div>
      )}
      {id ? <ChatView key={id} id={id} size="phone" onOpenDoc={setDoc} /> : <div className="cempty">No talks yet.</div>}
      {doc && (
        <div className="cph-doc">
          <DocPane doc={doc} onClose={() => setDoc(null)} />
        </div>
      )}
    </div>
  );
}
