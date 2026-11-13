import { useNavigate } from '@tanstack/react-router';
import { Sparkles } from 'lucide-react';
import type { DraftJob, Ticket } from '../../api/types';
import { useAct } from '../../lib/data';
import { usePrefs } from '../../lib/prefs';
import { andList } from '../../lib/lead';
import { WORDS, langOf } from '../../lib/split';
import { Cmd } from '../ui';
import { AreasList, PartsList } from './Parts';
import '../../styles/popups.css';
import '../../styles/split.css';

/**
 * New ticket, From an idea or message, when the Analyst found more than one story: its suggestion before anything is
 * created. A few stories: Create N stories, Create as one story, Cancel. A whole requirements document: Send to
 * Requirements, Make one story anyway, Cancel. "As one" goes on to the form as usual; nothing is made until a press.
 */

/** The suggestion under the pasted text. */
export function DraftSuggestion({ job }: { job: DraftJob }) {
  const s = job.draft!.split!;
  const lang = langOf(job.text);
  const w = WORDS[lang];
  const few = s.size === 'few';
  return (
    <div className="draftsize" dir={lang === 'ar' ? 'rtl' : 'ltr'} lang={lang}>
      <div className="read">
        <Sparkles size={15} aria-hidden="true" />
        <span>{few ? w.read(s.parts.length) : w.brd.read}</span>
      </div>
      <section className="decide splitcard" aria-label={few ? w.title(s.parts.length) : w.brd.title}>
        <div className="dh">
          <b>{few ? w.title(s.parts.length) : w.brd.title}</b>
          <span className="who">{w.who}</span>
        </div>
        <div className="db">{few ? <PartsList s={s} w={w} /> : <AreasList s={s} w={w} />}</div>
      </section>
    </div>
  );
}

/**
 * The dialog's buttons for it. `onOne`: go on to the form, as one story (`brd` keeps a short warning on it). The same
 * press sent again gets the same stories: the board keeps them on the draft.
 */
export function DraftSizeButtons({ job, onOne, onCancel, onMade }: { job: DraftJob; onOne(sized: 'kept' | 'brd'): void; onCancel(): void; onMade(first?: Ticket): void }) {
  const s = job.draft!.split!;
  const lang = langOf(job.text);
  const w = WORDS[lang];
  const few = s.size === 'few';
  const { toast } = usePrefs();
  const navigate = useNavigate();
  const split = useAct<{ tickets: Ticket[] }>();
  const send = useAct<{ breakdown: { id: string } }>();
  const busy = split.isPending || send.isPending;
  const create = () =>
    split.mutate(
      { path: `/api/v1/tickets/draft/${job.id}/split` },
      {
        onSuccess: ({ tickets }) => {
          const ids = tickets.map((t) => t.id);
          toast(`Created ${andList(ids)}. ${ids[0]} starts now; the others wait in Tickets until you start them.`);
          onMade(tickets[0]);
        },
      },
    );
  const requirements = () =>
    send.mutate(
      { path: `/api/v1/tickets/draft/${job.id}/requirements` },
      {
        onSuccess: ({ breakdown }) => {
          toast(`Sent to Requirements as ${breakdown.id}. The Analyst reads it first.`);
          onMade();
          void navigate({ to: '/requirements/$id', params: { id: breakdown.id } });
        },
      },
    );
  return (
    <>
      <div className="sizebar" dir={lang === 'ar' ? 'rtl' : 'ltr'} lang={lang}>
        <button className="btn pri" disabled={busy} onClick={few ? create : requirements}>
          {few ? w.create(s.parts.length) : w.brd.send}
        </button>
        <button className="btn" disabled={busy} onClick={() => onOne(few ? 'kept' : 'brd')}>
          {few ? w.one : w.brd.anyway}
        </button>
        <button className="btn" disabled={busy} onClick={onCancel}>
          {w.cancel}
        </button>
        <span className="grow" />
        <span className="note">{few ? w.hint : job.files.length ? w.brd.hint : w.brd.hintText}</span>
      </div>
      <Cmd text={`squad new --from "…" ${few ? '--split' : '--requirements'}`} />
    </>
  );
}
