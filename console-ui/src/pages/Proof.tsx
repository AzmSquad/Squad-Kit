import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { Check } from 'lucide-react';
import { assetUrl } from '../api/client';
import { useTicket } from '../lib/data';
import { ProofDecision } from './TicketDrawer';

export function ProofPage() {
  const { id } = useParams({ from: '/tickets/$id/proof' });
  const ticket = useTicket(id);
  const [pick, setPick] = useState(0);
  const t = ticket.data;
  if (!t) return <div className="center">{ticket.isError ? `No ticket ${id}.` : 'Loading…'}</div>;
  const shots = t.proof ?? [];
  const shot = shots[Math.min(pick, shots.length - 1)];
  const waiting = t.waiting?.kind === 'proof';
  const g = t.gates;

  return (
    <>
      <div className="top">
        <span className="crumbs">
          <Link to="/inbox">Waiting for you</Link> /
          <Link to="/board" search={{ t: t.id }}>
            {t.id} {t.title}
          </Link>{' '}
          / <b>Proof</b>
        </span>
      </div>
      <div className="gatebar">
        <span className="pill ok"><Check size={13} strokeWidth={2.5} />{g?.checksText ?? 'All checks pass'}</span>
        <span className="pill ok"><Check size={13} strokeWidth={2.5} />Review approved{g?.reviewBy ? ` by ${g.reviewBy}` : ''}</span>
        <span className="pill ok"><Check size={13} strokeWidth={2.5} />Proof made</span>
        <span style={{ marginLeft: 6 }}>Nothing ships without these three.</span>
      </div>
      <div className="split">
        <div className="critlist">
          <div className="lbl" style={{ marginTop: 0 }}>Done when · {shots.length}</div>
          {shots.map((s, i) => (
            <button key={s.criterion} className={`crit ${i === pick ? 'on' : ''}`} onClick={() => setPick(i)}>
              <Check size={15} strokeWidth={2.5} />
              <span>{s.criterion}</span>
            </button>
          ))}
          {shots.length === 0 && <p className="note">No screens change in this ticket, so the passing checks are the proof.</p>}
        </div>
        <div className="stage">
          {shot ? (
            <>
              <h3>{shot.criterion}</h3>
              <div className="ba">
                <div>
                  <div className="cap">
                    <span>{shot.beforeLabel}</span>
                  </div>
                  <img src={assetUrl(`/api/v1/proof/${shot.before}`)} alt={`${shot.criterion}, ${shot.beforeLabel}`} />
                </div>
                <div>
                  <div className="cap">
                    <span>{shot.afterLabel}</span>
                  </div>
                  <img src={assetUrl(`/api/v1/proof/${shot.after}`)} alt={`${shot.criterion}, ${shot.afterLabel}`} />
                </div>
              </div>
              {shot.note && <p className="note">{shot.note}</p>}
            </>
          ) : (
            <p className="note">Nothing to compare.</p>
          )}
        </div>
      </div>
      {waiting ? (
        <ProofDecision t={t} sticky />
      ) : (
        <div className="stickybar">
          <span className="note">{t.status}</span>
        </div>
      )}
    </>
  );
}
