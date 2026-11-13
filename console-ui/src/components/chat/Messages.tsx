import { useRef, useState, type RefObject } from 'react';
import { Check, ChevronRight, CircleAlert, Copy, Loader2, Minus, PencilLine, Plus, Reply, X } from 'lucide-react';
import type { AgentName, ChatMessage, Ticket } from '../../api/types';
import { useAct } from '../../lib/data';
import { usePrefs } from '../../lib/prefs';
import { SizeHint } from '../split/SizeHint';
import { detect, firstWords, textClass } from '../../lib/lang';
import { ChatMarkdown, Folded, lineCount } from '../ChatMarkdown';
import { AUDIO, ChatFiles, type OpenDoc } from '../ChatFiles';
import { ProposeChange, canPropose, shipped } from '../ChangeCard';
import { Written, clock, dateShort } from '../ui';
import { AGENT_TITLE, Avatar, type ChatSize, type Tool } from './parts';

function MsgActions({ t, m, holder, onReply }: { t: Ticket; m: ChatMessage; holder: RefObject<HTMLDivElement>; onReply(q: string): void }) {
  const act = useAct();
  const { toast } = usePrefs();
  const [menu, setMenu] = useState(false);
  const [change, setChange] = useState(false);
  const words = () => {
    // A sentence you selected inside this message, or the whole message.
    const sel = window.getSelection();
    const picked = sel && !sel.isCollapsed && holder.current?.contains(sel.anchorNode) ? sel.toString().trim() : '';
    return (picked || m.text).trim().slice(0, 2000);
  };
  const add = (kind: 'rule' | 'criterion' | 'note', label: string) => {
    setMenu(false);
    act.mutate({ path: `/api/v1/tickets/${t.id}/notes`, body: { text: words(), kind }, done: `Added to the spec as ${label}.` });
  };
  const copy = () => void navigator.clipboard?.writeText(m.text).then(() => toast('Copied'), () => toast('Could not copy. Select the text instead.', 'err'));
  const quote = () => onReply(`> ${m.text.replace(/\s+/g, ' ').slice(0, 160)}${m.text.length > 160 ? '…' : ''}\n\n`);
  return (
    <div className="cacts">
      <button className="cact" onClick={copy}>
        <Copy size={13} /> Copy
      </button>
      {/* Your message can become a change to the spec: the Analyst writes it, and you approve it. */}
      {m.who === 'you' && m.text.trim() && canPropose(t) && (
        <button className="cact" onClick={() => setChange(true)}>
          <PencilLine size={13} /> Propose as a change
        </button>
      )}
      {!shipped(t) && m.text.trim() && (
        <span className="cmenu-w">
          <button className="cact" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu} onMouseDown={(e) => e.preventDefault()}>
            <Plus size={13} /> Add to spec
          </button>
          {menu && (
            <div className="cmenu" role="menu" onMouseLeave={() => setMenu(false)}>
              <button role="menuitem" onClick={() => add('rule', 'a business rule')} onMouseDown={(e) => e.preventDefault()}>
                <b>A business rule</b>
                <small>Every agent must follow it</small>
              </button>
              <button role="menuitem" onClick={() => add('criterion', 'a "done when" item')} onMouseDown={(e) => e.preventDefault()}>
                <b>A "done when" item</b>
                <small>The Tester proves it with a screenshot</small>
              </button>
              <button role="menuitem" onClick={() => add('note', 'a note')} onMouseDown={(e) => e.preventDefault()}>
                <b>A note</b>
                <small>Context for the next steps</small>
              </button>
            </div>
          )}
        </span>
      )}
      {t.chat?.open && (
        <button className="cact" onClick={quote}>
          <Reply size={13} /> Reply
        </button>
      )}
      {change && <ProposeChange t={t} initial={m.text} from={t.chat?.with} onClose={() => setChange(false)} />}
    </div>
  );
}

/** Your own words: each line its own paragraph, so a line in Arabic and a line in English each read right. */
function asParagraphs(text: string): string {
  let fence = false;
  return text
    .split('\n')
    .map((l, i, all) => {
      if (/^\s*```/.test(l)) fence = !fence;
      const next = all[i + 1] ?? '';
      return !fence && l.trim() && next.trim() && !/^\s*([-*+]|\d+\.|>|```)\s/.test(next) ? `${l}\n` : l;
    })
    .join('\n');
}

/** Your own words. A message you just sent pops in. */
export function YouMessage({ t, m, fresh, onOpenDoc, onReply }: { t: Ticket; m: ChatMessage; fresh?: boolean; onOpenDoc(d: OpenDoc): void; onReply(q: string): void }) {
  const holder = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState(false);
  const voice = !m.text.trim() && (m.files ?? []).some((f) => AUDIO.test(f));
  return (
    <div className={`cyou cmsg ${picked ? 'picked' : ''} ${fresh ? 'pop-in' : ''}`}>
      {/* Only a click on the bubble itself: one in a picture or mockup it opened over the page reaches here too. */}
      <div className="cybub" ref={holder} onClick={(e) => e.currentTarget.contains(e.target as Node) && setPicked(!picked)}>
        {m.text.trim() && <ChatMarkdown text={asParagraphs(m.text)} ticket={t.id} />}
        {m.files && m.files.length > 0 && <ChatFiles ticket={t.id} files={m.files} onOpen={onOpenDoc} sent from="From you" />}
      </div>
      <span className="cmeta">
        You · {when(m.at)}
        {voice ? ' · written out from your voice' : ''}
      </span>
      <MsgActions t={t} m={m} holder={holder} onReply={onReply} />
      {m.big && <SizeHint story={t.id} m={m} />}
    </div>
  );
}

function when(at: string): string {
  const d = new Date(at);
  return d.toDateString() === new Date().toDateString() ? clock(at) : `${dateShort(at)} ${clock(at)}`;
}

export function AgentMessage({
  t,
  m,
  size,
  used,
  writing,
  answer,
  canChoose,
  newest,
  onChoose,
  onOther,
  onOpenDoc,
  onReply,
}: {
  t: Ticket;
  m: ChatMessage;
  /** The latest answer always shows whole. */
  newest: boolean;
  size: ChatSize;
  used: Tool[];
  writing: number | null;
  answer?: string;
  canChoose: boolean;
  onChoose(o: string): void;
  onOther(): void;
  onOpenDoc(d: OpenDoc): void;
  onReply(q: string): void;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState(false);
  const role = m.who as AgentName;
  const name = AGENT_TITLE[role] ?? 'Agent';
  const live = writing !== null;
  const text = live ? firstWords(m.text, writing) : m.text;
  const body = <ChatMarkdown text={text} ticket={t.id} stream={live} caret={live} />;
  return (
    <div className={`cag cmsg ag-${role} ${picked ? 'picked' : ''}`}>
      <Avatar role={role} live={live} />
      <div className="cwho">
        <b>{name}</b>
        {live ? <span className="shim">Writing</span> : <span className="ctime">{when(m.at)}</span>}
      </div>
      <div className="cagb" ref={holder} onClick={(e) => size === 'phone' && e.currentTarget.contains(e.target as Node) && !(e.target as HTMLElement).closest('button, a') && setPicked(!picked)}>
        {used.length > 0 && <Looked steps={used} />}
        {live || newest ? body : <Folded lines={lineCount(m.text)}>{body}</Folded>}
        {!live && m.files && m.files.length > 0 && <ChatFiles ticket={t.id} files={m.files} onOpen={onOpenDoc} from={`From the ${name} · ${when(m.at)}`} />}
        {!live && m.options && m.options.length > 0 && <Choices options={m.options} answer={answer} can={canChoose} onChoose={onChoose} onOther={onOther} />}
      </div>
      {!live && size === 'phone' && <span className="cmeta">{name} · {when(m.at)}</span>}
      {!live && <MsgActions t={t} m={m} holder={holder} onReply={onReply} />}
    </div>
  );
}

/** Tap one, or write your own. The agent's recommended choice comes first. */
function Choices({ options, answer, can, onChoose, onOther }: { options: string[]; answer?: string; can: boolean; onChoose(o: string): void; onOther(): void }) {
  const d = detect(options.join(' '));
  const chosen = answer?.trim();
  return (
    <div className="cchoices" dir={d.dir}>
      {options.map((o, i) => {
        const od = detect(o);
        const cls = chosen ? (chosen === o.trim() ? 'on' : 'off') : can ? '' : 'off';
        return (
          <button key={o} className={`cch ${cls} ${textClass(od)} ${can ? 'rise' : ''}`} style={{ ['--i' as string]: i }} lang={od.dir === 'rtl' ? 'ar' : 'en'} dir={od.dir} disabled={!can} onClick={() => onChoose(o)}>
            {o}
          </button>
        );
      })}
      {can && (
        <button className="cch other rise" style={{ ['--i' as string]: options.length }} onClick={onOther} dir={d.dir}>
          {d.dir === 'rtl' ? 'إجابة أخرى…' : 'Something else…'}
        </button>
      )}
    </div>
  );
}

function stepLine(s: Tool): { title: string; plus?: number; minus?: number } {
  let plus = 0;
  let minus = 0;
  for (const c of s.content) {
    if (c.type !== 'diff') continue;
    const before = (c.oldText ?? '').split('\n').filter(Boolean).length;
    const after = c.newText.split('\n').filter(Boolean).length;
    plus += Math.max(0, after - (c.oldText == null ? 0 : Math.min(before, after)));
    minus += c.oldText == null ? 0 : Math.max(0, before - after);
  }
  return { title: s.title, ...(plus || minus ? { plus, minus } : {}) };
}

function StepRow({ s }: { s: Tool }) {
  const l = stepLine(s);
  return (
    <div className={`cstep ${s.skipped ? 'skipped' : s.status}`}>
      {s.skipped ? <Minus size={13} /> : s.status === 'completed' ? <Check size={13} strokeWidth={2.5} /> : s.status === 'failed' ? <X size={13} /> : <Loader2 size={13} className="spin" />}
      <span className="cstep-t">{l.title}</span>
      {l.plus !== undefined && (
        <span className="cstep-n">
          <span className="add">+{l.plus}</span> <span className="del">−{l.minus}</span>
        </span>
      )}
    </div>
  );
}

/** When the answer is done, its working steps fold into "Looked at 4 things". */
function Looked({ steps }: { steps: Tool[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="cactv" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight size={13} style={{ transform: open ? 'rotate(90deg)' : undefined }} /> Looked at {steps.length} {steps.length === 1 ? 'thing' : 'things'}
      </button>
      {open && (
        <div className="cactlist">
          {steps.map((s) => (
            <StepRow key={s.id} s={s} />
          ))}
        </div>
      )}
    </>
  );
}

/** Before the first word: what the agent is reading, live, and each working step ticking off as it ends. */
export function Thinking({ role, steps, hasMessage }: { role: AgentName; steps: Tool[]; hasMessage: boolean }) {
  const now = steps.filter((s) => s.status === 'in_progress').at(-1) ?? steps.at(-1);
  const label = now ? now.title : hasMessage ? 'Reading your message' : 'Reading the ticket';
  const shown = steps.slice(-6);
  return (
    <div className={`cag cmsg ag-${role} thinking`}>
      <Avatar role={role} live />
      <div className="cwho">
        <b>{AGENT_TITLE[role]}</b>
        <span className="shim">{label}</span>
      </div>
      <div className="cagb">
        <span className="cdots" aria-label={`The ${AGENT_TITLE[role]} is answering`}>
          <i />
          <i />
          <i />
        </span>
        {shown.length > 0 && (
          <div className="csteps">
            {steps.length > shown.length && <div className="cstep more">and {steps.length - shown.length} earlier steps</div>}
            {shown.map((s) => (
              <StepRow key={s.id} s={s} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** A line from squad-kit. A stop or a failure always says what happened, that nothing was lost, and a way on. */
export function SquadNote({ t, m, last, onAsk }: { t: Ticket; m: ChatMessage; last: boolean; onAsk(): void }) {
  const act = useAct();
  const failed = m.note === 'failed' || (!m.note && m.text.startsWith('Could not answer'));
  const who = t.chat ? AGENT_TITLE[t.chat.with] : 'agent';
  const ways = last && t.chat?.open && !t.chat.thinking && (failed || m.note === 'stopped');
  const retry = () => act.mutate({ path: `/api/v1/tickets/${t.id}/chat/retry` });
  if (failed) {
    return (
      <div className="cfail cmsg">
        <div className="cfail-t">
          <CircleAlert size={15} /> The {who} could not answer. Nothing was lost.
          <span className="cfail-why">{m.text.replace(/^Could not answer:\s*/, '')}</span>
        </div>
        {ways && (
          <div className="cbtns">
            <button className="btn pri sm" disabled={act.isPending} onClick={retry}>
              Try again
            </button>
            <button className="btn sm" onClick={onAsk}>
              Ask something else
            </button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="cnote-w cmsg">
      <Written as="div" className="cnote-pill" text={m.text} />
      {ways && (
        <div className="cbtns">
          <button className="btn sm" disabled={act.isPending} onClick={retry}>
            Ask again
          </button>
        </div>
      )}
    </div>
  );
}
