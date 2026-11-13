import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, CircleAlert } from 'lucide-react';
import { send } from '../../api/client';
import type { Ticket } from '../../api/types';
import { detect } from '../../lib/lang';
import { WORDS, showDecidedSplit, splitOutcome, storyLang } from '../../lib/split';
import { Cmd, Written } from '../ui';
import { useCardBox } from '../decide/BoxAsk';
import { AreasList, PartsList } from './Parts';
import '../../styles/popups.css';
import '../../styles/split.css';

/**
 * The Analyst's suggestion on a story too big for one, as a decision card: in the story's talk, in the lead's answer
 * about it, and in its Now tab. The parts in build order, then Split into N, Keep as one, or Change the split (the note
 * goes in the chat's own box); a whole document has Send to Requirements instead. Each press is the board's own call
 * (`squad split`), sent with the mark of what the card showed. After it the card turns green with what really happened.
 * In the person's language, right to left in Arabic.
 */

type Choice = 'split' | 'keep' | 'change' | 'requirements';

/** Drawn from the story as the board has it now; a press is sent with the mark of what it showed. */
export function SplitCard({ t }: { t: Ticket }) {
  const s = t.split?.suggestion;
  const lang = storyLang(t);
  const w = WORDS[lang];
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  if (t.waiting?.kind === 'split' && s) return <LiveSplit t={t} />;
  // The story moved on: the card shows what was decided, from the board's own record.
  const outcome = splitOutcome(t, w);
  if (!s || !outcome) return null;
  const ids = t.split?.decided?.choice === 'split' ? t.split.decided.made : undefined;
  return (
    <section className="decide splitcard decided" dir={dir} lang={lang} aria-label={`${t.id}: ${outcome}`}>
      <Head t={t} title={s.size === 'brd' ? w.brd.title : w.title(s.parts.length)} who={w.who} />
      <div className="db">{s.size === 'brd' ? <AreasList s={s} w={w} /> : <PartsList s={s} w={w} {...(ids ? { ids } : {})} />}</div>
      <div className="done" role="status">
        <Check aria-hidden="true" />
        <Written text={outcome} />
      </div>
    </section>
  );
}

/** A decided split stays in the talk while the story is at its first steps: above the next thing to decide. */
export function SplitDone({ t }: { t: Ticket }) {
  return showDecidedSplit(t) || (t.split?.change && !t.waiting) ? <SplitCard t={t} /> : null;
}

function Head({ t, title, who }: { t: Ticket; title: string; who: string }) {
  return (
    <div className="dh">
      <span className="sid">{t.id}</span>
      <b>{title}</b>
      <span className="who">{who}</span>
    </div>
  );
}

function LiveSplit({ t }: { t: Ticket }) {
  const qc = useQueryClient();
  const box = useCardBox();
  const s = t.split!.suggestion!;
  const lang = storyLang(t);
  const w = WORDS[lang];
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [hit, setHit] = useState<Choice | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const press = useMutation({
    mutationFn: ({ choice, text }: { choice: Choice; text?: string }) => send<Ticket>(`/api/v1/tickets/${t.id}/split`, 'POST', { choice, ...(text ? { note: text } : {}), expect: t.waitKey }),
    onSuccess: (after) => {
      setRefused(null);
      setSaid(splitOutcome(after, w));
      box?.done();
      // The board, the new stories, the heads and the badges show it at once.
      void qc.invalidateQueries();
    },
    onError: (err) => {
      setRefused(err instanceof Error ? err.message : String(err));
      void qc.invalidateQueries();
    },
  });
  const go = (choice: Choice, text?: string) => {
    setHit(choice);
    press.mutate({ choice, ...(text ? { text } : {}) });
  };
  const change = () => {
    if (box) box.ask({ placeholder: w.ask, label: w.askLabel(t.id), send: (text) => go('change', text) });
    else setAsking(true);
  };
  const busy = press.isPending;
  const few = s.size === 'few';
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  if (said) {
    return (
      <section className="decide splitcard decided" dir={dir} lang={lang} aria-label={`${t.id}: ${said}`}>
        <Head t={t} title={few ? w.title(s.parts.length) : w.brd.title} who={w.who} />
        <div className="done" role="status">
          <Check aria-hidden="true" />
          <Written text={said} />
        </div>
      </section>
    );
  }
  return (
    <section className={`decide splitcard ${hit ? 'pressing' : ''}`} dir={dir} lang={lang} aria-label={`${t.id}: ${few ? w.title(s.parts.length) : w.brd.title}`}>
      <Head t={t} title={few ? w.title(s.parts.length) : w.brd.title} who={w.who} />
      <div className="db">
        {few && s.why && <Written as="p" className="sum" text={s.why} />}
        {few ? <PartsList s={s} w={w} /> : <AreasList s={s} w={w} />}
        {few && <p className="note">{w.note(t.id, s.parts.length)}</p>}
      </div>
      {refused && (
        <div className="refused" role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          <Written text={refused} />
        </div>
      )}
      {asking ? (
        <div className="df ask">
          <input className="input" autoFocus dir={note.trim() ? detect(note).dir : 'auto'} value={note} onChange={(e) => setNote(e.target.value)} placeholder={w.ask} onKeyDown={(e) => e.key === 'Enter' && note.trim() && !busy && go('change', note.trim())} />
          <button className="btn pri" disabled={!note.trim() || busy} onClick={() => go('change', note.trim())}>
            {w.send}
          </button>
          <button className="btn" onClick={() => setAsking(false)}>
            {w.cancel}
          </button>
        </div>
      ) : (
        <div className="df">
          {few ? (
            <button className={`btn pri ${hit === 'split' ? 'press' : ''}`} disabled={busy} onClick={() => go('split')}>
              {w.yes(s.parts.length)}
            </button>
          ) : (
            <button className={`btn pri ${hit === 'requirements' ? 'press' : ''}`} disabled={busy} onClick={() => go('requirements')}>
              {w.brd.send}
            </button>
          )}
          <button className={`btn ${hit === 'keep' ? 'press' : ''}`} disabled={busy} onClick={() => go('keep')}>
            {few ? w.keep : w.brd.keep}
          </button>
          {few && (
            <button className="link" disabled={busy} onClick={change}>
              {w.change}
            </button>
          )}
          <Cmd text={`squad split ${t.id} ${few ? '--yes' : '--requirements'}`} />
        </div>
      )}
      <p className="yours">
        <bdi>{w.yours}</bdi>
      </p>
    </section>
  );
}
