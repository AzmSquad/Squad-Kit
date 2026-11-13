import { Link } from '@tanstack/react-router';
import { Check } from 'lucide-react';
import type { LeadCard, LeadCardRun } from '../../api/types';
import { useAct } from '../../lib/data';
import { WORDS, langOf } from '../../lib/split';
import { Cmd, Written } from '../ui';
import { AreasList, PartsList } from './Parts';
import '../../styles/popups.css';
import '../../styles/split.css';

/**
 * The Squad lead's story draft from a text that is more than one story, by squad-kit's own count or the lead's:
 * Create N stories (each waits for Start), Create as one story, or for a whole document Send to Requirements and Make
 * one story anyway. And the card squad-kit gives at once, with no AI, for a requirements document pasted to the lead.
 * Each press is the card's own run (`squad lead run <card> --split | --one | --requirements`).
 */

type Draft = Extract<LeadCard, { kind: 'draft_story' }>;

function usePress(card: LeadCard) {
  const act = useAct<LeadCardRun>();
  const press = (body: { choice?: 'split' | 'one' | 'requirements'; dismiss?: boolean }) => act.mutate({ path: `/api/v1/lead/cards/${encodeURIComponent(card.id)}/run`, body });
  return { press, busy: act.isPending };
}

/** What the press did, green, with the stories it made or the breakdown it became. */
function Done({ card, stories, breakdown }: { card: LeadCard; stories?: string[]; breakdown?: string }) {
  if (card.status === 'dismissed') return <div className="lc-f lc-quiet">Put aside. Nothing was done.</div>;
  return (
    <div className="done" role="status">
      <Check aria-hidden="true" />
      <Written text={card.result ?? 'Done.'} />
      {stories?.map((id) => (
        <Link key={id} to="/board" search={{ ticket: id }} className="lc-link">
          {id}
        </Link>
      ))}
      {breakdown && (
        <Link to="/requirements/$id" params={{ id: breakdown }} className="lc-link">
          {breakdown}
        </Link>
      )}
    </div>
  );
}

export function LeadSplit({ card }: { card: Draft }) {
  const { press, busy } = usePress(card);
  const s = card.split!;
  const lang = langOf(`${card.title} ${card.ask}`);
  const w = WORDS[lang];
  const few = s.size === 'few';
  const title = few ? w.title(s.parts.length) : w.brd.title;
  const open = card.status === 'open';
  return (
    <section className={`decide splitcard ${open ? '' : 'decided'}`} dir={lang === 'ar' ? 'rtl' : 'ltr'} lang={lang} aria-label={`${title}: ${card.title}`}>
      <div className="dh">
        <b>{title}</b>
        <span className="who">{w.who}</span>
      </div>
      <div className="db">
        {few && s.why && <Written as="p" className="sum" text={s.why} />}
        {few ? <PartsList s={s} w={w} {...(card.stories ? { ids: card.stories } : {})} /> : <AreasList s={s} w={w} />}
      </div>
      {open ? (
        <>
          <div className="df">
            <button className="btn pri" disabled={busy} onClick={() => press({ choice: few ? 'split' : 'requirements' })}>
              {few ? w.create(s.parts.length) : w.brd.send}
            </button>
            <button className="btn" disabled={busy} onClick={() => press({ choice: 'one' })}>
              {few ? w.one : w.brd.anyway}
            </button>
            <button className="btn ghost" disabled={busy} onClick={() => press({ dismiss: true })}>
              {w.discard}
            </button>
            <Cmd text={`${card.command} ${few ? '--split' : '--requirements'}`} />
          </div>
          {card.result && <Written as="p" className="refused" text={card.result} />}
          <p className="yours">
            <bdi>{few ? w.hint : w.brd.hintText}</bdi>
          </p>
        </>
      ) : (
        <Done card={card} {...(card.stories ? { stories: card.stories } : card.story ? { stories: [card.story] } : {})} {...(card.breakdown ? { breakdown: card.breakdown } : {})} />
      )}
    </section>
  );
}

/** A requirements document pasted to the lead: one press from Requirements, in the language it was written in. */
export function LeadRequirements({ card }: { card: Extract<LeadCard, { kind: 'requirements' }> }) {
  const { press, busy } = usePress(card);
  const w = WORDS[card.lang];
  return (
    <section className={`decide splitcard ${card.status === 'open' ? '' : 'decided'}`} dir={card.lang === 'ar' ? 'rtl' : 'ltr'} lang={card.lang} aria-label={w.brd.title}>
      <div className="dh">
        <b>{w.brd.title}</b>
        <span className="who">{w.who}</span>
      </div>
      <div className="db brd">
        <p>{w.brd.why}</p>
        {card.found.length > 0 && <p className="found">{w.found(card.found)}</p>}
      </div>
      {card.status === 'open' ? (
        <div className="df">
          <button className="btn pri" disabled={busy} onClick={() => press({})}>
            {w.brd.send}
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => press({ dismiss: true })}>
            {w.notNow}
          </button>
          <Cmd text={card.command} />
        </div>
      ) : (
        <Done card={card} {...(card.breakdown ? { breakdown: card.breakdown } : {})} />
      )}
    </section>
  );
}
