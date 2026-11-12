import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Check, ShieldCheck } from 'lucide-react';
import type { LeadAllowable, LeadView, MorningBrief, NeedsYouItem } from '../api/types';
import { useAct } from '../lib/data';
import { dollars, openLabel, placeOf, problemOf, problemQuestion } from '../lib/lead';
import { leadAsk } from '../lib/leadAsk';
import { useLeadCan, useLeadRules } from '../lib/leadData';
import { RailButtons } from './LeadCards';
import { Cmd, Modal, Written } from './ui';

/**
 * Beside the conversation, apart from it: what needs you (with the lead's check-in words and the real ways out), who
 * in the squad works on what now, the morning brief when it is on, and what the lead can do, in its three levels.
 * All of it comes from the board's own data, with no AI.
 */
export function LeadRail({ view }: { view?: LeadView }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const needs = (view?.needsYou ?? []).filter((n) => !hidden.has(n.id));
  const now = view?.squadNow ?? [];
  return (
    <aside className="lead-rail" aria-label="Needs you and the squad now">
      <section>
        <h5>
          {needs.length > 0 && <span className="n">{needs.length}</span>}
          Needs you
        </h5>
        {needs.length ? (
          <div className="stack">
            {needs.map((n) => (
              <NeedsYou key={n.id} n={n} onNotNow={() => setHidden((h) => new Set(h).add(n.id))} />
            ))}
          </div>
        ) : (
          <p className="lr-calm">
            <Check size={14} strokeWidth={2.6} aria-hidden="true" /> Nothing needs you right now.
          </p>
        )}
      </section>
      {view?.brief && <Brief b={view.brief} />}
      <section>
        <h5>The squad now</h5>
        {now.length ? (
          <div className="stack">
            {now.map((s) => (
              <Link key={`${s.story}-${s.who}`} to="/board" search={{ ticket: s.story }} className={`sqr ${s.slow ? 'slow' : ''}`} title={`${s.story} ${s.title}`}>
                <span className="who">{s.who}</span>
                <span className="id">{s.story}</span>
                <Written className="st" text={s.doing} />
                {s.progress !== undefined && (
                  <span className="bar2" aria-label={`About ${Math.round(s.progress * 100)}% of this step`}>
                    <i style={{ width: `${Math.round(s.progress * 100)}%` }} />
                  </span>
                )}
              </Link>
            ))}
          </div>
        ) : (
          <p className="lr-calm">No one is working right now.</p>
        )}
      </section>
      <CanDo view={view} />
    </aside>
  );
}

/** One thing that needs you: the lead's check-in, Open, Ask about it, and its ways out as buttons. */
function NeedsYou({ n, onNotNow }: { n: NeedsYouItem; onNotNow(): void }) {
  const place = placeOf(n.open);
  const ask = () => leadAsk.open({ text: problemQuestion(problemOf(n), n.story), context: { from: 'problem', problem: problemOf(n), story: n.story } });
  const ways = n.cards.filter((c) => c.status === 'open' && !c.byItself);
  const by = n.cards.find((c) => c.byItself)?.byItself;
  // A slower step is no wait for you: a calm card, like the board's own.
  const you = n.kind !== 'slow';
  return (
    <div className={`prow ${you ? 'you' : ''}`}>
      <div className="pt">
        <Written as="b" text={n.words} />
        {n.more && <Written as="small" text={n.more} />}
        {by && <small className="by">{by}</small>}
      </div>
      <div className="acts">
        {ways.length > 0 ? (
          <RailButtons cards={ways} />
        ) : place?.to === '/tickets/$id/proof' ? (
          <Link to="/tickets/$id/proof" params={{ id: place.id }} className="btn pri sm">
            {openLabel(n)}
          </Link>
        ) : (
          <Link to="/board" search={{ ticket: place?.to === '/board' ? place.ticket : n.story }} className="btn pri sm">
            {openLabel(n)}
          </Link>
        )}
        {n.kind !== 'slow' && (
          <button className="btn sm ghost" onClick={ask}>
            Ask about it
          </button>
        )}
        {ways.length > 0 && (
          <button className="btn sm ghost" onClick={onNotNow} title="Hides it here for now. It comes back while the story still needs you.">
            Not now
          </button>
        )}
      </div>
    </div>
  );
}

/** The morning brief, when it is on: since yesterday evening. */
function Brief({ b }: { b: MorningBrief }) {
  const line = (label: string, xs: string[]) => (xs.length ? <Written as="li" lead={<b>{label}</b>} text={xs.join(', ')} /> : null);
  return (
    <section>
      <h5>This morning</h5>
      <div className="lr-brief">
        <Written as="p" text={b.headline} />
        <ul>
          {line('Merged', b.merged)}
          {line('Released', b.released)}
          {line('Working', b.working)}
          {line('Stopped', b.stopped)}
        </ul>
        {b.costUsd !== undefined && <span className="note">The AI used {dollars(b.costUsd)} since then.</span>}
      </div>
    </section>
  );
}

const LEVEL_DOT = ['var(--accent)', 'var(--you)', 'var(--bug)'];
const LEVEL_WORDS = [
  'Read the code and the stories, look at the app in its own copy, answer, tell you what needs you.',
  'Create a story, start or stop one, give more time. "Always allow" only for low-risk ones.',
  'Change code, merge, press Looks right, touch your real data or secrets.',
];

/** "What it can do": the three levels in one line each, and everything with your rules one press away. */
function CanDo({ view }: { view?: LeadView }) {
  const can = useLeadCan();
  const [open, setOpen] = useState(false);
  const levels = can.data?.levels ?? [
    { level: 1 as const, name: 'On its own', words: LEVEL_WORDS[0]!, items: [] },
    { level: 2 as const, name: 'After your OK', words: LEVEL_WORDS[1]!, items: [] },
    { level: 3 as const, name: 'Never', words: LEVEL_WORDS[2]!, items: [] },
  ];
  return (
    <section>
      <h5>
        <ShieldCheck size={14} aria-hidden="true" />
        What it can do
      </h5>
      <div className="can">
        {levels.map((l, i) => (
          <div className="cl" key={l.level}>
            <b>
              <span className="d" style={{ background: LEVEL_DOT[i] }} />
              {l.name}
            </b>
            <span>{l.words}</span>
          </div>
        ))}
        <button className="more" onClick={() => setOpen(true)}>
          See everything, and your rules <ArrowRight size={13} />
        </button>
      </div>
      {view && (
        <p className="lr-today">
          Today: {dollars(view.today.costUsd)} of {dollars(view.today.limitUsd)} a day
        </p>
      )}
      {open && <CanDialog onClose={() => setOpen(false)} />}
    </section>
  );
}

/** Everything it can and can't do, "Always allow" for the low-risk ones only, the morning brief, and its limits. */
function CanDialog({ onClose }: { onClose(): void }) {
  const can = useLeadCan();
  const rules = useLeadRules();
  const act = useAct();
  const r = rules.data;
  const save = (always: LeadAllowable[], brief: boolean, done: string) => act.mutate({ path: '/api/v1/lead/rules', method: 'PUT', body: { always, brief }, done });
  const toggle = (id: LeadAllowable, name: string) => {
    if (!r) return;
    const on = r.always.includes(id);
    save(on ? r.always.filter((x) => x !== id) : [...r.always, id], r.brief, on ? `It asks you each time now: ${name.toLowerCase()}` : `Always allowed: ${name.toLowerCase()}`);
  };
  const levels = can.data?.levels ?? [];
  const cmd = r ? `squad lead rules --always ${r.always.length ? r.always.join(',') : 'none'} --brief ${r.brief ? 'on' : 'off'}` : 'squad lead rules';
  return (
    <Modal title="What the Squad lead can do" wide onClose={onClose} footer={<><Cmd text={cmd} /><span className="grow" /><button className="btn pri" onClick={onClose}>Done</button></>}>
      <div className="lr-can">
        {levels.map((l, i) => (
          <div key={l.level} className="lr-level">
            <b>
              <span className="d" style={{ background: LEVEL_DOT[i] }} />
              {l.name}
            </b>
            <ul>
              {l.items.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
            {l.level === 2 && r && (
              <div className="lr-always">
                <p className="note">{can.data?.always.words}</p>
                {r.allowable.map((a) => {
                  const on = r.always.includes(a.id);
                  return (
                    <button key={a.id} className="switch" onClick={() => toggle(a.id, a.name)} aria-pressed={on} disabled={act.isPending}>
                      <span>Always allow: {a.name.toLowerCase()}</span>
                      <span className={`tog ${on ? 'on' : ''}`} />
                    </button>
                  );
                })}
              </div>
            )}
            {l.level === 3 && <p className="note">squad-kit refuses these in its own words, whoever asks. They cannot be turned on.</p>}
          </div>
        ))}
        {r && (
          <>
            <button className="switch" onClick={() => save(r.always, !r.brief, r.brief ? 'The morning brief is off' : 'The morning brief is on')} aria-pressed={r.brief} disabled={act.isPending}>
              <span>Morning brief: a short summary since yesterday evening, with no AI</span>
              <span className={`tog ${r.brief ? 'on' : ''}`} />
            </button>
            <p className="note lr-limits">
              One question may use up to {dollars(r.limits.questionUsd)} or {r.limits.questionTurns} turns and {r.limits.minutes} minutes. All the answers of a day may use{' '}
              {dollars(r.limits.dayUsd)}, at API prices. Today: {dollars(r.today.costUsd)}.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}
