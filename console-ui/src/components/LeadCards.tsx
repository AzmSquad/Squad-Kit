import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Check, Copy, Plus, TriangleAlert, X } from 'lucide-react';
import type { LeadCard, LeadCardRun, ProofKind } from '../api/types';
import { useAct } from '../lib/data';
import { PROOF_NAME, canAlwaysAllow, levelName } from '../lib/lead';
import { usePrefs } from '../lib/prefs';
import { typedDir } from '../lib/lang';
import { Cmd, Written } from './ui';

/**
 * The lead's cards: what it offers to do, each with its level ("On its own", "Needs your OK") and real buttons. A
 * press runs the same function as the board's own button (POST /lead/cards/<id>/run); the card then says what
 * happened. Nothing here runs without a press, except what "Always allow" covers, and the card says so.
 */

type Edits = { title?: string; ask?: string; doneWhen?: { text: string; proof: ProofKind }[]; text?: string };

/** Pressing a card: once, Always allow, Not now, or with the person's edits. */
function usePress(card: LeadCard) {
  const act = useAct<LeadCardRun>();
  const press = (body: { always?: boolean; dismiss?: boolean; edits?: Edits } = {}, done?: (r: LeadCardRun) => string | null) =>
    act.mutate({ path: `/api/v1/lead/cards/${encodeURIComponent(card.id)}/run`, body, ...(done ? { done } : {}) });
  return { press, busy: act.isPending };
}

const SETTING_NAME: Record<string, string> = {
  quality: 'Quality',
  'commands.start': 'the start command',
  'commands.url': "the app's address",
  'commands.setup': 'the setup command',
  'commands.test': 'the test command',
  'commands.lint': 'the code check command',
  'commands.build': 'the build command',
};

/** One card under an answer. */
export function LeadCardView({ card }: { card: LeadCard }) {
  switch (card.kind) {
    case 'draft_story':
      return <DraftCard card={card} />;
    case 'engineer_report':
      return <ReportCard card={card} />;
    default:
      return <ActionCard card={card} />;
  }
}

function Level({ card }: { card: LeadCard }) {
  return <span className={`lvl ${card.level === 2 ? 'ok' : ''}`}>{levelName(card)}</span>;
}

/** What a pressed card did, with a link to the story it made or acted on. */
function Done({ card, story }: { card: LeadCard; story?: string }) {
  if (card.status === 'dismissed') return <div className="lc-f lc-quiet">Put aside. Nothing was done.</div>;
  return (
    <div className="lc-f lc-done" role="status">
      <Check size={15} strokeWidth={2.6} aria-hidden="true" />
      <Written text={card.byItself ?? card.result ?? 'Done.'} />
      {story && (
        <Link to="/board" search={{ ticket: story }} className="lc-link">
          Open {story}
        </Link>
      )}
    </div>
  );
}

/** A story or bug draft: read it, edit it if you like, then Create story. Nothing starts until you press Start. */
function DraftCard({ card }: { card: Extract<LeadCard, { kind: 'draft_story' }> }) {
  const { press, busy } = usePress(card);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(card.title);
  const [ask, setAsk] = useState(card.ask);
  const [rows, setRows] = useState(card.doneWhen);
  const open = card.status === 'open';
  const edited = title !== card.title || ask !== card.ask || JSON.stringify(rows) !== JSON.stringify(card.doneWhen);
  const create = () => press(edited ? { edits: { title, ask, doneWhen: rows.filter((r) => r.text.trim()) } } : {});
  const setRow = (i: number, r: Partial<{ text: string; proof: ProofKind }>) => setRows((xs) => xs.map((x, k) => (k === i ? { ...x, ...r } : x)));
  return (
    <section className="lc lc-draft" aria-label={`${card.storyKind === 'bug' ? 'Bug' : 'Story'} draft: ${card.title}`}>
      <header className="lc-h">
        <b>{card.storyKind === 'bug' ? 'Bug draft' : 'Story draft'}</b>
        <span className="lc-sub">· {card.storyKind === 'bug' ? 'Bug' : 'Feature'} · from this conversation</span>
        <Level card={card} />
      </header>
      <div className="lc-b">
        {editing && open ? (
          <div className="lc-edit">
            <label>
              <span>Title</span>
              <input className="input" value={title} dir={typedDir(title)} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label>
              <span>What it is about</span>
              <textarea className="input" rows={3} value={ask} dir={typedDir(ask)} onChange={(e) => setAsk(e.target.value)} />
            </label>
            <div className="dw">Done when · and how it will be proved</div>
            <ol className="lc-rows">
              {rows.map((r, i) => (
                <li key={i}>
                  <input className="input" value={r.text} dir={typedDir(r.text)} aria-label={`Done when ${i + 1}`} onChange={(e) => setRow(i, { text: e.target.value })} />
                  <select className="input" value={r.proof} aria-label={`How done when ${i + 1} will be proved`} onChange={(e) => setRow(i, { proof: e.target.value as ProofKind })}>
                    {(Object.keys(PROOF_NAME) as ProofKind[]).map((k) => (
                      <option key={k} value={k}>
                        {PROOF_NAME[k]}
                      </option>
                    ))}
                  </select>
                  <button className="iconbtn" onClick={() => setRows((xs) => xs.filter((_, k) => k !== i))} aria-label={`Remove done when ${i + 1}`} disabled={rows.length < 2}>
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ol>
            {rows.length < 8 && (
              <button className="linkbtn" onClick={() => setRows((xs) => [...xs, { text: '', proof: 'screen' }])}>
                <Plus size={13} /> Add a "done when"
              </button>
            )}
          </div>
        ) : (
          <>
            <Written as="div" className="lc-t" text={title} />
            {ask && ask !== title && <Written as="div" className="lc-a" text={ask} />}
            <div className="dw">Done when · and how it will be proved</div>
            <ol className="dwl">
              {rows.map((r, i) => (
                <li key={i}>
                  <span className="n">{i + 1}</span>
                  <Written className="txt" text={r.text} />
                  <span className={`kind ${r.proof}`}>{PROOF_NAME[r.proof]}</span>
                </li>
              ))}
            </ol>
          </>
        )}
        {card.warnings.map((w) => (
          <div className="lc-warn" key={w}>
            <TriangleAlert size={15} aria-hidden="true" />
            <Written text={w} />
          </div>
        ))}
        {open && card.result && <Written as="p" className="lc-why" text={card.result} />}
      </div>
      {open ? (
        <div className="lc-f">
          <button className="btn go" disabled={busy || !title.trim() || !rows.some((r) => r.text.trim())} onClick={create}>
            Create story
          </button>
          <button className="btn" disabled={busy} onClick={() => setEditing(!editing)} aria-pressed={editing}>
            {editing ? 'Done editing' : 'Edit'}
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => press({ dismiss: true })}>
            Discard
          </button>
          <span className="lc-after">Becomes a new story in Tickets. Nothing starts until you press Start.</span>
          <Cmd text={card.command} />
        </div>
      ) : (
        <Done card={card} {...(card.story ? { story: card.story } : {})} />
      )}
    </section>
  );
}

/** A board action, an answer to send, or a setting to save: one press each. */
function ActionCard({ card }: { card: Exclude<LeadCard, { kind: 'draft_story' | 'engineer_report' }> }) {
  const { press, busy } = usePress(card);
  const [text, setText] = useState(card.kind === 'send_answer' ? card.text : '');
  const always = canAlwaysAllow(card);
  const story = card.kind === 'board_action' || card.kind === 'send_answer' ? card.story : undefined;
  const title =
    card.kind === 'send_answer' ? `An answer for ${card.story}` : card.kind === 'settings_change' ? `Change ${SETTING_NAME[card.setting] ?? card.setting} to ${card.value}` : `${card.label}${card.story ? ` · ${card.story}` : ''}`;
  const main = card.kind === 'board_action' && always ? 'Allow once' : card.label;
  const open = card.status === 'open' && !card.byItself;
  return (
    <section className="lc" aria-label={title}>
      <header className="lc-h">
        <b>{title}</b>
        <Level card={card} />
      </header>
      {(card.why || card.kind === 'send_answer' || card.asksFirst || (card.kind === 'settings_change' && card.technical) || (open && card.result)) && (
        <div className="lc-b">
          {card.why && <Written as="p" className="lc-a" text={card.why} />}
          {card.kind === 'send_answer' &&
            (open ? (
              <textarea className="input" rows={3} value={text} dir={typedDir(text)} aria-label="The answer to send" onChange={(e) => setText(e.target.value)} />
            ) : (
              <Written as="p" className="lc-quote" text={card.text} />
            ))}
          {card.kind === 'settings_change' && card.technical && <p className="note">A technical setting: only an engineer changes it.</p>}
          {card.asksFirst && open && <p className="note">It came from what the lead read, not from your words, so it asks you first even with Always allow on.</p>}
          {open && card.result && <Written as="p" className="lc-why" text={card.result} />}
        </div>
      )}
      {open ? (
        <div className="lc-f">
          <button className="btn pri" disabled={busy || (card.kind === 'send_answer' && !text.trim())} onClick={() => press(card.kind === 'send_answer' && text.trim() !== card.text ? { edits: { text } } : {})}>
            {main}
          </button>
          {always && (
            <button className="btn" disabled={busy} onClick={() => press({ always: true })} title="Runs by itself from now on, without asking. Only for low-risk actions.">
              Always allow
            </button>
          )}
          <button className="btn ghost" disabled={busy} onClick={() => press({ dismiss: true })}>
            Not now
          </button>
          <Cmd text={card.command} />
        </div>
      ) : (
        <Done card={card} {...(story ? { story } : {})} />
      )}
    </section>
  );
}

/** A short report for an engineer: what happened, the steps, the logs, with no secrets. Made on a press, never sent. */
function ReportCard({ card }: { card: Extract<LeadCard, { kind: 'engineer_report' }> }) {
  const { press, busy } = usePress(card);
  const { toast } = usePrefs();
  const copy = () =>
    void navigator.clipboard?.writeText(card.report ?? '').then(
      () => toast('Copied the report'),
      () => toast('Could not copy. Select the text instead.', 'err'),
    );
  return (
    <section className="lc" aria-label="A report for an engineer">
      <header className="lc-h">
        <b>A report for an engineer</b>
        <Level card={card} />
      </header>
      <div className="lc-b">
        <p className="lc-a">{card.why ?? 'What happened, the steps and the logs, with no secrets in it. Nothing is sent: you copy it and send it yourself.'}</p>
        {card.report && <pre className="lc-report">{card.report}</pre>}
        {card.status === 'open' && card.result && <Written as="p" className="lc-why" text={card.result} />}
      </div>
      <div className="lc-f">
        {card.report ? (
          <button className="btn pri" onClick={copy}>
            <Copy size={14} /> Copy the report
          </button>
        ) : (
          <button className="btn pri" disabled={busy} onClick={() => press()}>
            Prepare a report
          </button>
        )}
        {card.report && <span className="lc-after">Nothing was sent.</span>}
        <Cmd text={card.command} />
      </div>
    </section>
  );
}

/**
 * The ways out of a "Needs you" item on the rail: the first with Always allow when that is allowed, the others by their
 * own words. Each press runs the board's own action for the story as it stands now.
 */
export function RailButtons({ cards }: { cards: LeadCard[] }) {
  const act = useAct<LeadCardRun>();
  const live = cards.filter((c) => c.status === 'open' && !c.byItself);
  const run = (c: LeadCard, always = false) =>
    act.mutate({ path: `/api/v1/lead/cards/${encodeURIComponent(c.id)}/run`, body: always ? { always: true } : {}, done: (r) => r.card.result ?? null });
  const [first, ...rest] = live;
  if (!first) return null;
  const always = canAlwaysAllow(first);
  return (
    <>
      <button className="btn pri sm" disabled={act.isPending} onClick={() => run(first)} title={first.why}>
        {always ? 'Allow once' : first.label}
      </button>
      {always && (
        <button className="btn sm" disabled={act.isPending} onClick={() => run(first, true)} title="Runs by itself from now on, without asking. Only for low-risk actions.">
          Always allow
        </button>
      )}
      {rest.map((c) => (
        <button key={c.id} className="btn sm" disabled={act.isPending} onClick={() => run(c)} title={c.why}>
          {c.label}
        </button>
      ))}
    </>
  );
}
