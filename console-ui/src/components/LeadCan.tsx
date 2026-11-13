import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { LeadAllowable, MorningBrief } from '../api/types';
import { useAct } from '../lib/data';
import { dollars } from '../lib/lead';
import { useLeadCan, useLeadRules } from '../lib/leadData';
import { Cmd, Modal, Written } from './ui';

/**
 * Beside the Squad lead's own box: what it can do, in its three levels, with "Always allow" for the low-risk ones,
 * the morning brief and its limits; and the morning brief itself when it is on. All of it comes from the board's own
 * data, with no AI. What needs you is in the top bar, so the page has no column of its own for it.
 */

/** "What it can do": one press away, under the box. */
export function CanLink() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="linkbtn lead-can" onClick={() => setOpen(true)}>
        <ShieldCheck size={13} aria-hidden="true" /> What it can do
      </button>
      {open && <CanDialog onClose={() => setOpen(false)} />}
    </>
  );
}

/** The morning brief, when it is on: since yesterday evening. */
export function Brief({ b }: { b: MorningBrief }) {
  const line = (label: string, xs: string[]) => (xs.length ? <Written as="li" lead={<b>{label}</b>} text={xs.join(', ')} /> : null);
  return (
    <section className="lead-brief">
      <div className="lbl">This morning</div>
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
