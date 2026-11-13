import { useState } from 'react';
import { ticketFileUrl } from '../../api/client';
import type { Ticket, TicketNote } from '../../api/types';
import { useAct } from '../../lib/data';
import { Cmd, Written, WrittenLines, ago } from '../../components/ui';
import { ChangeHistory } from '../../components/ChangeCard';
import { Lightbox, type Picture } from '../../components/Lightbox';
import { shellQuote } from '../../lib/text';
import { DecidedForYou } from '../../components/AutoTicket';
import { useDraft } from '../../lib/drafts';
import { langProps, typedDir } from '../../lib/lang';
import { PlanBody } from './Plan';

/* ── Other tabs ────────────────────────────────────────── */

export function StoryTab({ t }: { t: Ticket }) {
  return (
    <div className="db">
      <div className="lbl">What was asked</div>
      <WrittenLines as="p" className="story" style={{ whiteSpace: 'pre-wrap' }} text={t.ask} />
      <BriefList head="Your acceptance criteria" items={t.brief?.criteria} />
      <BriefList head="Business rules" items={t.brief?.rules} />
      <BriefList head="Edge cases" items={t.brief?.edgeCases} />
      <Attachments t={t} />
      <Notes t={t} />
      <ChangeHistory t={t} />
      <DecidedForYou t={t} />
      {t.story ? (
        <PlanBody t={{ ...t, decision: undefined, work: undefined }} />
      ) : (
        <p className="note" style={{ marginTop: 16 }}>The Analyst writes the user story after your answers.</p>
      )}
    </div>
  );
}

const NOTE_KINDS = [
  { kind: 'note', label: 'Note', head: 'Note', hint: 'Anything the squad should know' },
  { kind: 'rule', label: 'Business rule', head: 'Rule', hint: 'For example: at most 3 bookings a day per person' },
  { kind: 'criterion', label: 'Acceptance criterion', head: 'Done when', hint: 'The Tester must prove it, for example: the clerk sees an error on the 4th booking' },
] as const;

/** Notes the person adds at any time. Every agent on the ticket reads them; a running one gets them at its next step. */
export function Notes({ t }: { t: Ticket }) {
  const act = useAct();
  const [kind, setKind] = useState<TicketNote['kind']>('note');
  const [text, setText] = useDraft(t.id, 'note', '');
  const notes = t.notes ?? [];
  const open = t.stage !== 'done';
  const pick = NOTE_KINDS.find((k) => k.kind === kind)!;
  const add = () => {
    if (!text.trim() || act.isPending) return;
    act.mutate(
      { path: `/api/v1/tickets/${t.id}/notes`, body: { text, kind }, done: t.live ? 'Added. The squad reads it at its next step.' : 'Added. Every agent on this ticket reads it.' },
      { onSuccess: () => setText('') },
    );
  };
  if (!open && !notes.length) return null;
  return (
    <>
      <div className="lbl">Notes{notes.length ? ` · ${notes.length}` : ''}</div>
      {notes.length > 0 && (
        <ul className="ticketnotes">
          {notes.map((n, i) => (
            <li key={i} {...langProps(n.text)}>
              <span className={`pill ${n.kind === 'criterion' ? 'ok' : n.kind === 'rule' ? 'wait' : ''}`}>{NOTE_KINDS.find((k) => k.kind === n.kind)?.head}</span>
              <Written className="grow" text={n.text} />
              <span className="note" dir="ltr"><Written text={n.by} /> · {ago(n.at)}</span>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <div className="addnote">
          <div className="seg" style={{ width: 'fit-content' }}>
            {NOTE_KINDS.map((k) => (
              <button key={k.kind} className={kind === k.kind ? 'on' : ''} onClick={() => setKind(k.kind)}>
                {k.label}
              </button>
            ))}
          </div>
          <textarea
            className="input"
            rows={2}
            dir={typedDir(text)}
            value={text}
            placeholder={pick.hint}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) add();
            }}
          />
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button className="btn pri sm" disabled={!text.trim() || act.isPending} onClick={add}>
              Add {pick.label.toLowerCase()}
            </button>
            <span className="note">Every agent on this ticket reads it{t.live ? ', the one working now from its next step' : ''}.</span>
            <span className="grow" />
            <Cmd text={`squad note ${t.id}${kind === 'note' ? '' : ` --${kind}`} ${shellQuote(text.trim() || '…')}`} />
          </div>
        </div>
      )}
    </>
  );
}

function BriefList({ head, items }: { head: string; items?: string[] }) {
  if (!items?.length) return null;
  return (
    <>
      <div className="lbl">{head}</div>
      <ul className="brief">
        {items.map((x, i) => (
          <Written as="li" key={i} text={x} />
        ))}
      </ul>
    </>
  );
}

const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** The files that came with the ticket. Pictures open in the viewer; anything else opens or downloads. */
function Attachments({ t }: { t: Ticket }) {
  const [zoom, setZoom] = useState<number | null>(null);
  const files = t.attachments ?? [];
  if (!files.length) return null;
  const name = (f: string) => f.split(/[\\/]/).pop() ?? f;
  const pictures: Picture[] = files.filter((f) => IMAGE.test(f)).map((f) => ({ src: ticketFileUrl(t.id, f), caption: name(f) }));
  const others = files.filter((f) => !IMAGE.test(f));
  return (
    <>
      <div className="lbl">Attached · {files.length}</div>
      {pictures.length > 0 && (
        <div className="thumbs">
          {pictures.map((p, i) => (
            <button key={p.src} className="zoom thumb" onClick={() => setZoom(i)} aria-label={`Open ${p.caption} full size`}>
              <img src={p.src} alt={p.caption} loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {others.map((f) => (
        <a key={f} className="filechip mono" href={ticketFileUrl(t.id, f)} target="_blank" rel="noreferrer">
          {name(f)}
        </a>
      ))}
      {zoom !== null && <Lightbox pictures={pictures} start={zoom} onClose={() => setZoom(null)} />}
    </>
  );
}
