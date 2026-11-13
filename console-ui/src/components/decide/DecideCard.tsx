import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, CircleAlert } from 'lucide-react';
import { send } from '../../api/client';
import type { Ticket } from '../../api/types';
import { useBoard } from '../../lib/data';
import { cardState, changeTo, decideKind, footnote, latestPress, outcome, pressShown, pressedKey, readPressed, savePressed, seeable, whoFor, yesLabel, type DecideKind, type Pressed } from '../../lib/decide';
import { detect } from '../../lib/lang';
import { Cmd, Written } from '../ui';
import { isMine, ownerOf, useMe } from '../HandOver';
import { AskFoot, LET_IT_DECIDE, QuestionsFoot } from './Answers';
import { Body, OpenLink } from './Body';
import { useCardBox } from './BoxAsk';
import { SplitCard } from '../split/SplitCard';

/**
 * A decision only the person can make, in the chat where they talk: a proof to accept, a spec, a plan or a design to
 * approve, questions to answer, an agent's question. It is drawn from the story as the board has it now, with the
 * board's own buttons: the same calls as the ticket's own, sent with the mark of what the card showed, so the board
 * refuses a press on something that changed. The lead may bring the card; only the person presses it. Never blind:
 * no Looks right or Approve without the thing to look at.
 */

/** `made`: the mark the lead's card was made with. A story's own talk leaves it out: it shows the story as it is. */
export function DecideCard({ story, made, fromLead }: { story: string; made?: string; fromLead?: boolean }) {
  const board = useBoard();
  const t = board.data?.ready ? board.data.tickets.find((x) => x.id === story) : undefined;
  const loading = !board.data;
  // The mark the card showed last while it was live: a press is remembered by it.
  const shownKey = useRef<string | undefined>(made ?? t?.waitKey);
  const state = loading ? 'live' : cardState(t, made);
  if (state === 'live' && t?.waitKey && !made) shownKey.current = t.waitKey;
  // Pressed here, in this card or in another one of the same story and wait.
  const [mine, setPressed] = useState<Pressed | null>(null);
  const pressed = pressShown({ mine, kept: readPressed()[pressedKey(story, shownKey.current)] ?? null, latest: latestPress(story), ...(made ? { made } : {}), state, ...(t?.waitKey ? { waitKey: t.waitKey } : {}) });
  const [refused, setRefused] = useState<string | null>(null);
  // A refusal belongs to the wait it was pressed on.
  useEffect(() => setRefused(null), [t?.waitKey]);
  // Someone else's story: their squad works on it on their computer, so the card only opens it, as the ticket does.
  const me = useMe();
  if (loading) return null;
  const kind = t ? decideKind(t) : null;
  // The Analyst's split has a card of its own, drawn from the story the same way, and green from its record once decided.
  if (t && kind === 'split' && (!me || isMine(t, me))) return <SplitCard t={t} />;

  if (pressed) {
    // What it showed when pressed, from the story as the board has it now: the proof, the spec or the plan stay on it.
    const was = pressed.kind ?? kind;
    return (
      <section className="decide decided" aria-label={`${story}: done`}>
        <Head t={t} story={story} who={t && was ? whoFor(t, was) : 'Done'} />
        {t && was && was !== 'open' && was !== 'questions' && was !== 'ask' && <Body t={t} kind={was} />}
        <div className="done" role="status">
          <Check aria-hidden="true" />
          <Written text={pressed.words} />
        </div>
      </section>
    );
  }
  if (state === 'live' && t && kind && me && !isMine(t, me)) {
    return (
      <section className="decide off" aria-label={`${story}: ${ownerOf(t)}'s`}>
        <Head t={t} story={story} who={`${ownerOf(t)}'s`} />
        <div className="note-row">
          <bdi>{ownerOf(t)} owns this story: it waits for them, on their computer.</bdi>
          <OpenLink t={t} label={`Open ${t.id}`} />
        </div>
      </section>
    );
  }
  if (state !== 'live' || !t || !kind) {
    return (
      <section className={`decide off ${state}`} aria-label={`${story}: ${state}`}>
        <Head t={t} story={story} who={state === 'changed' ? 'Changed since' : state === 'gone' ? 'Gone' : 'Decided'} />
        <div className="note-row">
          {state === 'changed' ? (
            <>
              <bdi>Changed since this card was made.</bdi>
              <OpenLink t={t!} label="Open it" />
            </>
          ) : state === 'gone' ? (
            <bdi>It is no longer on the board.</bdi>
          ) : (
            <>
              <Check size={14} strokeWidth={2.6} aria-hidden="true" />
              <bdi>Already decided on the board.</bdi>
              {t && <OpenLink t={t} label={`Open ${t.id}`} />}
            </>
          )}
        </div>
      </section>
    );
  }
  return (
    <LiveCard
      t={t}
      kind={kind}
      expect={made ?? t.waitKey}
      fromLead={Boolean(fromLead)}
      refused={refused}
      onRefused={setRefused}
      onDone={(words) => {
        const key = made ?? t.waitKey;
        savePressed(pressedKey(story, key), words, kind, key);
        setPressed({ words, at: new Date().toISOString(), kind, ...(key ? { key } : {}) });
      }}
    />
  );
}

function Head({ t, story, who }: { t?: Ticket; story: string; who: string }) {
  return (
    <div className="dh">
      <span className="sid">{story}</span>
      {t ? <Written as="b" text={t.title} /> : <b />}
      <span className="who">{who}</span>
    </div>
  );
}

/** The card with its buttons. Each press is the board's own call; a refusal stays on the card in the board's words. */
function LiveCard({ t, kind, expect, fromLead, refused, onRefused, onDone }: { t: Ticket; kind: DecideKind; expect?: string; fromLead: boolean; refused: string | null; onRefused(words: string | null): void; onDone(words: string): void }) {
  const qc = useQueryClient();
  const box = useCardBox();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [hit, setHit] = useState<string | null>(null);
  const press = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: Record<string, unknown>; words: (after: Ticket | null) => string; then?: () => void }) => send<Ticket>(`/api/v1/tickets/${t.id}/${path}`, 'POST', { ...body, ...(expect ? { expect } : {}) }),
    onSuccess: (after, v) => {
      onRefused(null);
      onDone(v.words(after && typeof after === 'object' ? after : null));
      v.then?.();
      // The board, the heads and the badges show it at once.
      void qc.invalidateQueries();
    },
    onError: (err) => {
      onRefused(err instanceof Error ? err.message : String(err));
      void qc.invalidateQueries();
    },
  });
  const sendBack = (text: string) => press.mutate({ path: 'change', body: { text }, words: () => outcome(kind, t.id, null, 'change'), then: () => box?.done() });
  const wrong = () => {
    const who = changeTo(kind);
    if (box) box.ask({ placeholder: kind === 'proof' ? `Tell the ${who} what is wrong…` : `Tell the ${who} what should change…`, label: `Goes back to the ${who} on ${t.id}`, send: sendBack });
    else setAsking(true);
  };
  const yes = () => {
    setHit('yes');
    press.mutate({ path: 'approve', words: (after) => outcome(kind, t.id, after, 'yes') });
  };
  const see = seeable(t, kind);
  const busy = press.isPending;
  return (
    <section className={`decide ${hit ? 'pressing' : ''}`} aria-label={`${t.id}: ${whoFor(t, kind)}`}>
      <Head t={t} story={t.id} who={whoFor(t, kind)} />
      <Body t={t} kind={kind} />
      {refused && (
        <div className="refused" role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          <Written text={refused} />
        </div>
      )}
      {kind === 'questions' ? (
        <QuestionsFoot t={t} expect={expect} onDone={onDone} onRefused={onRefused} />
      ) : kind === 'ask' ? (
        <AskFoot t={t} busy={busy} onPick={(answer) => press.mutate({ path: 'reply', body: { text: answer }, words: (after) => outcome(kind, t.id, after, { answer: answer === LET_IT_DECIDE ? 'Let it decide' : answer }) })} />
      ) : kind === 'open' ? (
        <div className="df">
          <OpenLink t={t} label={`Open ${t.id}`} btn />
        </div>
      ) : asking ? (
        <div className="df ask">
          <input className="input" autoFocus dir={note.trim() ? detect(note).dir : 'auto'} value={note} onChange={(e) => setNote(e.target.value)} placeholder={kind === 'proof' ? "What's wrong? One line is enough." : 'What should change? One line is enough.'} onKeyDown={(e) => e.key === 'Enter' && note.trim() && !busy && sendBack(note)} />
          <button className="btn pri" disabled={!note.trim() || busy} onClick={() => sendBack(note)}>
            Send back
          </button>
          <button className="btn" onClick={() => setAsking(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="df">
          {see && (
            <button className={`btn pri ${hit === 'yes' ? 'press' : ''}`} disabled={busy} onClick={yes}>
              {busy && hit === 'yes' ? 'Saving…' : yesLabel(kind)}
            </button>
          )}
          <button className="btn" disabled={busy} onClick={wrong}>
            {kind === 'proof' ? "Something's wrong" : 'Ask for changes'}
          </button>
          <OpenLink t={t} label={kind === 'proof' ? 'Full proof' : 'Read it all'} />
          <Cmd text={`squad approve ${t.id}`} />
        </div>
      )}
      {!see && kind !== 'open' && (
        <p className="yours">
          <bdi>Nothing to look at here yet: open it on the board to check it first.</bdi>
        </p>
      )}
      {(kind === 'proof' || kind === 'spec' || kind === 'plan' || kind === 'design' || fromLead) && (
        <p className="yours">
          <bdi>{footnote(kind, fromLead)}</bdi>
        </p>
      )}
    </section>
  );
}
